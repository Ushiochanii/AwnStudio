"""Supervision for tracing decisions, derived automatically from reviewed polygons.

The reviewed annotation draws every awn as one whole polygon, including the parts the
segmentation model missed. Hence:

* an evidence-graph edge belongs to truth awn k when most of it lies inside polygon k;
* a junction continuation a->b is correct when a and b belong to the same truth awn;
* a gap i->j is correct when a and b belong to the same truth awn (the polygon spans
  the missing piece);
* a root (spikelet s, branch e) is correct when e belongs to a truth awn whose base
  attaches to the truth spikelet matched to s.

No manual labelling beyond the existing polygons is required.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry import MultiPoint
from shapely.strtree import STRtree

from .awngraph import AwnGraph
from .spikelets import match_to_truth
from .truth import TruthInstance

EDGE_MEMBERSHIP = 0.6  # fraction of edge samples inside a truth awn polygon
POLYGON_TOLERANCE_PX = 3.0  # hand-drawn outline tolerance


MONOTONE_MIN_MM = 0.5  # minimal progress along the truth axis that counts as moving


@dataclass
class TruthAssignment:
    edge_awn: dict[int, int | None]  # edge -> truth awn index (None: not on any truth awn)
    awn_spikelet: dict[int, int | None]  # truth awn -> truth spikelet index
    pred_to_truth_spikelet: dict[int, int]  # predicted spikelet index -> truth spikelet index
    axes: list  # truth awn index -> LineString medial axis (page px) or None
    mm_per_px: float = 1.0

    def arc(self, awn: int, point) -> float | None:
        axis = self.axes[awn]
        if axis is None:
            return None
        from shapely.geometry import Point

        return float(axis.project(Point(float(point[0]), float(point[1])))) * self.mm_per_px


def polygon_axis(polygon):
    """Medial axis of a truth polygon: longest path of its skeleton (page px)."""
    import cv2
    import networkx as nx
    from shapely.geometry import LineString
    from skimage.morphology import skeletonize

    if polygon.is_empty:
        return None
    poly = max(getattr(polygon, "geoms", [polygon]), key=lambda g: g.area)
    x0, y0, x1, y1 = (int(v) for v in poly.bounds)
    w, h = x1 - x0 + 3, y1 - y0 + 3
    mask = np.zeros((h, w), np.uint8)
    ring = np.round(np.asarray(poly.exterior.coords) - (x0 - 1, y0 - 1)).astype(np.int32)
    cv2.fillPoly(mask, [ring], 1)
    skel = skeletonize(mask.astype(bool))
    ys, xs = np.nonzero(skel)
    if len(xs) < 2:
        return None
    g = nx.Graph()
    on = set(zip(ys.tolist(), xs.tolist()))
    for y, x in on:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if (dy or dx) and (y + dy, x + dx) in on:
                    g.add_edge((y, x), (y + dy, x + dx), weight=float(np.hypot(dy, dx)))
    if g.number_of_nodes() < 2:
        return None
    # Longest shortest-path: two BFS sweeps (exact on trees, good on near-trees).
    comp = max(nx.connected_components(g), key=len)
    sub = g.subgraph(comp)
    start = next(iter(comp))
    d1 = nx.single_source_dijkstra_path_length(sub, start)
    a = max(d1, key=d1.get)
    d2, paths = nx.single_source_dijkstra(sub, a)
    b = max(d2, key=d2.get)
    coords = [(x + x0 - 1, y + y0 - 1) for y, x in paths[b]]
    return LineString(coords) if len(coords) >= 2 else None


def assign_truth(
    graph: AwnGraph, spikelet_geoms: list, truth: list[TruthInstance], mm_per_px: float = 1.0
) -> TruthAssignment:
    awns = [t.geometry.buffer(POLYGON_TOLERANCE_PX) for t in truth if t.kind == "awn"]
    spk = [t.geometry for t in truth if t.kind == "spikelet"]
    tree = STRtree(awns)

    edge_awn: dict[int, int | None] = {}
    for eid, e in graph.edges.items():
        k = min(len(e.path), 25)
        samples = MultiPoint(e.path[np.linspace(0, len(e.path) - 1, k).round().astype(int)])
        best, best_frac = None, 0.0
        for a in tree.query(samples):
            frac = sum(awns[a].covers(p) for p in samples.geoms) / k
            if frac > best_frac:
                best, best_frac = int(a), frac
        edge_awn[eid] = best if best_frac >= EDGE_MEMBERSHIP else None

    # Truth awn -> truth spikelet: the spikelet closest to the awn's nearer end region.
    spk_tree = STRtree(spk)
    awn_spikelet: dict[int, int | None] = {}
    for a, poly in enumerate(awns):
        near = spk_tree.query(poly.buffer(30.0))
        if len(near) == 0:
            awn_spikelet[a] = None
            continue
        awn_spikelet[a] = int(min(near, key=lambda s: poly.distance(spk[s]) - 1e-6 * poly.intersection(spk[s]).area))

    # Medial axis of each truth awn, oriented from its base (spikelet side) to its tip.
    from shapely.geometry import LineString, Point

    axes = []
    for a, t in enumerate([t for t in truth if t.kind == "awn"]):
        axis = polygon_axis(t.geometry)
        s = awn_spikelet[a]
        if axis is not None and s is not None:
            head, tail = Point(axis.coords[0]), Point(axis.coords[-1])
            if spk[s].distance(tail) < spk[s].distance(head):
                axis = LineString(list(axis.coords)[::-1])
        axes.append(axis)

    pairs, _, _ = match_to_truth(spikelet_geoms, spk)
    return TruthAssignment(edge_awn, awn_spikelet, {p: t for p, t, _ in pairs}, axes, mm_per_px)


def same_awn(ta: TruthAssignment, a: int, b: int) -> bool:
    return ta.edge_awn.get(a) is not None and ta.edge_awn.get(a) == ta.edge_awn.get(b)


def continues(ta: TruthAssignment, a: int, b: int, p0, p1, p2, p3) -> bool:
    """Travel p0 -(edge a)-> p1 ~> p2 -(edge b)-> p3 follows one truth awn monotonically."""
    if not same_awn(ta, a, b):
        return False
    awn = ta.edge_awn[a]
    s = [ta.arc(awn, p) for p in (p0, p1, p2, p3)]
    if any(v is None for v in s):
        return False
    sign = 1.0 if s[3] >= s[0] else -1.0
    s = [sign * v for v in s]
    return s[1] - s[0] >= MONOTONE_MIN_MM and s[3] - s[2] >= MONOTONE_MIN_MM and s[2] - s[1] >= -MONOTONE_MIN_MM


def branches(ta: TruthAssignment, a: int, b: int, p0, p1, p3) -> bool:
    """At node p1, reached along edge a (from p0), a second awn of the same spikelet
    leaves along edge b (towards p3): a and b lie on different truth awns of one
    spikelet and both progress away from the spikelet base."""
    wa, wb = ta.edge_awn.get(a), ta.edge_awn.get(b)
    if wa is None or wb is None or wa == wb:
        return False
    sa, sb = ta.awn_spikelet.get(wa), ta.awn_spikelet.get(wb)
    if sa is None or sa != sb:
        return False
    s0, s1 = ta.arc(wa, p0), ta.arc(wa, p1)
    t1, t3 = ta.arc(wb, p1), ta.arc(wb, p3)
    if None in (s0, s1, t1, t3):
        return False
    return s1 - s0 >= MONOTONE_MIN_MM and t3 - t1 >= MONOTONE_MIN_MM


def root_correct(ta: TruthAssignment, spikelet: int, edge: int, p_node, p_far) -> bool:
    """Branch `edge` leaves spikelet's base region along one of that spikelet's truth awns."""
    awn = ta.edge_awn.get(edge)
    truth_spk = ta.pred_to_truth_spikelet.get(spikelet)
    if awn is None or truth_spk is None or ta.awn_spikelet.get(awn) != truth_spk:
        return False
    s0, s1 = ta.arc(awn, p_node), ta.arc(awn, p_far)
    return s0 is not None and s1 is not None and s1 - s0 >= MONOTONE_MIN_MM
