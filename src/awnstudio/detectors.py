"""Segmentation detectors and the per-detector files that depend on them.

Reconstruction is fitted to the evidence a detector produces (fragmentation, confidence
distribution), so every detector has its own cached detections, decision datasets, link
models and length protocol:

    detector             detections            linkdata            results
    default (YOLO)       runs/detections       runs/linkdata       runs/results/<method>
    other detector <id>  runs/detections_<id>  runs/linkdata_<id>  runs/results/<method>@<id>

    fitted files         default (YOLO)            other detector <id>
    link models          models/link_models.json   models/link_models.<id>.json
    length protocol      models/protocol_pfg.json  models/protocol_pfg.<id>.json

Ids are the model ids of the web workbench. The default detector keeps the original
locations, so existing callers are unaffected.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .paths import REPO_ROOT, paths


@dataclass(frozen=True)
class Detector:
    id: str
    name: str
    adapter: str  # "ultralytics_yolo_seg" | "mask2former_segmentation"
    weights_rel: str  # relative to the research project root (legacy_root)
    default: bool = False

    @property
    def weights(self) -> Path:
        return paths().legacy_root / self.weights_rel

    @property
    def available(self) -> bool:
        if not self.weights.is_file():
            return False
        if self.adapter == "mask2former_segmentation":
            return all((self.weights.parent / f).is_file() for f in ("config.json", "preprocessor_config.json"))
        return True

    @property
    def detections_dir(self) -> Path:
        return paths().runs / ("detections" if self.default else f"detections_{self.id}")

    @property
    def linkdata_dir(self) -> Path:
        return paths().runs / ("linkdata" if self.default else f"linkdata_{self.id}")

    def _model_file(self, stem: str) -> Path:
        return REPO_ROOT / "models" / (f"{stem}.json" if self.default else f"{stem}.{self.id}.json")

    @property
    def link_models_path(self) -> Path:
        return self._model_file("link_models")

    def protocol_path(self, method: str) -> Path:
        return self._model_file(f"protocol_{method}")

    def results_dir(self, method: str) -> Path:
        return paths().runs / "results" / (method if self.default else f"{method}@{self.id}")

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "adapter": self.adapter, "default": self.default,
                "available": self.available and self.link_models_path.is_file()}


DETECTORS = {
    d.id: d
    for d in (
        Detector("controlled-v2-stage1", "YOLO11n-seg 640 · controlled v2", "ultralytics_yolo_seg",
                 "artifacts/models/controlled_v2_targeted_robust_stage1_640_b20/weights/best.pt", default=True),
        Detector("mask2former-swin-large", "Mask2Former Swin-L", "mask2former_segmentation",
                 "artifacts/models/reviewer_mask2former_swin_large_formal_20260929/best/model.safetensors"),
    )
}
DEFAULT_DETECTOR = next(d.id for d in DETECTORS.values() if d.default)


def detector(detector_id: str | None = None) -> Detector:
    return DETECTORS[detector_id or DEFAULT_DETECTOR]


def list_detectors() -> list[dict]:
    """Detectors for a model picker: available = weights present and reconstruction fitted."""
    return [d.public() for d in DETECTORS.values()]
