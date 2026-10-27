"""Does a selected path keep its awn identity where awns meet (crossings / merges)?

An edge is labelled with truth awn k only when it lies on k alone (>= 60% of its samples
inside k's polygon, <= 30% inside any other): edges on a ridge shared by two awns carry
no identity. Along each selected path, consecutive identity-carrying edges are compared:
same truth awn = kept ("straight through"), different = switched ("bounce back" / jump),
split by whether it switched to a sibling (same spikelet) or to another spikelet's awn.
Run with and without crossing repair (awnstudio.crossings).

    PYTHONPATH=src python experiments/crossing/pairing.py --split valid --input model
"""
import argparse
import json
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import shapely

from awnstudio.awngraph import build_graph
from awnstudio.assembly import assemble
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.crossings import repair
from awnstudio.detection import primary
from awnstudio.diagnose import oracle_observations
from awnstudio.labels import POLYGON_TOLERANCE_PX
from awnstudio.paths import paths
from awnstudio.pipeline import default_models
from awnstudio.spikelets import fuse_spikelets
from awnstudio.splits import pages
from awnstudio.tracer import Tracer
from awnstudio.truth import truth_instances


def run(job):
    page, split, source, repaired = job
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    w, h = meta["width"], meta["height"]
    cal = calibrate_cached(page)
    truth = truth_instances(page, split)
    if source != "model":
        obs = oracle_observations(truth, w, h, cal, broken=source == "oracle_broken")
    obs = primary(obs)
    sx, sy = cal.mm_per_px
    spk = fuse_spikelets(obs, w, h, sx * sy)
    g = build_graph(obs, w, h)
    tracer = Tracer(g, [s.geometry for s in spk], cal, default_models())
    awn_polys = [t.geometry.buffer(POLYGON_TOLERANCE_PX) for t in truth if t.kind == "awn"]
    spk_polys = [t.geometry for t in truth if t.kind == "spikelet"]
    owner = [min(range(len(spk_polys)), key=lambda j: a.distance(spk_polys[j])) if spk_polys else None
             for a in awn_polys]
    tree = shapely.STRtree(awn_polys)

    def identity(e):
        p = g.edges[e].path[:: max(1, len(g.edges[e].path) // 25)]
        fr = sorted(((shapely.contains_xy(awn_polys[int(k)], p[:, 0], p[:, 1]).mean(), int(k))
                     for k in tree.query(shapely.LineString(p) if len(p) > 1 else shapely.Point(p[0]))), reverse=True)
        if fr and fr[0][0] >= 0.6 and (len(fr) < 2 or fr[1][0] <= 0.3):
            return fr[0][1]
        return None

    cache = {}
    counts = Counter()
    traces = [sel.trace for sel in assemble(tracer)]
    if repaired:
        traces = repair(tracer, traces)
    for trace in traces:
        ids = []
        for e, _ in trace.edges:
            if e not in cache:
                cache[e] = identity(e)
            if cache[e] is not None:
                ids.append(cache[e])
        for a, b in zip(ids, ids[1:]):
            counts["kept" if a == b else "switch_sibling" if owner[a] == owner[b] else "switch_other"] += 1
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="valid")
    ap.add_argument("--input", default="model")
    a = ap.parse_args()
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    todo = [p for p in pages(a.split) if p in cached]
    out = {}
    for repaired in (False, True):
        total = Counter()
        with ProcessPoolExecutor(8) as pool:
            for c in pool.map(run, [(p, a.split, a.input, repaired) for p in todo]):
                total += c
        out["repaired" if repaired else "baseline"] = dict(total)
        n = sum(total.values())
        print(f"{a.input} {a.split} repaired={repaired}: kept {total['kept']}/{n} = {total['kept'] / max(1, n):.3f}"
              f"  switch_sibling {total['switch_sibling']}  switch_other {total['switch_other']}")
    target = paths().runs / f"pairing_{a.input}_{a.split}.json"
    target.write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
