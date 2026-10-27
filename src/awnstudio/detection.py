"""Tiled instance segmentation of a full page.

A page (~3508 x 2480 px) is scanned with overlapping 640 px tiles (stride 320). Every
predicted mask is polygonized in page coordinates; disconnected raster components of
one mask become separate observations. Nothing is merged here: overlapping tiles
produce duplicate and partial views of the same object, and resolving them is the job
of the reconstruction stages.

Equivalent to the frozen "primary_ultralytics_tiled_v1" evidence provider.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import cv2
import numpy as np
from shapely import Polygon, make_valid
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

CLASS_NAMES = {0: "awn", 1: "spikelet"}

TILE_SIZE = 640
TILE_STRIDE = 320
OBSERVATION_FLOOR = 0.05  # keep everything the model reports above this
PRIMARY_CONFIDENCE = 0.25  # observations used by reconstruction
NMS_IOU = 0.7


@dataclass(frozen=True)
class Observation:
    """One connected mask component from one tile prediction, in page pixels."""

    kind: str  # "awn" | "spikelet"
    confidence: float
    geometry: BaseGeometry
    tile: tuple[int, int, int, int]  # x1, y1, x2, y2
    prediction: int  # index of the prediction within its tile
    component: int  # index of the component within the prediction mask

    @property
    def key(self) -> str:
        return f"{self.tile[0]}_{self.tile[1]}:{self.prediction}:{self.component}"


def _starts(length: int, size: int, stride: int) -> list[int]:
    return sorted({*range(0, max(1, length - size + 1), stride), max(0, length - size)})


def tile_windows(width: int, height: int, size: int = TILE_SIZE, stride: int = TILE_STRIDE):
    return [
        (x, y, min(x + size, width), min(y + size, height))
        for y in _starts(height, size, stride)
        for x in _starts(width, size, stride)
    ]


def _polygons(geometry) -> list[BaseGeometry]:
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [part for item in geometry.geoms for part in _polygons(item)]
    return []


def mask_components(mask: np.ndarray, tile: tuple[int, int, int, int]) -> list[BaseGeometry]:
    """Polygonize a model-resolution mask into page coordinates.

    The model may return letterboxed masks at its input resolution; the letterbox is
    undone analytically on the contour coordinates rather than by resizing the raster.
    """
    binary = np.ascontiguousarray((np.asarray(mask, np.float32) > 0.5).astype(np.uint8))
    if not binary.any():
        return []
    x1, y1, x2, y2 = tile
    target_w, target_h = x2 - x1, y2 - y1
    mask_h, mask_w = binary.shape
    gain = min(mask_h / target_h, mask_w / target_w)
    pad_x = (mask_w - target_w * gain) / 2.0
    pad_y = (mask_h - target_h * gain) / 2.0

    def to_page(points):
        mapped = np.asarray(points, dtype=float).copy()
        mapped[:, 0] = np.clip((mapped[:, 0] - pad_x) / gain + x1, x1, x1 + target_w)
        mapped[:, 1] = np.clip((mapped[:, 1] - pad_y) / gain + y1, y1, y1 + target_h)
        return mapped

    components = []
    for contour in cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        points = contour.reshape(-1, 2)
        if len(points) >= 3:
            parts = [p for p in _polygons(make_valid(Polygon(to_page(points)))) if p.area > 0]
            if parts:
                merged = unary_union(parts)
                if not merged.is_empty:
                    components.append(merged)
            continue
        # Degenerate contour (1-2 px island): keep its bounding box.
        bx, by, bw, bh = cv2.boundingRect(contour)
        corners = [[bx, by], [bx + max(1, bw), by], [bx + max(1, bw), by + max(1, bh)], [bx, by + max(1, bh)]]
        components.extend(p for p in _polygons(make_valid(Polygon(to_page(corners)))) if p.area > 0)

    components = [c for c in components if not c.is_empty and c.area > 0]
    components.sort(key=lambda g: (-float(g.area), tuple(map(float, g.bounds))))
    return components


class Mask2FormerTiles:
    """Hugging Face Mask2Former instance segmentation of one tile (masks at tile size).

    Ported from the research project's adapter: no resize, instance post-processing at
    mask threshold 0.5, label ids 0 = awn and 1 = spikelet.
    """

    def __init__(self, checkpoint_dir: str | Path, device: str | int = 0):
        import torch
        from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

        self.torch = torch
        self.processor = AutoImageProcessor.from_pretrained(checkpoint_dir, local_files_only=True)
        self.model = Mask2FormerForUniversalSegmentation.from_pretrained(checkpoint_dir, local_files_only=True)
        dev = f"cuda:{device}" if str(device).isdigit() else str(device)
        self.model.to(torch.device(dev)).eval()

    def predict_tile(self, tile_bgr: np.ndarray, confidence: float):
        h, w = tile_bgr.shape[:2]
        rgb = cv2.cvtColor(tile_bgr, cv2.COLOR_BGR2RGB)
        inputs = self.processor(images=rgb, return_tensors="pt", do_resize=False)
        device = next(self.model.parameters()).device
        inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}
        with self.torch.no_grad():
            outputs = self.model(**inputs)
        post = self.processor.post_process_instance_segmentation(
            outputs, threshold=confidence, mask_threshold=0.5, target_sizes=[(h, w)], return_binary_maps=True,
        )[0]
        segmentation, info = post.get("segmentation"), list(post.get("segments_info", ()))
        if segmentation is None or not info:
            return []
        masks = segmentation.detach().cpu().numpy()
        if masks.ndim == 2:
            masks = masks[None]
        return [(int(i["label_id"]), float(i["score"]), m) for m, i in zip(masks, info)
                if int(i["label_id"]) in CLASS_NAMES and float(i["score"]) >= confidence]


class TiledSegmenter:
    """Run a segmentation model (Ultralytics YOLO or Mask2Former) over a page."""

    def __init__(self, weights: str | Path, device: str | int = 0, imgsz: int = TILE_SIZE,
                 adapter: str = "ultralytics_yolo_seg"):
        self.weights = Path(weights)
        self.adapter = adapter
        self.device = device
        self.imgsz = imgsz
        if adapter == "ultralytics_yolo_seg":
            from ultralytics import YOLO

            self.model = YOLO(str(self.weights))
        elif adapter == "mask2former_segmentation":
            self.model = Mask2FormerTiles(self.weights.parent, device)
        else:
            raise ValueError(f"unsupported adapter: {adapter}")

    def _predict_tile(self, tile_bgr: np.ndarray, confidence: float):
        """[(class id, score, mask)] for one tile; masks at model or tile resolution."""
        if self.adapter == "mask2former_segmentation":
            return self.model.predict_tile(tile_bgr, confidence)
        result = self.model.predict(
            tile_bgr, imgsz=self.imgsz, conf=confidence, iou=NMS_IOU, device=self.device, verbose=False,
        )[0]
        if result.masks is None:
            return []
        return list(zip(result.boxes.cls.cpu().numpy().astype(int), result.boxes.conf.cpu().numpy(),
                        result.masks.data.cpu().numpy()))

    def predict_page(
        self,
        image_bgr: np.ndarray,
        *,
        confidence: float = OBSERVATION_FLOOR,
        progress: Callable[[int, int], None] | None = None,
    ) -> list[Observation]:
        height, width = image_bgr.shape[:2]
        tiles = tile_windows(width, height)
        observations: list[Observation] = []
        for index, tile in enumerate(tiles):
            x1, y1, x2, y2 = tile
            predictions = self._predict_tile(image_bgr[y1:y2, x1:x2], confidence)
            if progress:
                progress(index + 1, len(tiles))
            for prediction, (cls, score, mask) in enumerate(predictions):
                for component, geometry in enumerate(mask_components(mask, tile)):
                    observations.append(
                        Observation(CLASS_NAMES[int(cls)], float(score), geometry, tile, prediction, component)
                    )
        return observations


def primary(observations: Iterable[Observation]) -> list[Observation]:
    return [o for o in observations if o.confidence >= PRIMARY_CONFIDENCE]
