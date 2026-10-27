"""Reconstruction diagnosis: where do stitching errors come from?

Every reconstructed awn path is compared with the reviewed whole-awn polygons of its
page (no ImageJ / accession mapping is needed) and put in one class:

Lengths below are contiguous runs of the path (scattered outline jitter does not add up).

* JUMP       - >= EVAL_MM runs along a different truth awn (switched at a crossing);
* FALSE_LINK - >= EVAL_MM runs over no truth awn; split by whether the input
               evidence covers it (glare / false mask) or the path bridged empty space,
               and by whether the run is at the tip (overshoot past the truth tip) or
               in the middle of the path;
* SHORT      - >= EVAL_MM of its truth awn is missing beyond the last covered point on
               the tip side; split by whether evidence continues there (stitching
               stopped early) or not (the input never had it);
* OK         - none of the above.

Truth awns that no path follows are MISSED (with the share of their axis covered by
evidence); several paths on one truth awn are duplicates. Samples inside truth
spikelets (dilated by AWN_TOL_PX) are ignored, so root handling does not count as an error.

The same pipeline can be fed three inputs, which separates segmentation errors from
stitching errors: ``model`` (cached detections), ``oracle_whole`` (each truth polygon
as one observation) and ``oracle_broken`` (truth polygons cut every BREAK_EVERY_MM).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.ops import substring

from .calibration import Calibration
from .detection import Observation
from .labels import polygon_axis
from .measurement import measure_path_mm, trim_root
from .spikelets import match_to_truth
from .truth import TruthInstance

EVAL_MM = 2.0  # evaluation threshold, not a method parameter
AWN_TOL_PX = 4.0  # truth awn masks are dilated by this much (hand-drawn outline)
ATTACH_MM = 2.0  # axis end within this distance of a truth spikelet: attached awn
BREAK_EVERY_MM = 10.0  # oracle_broken: cut spacing along the axis
BREAK_GAP_MM = 1.0  # oracle_broken: gap length along the axis
BREAK_HALF_WIDTH_MM = 1.5  # oracle_broken: the cut extends this far across the axis

CLASSES = ("OK", "SHORT", "JUMP", "FALSE_LINK")


# ----------------------------------------------------------------------------- inputs


def oracle_observations(
    truth: list[TruthInstance], width: int, height: int, calibration: Calibration, broken: bool = False
) -> list[Observation]:
    """Truth polygons as observations (confidence 1), optionally cut into pieces."""
    tile = (0, 0, width, height)
    mm = float(np.mean(calibration.mm_per_px))
    out = []
    for k, inst in enumerate(truth):
        pieces = [inst.geometry]
        if broken and inst.kind == "awn":
            pieces = break_polygon(inst.geometry, mm)
        for c, piece in enumerate(pieces):
            out.append(Observation(inst.kind, 1.0, piece, tile, k, c))
    return out


def break_polygon(polygon, mm_per_px: float) -> list:
    axis = polygon_axis(polygon)
    if axis is None:
        return [polygon]
    every, gap, half = BREAK_EVERY_MM / mm_per_px, BREAK_GAP_MM / mm_per_px, BREAK_HALF_WIDTH_MM / mm_per_px
    cuts = [
        substring(axis, d - gap / 2, d + gap / 2).buffer(half, cap_style="flat")
        for d in np.arange(every, axis.length - gap, every)
    ]
    if not cuts:
        return [polygon]
    rest = polygon.difference(shapely.union_all(cuts))
    return [p for p in getattr(rest, "geoms", [rest]) if p.geom_type == "Polygon" and p.area > 1]


# ----------------------------------------------------------------------------- truth


@dataclass
class TruthAwn:
    index: int
    geometry: object  # polygon, page px
    mask: object  # polygon dilated by AWN_TOL_PX
    axis: LineString | None  # base -> tip, trimmed at the spikelet exit
    spikelet: int | None  # index into truth spikelets
    length_mm: float


def truth_awns(truth: list[TruthInstance], calibration: Calibration) -> tuple[list[TruthAwn], list]:
    spikelets = [t.geometry for t in truth if t.kind == "spikelet"]
    tree = shapely.STRtree(spikelets) if spikelets else None
    attach_px = ATTACH_MM / float(np.mean(calibration.mm_per_px))
    out = []
    for k, t in enumerate([t for t in truth if t.kind == "awn"]):
        axis = polygon_axis(t.geometry)
        spikelet = None
        if axis is not None and tree is not None:
            ends = [Point(axis.coords[0]), Point(axis.coords[-1])]
            best = None
            for s in tree.query(axis.buffer(attach_px)):
                for e, end in enumerate(ends):
                    d = spikelets[int(s)].distance(end)
                    if d <= attach_px and (best is None or d < best[0]):
                        best = (d, int(s), e)
            if best is not None:
                _, spikelet, e = best
                coords = list(axis.coords) if e == 0 else list(axis.coords)[::-1]
                trimmed = trim_root(coords, spikelets[spikelet])
                axis = LineString(trimmed) if len(trimmed) >= 2 else None
        # Same convention as the pipeline (DP1 arc length): the raw skeleton staircase is ~3% longer.
        length = measure_path_mm(list(axis.coords), calibration) if axis is not None else 0.0
        out.append(TruthAwn(k, t.geometry, t.geometry.buffer(AWN_TOL_PX), axis, spikelet, length))
    return out, spikelets


# ----------------------------------------------------------------------------- classification


@dataclass
class PathDiagnosis:
    spikelet: int  # index in the PageResult
    awn: int  # index within that spikelet
    cls: str
    main: int | None  # truth awn index
    length_mm: float
    on_main_mm: float
    jump_mm: float
    false_mm: float
    false_on_evidence_mm: float
    false_at_tip: bool  # the longest off-truth run ends at the path tip (overshoot)
    jump_total_mm: float
    false_total_mm: float
    missing_tip_mm: float
    missing_tip_evidence: float  # share of the missing tip axis covered by evidence
    detail: str = ""
    missing_tip_px: list = field(default_factory=list)  # drawn in figures
    samples_px: list = field(default_factory=list)


def _resample(path, step_px: float = 1.0) -> np.ndarray:
    line = LineString(path)
    n = max(2, int(np.ceil(line.length / step_px)) + 1)
    return np.asarray([line.interpolate(t, normalized=True).coords[0] for t in np.linspace(0, 1, n)])


def _sample_weights_mm(points: np.ndarray, calibration: Calibration) -> np.ndarray:
    seg = np.linalg.norm(np.diff(calibration.to_mm(points), axis=0), axis=1)
    w = np.zeros(len(points))
    w[:-1] += seg / 2
    w[1:] += seg / 2
    return w


def _longest_run(weight: np.ndarray, mask: np.ndarray) -> tuple[float, int]:
    """Largest sum of weights over consecutive True samples, and the run's last index."""
    best, end, run = 0.0, -1, 0.0
    for i, (w, m) in enumerate(zip(weight, mask)):
        run = run + w if m else 0.0
        if run > best:
            best, end = run, i
    return float(best), end


def _covered(geometry, points: np.ndarray) -> np.ndarray:
    if geometry is None or geometry.is_empty or len(points) == 0:
        return np.zeros(len(points), bool)
    return shapely.contains_xy(geometry, points[:, 0], points[:, 1])


def classify_path(
    path_px, awns: list[TruthAwn], spikelet_union, evidence, calibration: Calibration, tree=None
) -> dict:
    points = _resample(path_px)
    weight = _sample_weights_mm(points, calibration)
    keep = ~_covered(spikelet_union, points)
    tree = tree or shapely.STRtree([a.mask for a in awns])
    candidates = [int(i) for i in tree.query(LineString(points))] if awns else []
    on = {k: _covered(awns[k].mask, points) & keep for k in candidates}
    covered = {k: float(weight[m].sum()) for k, m in on.items()}
    main = max(covered, key=covered.get) if covered and max(covered.values()) > 0 else None
    any_awn = np.zeros(len(points), bool)
    for m in on.values():
        any_awn |= m
    off = keep & ~any_awn
    on_ev = _covered(evidence, points)
    on_main = on[main] if main is not None else np.zeros(len(points), bool)
    jump = keep & any_awn & ~on_main
    false_mm, false_end = _longest_run(weight, off)
    res = {
        "main": main,
        "on_main_mm": float(weight[on_main].sum()),
        "jump_mm": _longest_run(weight, jump)[0],
        "false_mm": false_mm,
        "false_on_evidence_mm": _longest_run(weight, off & on_ev)[0],
        "false_at_tip": false_end == len(points) - 1,
        "jump_total_mm": float(weight[jump].sum()),
        "false_total_mm": float(weight[off].sum()),
        "missing_tip_mm": 0.0,
        "missing_tip_evidence": 0.0,
        "missing_tip_px": [],
    }
    axis = awns[main].axis if main is not None else None
    if axis is not None and on_main.any():
        reach = max(axis.project(Point(p)) for p in points[on_main])
        if axis.length - reach > 0.5:
            tip = substring(axis, reach, axis.length)
            tip_pts = _resample(list(tip.coords))
            res["missing_tip_mm"] = calibration.length_mm(tip_pts)
            res["missing_tip_evidence"] = float(_covered(evidence, tip_pts).mean())
            res["missing_tip_px"] = tip_pts[:: max(1, len(tip_pts) // 50)].tolist()
    if res["jump_mm"] >= EVAL_MM:
        cls, detail = "JUMP", ""
    elif res["false_mm"] >= EVAL_MM:
        cls = "FALSE_LINK"
        detail = "on_evidence" if res["false_on_evidence_mm"] >= res["false_mm"] / 2 else "empty_space"
        detail += "/tip_overshoot" if res["false_at_tip"] else "/mid_path"
    elif res["missing_tip_mm"] >= EVAL_MM:
        cls = "SHORT"
        detail = "evidence_continues" if res["missing_tip_evidence"] >= 0.5 else "no_evidence"
    else:
        cls, detail = "OK", ""
    res["cls"], res["detail"] = cls, detail
    res["samples_px"] = points[:: max(1, len(points) // 200)].tolist()
    return res


@dataclass
class PageDiagnosis:
    paths: list[PathDiagnosis]
    truth: list[dict]  # per attached truth awn: matched, duplicates, evidence coverage
    representatives: list[dict]  # per matched truth spikelet with awns
    detached_truth_awns: int


def diagnose_page(result, truth: list[TruthInstance], evidence, calibration: Calibration) -> PageDiagnosis:
    """``evidence``: union of the awn observations the pipeline was given."""
    awns, spikelets = truth_awns(truth, calibration)
    spikelet_union = shapely.union_all(spikelets).buffer(AWN_TOL_PX) if spikelets else None
    tree = shapely.STRtree([a.mask for a in awns]) if awns else None
    paths = []
    for si, s in enumerate(result.spikelets):
        for ai, a in enumerate(s.awns):
            if len(a.path_px) < 2 or LineString(a.path_px).length == 0:
                continue
            r = classify_path(a.path_px, awns, spikelet_union, evidence, calibration, tree)
            paths.append(PathDiagnosis(si, ai, length_mm=a.length_mm, **r))

    followers: dict[int, int] = {}
    for p in paths:
        if p.main is not None:
            followers[p.main] = followers.get(p.main, 0) + 1
    rows = []
    for a in awns:
        if a.spikelet is None or a.axis is None:
            continue
        pts = _resample(list(a.axis.coords))
        rows.append({
            "awn": a.index, "spikelet": a.spikelet, "length_mm": a.length_mm,
            "matched": a.index in followers, "duplicates": max(0, followers.get(a.index, 0) - 1),
            "evidence_cover": float(_covered(evidence, pts).mean()),
            "axis_px": pts[:: max(1, len(pts) // 50)].tolist(),
        })

    reps = []
    pairs, _, _ = match_to_truth([s.geometry for s in result.spikelets], spikelets)
    for p, t, _ in pairs:
        lengths = [a.length_mm for a in awns if a.spikelet == t and a.axis is not None]
        if lengths:
            reps.append({"truth_spikelet": t, "pred_spikelet": p, "truth_mm": max(lengths),
                         "pred_mm": result.spikelets[p].length_mm})
    detached = sum(1 for a in awns if a.spikelet is None)
    return PageDiagnosis(paths, rows, reps, detached)


def page_counts(d: PageDiagnosis) -> dict:
    c = {k: 0 for k in CLASSES}
    for p in d.paths:
        c[p.cls] += 1
        key = f"{p.cls}:{p.detail}" if p.detail else None
        if key:
            c[key] = c.get(key, 0) + 1
    c["paths"] = len(d.paths)
    c["truth_awns"] = len(d.truth)
    c["MISSED"] = sum(not r["matched"] for r in d.truth)
    c["MISSED:evidence_ge50"] = sum(not r["matched"] and r["evidence_cover"] >= 0.5 for r in d.truth)
    c["duplicates"] = sum(r["duplicates"] for r in d.truth)
    c["errors"] = c["SHORT"] + c["JUMP"] + c["FALSE_LINK"] + c["MISSED"]
    return c


def representative_stats(rows: list[dict]) -> dict:
    measured = [r for r in rows if r["pred_mm"] is not None]
    err = np.asarray([r["pred_mm"] - r["truth_mm"] for r in measured])
    if not len(err):
        return {"n_truth": len(rows), "n_measured": 0}
    return {
        "n_truth": len(rows), "n_measured": len(measured),
        "mae_mm": float(np.abs(err).mean()), "median_ae_mm": float(np.median(np.abs(err))),
        "bias_mm": float(err.mean()), "within_2mm": float((np.abs(err) <= 2).mean()),
    }
