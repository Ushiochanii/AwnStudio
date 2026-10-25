"""Length evaluation against manual ImageJ measurements.

Each predicted spikelet is matched one-to-one to a reviewed spikelet polygon
(maximum total IoU, IoU >= MIN_IOU). The polygon's truth identity selects the manual
length record. Metrics follow the research project's definitions so numbers are
comparable: coverage and MAE are computed over truth-positive records
(manual length >= 5 mm); non-positive records count as suppressed when the prediction
is missing or < 5 mm.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linear_sum_assignment
from shapely.strtree import STRtree

from .identity import full_row_identities, truth_spikelet_identities
from .results import PageResult
from .truth import POSITIVE_MM, LengthTarget, accession_mapping, length_key, length_targets, manual_lengths

MIN_IOU = 0.3


@dataclass
class ScoredTarget:
    page_id: str
    column: int
    repeat: int
    role: str
    truth_mm: float
    predicted_mm: float | None
    spikelet_id: str | None

    @property
    def positive(self) -> bool:
        return self.truth_mm >= POSITIVE_MM

    @property
    def error_mm(self) -> float | None:
        return None if self.predicted_mm is None else self.predicted_mm - self.truth_mm


def _iou(a, b) -> float:
    inter = a.intersection(b).area
    return inter / (a.area + b.area - inter) if inter > 0 else 0.0


def _targets(page_id: str, split: str):
    """(identities, length targets). Validation/test: cell truth. Train: full rows only."""
    if split != "train":
        identities, _ = truth_spikelet_identities(page_id, split)
        return identities, length_targets(page_id)
    identities = full_row_identities(page_id, split)
    pair_of = accession_mapping().get(page_id, {})
    lengths = manual_lengths()
    targets = []
    for ident in identities:
        pair = pair_of.get(ident.column)
        if pair is None:
            continue
        key = length_key(*pair, ident.repeat, ident.role)
        if lengths.get(key) is not None:
            targets.append(LengthTarget(page_id, ident.column, ident.repeat, ident.role, key, lengths[key]))
    return identities, targets


def score_page(result: PageResult, split: str = "valid") -> list[ScoredTarget]:
    identities, targets = _targets(result.page_id, split)
    preds = result.spikelets
    iou = np.zeros((len(identities), len(preds)))
    if preds:
        tree = STRtree([p.geometry for p in preds])
        for i, ident in enumerate(identities):
            for j in tree.query(ident.instance.geometry):
                iou[i, j] = _iou(ident.instance.geometry, preds[j].geometry)
    matched = {}
    if identities and preds:
        rows, cols = linear_sum_assignment(-iou)
        matched = {(identities[r].column, identities[r].repeat, identities[r].role): preds[c]
                   for r, c in zip(rows, cols) if iou[r, c] >= MIN_IOU}

    out = []
    for target in targets:
        pred = matched.get((target.column, target.repeat, target.role))
        out.append(ScoredTarget(
            result.page_id, target.column, target.repeat, target.role, target.length_mm,
            None if pred is None else pred.length_mm, None if pred is None else pred.id,
        ))
    return out


def regression(pairs: list[tuple[float, float]]) -> dict:
    if not pairs:
        return {"n": 0}
    truth = np.asarray([t for t, _ in pairs])
    pred = np.asarray([p for _, p in pairs])
    err = pred - truth
    ae = np.abs(err)
    sst = float(((truth - truth.mean()) ** 2).sum())
    return {
        "n": len(pairs),
        "mae_mm": float(ae.mean()),
        "median_ae_mm": float(np.median(ae)),
        "rmse_mm": float(math.sqrt((err ** 2).mean())),
        "bias_mm": float(err.mean()),
        "r2": None if sst <= 0 else float(1 - (err ** 2).sum() / sst),
        "pearson_r": float(np.corrcoef(truth, pred)[0, 1]) if len(pairs) > 2 else None,
        "within_2mm": float((ae <= 2).mean()),
        "within_5mm": float((ae <= 5).mean()),
    }


def summarize(rows: list[ScoredTarget]) -> dict:
    pos = [r for r in rows if r.positive]
    non = [r for r in rows if not r.positive]
    measured = [r for r in pos if r.predicted_mm is not None]
    return {
        "targets": len(rows),
        "positive": len(pos),
        "positive_measured": len(measured),
        "coverage": len(measured) / len(pos) if pos else None,
        "positive_detected_ge5": sum(r.predicted_mm is not None and r.predicted_mm >= POSITIVE_MM for r in pos) / max(1, len(pos)),
        "nonpositive_suppression": sum(r.predicted_mm is None or r.predicted_mm < POSITIVE_MM for r in non) / max(1, len(non)),
        "length": regression([(r.truth_mm, r.predicted_mm) for r in measured]),
    }


def format_summary(name: str, s: dict) -> str:
    L = s["length"]
    if not s["positive"] or not L.get("n"):
        return f"{name}: {s['targets']} targets, {s['positive']} positive, nothing to score"
    return (
        f"{name}: coverage {s['positive_measured']}/{s['positive']} ({100 * s['coverage']:.2f}%)  "
        f"MAE {L['mae_mm']:.3f}  MedAE {L['median_ae_mm']:.3f}  RMSE {L['rmse_mm']:.3f}  "
        f"bias {L['bias_mm']:+.3f}  R2 {L['r2']:.4f}  <=2mm {100 * L['within_2mm']:.1f}%  "
        f"non-pos suppression {100 * s['nonpositive_suppression']:.1f}%"
    )
