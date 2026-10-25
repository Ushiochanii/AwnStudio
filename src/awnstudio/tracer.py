"""Probabilistic awn tracing on the evidence graph.

Starting from a root branch of a spikelet, an awn is followed edge by edge. At the end
of the current edge the options are: continue along another edge through a junction,
jump a gap to another end point, or stop (tip). Each option k has a model probability
q_k of being the true continuation. Assuming at most one option is the continuation,
their joint is the categorical distribution

    P(k) = r_k / (1 + sum_l r_l),   P(stop) = 1 / (1 + sum_l r_l),   r_k = q_k / (1 - q_k).

Expanding this tree gives a distribution over complete traces and hence over awn
length. The reported trace is the one at the median of that length distribution:
the Bayes estimate under absolute error, which is how lengths are scored. No
acceptance threshold is involved; 0.5 appears only through the median.

Roots: a branch end next to a spikelet starts an awn of that spikelet when its root
probability exceeds 1/2 (the MAP decision), and each branch end belongs to at most
one spikelet (the most probable). A spikelet's representative is its longest awn,
per the output specification.
"""
from __future__ import annotations

import heapq
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from .awngraph import AwnGraph
from .calibration import Calibration
from .events import gaps, junctions, roots
from .geometry import end_direction
from .linking import LogisticModel

MIN_TRACE_PROB = 1e-3  # traces below this probability are not expanded (negligible mass)
MAX_HOPS = 40


@dataclass
class Trace:
    edges: list[tuple[int, int]]  # (edge, start node) in travel order
    prob: float
    length_mm: float
    jumps: int = 0


def _odds(q: float) -> float:
    q = min(max(q, 1e-6), 1 - 1e-6)
    return q / (1 - q)


class Tracer:
    def __init__(self, graph: AwnGraph, spikelet_geoms: list, cal: Calibration, models: dict[str, LogisticModel]):
        self.g, self.cal, self.models = graph, cal, models
        self.spikelet_geoms = spikelet_geoms
        self.options: dict[tuple[int, int], list[tuple[str, int, int, float]]] = defaultdict(list)
        # options[(edge, arrival node)] -> [(kind, next edge, next start node, q)]
        for j in junctions(graph, cal):
            q = models["junction"].prob(j.__dict__)
            self.options[(j.a, j.node)].append(("junction", j.b, j.node, q))
        for gp in gaps(graph, cal):
            q = models["gap"].prob(gp.__dict__)
            self.options[(gp.a, gp.i)].append(("gap", gp.b, gp.j, q))
        self.edge_len = {e: cal.length_mm(edge.path) for e, edge in graph.edges.items()}

    # ------------------------------------------------------------------ roots
    def root_branches(self) -> dict[int, list[tuple[int, int, float]]]:
        """spikelet -> [(edge, start node, p_root)], each branch end owned by one spikelet."""
        best: dict[tuple[int, int], tuple[float, int]] = {}
        for r in roots(self.g, self.spikelet_geoms, self.cal):
            p = self.models["root"].prob(r.__dict__)
            key = (r.edge, r.node)
            if p >= 0.5 and (key not in best or p > best[key][0]):
                best[key] = (p, r.spikelet)
        out: dict[int, list] = defaultdict(list)
        for (edge, node), (p, s) in best.items():
            out[s].append((edge, node, p))
        return out

    # ------------------------------------------------------------------ traces
    def trace_distribution(self, edge: int, start: int) -> list[Trace]:
        """All traces (with probability) from a root branch, best-first expansion."""
        done: list[Trace] = []
        heap = [(-1.0, 0, Trace([(edge, start)], 1.0, self.edge_len[edge]))]
        counter = 1
        while heap:
            _, _, t = heapq.heappop(heap)
            last_edge, last_start = t.edges[-1]
            arrival = self.g.other(last_edge, last_start)
            used = {e for e, _ in t.edges}
            opts = [o for o in self.options.get((last_edge, arrival), []) if o[1] not in used]
            if len(t.edges) >= MAX_HOPS:
                opts = []
            ratios = [_odds(q) for *_, q in opts]
            z = 1.0 + sum(ratios)
            done.append(Trace(t.edges, t.prob / z, t.length_mm, t.jumps))
            for (kind, nxt, nstart, _), r in zip(opts, ratios):
                p = t.prob * r / z
                if p < MIN_TRACE_PROB:
                    continue
                extra = self.edge_len[nxt]
                if kind == "gap":
                    extra += float(np.linalg.norm(self.cal.to_mm(self.g.nodes[nstart][None] - self.g.nodes[arrival][None])))
                heapq.heappush(heap, (-p, counter, Trace(t.edges + [(nxt, nstart)], p, t.length_mm + extra,
                                                          t.jumps + (kind == "gap"))))
                counter += 1
        return done

    @staticmethod
    def median_trace(traces: list[Trace]) -> Trace:
        ordered = sorted(traces, key=lambda t: t.length_mm)
        total = sum(t.prob for t in ordered)
        acc = 0.0
        for t in ordered:
            acc += t.prob
            if acc >= 0.5 * total:
                return t
        return ordered[-1]

    def trace_path(self, trace: Trace) -> np.ndarray:
        """Page-pixel polyline of a trace (gaps bridged by straight segments)."""
        parts = []
        for edge, start in trace.edges:
            p = self.g.oriented_path(edge, start)
            parts.append(p if not parts else p[1:] if np.allclose(parts[-1][-1], p[0]) else p)
        path = np.vstack(parts)
        # The medial axis ends one half-width short of the mask tip: extend the tip.
        last_edge, _ = trace.edges[-1]
        hw = self.g.edges[last_edge].half_width_px
        d = end_direction(path)
        if d is not None and hw > 0:
            path = np.vstack([path, path[-1] + d * hw])
        return path
