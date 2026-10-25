"""Page reconstruction: detections -> spikelets + traced awns -> lengths."""
from __future__ import annotations

from functools import lru_cache

from .awngraph import build_graph
from .calibration import Calibration
from .detection import Observation, primary
from .linking import load_models
from .measurement import measure_path_mm, trim_root
from .paths import REPO_ROOT
from .results import AwnResult, PageResult, SpikeletResult
from .spikelets import fuse_spikelets
from .tracer import Tracer

METHOD = "pfg_median"


@lru_cache(maxsize=1)
def default_models():
    return load_models(REPO_ROOT / "models" / "link_models.json")


def reconstruct_page(
    page_id: str, observations: list[Observation], width: int, height: int, calibration: Calibration, models=None
) -> PageResult:
    models = models or default_models()
    obs = primary(observations)
    sx, sy = calibration.mm_per_px
    spikelets = fuse_spikelets(obs, width, height, sx * sy)
    graph = build_graph(obs, width, height)
    geoms = [s.geometry for s in spikelets]
    tracer = Tracer(graph, geoms, calibration, models)

    results = [SpikeletResult(s.id, s.geometry, meta={"confidence": s.confidence}) for s in spikelets]
    for s, branches in tracer.root_branches().items():
        for edge, node, p_root in branches:
            traces = tracer.trace_distribution(edge, node)
            best = tracer.median_trace(traces)
            path = trim_root(tracer.trace_path(best).tolist(), geoms[s])
            results[s].awns.append(AwnResult(
                path_px=[tuple(p) for p in path],
                length_mm=measure_path_mm(path, calibration),
                score=p_root * best.prob,
                meta={"p_root": p_root, "trace_prob": best.prob, "hops": len(best.edges) - 1,
                      "gaps": best.jumps, "alternatives": len(traces)},
            ))
    for r in results:
        if r.awns:
            r.representative = max(range(len(r.awns)), key=lambda k: r.awns[k].length_mm)
    return PageResult(page_id, METHOD, calibration.x_period_px, calibration.y_period_px, results)
