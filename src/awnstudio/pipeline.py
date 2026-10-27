"""Page reconstruction: detections -> spikelets + traced awns -> lengths."""
from __future__ import annotations

from functools import lru_cache

from .assembly import assemble
from .awngraph import build_graph
from .calibration import Calibration
from .crossings import repair as repair_crossings
from .detection import Observation, primary
from .detectors import DETECTORS, detector
from .linking import load_models
from .measurement import measure_path_mm, trim_root
from .protocol import Protocol, load_protocol
from .results import AwnResult, PageResult, SpikeletResult
from .spikelets import fuse_spikelets
from .tracer import Tracer

METHOD = "pfg"
REPAIR_CROSSINGS = True  # joint re-pairing at crossings (awnstudio.crossings)


@lru_cache(maxsize=None)
def default_models(detector_id: str | None = None):
    """Link models fitted to one detector's evidence (default detector: models/link_models.json)."""
    return load_models(detector(detector_id).link_models_path)


def models_for(model_id: str | None = None, method: str = METHOD) -> tuple[dict, Protocol | None]:
    """(link models, length protocol) for a detector, falling back to the default detector's
    files when the model is unknown or has not been fitted yet."""
    det = DETECTORS.get(model_id) if model_id else None
    if det is None or not det.link_models_path.is_file():
        det = detector()
    protocol_path = det.protocol_path(method)
    if not protocol_path.is_file():
        protocol_path = detector().protocol_path(method)
    return default_models(det.id), load_protocol(protocol_path) if protocol_path.is_file() else None


def reconstruct_page(
    page_id: str, observations: list[Observation], width: int, height: int, calibration: Calibration, models=None,
    mode: str = "assembly", detector_id: str | None = None,
) -> PageResult:
    models = models or default_models(detector_id)
    obs = primary(observations)
    sx, sy = calibration.mm_per_px
    spikelets = fuse_spikelets(obs, width, height, sx * sy)
    graph = build_graph(obs, width, height)
    geoms = [s.geometry for s in spikelets]
    tracer = Tracer(graph, geoms, calibration, models)

    results = [SpikeletResult(s.id, s.geometry, meta={"confidence": s.confidence}) for s in spikelets]
    if mode == "assembly":
        selected = assemble(tracer)
        traces = [sel.trace for sel in selected]
        if REPAIR_CROSSINGS:
            traces = repair_crossings(tracer, traces)
        chosen = [(sel.spikelet, t, sel.p_root) for sel, t in zip(selected, traces)]
    else:  # independent median tracing per root branch
        chosen = [
            (s, tracer.median_trace(tracer.trace_distribution(edge, node)), p_root)
            for s, branches in tracer.root_branches().items()
            for edge, node, p_root in branches
        ]
    for s, trace, p_root in chosen:
        path = trim_root(tracer.trace_path(trace).tolist(), geoms[s])
        results[s].awns.append(AwnResult(
            path_px=[tuple(p) for p in path],
            length_mm=measure_path_mm(path, calibration),
            score=p_root * trace.prob,
            meta={"p_root": p_root, "trace_prob": trace.prob, "hops": len(trace.edges) - 1, "gaps": trace.jumps},
        ))
    for r in results:
        if r.awns:
            r.representative = max(range(len(r.awns)), key=lambda k: r.awns[k].length_mm)
    return PageResult(page_id, f"{METHOD}_{mode}", calibration.x_period_px, calibration.y_period_px, results)
