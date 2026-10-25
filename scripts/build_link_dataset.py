"""Extract tracing decisions with truth labels from cached pages.

    PYTHONPATH=src python scripts/build_link_dataset.py --split train
Writes runs/linkdata/<split>.npz-like JSON tables: junction.jsonl, gap.jsonl, root.jsonl.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import time

from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.events import gaps, junctions, roots
from awnstudio.labels import assign_truth, continues, root_correct
from awnstudio.paths import paths
from awnstudio.spikelets import fuse_spikelets
from awnstudio.splits import pages
from awnstudio.truth import truth_instances


def page_records(page: str, split: str):
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    obs = primary(obs)
    cal = calibrate_cached(page)
    sx, sy = cal.mm_per_px
    spikelets = fuse_spikelets(obs, meta["width"], meta["height"], sx * sy)
    graph = build_graph(obs, meta["width"], meta["height"])
    geoms = [s.geometry for s in spikelets]
    ta = assign_truth(graph, geoms, truth_instances(page, split), mm_per_px=(sx + sy) / 2.0)

    def edge_len(e):
        return float(cal.length_mm(graph.edges[e].path))

    def far(e, node):
        return graph.nodes[graph.other(e, node)]

    def at(node):
        return graph.nodes[node]

    out = {"junction": [], "gap": [], "root": []}
    for j in junctions(graph, cal):
        label = continues(ta, j.a, j.b, far(j.a, j.node), at(j.node), at(j.node), far(j.b, j.node))
        out["junction"].append({**dataclasses.asdict(j), "page": page, "label": label,
                                "len_a_mm": edge_len(j.a), "len_b_mm": edge_len(j.b),
                                "known": ta.edge_awn.get(j.a) is not None})
    for g in gaps(graph, cal):
        label = continues(ta, g.a, g.b, far(g.a, g.i), at(g.i), at(g.j), far(g.b, g.j))
        out["gap"].append({**dataclasses.asdict(g), "page": page, "label": label,
                           "len_a_mm": edge_len(g.a), "len_b_mm": edge_len(g.b),
                           "conf_a": graph.edges[g.a].confidence, "conf_b": graph.edges[g.b].confidence,
                           "known": ta.edge_awn.get(g.a) is not None})
    for r in roots(graph, geoms, cal):
        label = root_correct(ta, r.spikelet, r.edge, at(r.node), far(r.edge, r.node))
        out["root"].append({**dataclasses.asdict(r), "page": page, "label": label,
                            "len_mm": edge_len(r.edge), "conf": graph.edges[r.edge].confidence,
                            "known": r.spikelet in ta.pred_to_truth_spikelet})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="train", choices=["train", "valid"])
    args = parser.parse_args()
    out_dir = paths().runs / "linkdata" / args.split
    out_dir.mkdir(parents=True, exist_ok=True)
    handles = {k: open(out_dir / f"{k}.jsonl", "w") for k in ("junction", "gap", "root")}
    for page in pages(args.split):
        t = time.perf_counter()
        recs = page_records(page, args.split)
        for k, rows in recs.items():
            for row in rows:
                handles[k].write(json.dumps(row) + "\n")
        print(page, {k: len(v) for k, v in recs.items()}, f"{time.perf_counter() - t:.1f}s", flush=True)
    for h in handles.values():
        h.close()


if __name__ == "__main__":
    main()
