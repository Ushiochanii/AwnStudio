"""Small geometric helpers in millimetre space."""
from __future__ import annotations

import math

import numpy as np

TANGENT_SPAN_MM = 2.0  # arc length over which an end direction is estimated


def arc_lengths(path: np.ndarray) -> np.ndarray:
    if len(path) < 2:
        return np.zeros(len(path))
    return np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])


def end_direction(path_mm: np.ndarray, span_mm: float = TANGENT_SPAN_MM) -> np.ndarray | None:
    """Unit direction at path[-1], pointing outward (away from the path body).

    Principal axis of the last `span_mm` of arc, signed by the chord direction.
    """
    if len(path_mm) < 2:
        return None
    s = arc_lengths(path_mm)
    window = path_mm[s >= s[-1] - span_mm]
    if len(window) < 2:
        window = path_mm[-2:]
    centred = window - window.mean(axis=0)
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    axis = vt[0]
    chord = window[-1] - window[0]
    if np.dot(axis, chord) < 0:
        axis = -axis
    norm = np.linalg.norm(axis)
    return axis / norm if norm > 0 else None


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    """Unsigned angle in degrees between two vectors."""
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 180.0
    return math.degrees(math.acos(float(np.clip(np.dot(a, b) / (na * nb), -1.0, 1.0))))
