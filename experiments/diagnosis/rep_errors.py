"""What causes representative-length errors? Class of the representative path for each spikelet.

    PYTHONPATH=src python experiments/diagnosis/rep_errors.py step1 model_valid
"""
import json
import sys
from collections import Counter, defaultdict

import numpy as np

from awnstudio.paths import paths

tag, name = sys.argv[1], sys.argv[2]
base = paths().runs / f"diagnosis_{tag}" / name
paths_by = defaultdict(list)
for line in open(base / "paths.jsonl"):
    r = json.loads(line)
    paths_by[(r["page"], r["spikelet"])].append(r)
reps = json.loads((base / "representatives.json").read_text())
rows = []
for r in reps:
    if r["pred_mm"] is None:
        rows.append(("unmeasured", "", r["truth_mm"], None))
        continue
    cand = paths_by[(r["page"], r["pred_spikelet"])]
    best = max(cand, key=lambda p: p["length_mm"])
    rows.append((best["cls"], best["detail"], r["truth_mm"], r["pred_mm"] - r["truth_mm"]))
err = np.array([e for *_, e in rows if e is not None])
print(f"{name} [{tag}] spikelets {len(rows)}  MAE {np.abs(err).mean():.2f}")
total_abs = np.abs(err).sum()
by = defaultdict(list)
for cls, detail, t, e in rows:
    if e is not None:
        by[(cls, detail)].append(e)
for k, es in sorted(by.items(), key=lambda kv: -np.abs(kv[1]).sum()):
    es = np.array(es)
    print(f"  {k[0]:<10} {k[1]:<32} n={len(es):4d}  share of total |err| {np.abs(es).sum() / total_abs:5.1%}  "
          f"mean err {es.mean():+.2f}  |err|>2mm {int((np.abs(es) > 2).sum())}")
big = [(c, d, e) for c, d, t, e in rows if e is not None and abs(e) > 2]
print("  |err|>2mm by sign:", Counter(("over" if e > 0 else "under", c) for c, d, e in big))

# Is the representative path on the spikelet's longest truth awn?
truth_by = defaultdict(list)
for line in open(base / "truth_awns.jsonl"):
    t = json.loads(line)
    truth_by[(t["page"], t["spikelet"])].append(t)
stat = Counter()
miss_len = []
for r in reps:
    if r["pred_mm"] is None:
        continue
    best = max(paths_by[(r["page"], r["pred_spikelet"])], key=lambda p: p["length_mm"])
    truths = sorted(truth_by[(r["page"], r["truth_spikelet"])], key=lambda t: -t["length_mm"])
    longest = truths[0]
    err = r["pred_mm"] - r["truth_mm"]
    if best["main"] == longest["awn"]:
        key = "on_longest"
    elif len(truths) > 1 and best["main"] in {t["awn"] for t in truths[1:]}:
        key = "on_shorter_sibling" + ("(longest traced)" if longest["matched"] else "(longest MISSED)")
        miss_len.append(longest["length_mm"] - truths[1]["length_mm"])
    else:
        key = "elsewhere"
    stat[(key, "big_under" if err < -2 else "big_over" if err > 2 else "ok")] += 1
for k, v in sorted(stat.items()):
    print("  ", k, v)
if miss_len:
    print("   longest minus second truth awn (when rep on sibling): median %.1f mm" % np.median(miss_len))
