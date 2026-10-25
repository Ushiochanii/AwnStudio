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


def trim_root(path, spikelet_geometry):
    """Start the measurement where the awn leaves its spikelet.

    The awn base is defined as the exit of the path from the spikelet polygon: the
    initial run of path points inside the polygon is removed and replaced by the
    boundary crossing point. Paths that start outside are returned unchanged.
    """
    from shapely.geometry import LineString, Point

    points = [tuple(map(float, p)) for p in path]
    k = 0
    while k < len(points) and spikelet_geometry.contains(Point(points[k])):
        k += 1
    if k == 0 or k >= len(points):
        return points
    segment = LineString([points[k - 1], points[k]])
    crossing = segment.intersection(spikelet_geometry.boundary)
    if crossing.is_empty:
        return points[k:]
    candidates = [crossing] if crossing.geom_type == "Point" else list(getattr(crossing, "geoms", []))
    candidates = [c for c in candidates if c.geom_type == "Point"]
    if not candidates:
        return points[k:]
    exit_point = max(candidates, key=lambda c: segment.project(c))
    return [(exit_point.x, exit_point.y), *points[k:]]


def measure_path_mm(path, calibration: Calibration) -> float:
    return calibration.length_mm(simplify_path(path))
