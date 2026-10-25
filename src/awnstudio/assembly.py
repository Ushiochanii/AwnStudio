"""Page-level awn assembly as one integer program.

Every evidence edge is either part of an awn or clutter, and every awn starts at a
spikelet root. Tracing alone decides each awn in isolation; assembly decides all of
them jointly so that

* evidence is explained: leaving an edge unexplained costs its log-odds of being awn
  (edge model), which pulls traces through sharp but real bends;
* evidence is not double-counted: an edge carries at most one awn, except the short
  core of a crossing where two awns overlap (capacity 2).

Variables: x[r,t] = root branch r is an awn and follows candidate trace t;
           y[e]   = edge e is explained.
Maximize  sum x[r,t] (logit p_root(r) + log P(t | r)) + sum y[e] logit p_awn(e)
s.t.      sum_t x[r,t] <= 1                         (one trace per root branch)
          sum_{(r,t) uses e} x[r,t] <= capacity(e)
          y[e] <= sum_{(r,t) uses e} x[r,t]
This is the MAP configuration of the root, continuation and evidence models taken as
independent factors. Candidate traces per root come from the tracer's expansion.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix

from .events import roots
from .tracer import Trace, Tracer

MAX_TRACES_PER_ROOT = 40
MIN_ROOT_PROB = 0.05
CROSSING_CORE_MM = 1.0  # junction-to-junction edges this short are crossing cores


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


@dataclass
class Selected:
    spikelet: int
    trace: Trace
    p_root: float


def assemble(tracer: Tracer) -> list[Selected]:
    g, models = tracer.g, tracer.models

    # Root candidates: each branch end next to a spikelet, per spikelet.
    candidates = []  # (spikelet, edge, node, p_root)
    for r in roots(g, tracer.spikelet_geoms, tracer.cal):
        p = models["root"].prob(r.__dict__)
        if p >= MIN_ROOT_PROB:
            candidates.append((r.spikelet, r.edge, r.node, p))

    columns = []  # (candidate index, trace)
    cost = []
    for ci, (s, edge, node, p) in enumerate(candidates):
        traces = sorted(tracer.trace_distribution(edge, node), key=lambda t: -t.prob)[:MAX_TRACES_PER_ROOT]
        for t in traces:
            columns.append((ci, t))
            cost.append(_logit(p) + math.log(max(t.prob, 1e-12)))

    edges = list(g.edges)
    eindex = {e: k for k, e in enumerate(edges)}
    edge_p = {}
    for e in edges:
        ed = g.edges[e]
        sx, sy = tracer.cal.mm_per_px
        edge_p[e] = models["edge"].prob({
            "confidence": ed.confidence, "length_mm": tracer.edge_len[e],
            "half_width_mm": ed.half_width_px * (sx + sy) / 2.0,
            "terminal": int(g.degree(ed.u) == 1) + int(g.degree(ed.v) == 1),
        })

    nx_, ny = len(columns), len(edges)
    if nx_ == 0:
        return []
    c = np.concatenate([-np.asarray(cost), -np.asarray([_logit(edge_p[e]) for e in edges])])

    rows_root = defaultdict(list)
    uses = defaultdict(list)
    for k, (ci, t) in enumerate(columns):
        rows_root[ci].append(k)
        for e in {e for e, _ in t.edges}:
            uses[e].append(k)

    n_rows = len(rows_root) + 2 * ny
    A = lil_matrix((n_rows, nx_ + ny))
    lo = np.full(n_rows, -np.inf)
    hi = np.zeros(n_rows)
    r = 0
    for ks in rows_root.values():
        for k in ks:
            A[r, k] = 1
        hi[r] = 1
        r += 1
    for e in edges:
        ed = g.edges[e]
        core = g.degree(ed.u) >= 3 and g.degree(ed.v) >= 3 and tracer.edge_len[e] <= CROSSING_CORE_MM
        for k in uses[e]:
            A[r, k] = 1
        hi[r] = 2 if core else 1
        r += 1
        # y_e - sum x <= 0
        A[r, nx_ + eindex[e]] = 1
        for k in uses[e]:
            A[r, k] = -1
        hi[r] = 0
        r += 1

    integrality = np.concatenate([np.ones(nx_), np.zeros(ny)])
    res = milp(c, constraints=LinearConstraint(A.tocsr(), lo, hi), integrality=integrality,
               bounds=Bounds(np.zeros(nx_ + ny), np.ones(nx_ + ny)), options={"time_limit": 60})
    if res.x is None:
        raise RuntimeError(f"assembly failed: {res.message}")
    chosen = [k for k in range(nx_) if res.x[k] > 0.5]
    return [Selected(candidates[columns[k][0]][0], columns[k][1], candidates[columns[k][0]][3]) for k in chosen]
