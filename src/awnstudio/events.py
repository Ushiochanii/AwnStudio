"""Decision points of awn tracing and their geometric features.

Tracing an awn through the evidence graph needs three kinds of decisions:

* root      - which graph branch leaves spikelet s as one of its awns;
* junction  - arriving at a junction along edge a, does the same awn continue along b?
* gap       - arriving at an end point i, does the awn resume at end point j
              (segmentation broke it), or is i the true tip?

Each candidate decision is described by a handful of geometric quantities in
millimetres / degrees. They are the inputs of the probability models in
`awnstudio.linking`; nothing here is a threshold except the candidate search radius.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry import Point
from shapely.strtree import STRtree

from .awngraph import AwnGraph
from .calibration import Calibration
from .geometry import angle_between, end_direction

GAP_SEARCH_MM = 8.0  # candidate radius for re-joining broken awns
ROOT_SEARCH_MM = 3.0  # candidate radius between a spikelet and an awn branch end


@dataclass(frozen=True)
class Junction:
    node: int
    a: int  # arriving edge
    b: int  # leaving edge
    deflection_deg: float  # 0 = straight through
    shared_support: float  # Jaccard overlap of the covering observations of a and b
    width_ratio: float  # min/max half-width of a and b
    degree: int


@dataclass(frozen=True)
class Gap:
    i: int  # end node (arrival)
    j: int  # end node (resumption)
    a: int  # edge ending at i
    b: int  # edge starting at j
    distance_mm: float
    turn_in_deg: float  # arrival direction vs. chord
    turn_out_deg: float  # chord vs. departure direction
    shared_support: float


@dataclass(frozen=True)
class Root:
    spikelet: int  # index into the spikelet list
    node: int  # the branch end next to the spikelet
    edge: int  # branch leaving that node
    distance_mm: float  # node to spikelet polygon (0 if inside)
    axis_deg: float  # branch direction vs. spikelet long axis pointing away from centroid
    inside: bool


def path_mm(graph: AwnGraph, edge: int, start: int, cal: Calibration) -> np.ndarray:
    return cal.to_mm(graph.oriented_path(edge, start))


def arrive_dir(graph, edge, node, cal):
    """Travel direction when arriving at `node` along `edge`."""
    return end_direction(path_mm(graph, edge, graph.other(edge, node), cal))


def depart_dir(graph, edge, node, cal):
    """Travel direction when leaving `node` along `edge`."""
    d = arrive_dir(graph, edge, node, cal)
    return None if d is None else -d


def _jaccard(a: frozenset, b: frozenset) -> float:
    return len(a & b) / len(a | b) if (a or b) else 0.0


def junctions(graph: AwnGraph, cal: Calibration) -> list[Junction]:
    out = []
    for node, inc in graph.incident.items():
        if len(inc) < 3:
            continue
        for a in inc:
            da = arrive_dir(graph, a, node, cal)
            for b in inc:
                if a == b:
                    continue
                db = depart_dir(graph, b, node, cal)
                ea, eb = graph.edges[a], graph.edges[b]
                out.append(Junction(
                    node, a, b,
                    180.0 if da is None or db is None else angle_between(da, db),
                    _jaccard(ea.support, eb.support),
                    min(ea.half_width_px, eb.half_width_px) / max(1e-9, ea.half_width_px, eb.half_width_px),
                    len(inc),
                ))
    return out


def gaps(graph: AwnGraph, cal: Calibration) -> list[Gap]:
    ends = [n for n in graph.nodes if graph.degree(n) == 1]
    if len(ends) < 2:
        return []
    pos = np.asarray([cal.to_mm(graph.nodes[n][None])[0] for n in ends])
    out = []
    for p, i in enumerate(ends):
        d = np.linalg.norm(pos - pos[p], axis=1)
        a = graph.incident[i][0]
        da = arrive_dir(graph, a, i, cal)
        for q in np.nonzero((d > 0) & (d <= GAP_SEARCH_MM))[0]:
            j = ends[q]
            b = graph.incident[j][0]
            if a == b:
                continue
            db = depart_dir(graph, b, j, cal)
            chord = pos[q] - pos[p]
            out.append(Gap(
                i, j, a, b, float(d[q]),
                180.0 if da is None else angle_between(da, chord),
                180.0 if db is None else angle_between(chord, db),
                _jaccard(graph.edges[a].support, graph.edges[b].support),
            ))
    return out


def _axis_away(geometry, point_mm, cal) -> np.ndarray:
    """Unit long axis of a spikelet (mm space), signed to point from centroid toward point."""
    from shapely import affinity

    sx, sy = cal.mm_per_px
    g = affinity.scale(geometry, xfact=sx, yfact=sy, origin=(0, 0))
    pts = np.asarray(g.exterior.coords if g.geom_type == "Polygon" else g.convex_hull.exterior.coords)
    centred = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    axis = vt[0]
    if np.dot(axis, point_mm - np.asarray(g.centroid.coords[0])) < 0:
        axis = -axis
    return axis


def roots(graph: AwnGraph, spikelet_geoms: list, cal: Calibration) -> list[Root]:
    """Branch ends (end points or junctions) close to each spikelet, with the branch leaving them."""
    sx, sy = cal.mm_per_px
    radius_px = ROOT_SEARCH_MM / min(sx, sy)
    node_ids = list(graph.nodes)
    pts = [Point(*graph.nodes[n]) for n in node_ids]
    tree = STRtree(pts)
    out = []
    for s, geom in enumerate(spikelet_geoms):
        for k in tree.query(geom.buffer(radius_px)):
            node = node_ids[int(k)]
            p = pts[int(k)]
            inside = geom.contains(p)
            # anisotropic point-polygon distance in mm (approximate with mean scale)
            dist = 0.0 if inside else float(geom.distance(p)) * (sx + sy) / 2.0
            if dist > ROOT_SEARCH_MM:
                continue
            p_mm = cal.to_mm(np.asarray([[p.x, p.y]]))[0]
            axis = _axis_away(geom, p_mm, cal)
            for e in graph.incident[node]:
                d = depart_dir(graph, e, node, cal)
                out.append(Root(s, node, e, dist, 180.0 if d is None else angle_between(axis, d), inside))
    return out
