"""Physical scale from the 5 mm graph paper behind every page.

The grid lines are cyan/blue. Projecting a blue-response image onto each axis gives
a 1-D signal whose peaks are grid lines; the robust median of peak spacing (allowing
for missed lines) is the grid period in pixels per 5 mm. Each page is first resampled
to the development reference geometry so the peak-detection scales are meaningful,
and periods are mapped back to source pixels per axis.

Algorithmically identical to the frozen "grid calibration v2" of the research project.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.signal import find_peaks

GRID_MM = 5.0
REFERENCE_SIZE = (3508, 2480)  # (width, height) of the development scans
REFERENCE_PERIOD_RANGE = (54.0, 64.0)  # plausible px / 5 mm at reference size

# Quality gates (reported, and used to mark a page as needing review).
MAX_XY_DISAGREEMENT = 0.05
MAX_STRIP_RANGE_PX = 3.0
MIN_PEAKS = {"x": 40, "y": 25}
MAX_PAGE_ANISOTROPY = 0.05
QC_STRIPS = 6


@dataclass(frozen=True)
class Calibration:
    """Pixels per 5 mm along x and y in source-image pixels."""

    x_period_px: float
    y_period_px: float
    adequate: bool = True
    qc_reasons: tuple[str, ...] = ()
    diagnostics: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def mm_per_px(self) -> tuple[float, float]:
        return GRID_MM / self.x_period_px, GRID_MM / self.y_period_px

    def to_mm(self, points) -> np.ndarray:
        sx, sy = self.mm_per_px
        return np.asarray(points, dtype=float) * (sx, sy)

    def to_px(self, points_mm) -> np.ndarray:
        sx, sy = self.mm_per_px
        return np.asarray(points_mm, dtype=float) / (sx, sy)

    def length_mm(self, path_px) -> float:
        points = np.asarray(path_px, dtype=float)
        if len(points) < 2:
            return 0.0
        return float(np.linalg.norm(np.diff(self.to_mm(points), axis=0), axis=1).sum())

    @classmethod
    def isotropic(cls, mm_per_px: float) -> "Calibration":
        period = GRID_MM / float(mm_per_px)
        return cls(period, period)


def calibrate_cached(page_id: str) -> Calibration:
    """Calibrate a dataset page once and memoize it under runs/calibration/."""
    import json

    from .paths import paths

    target = paths().runs / "calibration" / f"{page_id}.json"
    if target.exists():
        d = json.loads(target.read_text())
        return Calibration(d["x"], d["y"], d["adequate"], tuple(d["qc_reasons"]))
    calibration = calibrate_page(cv2.imread(str(paths().page_image(page_id))))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "x": calibration.x_period_px, "y": calibration.y_period_px,
        "adequate": calibration.adequate, "qc_reasons": list(calibration.qc_reasons),
    }))
    return calibration


def grid_response(image_bgr: np.ndarray) -> np.ndarray:
    b, g, r = cv2.split(image_bgr.astype(np.float32))
    score = np.clip((b - r) * 0.7 + (g - r) * 0.3, 0.0, None)
    return score * ((b + g + r) / 3.0 > 120.0)


def _peaks(signal: np.ndarray) -> np.ndarray:
    smoothed = cv2.GaussianBlur(np.asarray(signal, np.float32).reshape(1, -1), (0, 0), 2.0).ravel()
    prominence = max(0.3, float(np.percentile(smoothed, 75)) * 0.15)
    peaks, _ = find_peaks(smoothed, distance=40, prominence=prominence)
    return peaks.astype(float)


def _period(peaks: np.ndarray) -> float:
    """Median line spacing, dividing gaps that skip lines by the number of cells."""
    diffs = np.diff(peaks)
    period = float(np.median(diffs[(diffs >= 50) & (diffs <= 68)]))
    if not np.isfinite(period):
        period = float(np.median(diffs))
    for abs_tol, rel_tol in ((5.0, 0.12), (4.0, 0.10)):
        cells = np.maximum(1, np.rint(diffs / period).astype(int))
        normalized = diffs / cells
        keep = np.abs(normalized - period) <= max(abs_tol, period * rel_tol)
        period = float(np.median(normalized[keep]))
    return period


def _axis(score: np.ndarray, axis: str) -> tuple[float, int, float]:
    """Return (period, peak count, strip-to-strip period range) for one axis."""
    reduce_axis = 0 if axis == "x" else 1
    peaks = _peaks(score.mean(axis=reduce_axis))
    period = _period(peaks)
    extent = score.shape[0] if axis == "x" else score.shape[1]
    strips = []
    for index in range(QC_STRIPS):
        start, end = round(index * extent / QC_STRIPS), round((index + 1) * extent / QC_STRIPS)
        band = score[start:end, :] if axis == "x" else score[:, start:end]
        strips.append(_period(_peaks(band.mean(axis=reduce_axis))))
    return period, len(peaks), float(np.ptp(strips))


def calibrate_page(image_bgr: np.ndarray) -> Calibration:
    if image_bgr is None or image_bgr.ndim != 3:
        raise ValueError("expected a BGR full-page image")
    height, width = image_bgr.shape[:2]
    ref_w, ref_h = REFERENCE_SIZE
    scale_x, scale_y = width / ref_w, height / ref_h
    normalized = image_bgr
    if (width, height) != REFERENCE_SIZE:
        interpolation = cv2.INTER_AREA if (width > ref_w or height > ref_h) else cv2.INTER_LINEAR
        normalized = cv2.resize(image_bgr, REFERENCE_SIZE, interpolation=interpolation)

    score = grid_response(normalized)
    x_norm, x_peaks, x_range = _axis(score, "x")
    y_norm, y_peaks, y_range = _axis(score, "y")

    lo, hi = REFERENCE_PERIOD_RANGE
    disagreement = abs(x_norm - y_norm) / max(1e-9, (x_norm + y_norm) / 2.0)
    anisotropy = abs(scale_x - scale_y) / max(1e-9, (scale_x + scale_y) / 2.0)
    checks = {
        "x_period_in_reference_range": lo <= x_norm <= hi,
        "y_period_in_reference_range": lo <= y_norm <= hi,
        "normalized_xy_period_consistent": disagreement <= MAX_XY_DISAGREEMENT,
        "x_strip_stable": x_range <= MAX_STRIP_RANGE_PX,
        "y_strip_stable": y_range <= MAX_STRIP_RANGE_PX,
        "x_peak_count_sufficient": x_peaks >= MIN_PEAKS["x"],
        "y_peak_count_sufficient": y_peaks >= MIN_PEAKS["y"],
        "page_scale_isotropic": anisotropy <= MAX_PAGE_ANISOTROPY,
    }
    return Calibration(
        x_period_px=x_norm * scale_x,
        y_period_px=y_norm * scale_y,
        adequate=all(checks.values()),
        qc_reasons=tuple(name for name, ok in checks.items() if not ok),
        diagnostics={
            "normalized_period_px": (x_norm, y_norm),
            "peak_count": (x_peaks, y_peaks),
            "strip_range_px": (x_range, y_range),
            "xy_disagreement": disagreement,
        },
    )
