"""Agreement with the manual measurement protocol.

The reconstructed path runs from where the awn leaves the segmented spikelet to the
end of the segmented awn's medial axis. The manual reference (ImageJ polyline) uses
its own base and tip convention; on training pages the reviewed awn polygons are
~2 mm longer than the ImageJ value, i.e. the conventions differ systematically, not
randomly. Rather than editing geometry with ad-hoc offsets, the difference is
modelled once as a linear method-comparison calibration

    manual = a + b * measured

estimated with the Theil-Sen estimator (robust to the occasional reconstruction
failure) on training pages only, and applied unchanged to validation / test pages.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.stats import theilslopes


@dataclass(frozen=True)
class Protocol:
    intercept: float
    slope: float
    n: int

    def apply(self, measured_mm: float | None) -> float | None:
        return None if measured_mm is None else self.intercept + self.slope * measured_mm

    def to_json(self) -> dict:
        return {"intercept": self.intercept, "slope": self.slope, "n": self.n}


def fit_protocol(measured: list[float], manual: list[float]) -> Protocol:
    slope, intercept, _, _ = theilslopes(np.asarray(manual), np.asarray(measured))
    return Protocol(float(intercept), float(slope), len(measured))


def load_protocol(path: Path) -> Protocol:
    d = json.loads(Path(path).read_text())
    return Protocol(d["intercept"], d["slope"], d["n"])
