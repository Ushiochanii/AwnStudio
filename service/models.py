"""Detection models the service can run, as in the original workbench.

Every model is presented to `awnstudio.detection.TiledSegmenter` through the
Ultralytics `predict` interface it already uses, so tiling, polygonization and
the reconstruction stay identical whichever detector produced the masks:

* Ultralytics YOLO checkpoints are used directly (the 960 / 1280 resolution
  checkpoints get their larger model input through `imgsz`);
* Mask2Former, Mask R-CNN and RF-DETR use the per-tile adapters of the research
  project (`awnphen.modeling.inference.*`, imported read-only from the legacy
  tree), wrapped by `TileModel` below.

The YOLO11N production checkpoint stays the default. The link models and the
length protocol were fitted on its detections; `files_for` picks the
detector-specific files when they exist (models/link_models.<model id>.json,
models/protocol_pfg.<model id>.json) and otherwise falls back to the default
ones. When the pipeline provides `models_for(model_id)` it is used instead.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TILE = 640
CUSTOM_MODELS_PATH = Path(os.environ.get("AWNSTUDIO_CUSTOM_MODELS", Path.home() / ".config/awnstudio/models.json")).expanduser()
RFDETR_PYTHON = Path(os.environ.get("AWNSTUDIO_RFDETR_PYTHON", "/root/.venvs/wheat_awn_candidates_20260909/bin/python"))

ADAPTERS = {
    "ultralytics_yolo_seg": "Ultralytics YOLO segmentation",
    "mask2former_segmentation": "Mask2Former segmentation",
    "torchvision_maskrcnn": "Torchvision Mask R-CNN",
    "rfdetr_segmentation": "RF-DETR segmentation",
}
DEFAULT_MODEL_ID = "controlled-v2-stage1"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    weights: Path
    adapter: str = "ultralytics_yolo_seg"
    description: str = ""
    scale: float = 1.0  # model input = scale x 640 px tile
    custom: bool = False

    @property
    def available(self) -> bool:
        if not self.weights.is_file():
            return False
        if self.adapter == "mask2former_segmentation":
            folder = self.weights.parent
            return (folder / "config.json").is_file() and (folder / "preprocessor_config.json").is_file()
        if self.adapter == "rfdetr_segmentation":
            return RFDETR_PYTHON.is_file()
        return True

    def public(self, default_id: str) -> dict:
        return {
            "id": self.id, "name": self.name, "adapter": self.adapter, "description": self.description,
            "available": self.available, "default": self.id == default_id, "custom": self.custom,
            "scale": self.scale, "weights": str(self.weights) if self.custom else None,
            "link_models": link_models_for(self.id).name,
            "protocol": protocol_for(self.id).name,
        }


def builtin_specs(legacy_root: Path) -> list[ModelSpec]:
    models = legacy_root / "artifacts" / "models"
    return [
        ModelSpec(DEFAULT_MODEL_ID, "YOLO 11N (Default) · Balanced",
                  models / "controlled_v2_targeted_robust_stage1_640_b20/weights/best.pt",
                  description="Frozen production YOLO11N baseline; the reconstruction was fitted on its detections."),
        ModelSpec("yolo11n-resolution-960", "YOLO 11N · 960 Resolution",
                  models / "resolution_sweep_20260929_yolo11n_seg_960_e80_b4_amp/weights/best.pt",
                  description="Each 640 tile is upscaled to a 960 model input.", scale=1.5),
        ModelSpec("yolo11n-resolution-1280", "YOLO 11N · 1280 Resolution",
                  models / "resolution_sweep_20260930_yolo11n_seg_1280_e80_b4_amp_postdriver/weights/best.pt",
                  description="Each 640 tile is upscaled to a 1280 model input.", scale=2.0),
        ModelSpec("yolo11m-benchmark", "YOLO 11M · Larger",
                  models / "benchmark_20260926_canonical_yolo11m_seg_640_e80_b4_amp/weights/best.pt",
                  description="YOLO11M comparison model from the 640 benchmark."),
        ModelSpec("rfdetr-seg-xlarge", "RF-DETR Seg XLarge · Transformer",
                  models / "crossarch_20260927_rfdetr_seg_xlarge_formal_e80_effb4/checkpoint_best_total.pth",
                  adapter="rfdetr_segmentation", description="Cross-architecture RF-DETR comparison model."),
        ModelSpec("mask2former-swin-large", "Mask2Former Swin-L · Heavy",
                  models / "reviewer_mask2former_swin_large_formal_20260929/best/model.safetensors",
                  adapter="mask2former_segmentation", description="High-capacity Mask2Former Swin-L."),
        ModelSpec("maskrcnn-r50-fpn-v2", "Mask R-CNN R50-FPN V2 · Baseline",
                  models / "crossarch_20260927_maskrcnn_r50_fpn_v2_formal_e80_b4/best.pt",
                  adapter="torchvision_maskrcnn", description="Classical two-stage Mask R-CNN comparison model."),
    ]


def _specific(stem: str, model_id: str | None) -> Path:
    specific = ROOT / "models" / f"{stem}.{model_id}.json"
    return specific if model_id and specific.is_file() else ROOT / "models" / f"{stem}.json"


def link_models_for(model_id: str | None) -> Path:
    return _specific("link_models", model_id)


def protocol_for(model_id: str | None) -> Path:
    return _specific("protocol_pfg", model_id)


def files_for(model_id: str | None) -> tuple[Path, Path]:
    """(link models, length protocol) for a detector, with the default fallback."""
    try:
        from awnstudio.pipeline import models_for
    except ImportError:
        return link_models_for(model_id), protocol_for(model_id)
    files = models_for(model_id)
    if isinstance(files, dict):
        return Path(files["link_models"]), Path(files["protocol"])
    link, protocol = files
    return Path(link), Path(protocol)


def protocol_json(path: Path) -> dict | None:
    """The linear method-comparison calibration (manual = a + b * measured)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return {"intercept": float(data["intercept"]), "slope": float(data["slope"]), "n": int(data["n"]), "file": Path(path).name}
    except (OSError, ValueError, KeyError, TypeError):
        return None


# ---------------------------------------------------------------- registry

def _normalize_path(value: str | Path) -> Path:
    raw = str(value).strip().strip('"').replace("\\", "/")
    raw = re.sub(r"/+", "/", raw)
    match = re.match(r"^([A-Za-z]):/(.*)$", raw)
    if match and Path("/mnt").is_dir():
        raw = f"/mnt/{match.group(1).lower()}/{match.group(2)}"
    return Path(raw).expanduser().resolve()


class Registry:
    def __init__(self, legacy_root: Path | None, default_weights: Path | None = None):
        self.builtin = builtin_specs(legacy_root) if legacy_root else []
        if default_weights and not any(s.weights == Path(default_weights) for s in self.builtin):
            self.builtin.insert(0, ModelSpec(DEFAULT_MODEL_ID, "YOLO (configured)", Path(default_weights)))

    def _custom(self) -> list[ModelSpec]:
        try:
            items = json.loads(CUSTOM_MODELS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        out = []
        for item in items if isinstance(items, list) else []:
            if item.get("adapter") in ADAPTERS and item.get("id") and item.get("weights"):
                out.append(ModelSpec(item["id"], item.get("name") or item["id"], Path(item["weights"]),
                                     item["adapter"], item.get("description", ""), float(item.get("scale", 1.0)), True))
        return out

    def specs(self) -> list[ModelSpec]:
        seen, out = set(), []
        for spec in [*self.builtin, *self._custom()]:
            if spec.id not in seen:
                seen.add(spec.id)
                out.append(spec)
        return out

    @property
    def default_id(self) -> str | None:
        specs = self.specs()
        return next((s.id for s in specs if s.id == DEFAULT_MODEL_ID and s.available), next((s.id for s in specs if s.available), None))

    def get(self, model_id: str | None) -> ModelSpec:
        model_id = model_id or self.default_id
        for spec in self.specs():
            if spec.id == model_id:
                return spec
        raise KeyError(f"unknown model: {model_id}")

    def catalog(self) -> dict:
        default = self.default_id
        return {"default": default, "models": [s.public(default) for s in self.specs()],
                "adapters": [{"id": k, "name": v} for k, v in ADAPTERS.items()]}

    def register(self, name: str, weights: str, adapter: str) -> ModelSpec:
        name, adapter = name.strip(), adapter.strip()
        if not name or not str(weights).strip():
            raise ValueError("name and weights are required")
        if adapter not in ADAPTERS:
            raise ValueError(f"unsupported adapter: {adapter}")
        path = _normalize_path(weights)
        model_id = "custom-" + hashlib.sha1(f"{adapter}|{path}".encode()).hexdigest()[:10]
        items = [i for i in self._raw() if i.get("id") != model_id]
        items.append({"id": model_id, "name": name, "weights": str(path), "adapter": adapter})
        self._write(items)
        return self.get(model_id)

    def remove(self, model_id: str) -> bool:
        items = self._raw()
        kept = [i for i in items if i.get("id") != model_id]
        self._write(kept)
        return len(kept) != len(items)

    def _raw(self) -> list[dict]:
        try:
            data = json.loads(CUSTOM_MODELS_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _write(self, items: list[dict]):
        CUSTOM_MODELS_PATH.parent.mkdir(parents=True, exist_ok=True)
        CUSTOM_MODELS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- loading

class _Array:
    """The `.cpu().numpy()` access path TiledSegmenter uses on torch tensors."""

    def __init__(self, data):
        self._data = np.asarray(data)

    def cpu(self):
        return self

    def numpy(self):
        return self._data


class _Result:
    def __init__(self, predictions):
        if predictions:
            self.masks = type("Masks", (), {"data": _Array(np.stack([np.asarray(p.mask, np.float32) for p in predictions]))})()
            self.boxes = type("Boxes", (), {
                "cls": _Array([p.class_id for p in predictions]),
                "conf": _Array([p.confidence for p in predictions]),
            })()
        else:
            self.masks = None
            self.boxes = None


class TileModel:
    """Presents a research-project tile adapter (`predict_tile`) as an
    Ultralytics model. Masks come back at tile size, so TiledSegmenter's
    letterbox correction is the identity."""

    def __init__(self, adapter):
        self.adapter = adapter

    def predict(self, image_bgr, *, conf: float, **_ignored):
        return [_Result(self.adapter.predict_tile(image_bgr, confidence=float(conf)))]

    def close(self):
        close = getattr(self.adapter, "close", None)
        if callable(close):
            close()


def _torch_device(device: str) -> str:
    value = str(device)
    return "cpu" if value == "cpu" else f"cuda:{value}" if value.isdigit() else value


def _use_legacy(legacy_root: Path):
    for path in (legacy_root / "src", legacy_root / "app" / "measurement_workbench"):
        if str(path) not in sys.path:
            sys.path.append(str(path))


def load_segmenter(spec: ModelSpec, device: str, legacy_root: Path | None):
    """A TiledSegmenter for `spec`."""
    from awnstudio.detection import TiledSegmenter

    if not spec.available:
        raise FileNotFoundError(f"model not available: {spec.name} ({spec.weights})")
    imgsz = int(round(TILE * spec.scale))
    if spec.adapter == "ultralytics_yolo_seg":
        segmenter = TiledSegmenter(spec.weights, device=device, imgsz=imgsz)
        if dict(segmenter.model.names) != {0: "awn", 1: "spikelet"}:
            raise ValueError(f"class mapping mismatch: {segmenter.model.names}")
        return segmenter
    if legacy_root is None:
        raise RuntimeError("this adapter needs the research project (legacy_root in configs/paths.yaml)")
    _use_legacy(legacy_root)
    model = TileModel(_load_adapter(spec, device, legacy_root))
    segmenter = TiledSegmenter.__new__(TiledSegmenter)
    segmenter.weights, segmenter.model, segmenter.device, segmenter.imgsz = spec.weights, model, device, imgsz
    return segmenter


def _load_adapter(spec: ModelSpec, device: str, legacy_root: Path):
    import torch

    if spec.adapter == "mask2former_segmentation":
        from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

        from awnphen.modeling.inference.mask2former_segmentation import Mask2FormerSegmentationAdapter

        folder = spec.weights.parent
        processor = AutoImageProcessor.from_pretrained(folder, local_files_only=True)
        model = Mask2FormerForUniversalSegmentation.from_pretrained(folder, local_files_only=True)
        model.to(torch.device(_torch_device(device))).eval()
        return Mask2FormerSegmentationAdapter(model=model, processor=processor, checkpoint_dir=folder, input_size=TILE)

    if spec.adapter == "torchvision_maskrcnn":
        from torchvision.models.detection import maskrcnn_resnet50_fpn_v2
        from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
        from torchvision.models.detection.mask_rcnn import MaskRCNNPredictor

        from awnphen.modeling.inference.torchvision_maskrcnn import TorchvisionMaskRCNNAdapter

        payload = torch.load(spec.weights, map_location="cpu", weights_only=True)
        cfg = dict(dict(payload.get("config") or {}).get("model") or {})
        budget = dict(cfg.get("proposal_budget") or {})
        model = maskrcnn_resnet50_fpn_v2(
            weights=None, weights_backbone=None,
            min_size=int(cfg.get("min_size", TILE)), max_size=int(cfg.get("max_size", TILE)),
            rpn_pre_nms_top_n_train=int(budget.get("rpn_pre_nms_top_n_train", 2000)),
            rpn_post_nms_top_n_train=int(budget.get("rpn_post_nms_top_n_train", 2000)),
            rpn_pre_nms_top_n_test=int(budget.get("rpn_pre_nms_top_n_test", 1000)),
            rpn_post_nms_top_n_test=int(budget.get("rpn_post_nms_top_n_test", 1000)),
            box_batch_size_per_image=int(budget.get("box_batch_size_per_image", 512)),
            box_detections_per_img=int(budget.get("detections_per_img", 100)),
        )
        classes = int(cfg.get("num_classes_with_background", 3))
        model.roi_heads.box_predictor = FastRCNNPredictor(model.roi_heads.box_predictor.cls_score.in_features, classes)
        model.roi_heads.mask_predictor = MaskRCNNPredictor(model.roi_heads.mask_predictor.conv5_mask.in_channels, 256, classes)
        model.load_state_dict(payload["model"], strict=True)
        return TorchvisionMaskRCNNAdapter(model=model, device=_torch_device(device), input_size=TILE,
                                          mask_threshold=0.5, checkpoint_path=spec.weights)

    if spec.adapter == "rfdetr_segmentation":
        from rfdetr_worker_adapter import RFDETRWorkerAdapter

        torch_device = _torch_device(device)
        return RFDETRWorkerAdapter(
            checkpoint_path=spec.weights, device="cuda" if torch_device.startswith("cuda") else torch_device,
            input_size=624, worker_script=legacy_root / "app" / "measurement_workbench" / "rfdetr_worker.py",
        )

    raise ValueError(f"unsupported adapter: {spec.adapter}")
