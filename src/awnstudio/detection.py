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


class TiledSegmenter:
    """Run an Ultralytics segmentation model over a page."""

    def __init__(self, weights: str | Path, device: str | int = 0, imgsz: int = TILE_SIZE):
        from ultralytics import YOLO

        self.weights = Path(weights)
        self.model = YOLO(str(self.weights))
        self.device = device
        self.imgsz = imgsz

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
            result = self.model.predict(
                image_bgr[y1:y2, x1:x2],
                imgsz=self.imgsz,
                conf=confidence,
                iou=NMS_IOU,
                device=self.device,
                verbose=False,
            )[0]
            if progress:
                progress(index + 1, len(tiles))
            if result.masks is None:
                continue
            masks = result.masks.data.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy().astype(int)
            scores = result.boxes.conf.cpu().numpy()
            for prediction, (mask, cls, score) in enumerate(zip(masks, classes, scores)):
                for component, geometry in enumerate(mask_components(mask, tile)):
                    observations.append(
                        Observation(CLASS_NAMES[int(cls)], float(score), geometry, tile, prediction, component)
                    )
        return observations


def primary(observations: Iterable[Observation]) -> list[Observation]:
    return [o for o in observations if o.confidence >= PRIMARY_CONFIDENCE]
