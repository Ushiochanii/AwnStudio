"""Page-level awn assembly as one integer program.

Every evidence edge is either part of an awn or clutter, and every awn starts at a
spikelet. Tracing alone decides each awn in isolation; assembly decides all of them
jointly so that

* evidence is explained: leaving an edge unexplained costs its log-odds of being awn
  (edge model), which pulls traces through sharp but real bends;
* evidence is not double-counted between spikelets: an edge belongs to at most one
  spikelet, except the short core of a crossing where awns of two spikelets overlap;
* a spikelet may carry several awns. Most awned spikelets have two, and they often lie
  together in one evidence ridge, at the base and again further up. Two awns of the
  same spikelet may therefore share any edge (capacity 2 per spikelet), so a ridge
  that hides two awns can carry both. A second awn is modelled as a branch: it shares
  its parent's path up to a junction, leaves along another edge there with the
  probability of the branch model, and may rejoin the parent's later edges;
* two awns of one spikelet never follow the identical edge set.

Columns (binary x) are candidate awns: root columns (root branch r, trace t) and
branch columns (parent column, junction, leaving edge, trace). y[e] marks explained
edges, z[e, s] that spikelet s uses edge e.

Maximize  sum_root x (logit p_root + log P(t)) + sum_branch x (logit p_branch + log P(t))
          + sum_e y[e] logit p_awn(e)
s.t.      sum of root columns of one root branch <= 1
          sum of branch columns of one branch slot <= x[parent]
          sum of columns of spikelet s whose own edges include e <= 2 z[e, s]
          sum_s z[e, s] <= capacity(e)   (1, or 2 at a crossing core)
          sum of columns of one spikelet with the same edge set <= 1
          y[e] <= sum of columns whose own edges include e
This is the MAP configuration of root, continuation, branch and evidence factors.
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
MAX_TRACES_PER_BRANCH = 10
MIN_ROOT_PROB = 0.05
MIN_BRANCH_PROB = 0.05
MIN_BRANCH_PARENT_PROB = 0.05
CROSSING_CORE_MM = 1.0  # junction-to-junction edges this short are crossing cores


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


@dataclass
class Selected:
    spikelet: int
    trace: Trace
    p_root: float


def _candidate_columns(tracer: Tracer) -> list[dict]:
    g, models = tracer.g, tracer.models
    columns = []
    for r in roots(g, tracer.spikelet_geoms, tracer.cal):
        p = models["root"].prob(r.__dict__)
        if p < MIN_ROOT_PROB:
            continue
        traces = sorted(tracer.trace_distribution(r.edge, r.node), key=lambda t: -t.prob)[:MAX_TRACES_PER_ROOT]
        for t in traces:
            columns.append({
                "group": ("root", r.edge, r.node, r.spikelet),
                "cost": _logit(p) + math.log(max(t.prob, 1e-12)),
                "own": {e for e, _ in t.edges}, "spikelet": r.spikelet, "trace": t, "p_root": p,
            })

    if "branch" not in models:
        return columns
    branch_traces: dict[tuple[int, int], list[Trace]] = {}
    for k in range(len(columns)):
        parent = columns[k]
        t = parent["trace"]
        if t.prob < MIN_BRANCH_PARENT_PROB:
            continue
        used = {e for e, _ in t.edges}
        for step, (edge, start) in enumerate(t.edges):
            node = g.other(edge, start)
            for rec in tracer.options.get((edge, node), ([], []))[0]:
                if rec.b in used:
                    continue
                pb = models["branch"].prob(rec.__dict__)
                if pb < MIN_BRANCH_PROB:
                    continue
                key = (rec.b, node)
                if key not in branch_traces:
                    branch_traces[key] = sorted(
                        tracer.trace_distribution(rec.b, node), key=lambda x: -x.prob
                    )[:MAX_TRACES_PER_BRANCH]
                prefix = t.edges[: step + 1]
                before = {e for e, _ in prefix}
                prefix_len = sum(tracer.edge_len[e] for e, _ in prefix)
                for bt in branch_traces[key]:
                    own = {e for e, _ in bt.edges}
                    if own & before:  # may rejoin the parent's later edges, never run back
                        continue
                    columns.append({
                        "group": ("branch", k, node, rec.b),
                        "cost": _logit(pb) + math.log(max(bt.prob, 1e-12)),
                        "own": own, "spikelet": parent["spikelet"], "p_root": parent["p_root"],
                        "trace": Trace(prefix + bt.edges, parent["p_root"] * pb * bt.prob,
                                       prefix_len + bt.length_mm, bt.jumps),
                    })
    return columns


def assemble(tracer: Tracer) -> list[Selected]:
    g, models = tracer.g, tracer.models
    columns = _candidate_columns(tracer)
    if not columns:
        return []

    edges = list(g.edges)
    eindex = {e: k for k, e in enumerate(edges)}
    sx, sy = tracer.cal.mm_per_px
    edge_logit = []
    for e in edges:
        ed = g.edges[e]
        edge_logit.append(_logit(models["edge"].prob({
            "confidence": ed.confidence, "length_mm": tracer.edge_len[e],
            "half_width_mm": ed.half_width_px * (sx + sy) / 2.0,
            "terminal": int(g.degree(ed.u) == 1) + int(g.degree(ed.v) == 1),
        })))

    nx_, ny = len(columns), len(edges)
    c = np.concatenate([-np.asarray([col["cost"] for col in columns]), -np.asarray(edge_logit)])

    groups = defaultdict(list)
    uses = defaultdict(list)
    same = defaultdict(list)  # (spikelet, full edge set) -> columns
    for k, col in enumerate(columns):
        groups[col["group"]].append(k)
        for e in col["own"]:
            uses[e].append(k)
        same[(col["spikelet"], frozenset(e for e, _ in col["trace"].edges))].append(k)
    same = [ks for ks in same.values() if len(ks) > 1]
    pairs = sorted({(e, columns[k]["spikelet"]) for e, ks in uses.items() for k in ks})
    zindex = {pair: nx_ + ny + k for k, pair in enumerate(pairs)}
    nz = len(pairs)
    c = np.concatenate([c, np.zeros(nz)])

    n_rows = len(groups) + 2 * ny + nz + len(same)
    A = lil_matrix((n_rows, nx_ + ny + nz))
    lo = np.full(n_rows, -np.inf)
    hi = np.zeros(n_rows)
    r = 0
    for group, ks in groups.items():
        for k in ks:
            A[r, k] = 1
        if group[0] == "branch":  # at most one branch trace, and only with its parent
            A[r, group[1]] = -1
            hi[r] = 0
        else:
            hi[r] = 1
        r += 1
    for (e, s), z in zindex.items():  # columns of s on e <= 2 z[e, s]
        for k in uses[e]:
            if columns[k]["spikelet"] == s:
                A[r, k] = 1
        A[r, z] = -2
        r += 1
    for ks in same:
        for k in ks:
            A[r, k] = 1
        hi[r] = 1
        r += 1
    for e in edges:
        ed = g.edges[e]
        core = g.degree(ed.u) >= 3 and g.degree(ed.v) >= 3 and tracer.edge_len[e] <= CROSSING_CORE_MM
        for s in {columns[k]["spikelet"] for k in uses[e]}:
            A[r, zindex[(e, s)]] = 1
        hi[r] = 2 if core else 1
        r += 1
        A[r, nx_ + eindex[e]] = 1  # y_e - sum x <= 0
        for k in uses[e]:
            A[r, k] = -1
        hi[r] = 0
        r += 1

    integrality = np.concatenate([np.ones(nx_), np.zeros(ny), np.ones(nz)])
    n = nx_ + ny + nz
    res = milp(c, constraints=LinearConstraint(A.tocsr(), lo, hi), integrality=integrality,
               bounds=Bounds(np.zeros(n), np.ones(n)), options={"time_limit": 60})
    if res.x is None:
        raise RuntimeError(f"assembly failed: {res.message}")
    return [Selected(columns[k]["spikelet"], columns[k]["trace"], columns[k]["p_root"])
            for k in range(nx_) if res.x[k] > 0.5]
