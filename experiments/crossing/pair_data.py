"""Labelled crossing-pairing decisions: when should two awns' tails be exchanged?

For every two selected traces (step-1 assembly, no repair) that enter one crossing
cluster by different arms and leave it by different arms, the four arms are labelled
with their truth awn when they lie on one truth awn alone. A decision is labelled
"keep" when the current pairing matches the truth, "swap" when the exchanged pairing
does, and is unlabelled otherwise. Features: junction utilities of both pairings
(choice model), the summed squared deflections, and the largest deflection in each.

    PYTHONPATH=src python experiments/crossing/pair_data.py --split train --input oracle_whole
"""
import argparse
import json
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import shapely

from awnstudio.assembly import assemble
from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.crossings import _passes, _utility, core_clusters
from awnstudio.detection import primary
from awnstudio.diagnose import oracle_observations
from awnstudio.events import arrive_dir, depart_dir
from awnstudio.geometry import angle_between
from awnstudio.labels import POLYGON_TOLERANCE_PX
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
        obs = oracle_observations(truth, w, h, cal)
    obs = primary(obs)
    sx, sy = cal.mm_per_px
    spk = fuse_spikelets(obs, w, h, sx * sy)
    g = build_graph(obs, w, h)
    tracer = Tracer(g, [s.geometry for s in spk], cal, default_models())
    choice = tracer.models["choice"]
    awn_polys = [t.geometry.buffer(POLYGON_TOLERANCE_PX) for t in truth if t.kind == "awn"]
    tree = shapely.STRtree(awn_polys)

    def identity(e):
        p = g.edges[e].path[:: max(1, len(g.edges[e].path) // 25)]
        geom = shapely.LineString(p) if len(p) > 1 else shapely.Point(p[0])
        fr = sorted(((shapely.contains_xy(awn_polys[int(k)], p[:, 0], p[:, 1]).mean(), int(k))
                     for k in tree.query(geom)), reverse=True)
        return fr[0][1] if fr and fr[0][0] >= 0.6 and (len(fr) < 2 or fr[1][0] <= 0.3) else None

    def defl(a, na, b, nb):
        da, db = arrive_dir(g, a, na, cal), depart_dir(g, b, nb, cal)
        return 180.0 if da is None or db is None else angle_between(da, db)

    cluster = core_clusters(g)
    traces = [sel.trace for sel in assemble(tracer)]
    passes = {k: _passes(g, cluster, t) for k, t in enumerate(traces)}
    rows = []
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
                    na1, na2, nb1, nb2 = g.other(*t1[i1]), g.other(*t2[i2]), t1[j1][1], t2[j2][1]
                    ids = [identity(e) for e in (a1, b1, a2, b2)]
                    label = None
                    if None not in ids:
                        if ids[0] == ids[1] and ids[2] == ids[3] and ids[0] != ids[2]:
                            label = "keep"
                        elif ids[0] == ids[3] and ids[2] == ids[1] and ids[0] != ids[2]:
                            label = "swap"
                    d_now = [defl(a1, na1, b1, nb1), defl(a2, na2, b2, nb2)]
                    d_alt = [defl(a1, na1, b2, nb2), defl(a2, na2, b1, nb1)]
                    rows.append({
                        "page": page, "label": label,
                        "u_now": _utility(g, cal, choice, a1, na1, b1, nb1) + _utility(g, cal, choice, a2, na2, b2, nb2),
                        "u_alt": _utility(g, cal, choice, a1, na1, b2, nb2) + _utility(g, cal, choice, a2, na2, b1, nb1),
                        "d2_now": sum((d / 90) ** 2 for d in d_now), "d2_alt": sum((d / 90) ** 2 for d in d_alt),
                        "dmax_now": max(d_now), "dmax_alt": max(d_alt),
                        "nodes": len({n for n, cc in cluster.items() if cc == c1}),
                    })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="train")
    ap.add_argument("--input", default="oracle_whole")
    a = ap.parse_args()
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    rows = []
    with ProcessPoolExecutor(8) as pool:
        for r in pool.map(run, [(p, a.split, a.input) for p in pages(a.split) if p in cached]):
            rows += r
    (paths().runs / f"pairdata_{a.input}_{a.split}.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    print(a.input, a.split, Counter(r["label"] for r in rows))
    lab = [r for r in rows if r["label"]]
    for name in ("keep", "swap"):
        sel = [r for r in lab if r["label"] == name]
        if sel:
            du = np.array([r["u_alt"] - r["u_now"] for r in sel])
            print(f"  {name}: n={len(sel)}  u_alt-u_now median {np.median(du):+.2f}  "
                  f"share alt better {np.mean(du > 0):.2f}  dmax_now median {np.median([r['dmax_now'] for r in sel]):.1f}  "
                  f"dmax_alt median {np.median([r['dmax_alt'] for r in sel]):.1f}")


if __name__ == "__main__":
    main()
