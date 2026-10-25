"""Awn length: calibrated arc length of the measurement path.

The path is first simplified with Douglas-Peucker at 1 px tolerance ("DP1") to remove
the pixel-grid staircase of skeleton paths, then its length is summed in millimetres
with independent x / y scales.
"""
from __future__ import annotations

from shapely.geometry import LineString

from .calibration import Calibration

DP_TOLERANCE_PX = 1.0


def simplify_path(path, tolerance_px: float = DP_TOLERANCE_PX):
    points = [(float(x), float(y)) for x, y in path]
    if len(points) < 3 or tolerance_px <= 0:
        return points
    simplified = [tuple(map(float, p)) for p in LineString(points).simplify(tolerance_px, preserve_topology=False).coords]
    if len(simplified) < 2:
        return points
    return [points[0], *simplified[1:-1], points[-1]]


def measure_path_mm(path, calibration: Calibration) -> float:
    return calibration.length_mm(simplify_path(path))
