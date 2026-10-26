"""Tip overshoot: which decision leads a trace off its truth awn at the tip, and how do
those steps differ from correct continuations?

For every selected trace (model input) each hop after the first is labelled
* wrong - the hop's edge lies mostly off every truth awn and nothing after it returns
          to the trace's main truth awn (the tip overshoot);
* right - the hop's edge lies mostly on the trace's main truth awn.
Per hop the decision type (junction / gap) and the features of the step are written.

    PYTHONPATH=src python experiments/diagnosis/overshoot.py --split train
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
from awnstudio.detection import primary
from awnstudio.diagnose import truth_awns
from awnstudio.events import arrive_dir, depart_dir
from awnstudio.geometry import angle_between
from awnstudio.paths import paths
from awnstudio.pipeline import default_models
from awnstudio.spikelets import fuse_spikelets
from awnstudio.splits import pages
from awnstudio.tracer import Tracer
from awnstudio.truth import truth_instances


def run(job):
    page, split = job
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    obs = primary(obs)
    w, h = meta["width"], meta["height"]
    cal = calibrate_cached(page)
    sx, sy = cal.mm_per_px
    spk = fuse_spikelets(obs, w, h, sx * sy)
    graph = build_graph(obs, w, h)
    tracer = Tracer(graph, [s.geometry for s in spk], cal, default_models())
    awns, spikelets = truth_awns(truth_instances(page, split), cal)
    union = shapely.union_all([a.mask for a in awns]) if awns else None
    sp_union = shapely.union_all(spikelets).buffer(4) if spikelets else None

    def frac_on(e, geom):
        p = graph.edges[e].path
        return float(shapely.contains_xy(geom, p[:, 0], p[:, 1]).mean()) if geom is not None else 0.0

    rows = []
    for sel in assemble(tracer):
        edges = sel.trace.edges
        # main truth awn: most covered by the trace's edges
        cover = Counter()
        for e, _ in edges:
            p = graph.edges[e].path
            for k, a in enumerate(awns):
                n = int(shapely.contains_xy(a.mask, p[:, 0], p[:, 1]).sum())
                if n:
                    cover[k] += n
        if not cover:
            continue
        main = awns[cover.most_common(1)[0][0]].mask
        on_main = [frac_on(e, main) >= 0.5 for e, _ in edges]
        off_all = [frac_on(e, union) < 0.5 and frac_on(e, sp_union) < 0.5 for e, _ in edges]
        last_on = max([i for i, v in enumerate(on_main) if v], default=-1)
        for i in range(1, len(edges)):
            (pe, ps), (e, start) = edges[i - 1], edges[i]
            arrival = graph.other(pe, ps)
            kind = "junction" if arrival == start else "gap"
            if on_main[i]:
                label = "right"
            elif off_all[i] and i > last_on:
                label = "wrong"
            else:
                continue
            ed = graph.edges[e]
            da, db = arrive_dir(graph, pe, arrival, cal), depart_dir(graph, e, start, cal)
            seg = cal.to_mm(ed.path)
            chord = seg[-1] - seg[0]
            arc = float(np.linalg.norm(np.diff(seg, axis=0), axis=1).sum())
            rows.append({
                "page": page, "label": label, "kind": kind,
                "turn_deg": 180.0 if da is None or db is None else angle_between(da, db),
                "gap_mm": float(np.linalg.norm(cal.to_mm(graph.nodes[start][None] - graph.nodes[arrival][None]))),
                "edge_len_mm": tracer.edge_len[e], "conf": ed.confidence,
                "half_width_mm": ed.half_width_px * (sx + sy) / 2,
                "prev_half_width_mm": graph.edges[pe].half_width_px * (sx + sy) / 2,
                "straightness": float(np.linalg.norm(chord) / max(arc, 1e-9)),
                "axis_dev_deg": float(min(abs(np.degrees(np.arctan2(chord[1], chord[0]))) % 90,
                                          90 - abs(np.degrees(np.arctan2(chord[1], chord[0]))) % 90)),
                "terminal": int(graph.degree(graph.other(e, start)) == 1),
            })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="train")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    rows = []
    with ProcessPoolExecutor(a.workers) as pool:
        for r in pool.map(run, [(p, a.split) for p in pages(a.split) if p in cached]):
            rows += r
    out = paths().runs / "diagnosis" / f"overshoot_{a.split}.jsonl"
    out.write_text("\n".join(json.dumps(r) for r in rows))
    print(Counter((r["label"], r["kind"]) for r in rows))
    keys = ["turn_deg", "gap_mm", "edge_len_mm", "conf", "half_width_mm", "prev_half_width_mm", "straightness",
            "axis_dev_deg", "terminal"]
    for kind in ("junction", "gap"):
        for label in ("right", "wrong"):
            sel = [r for r in rows if r["kind"] == kind and r["label"] == label]
            if sel:
                print(kind, label, len(sel), " ".join(f"{k}={np.median([r[k] for r in sel]):.2f}" for k in keys))


if __name__ == "__main__":
    main()
