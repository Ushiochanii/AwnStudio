"""Joint re-pairing of awns that pass through the same crossing.

Tracing and assembly choose each awn's continuation at a junction on its own. Where two
awns cross at a small angle, the overlap skeletonizes into a node or a tiny cluster of
nodes joined by edges no longer than the local awn diameter (the medial-axis
significance criterion also used for spur pruning). Inside such a cluster edge
directions are meaningless, and an awn often "bounces back" onto the arm on its own
side instead of passing straight through.

Here the crossing is treated as one unit. For every two selected awns that enter a
cluster by different arms and leave it by different arms, both pairings of the arms are
scored with the fitted junction utility of the continuation choice model (deflection,
shared support, width ratio, all measured on the arms outside the cluster), and the
tails are exchanged when the other pairing has the higher joint utility.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from .awngraph import AwnGraph
from .events import _jaccard, arrive_dir, depart_dir
from .geometry import angle_between
from .linking import FEATURES
from .tracer import Trace


def core_clusters(graph: AwnGraph) -> dict[int, int]:
    """Node -> cluster id; junctions joined by sub-diameter edges share a cluster."""
    parent = {n: n for n in graph.nodes}

    def find(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    def radius(n):
        x, y = np.round(graph.nodes[n]).astype(int)
        return float(graph.distance[y, x]) if graph.distance is not None else 0.0

    for e in graph.edges.values():
        if graph.degree(e.u) >= 3 and graph.degree(e.v) >= 3 and \
                e.length_px <= 2.0 * max(radius(e.u), radius(e.v)) + 1.0:
            parent[find(e.u)] = find(e.v)
    return {n: find(n) for n in graph.nodes}


def _passes(graph, cluster, trace: Trace):
    """(cluster, i_in, i_out): edges[i_in] arrives at the cluster, edges[i_out] leaves it."""
    out = []
    edges = trace.edges
    i = 0
    while i < len(edges) - 1:
        e, start = edges[i]
        node = graph.other(e, start)
        c = cluster[node]
        if graph.degree(node) < 3 or cluster[start] == c:  # not a junction, or an internal edge
            i += 1
            continue
        j = i + 1
        while j < len(edges) and edges[j][1] == graph.other(edges[j - 1][0], edges[j - 1][1]) and \
                cluster[edges[j][1]] == c and cluster[graph.other(*edges[j])] == c:
            j += 1  # internal edge of the cluster
        if j < len(edges) and cluster[edges[j][1]] == c and edges[j][1] == graph.other(edges[j - 1][0], edges[j - 1][1]):
            out.append((c, i, j))
        i = j
    return out


def _connector(graph, cluster, a: int, b: int) -> list[tuple[int, int]] | None:
    """Shortest edge path from node a to node b inside one cluster."""
    if a == b:
        return []
    prev = {a: None}
    queue = deque([a])
    while queue:
        n = queue.popleft()
        for e in graph.incident[n]:
            m = graph.other(e, n)
            if cluster[m] != cluster[a] or m in prev:
                continue
            prev[m] = (e, n)
            if m == b:
                path = []
                while prev[m] is not None:
                    e, n = prev[m]
                    path.append((e, n))
                    m = n
                return path[::-1]
            queue.append(m)
    return None


def _utility(graph, cal, choice, a: int, node_a: int, b: int, node_b: int) -> float:
    da, db = arrive_dir(graph, a, node_a, cal), depart_dir(graph, b, node_b, cal)
    ea, eb = graph.edges[a], graph.edges[b]
    record = {
        "deflection_deg": 180.0 if da is None or db is None else angle_between(da, db),
        "shared_support": _jaccard(ea.support, eb.support),
        "width_ratio": min(ea.half_width_px, eb.half_width_px) / max(1e-9, ea.half_width_px, eb.half_width_px),
    }
    return float(np.dot(choice.junction, [1.0, *FEATURES["junction"][1](record)]))


def _length(trace_edges, tracer) -> float:
    total = 0.0
    g = tracer.g
    for k, (e, start) in enumerate(trace_edges):
        total += tracer.edge_len[e]
        if k and start != g.other(*trace_edges[k - 1]):  # gap jump
            gap = g.nodes[start] - g.nodes[g.other(*trace_edges[k - 1])]
            total += float(np.linalg.norm(tracer.cal.to_mm(gap[None])))
    return total


def repair(tracer, traces: list[Trace]) -> list[Trace]:
    """Return traces with tails exchanged at crossings where the other pairing scores higher."""
    g, cal, choice = tracer.g, tracer.cal, tracer.models["choice"]
    cluster = core_clusters(g)
    traces = list(traces)
    for _ in range(4 * len(traces)):  # each exchange strictly raises total utility
        changed = False
        passes = {k: _passes(g, cluster, t) for k, t in enumerate(traces)}
        for k1 in range(len(traces)):
            for k2 in range(k1 + 1, len(traces)):
                for c1, i1, j1 in passes[k1]:
                    for c2, i2, j2 in passes[k2]:
                        if c1 != c2:
                            continue
                        t1, t2 = traces[k1].edges, traces[k2].edges
                        a1, a2, b1, b2 = t1[i1][0], t2[i2][0], t1[j1][0], t2[j2][0]
                        if a1 == a2 or b1 == b2:
                            continue
                        na1, na2 = g.other(*t1[i1]), g.other(*t2[i2])
                        nb1, nb2 = t1[j1][1], t2[j2][1]
                        if {e for e, _ in t1[:i1 + 1]} & {e for e, _ in t2[j2:]} or \
                                {e for e, _ in t2[:i2 + 1]} & {e for e, _ in t1[j1:]}:
                            continue  # the exchanged traces would revisit an edge
                        now = _utility(g, cal, choice, a1, na1, b1, nb1) + _utility(g, cal, choice, a2, na2, b2, nb2)
                        alt = _utility(g, cal, choice, a1, na1, b2, nb2) + _utility(g, cal, choice, a2, na2, b1, nb1)
                        if alt <= now:
                            continue
                        c12, c21 = _connector(g, cluster, na1, nb2), _connector(g, cluster, na2, nb1)
                        if c12 is None or c21 is None:
                            continue
                        new1 = t1[:i1 + 1] + c12 + t2[j2:]
                        new2 = t2[:i2 + 1] + c21 + t1[j1:]
                        traces[k1] = Trace(new1, traces[k1].prob, _length(new1, tracer), traces[k1].jumps)
                        traces[k2] = Trace(new2, traces[k2].prob, _length(new2, tracer), traces[k2].jumps)
                        changed = True
                        break
                    if changed:
                        break
                if changed:
                    break
            if changed:
                break
        if not changed:
            break
    return traces
