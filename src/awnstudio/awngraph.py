"""Awn evidence graph.

All primary awn masks of a page are rasterized into one evidence map, so duplicate
views of the same awn from overlapping tiles coincide instead of having to be
de-duplicated. Its medial axis (skeleton) is turned into a graph:

* nodes - skeleton end points and junctions (8-connected junction pixels are merged);
* edges - skeleton chains between nodes, with their pixel path, length, mean local
          half-width (distance transform) and the set of mask observations that
          cover them.

Awns are then paths through this graph. A junction is where awns cross or touch, an
end point is either a true tip or a place where segmentation broke the awn (a gap).
Instance masks are not discarded: an edge records which observations cover it, so
"the same predicted instance covers both sides of a junction" is available as
evidence for continuity.

Spur pruning uses the medial-axis significance criterion: a terminal branch shorter
than the local half-width at its junction is a boundary artifact, not a structure.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize

from .detection import Observation

_NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Edge:
    id: int
    u: int  # node ids at path[0] / path[-1]
    v: int
    path: np.ndarray  # (n, 2) float x, y page pixels
    half_width_px: float
    support: frozenset[int]  # observation indices covering the edge
    confidence: float  # max confidence of covering observations

    @property
    def length_px(self) -> float:
        return float(np.linalg.norm(np.diff(self.path, axis=0), axis=1).sum()) if len(self.path) > 1 else 0.0


@dataclass
class AwnGraph:
    nodes: dict[int, np.ndarray]  # node id -> (x, y)
    edges: dict[int, Edge]
    incident: dict[int, list[int]] = field(default_factory=dict)  # node -> edge ids
    evidence: np.ndarray | None = None  # uint8 union mask
    distance: np.ndarray | None = None  # distance transform of the mask

    def degree(self, node: int) -> int:
        return len(self.incident.get(node, ()))

    def other(self, edge: int, node: int) -> int:
        e = self.edges[edge]
        return e.v if e.u == node else e.u

    def oriented_path(self, edge: int, start: int) -> np.ndarray:
        e = self.edges[edge]
        return e.path if e.u == start else e.path[::-1]


def rasterize(observations: list[Observation], indices: list[int], shape) -> tuple[np.ndarray, np.ndarray]:
    """Union mask and, per pixel, the index of the covering observation with the highest confidence."""
    mask = np.zeros(shape, np.uint8)
    owner = np.full(shape, -1, np.int32)
    best = np.zeros(shape, np.float32)
    for i in sorted(indices, key=lambda k: observations[k].confidence):
        o = observations[i]
        single = np.zeros(shape, np.uint8)
        geoms = getattr(o.geometry, "geoms", [o.geometry])
        for g in geoms:
            ring = np.round(np.asarray(g.exterior.coords)).astype(np.int32)
            cv2.fillPoly(single, [ring], 1)
            for hole in g.interiors:
                cv2.fillPoly(single, [np.round(np.asarray(hole.coords)).astype(np.int32)], 0)
        hit = single.astype(bool)
        mask |= single
        owner[hit] = i
        best[hit] = o.confidence
    return mask, owner


def build_graph(observations: list[Observation], width: int, height: int) -> AwnGraph:
    awn_idx = [i for i, o in enumerate(observations) if o.kind == "awn"]
    mask, _ = rasterize(observations, awn_idx, (height, width))
    distance = ndimage.distance_transform_edt(mask)
    skel = skeletonize(mask.astype(bool))

    graph = _trace(skel, distance)
    graph.evidence, graph.distance = mask, distance
    _prune_spurs(graph)
    _attach_support(graph, observations, awn_idx)
    return graph


def _trace(skel: np.ndarray, distance: np.ndarray) -> AwnGraph:
    ys, xs = np.nonzero(skel)
    on = set(zip(ys.tolist(), xs.tolist()))
    kernel = np.ones((3, 3), np.uint8)
    neighbours = ndimage.convolve(skel.astype(np.uint8), kernel, mode="constant") - skel
    is_node = skel & (neighbours != 2)

    # Merge adjacent node pixels (junction clusters) into one node.
    labels, count = ndimage.label(is_node, structure=np.ones((3, 3)))
    node_of_pixel: dict[tuple[int, int], int] = {}
    nodes: dict[int, np.ndarray] = {}
    for lab, (sl_y, sl_x) in enumerate(ndimage.find_objects(labels), start=1):
        py, px = np.nonzero(labels[sl_y, sl_x] == lab)
        py, px = py + sl_y.start, px + sl_x.start
        nodes[lab] = np.asarray([px.mean(), py.mean()], float)
        for y, x in zip(py.tolist(), px.tolist()):
            node_of_pixel[(y, x)] = lab

    edges: dict[int, Edge] = {}
    visited: set[tuple[tuple[int, int], tuple[int, int]]] = set()

    def step_neighbours(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in _NEIGHBOURS if (y + dy, x + dx) in on]

    def add_edge(u, v, pixels):
        path = np.asarray([(x, y) for y, x in pixels], float)
        hw = float(np.mean([distance[y, x] for y, x in pixels]))
        eid = len(edges)
        edges[eid] = Edge(eid, u, v, path, hw, frozenset(), 0.0)

    for start, u in node_of_pixel.items():
        for nxt in step_neighbours(start):
            if nxt in node_of_pixel or (start, nxt) in visited:
                if nxt in node_of_pixel and node_of_pixel[nxt] != u and (start, nxt) not in visited:
                    # Two distinct nodes directly adjacent: a 2-pixel edge.
                    visited.add((start, nxt)); visited.add((nxt, start))
                    add_edge(u, node_of_pixel[nxt], [start, nxt])
                continue
            pixels = [start, nxt]
            visited.add((start, nxt))
            prev, cur = start, nxt
            while cur not in node_of_pixel:
                options = [q for q in step_neighbours(cur) if q != prev and q not in pixels[-3:]]
                if not options:
                    break
                # Prefer 4-connected continuation to avoid diagonal shortcuts.
                options.sort(key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
                prev, cur = cur, options[0]
                pixels.append(cur)
            if cur in node_of_pixel:
                visited.add((cur, prev))
                v = node_of_pixel[cur]
                add_edge(u, v, pixels)
            # chains that dead-end without a node cannot happen: an end pixel is a node.

    # Isolated cycles (no node at all) are ignored: they are not awn-shaped.
    incident: dict[int, list[int]] = {n: [] for n in nodes}
    for e in edges.values():
        incident[e.u].append(e.id)
        if e.v != e.u:
            incident[e.v].append(e.id)
    return AwnGraph(nodes, edges, incident)


def _remove_edge(graph: AwnGraph, eid: int) -> None:
    e = graph.edges.pop(eid)
    for n in {e.u, e.v}:
        graph.incident[n].remove(eid)


def _merge_degree_two(graph: AwnGraph, node: int) -> None:
    a, b = graph.incident[node]
    if a == b:
        return
    pa = graph.oriented_path(a, graph.other(a, node))  # ends at node
    pb = graph.oriented_path(b, node)  # starts at node
    ea, eb = graph.edges[a], graph.edges[b]
    u, v = graph.other(a, node), graph.other(b, node)
    path = np.vstack([pa, pb[1:]])
    la, lb = ea.length_px, eb.length_px
    hw = (ea.half_width_px * la + eb.half_width_px * lb) / max(1e-9, la + lb)
    _remove_edge(graph, a)
    _remove_edge(graph, b)
    eid = max(graph.edges, default=-1) + 1
    graph.edges[eid] = Edge(eid, u, v, path, hw, frozenset(), 0.0)
    graph.incident[u].append(eid)
    if v != u:
        graph.incident[v].append(eid)
    graph.nodes.pop(node)
    graph.incident.pop(node)


def _prune_spurs(graph: AwnGraph) -> None:
    changed = True
    while changed:
        changed = False
        for eid in list(graph.edges):
            if eid not in graph.edges:
                continue
            e = graph.edges[eid]
            du, dv = graph.degree(e.u), graph.degree(e.v)
            if (du == 1) == (dv == 1):  # not a terminal branch (or an isolated segment)
                continue
            junction = e.v if du == 1 else e.u
            jx, jy = np.round(graph.nodes[junction]).astype(int)
            radius = float(graph.distance[jy, jx])
            if e.length_px <= radius + 1.0:
                tip = e.u if du == 1 else e.v
                _remove_edge(graph, eid)
                graph.nodes.pop(tip)
                graph.incident.pop(tip)
                if graph.degree(junction) == 2:
                    _merge_degree_two(graph, junction)
                changed = True
    for node in [n for n in graph.nodes if graph.degree(n) == 0]:
        graph.nodes.pop(node)
        graph.incident.pop(node)


def _attach_support(graph: AwnGraph, observations: list[Observation], awn_idx: list[int]) -> None:
    from shapely.geometry import Point
    from shapely.strtree import STRtree

    geoms = [observations[i].geometry.buffer(1.0) for i in awn_idx]
    tree = STRtree(geoms)
    for e in graph.edges.values():
        # Sample a few points along the edge; an observation supports the edge if it
        # covers at least half of the samples.
        k = min(len(e.path), 9)
        samples = e.path[np.linspace(0, len(e.path) - 1, k).round().astype(int)]
        counts: dict[int, int] = {}
        for x, y in samples:
            p = Point(float(x), float(y))
            for j in tree.query(p, predicate="intersects"):
                counts[int(j)] = counts.get(int(j), 0) + 1
        support = frozenset(awn_idx[j] for j, c in counts.items() if c * 2 >= k)
        e.support = support
        e.confidence = max((observations[i].confidence for i in support), default=0.0)
