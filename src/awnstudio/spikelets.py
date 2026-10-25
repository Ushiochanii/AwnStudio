"""Spikelet instances from overlapping tile observations.

A spikelet is compact and much smaller than a tile, so every spikelet is seen whole
by at least one tile, and partially by tiles whose border cuts it. Observations of
the same object overlap strongly relative to the smaller one; distinct spikelets
barely touch. Observations are therefore grouped by connected components of the
relation  |A ∩ B| / min(|A|, |B|) >= SAME_OBJECT_OVERLAP , and each group is
represented by its largest member that is not cut by its tile border (falling back
to the largest member).

Groups smaller than the smallest reviewed spikelet of the training pages (in mm^2)
are dropped: they are stray mask islands, mostly secondary components of one
prediction. (Touching the page border is not a rejection criterion: bottom-row
spikelets are routinely cut by the lower page edge while their awns are complete.)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from .detection import Observation

SAME_OBJECT_OVERLAP = 0.5
TILE_EDGE_PX = 2.0
# Smallest reviewed spikelet over the 91 training pages (3809 instances): 5.76 mm^2.
MIN_AREA_MM2 = 5.76


@dataclass
class Spikelet:
    id: str
    geometry: BaseGeometry
    confidence: float  # max member confidence
    members: list[int] = field(default_factory=list)  # indices into the observation list
    flags: list[str] = field(default_factory=list)


def _cut_by_tile(o: Observation, width: int, height: int) -> bool:
    """True when the mask touches a tile border that is not also the page border."""
    x1, y1, x2, y2 = o.tile
    bx1, by1, bx2, by2 = o.geometry.bounds
    return (
        (x1 > 0 and bx1 - x1 <= TILE_EDGE_PX)
        or (y1 > 0 and by1 - y1 <= TILE_EDGE_PX)
        or (x2 < width and x2 - bx2 <= TILE_EDGE_PX)
        or (y2 < height and y2 - by2 <= TILE_EDGE_PX)
    )


def _components(n: int, edges: list[tuple[int, int]]) -> list[list[int]]:
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in edges:
        parent[find(a)] = find(b)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def fuse_spikelets(
    observations: list[Observation], width: int, height: int, mm2_per_px2: float | None = None
) -> list[Spikelet]:
    index = [i for i, o in enumerate(observations) if o.kind == "spikelet"]
    geoms = [observations[i].geometry for i in index]
    tree = STRtree(geoms)
    edges = []
    for a, ga in enumerate(geoms):
        for b in tree.query(ga):
            if b <= a:
                continue
            inter = ga.intersection(geoms[b]).area
            if inter > 0 and inter / min(ga.area, geoms[b].area) >= SAME_OBJECT_OVERLAP:
                edges.append((a, int(b)))

    spikelets = []
    for group in _components(len(geoms), edges):
        members = [index[k] for k in group]
        whole = [i for i in members if not _cut_by_tile(observations[i], width, height)]
        best = max(whole or members, key=lambda i: observations[i].geometry.area)
        spikelets.append(
            Spikelet(
                id="",
                geometry=observations[best].geometry,
                confidence=max(observations[i].confidence for i in members),
                members=members,
                flags=[] if whole else ["only_tile_cut_views"],
            )
        )
    if mm2_per_px2 is not None:
        spikelets = [s for s in spikelets if s.geometry.area * mm2_per_px2 >= MIN_AREA_MM2]
    spikelets.sort(key=lambda s: (round(s.geometry.centroid.y), s.geometry.centroid.x))
    for k, s in enumerate(spikelets):
        s.id = f"S{k:03d}"
    return spikelets


def match_to_truth(predicted: list[BaseGeometry], truth: list[BaseGeometry], min_iou: float = 0.5):
    """Greedy-optimal one-to-one IoU matching; returns (pairs, unmatched_pred, unmatched_truth)."""
    from scipy.optimize import linear_sum_assignment

    if not predicted or not truth:
        return [], list(range(len(predicted))), list(range(len(truth)))
    iou = np.zeros((len(truth), len(predicted)))
    tree = STRtree(predicted)
    for i, t in enumerate(truth):
        for j in tree.query(t):
            inter = t.intersection(predicted[j]).area
            if inter > 0:
                iou[i, j] = inter / (t.area + predicted[j].area - inter)
    rows, cols = linear_sum_assignment(-iou)
    pairs = [(int(c), int(r), float(iou[r, c])) for r, c in zip(rows, cols) if iou[r, c] >= min_iou]
    mp = {p for p, _, _ in pairs}
    mt = {t for _, t, _ in pairs}
    return pairs, [j for j in range(len(predicted)) if j not in mp], [i for i in range(len(truth)) if i not in mt]
