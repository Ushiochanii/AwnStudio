"""Stage-by-stage page reconstruction for the workbench.

`reconstruct_staged` runs the same steps as `awnstudio.pipeline.reconstruct_page`
(assembly mode) and returns the same `PageResult`, but also keeps what the
workbench shows while a measurement runs and when a spikelet is inspected:

* evidence    - primary detection masks (simplified outlines, kind, confidence);
* spikelets   - fused spikelets, in the order the result lists them;
* seeds       - root branches with their root probability;
* growth      - for every chosen awn, its trace hop by hop (edge path, length,
                whether the hop bridges a gap);
* alternatives - the median trace of every root branch whose root the page-level
                assembly did not use (the chosen awns are in the result itself);
* timings     - wall time of each stage.

`service/tests/test_staged.py` checks that the result is identical to
`reconstruct_page` on a cached page, so the two cannot drift apart unnoticed.
"""
from __future__ import annotations

import time
from typing import Callable

import numpy as np

from awnstudio.assembly import assemble
from awnstudio.awngraph import build_graph
from awnstudio.calibration import Calibration
from awnstudio.detection import Observation, primary
from awnstudio.measurement import measure_path_mm, simplify_path, trim_root
from awnstudio import pipeline
from awnstudio.pipeline import METHOD, default_models
from awnstudio.results import AwnResult, PageResult, SpikeletResult
from awnstudio.spikelets import fuse_spikelets
from awnstudio.tracer import Tracer

EVIDENCE_SIMPLIFY_PX = 1.5


def _rings(geometry, tolerance: float = EVIDENCE_SIMPLIFY_PX) -> list[list[list[int]]]:
    """Exterior rings of a (multi)polygon as rounded integer point lists."""
    simplified = geometry.simplify(tolerance, preserve_topology=True)
    parts = getattr(simplified, "geoms", [simplified])
    rings = []
    for part in parts:
        exterior = getattr(part, "exterior", None)
        if exterior is None:
            continue
        coords = np.round(np.asarray(exterior.coords)[:-1]).astype(int).tolist()
        if len(coords) >= 3:
            rings.append(coords)
    return rings


def evidence_item(observation: Observation) -> dict:
    return {"kind": observation.kind, "confidence": round(float(observation.confidence), 4), "rings": _rings(observation.geometry)}


def _round_path(points) -> list[list[float]]:
    return [[round(float(x), 2), round(float(y), 2)] for x, y in points]


def _hops(tracer: Tracer, trace, calibration: Calibration) -> list[dict]:
    hops, previous_end = [], None
    for edge, start in trace.edges:
        path = tracer.g.oriented_path(edge, start)
        gap = previous_end is not None and not np.allclose(previous_end, path[0])
        hops.append({"path": _round_path(simplify_path(path.tolist(), 0.75)), "length_mm": calibration.length_mm(path), "gap": bool(gap)})
        previous_end = path[-1]
    return hops


def reconstruct_staged(
    page_id: str,
    observations: list[Observation],
    width: int,
    height: int,
    calibration: Calibration,
    models=None,
    on_stage: Callable[[str], None] | None = None,
) -> tuple[PageResult, dict]:
    models = models or default_models()
    timings: dict[str, float] = {}
    clock = time.perf_counter()

    def stage(name: str):
        nonlocal clock
        now = time.perf_counter()
        if on_stage:
            on_stage(name)
        return now

    def done(name: str, started: float):
        timings[name] = time.perf_counter() - started

    started = stage("fuse")
    obs = primary(observations)
    sx, sy = calibration.mm_per_px
    spikelets = fuse_spikelets(obs, width, height, sx * sy)
    done("fuse", started)

    started = stage("graph")
    graph = build_graph(obs, width, height)
    geoms = [s.geometry for s in spikelets]
    tracer = Tracer(graph, geoms, calibration, models)
    done("graph", started)

    started = stage("assemble")
    selections = assemble(tracer)
    traces = [sel.trace for sel in selections]
    # Same crossing re-pairing as reconstruct_page, when the pipeline has it.
    if getattr(pipeline, "REPAIR_CROSSINGS", False):
        from awnstudio.crossings import repair

        traces = repair(tracer, traces)
    done("assemble", started)

    started = stage("measure")
    results = [SpikeletResult(s.id, s.geometry, meta={"confidence": s.confidence}) for s in spikelets]
    growth: dict[str, list[dict]] = {}
    for sel, trace in zip(selections, traces):
        s, p_root = sel.spikelet, sel.p_root
        path = trim_root(tracer.trace_path(trace).tolist(), geoms[s])
        results[s].awns.append(AwnResult(
            path_px=[tuple(p) for p in path],
            length_mm=measure_path_mm(path, calibration),
            score=p_root * trace.prob,
            meta={"p_root": p_root, "trace_prob": trace.prob, "hops": len(trace.edges) - 1, "gaps": trace.jumps},
        ))
        growth.setdefault(results[s].id, []).append({"p_root": p_root, "hops": _hops(tracer, trace, calibration)})
    for r in results:
        if r.awns:
            r.representative = max(range(len(r.awns)), key=lambda k: r.awns[k].length_mm)
    done("measure", started)

    started = stage("alternatives")
    used_roots = {trace.edges[0] for trace in traces if trace.edges}
    alternatives: dict[str, list[dict]] = {}
    seeds: dict[str, list[dict]] = {}
    for s, branches in tracer.root_branches().items():
        sid = results[s].id
        for edge, node, p_root in branches:
            seeds.setdefault(sid, []).append({"p_root": p_root, "path": _round_path(simplify_path(tracer.g.oriented_path(edge, node).tolist(), 0.75))})
            if (edge, node) in used_roots:
                continue
            traces = tracer.trace_distribution(edge, node)
            if not traces:
                continue
            trace = tracer.median_trace(traces)
            path = trim_root(tracer.trace_path(trace).tolist(), geoms[s])
            alternatives.setdefault(sid, []).append({
                "path": _round_path(path), "length_mm": measure_path_mm(path, calibration),
                "score": p_root * trace.prob, "hops": len(trace.edges) - 1,
            })
    done("alternatives", started)

    page = PageResult(page_id, f"{METHOD}_assembly", calibration.x_period_px, calibration.y_period_px, results)
    stages = {
        "evidence": [evidence_item(o) for o in obs],
        "seeds": seeds,
        "growth": growth,
        "alternatives": alternatives,
        "timings": timings,
    }
    return page, stages
