"""Why does a trace stop early or jump? Mechanism breakdown for SHORT / JUMP paths.

For every selected awn of the assembly whose diagnosis is SHORT or JUMP, the graph
around its last edge (SHORT) is inspected:

* blocked   - an edge continuing along the truth awn exists at the stop node, but it is
              owned by another selected awn (edge capacity);
* stopped   - such an edge exists and is free; the chosen trace just ends there;
* no_option - no graph option at the stop node continues along the truth awn.

    PYTHONPATH=src python experiments/diagnosis/why_short.py --input oracle_whole --split valid
"""
import argparse
import json
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import shapely
from shapely.geometry import LineString

from awnstudio.assembly import assemble
from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.diagnose import AWN_TOL_PX, classify_path, oracle_observations, truth_awns
from awnstudio.measurement import trim_root
from awnstudio.paths import paths
from awnstudio.pipeline import default_models
from awnstudio.spikelets import fuse_spikelets
from awnstudio.splits import pages
from awnstudio.tracer import Tracer
from awnstudio.truth import truth_instances


def run(job):
    page, split, source = job
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    w, h = meta["width"], meta["height"]
    cal = calibrate_cached(page)
    truth = truth_instances(page, split)
    if source != "model":
        obs = oracle_observations(truth, w, h, cal, broken=source == "oracle_broken")
    obs = primary(obs)
    sx, sy = cal.mm_per_px
    spk = fuse_spikelets(obs, w, h, sx * sy)
    graph = build_graph(obs, w, h)
    tracer = Tracer(graph, [s.geometry for s in spk], cal, default_models())
    chosen = assemble(tracer)
    owner = {}
    for k, sel in enumerate(chosen):
        for e, _ in sel.trace.edges:
            owner.setdefault(e, []).append(k)

    awns, spikelets = truth_awns(truth, cal)
    sp_union = shapely.union_all(spikelets).buffer(AWN_TOL_PX)
    evidence = shapely.union_all([o.geometry for o in obs if o.kind == "awn"])
    tree = shapely.STRtree([a.mask for a in awns])
    out = []
    for k, sel in enumerate(chosen):
        path = trim_root(tracer.trace_path(sel.trace).tolist(), spk[sel.spikelet].geometry)
        if len(path) < 2 or LineString(path).length == 0:
            continue
        r = classify_path(path, awns, sp_union, evidence, cal, tree)
        if r["cls"] not in ("SHORT", "JUMP"):
            continue
        main = awns[r["main"]]
        last_edge, last_start = sel.trace.edges[-1]
        node = graph.other(last_edge, last_start)

        def along(e):  # edge mostly inside the main truth awn and not yet used by this trace
            p = graph.edges[e].path
            return shapely.contains_xy(main.mask, p[:, 0], p[:, 1]).mean() >= 0.6

        used = {e for e, _ in sel.trace.edges}
        jopts, gopts = tracer.options.get((last_edge, node), ([], []))
        cont = [o.b for o in jopts if o.b not in used and along(o.b)] + \
               [o.b for o in gopts if o.b not in used and along(o.b)]
        if r["cls"] == "SHORT":
            if not cont:
                mech = "no_option"
            elif any(len(owner.get(e, [])) > 0 for e in cont):
                same = any(chosen[o].spikelet == sel.spikelet for e in cont for o in owner.get(e, []))
                mech = "blocked_same_spikelet" if same else "blocked_other_spikelet"
            else:
                mech = "stopped"
        else:
            mech = "jump"
        # how many truth awns does the stop node's edge carry (shared ridge)?
        hw = graph.edges[last_edge].half_width_px * (sx + sy) / 2
        out.append({"page": page, "cls": r["cls"], "mech": mech, "degree": graph.degree(node),
                    "n_options": len(jopts) + len(gopts), "last_half_width_mm": hw,
                    "missing_tip_mm": r["missing_tip_mm"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="oracle_whole")
    ap.add_argument("--split", default="valid")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    todo = [(p, a.split, a.input) for p in pages(a.split) if p in cached]
    rows = []
    with ProcessPoolExecutor(a.workers) as pool:
        for r in pool.map(run, todo):
            rows += r
    print(a.input, a.split, Counter((r["cls"], r["mech"]) for r in rows))
    print("stop-node degree", Counter((r["mech"], r["degree"]) for r in rows))
    out = paths().runs / "diagnosis" / f"why_{a.input}_{a.split}.json"
    out.write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
