"""Diagnose reconstruction errors against whole-awn truth polygons.

    PYTHONPATH=src python scripts/diagnose_reconstruction.py --split valid --input oracle_broken --figures 4

Inputs: ``model`` (cached detections), ``oracle_whole`` (truth polygons), ``oracle_broken``
(truth polygons cut every 10 mm). Output: runs/diagnosis/INPUT_SPLIT/.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import shapely

from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.diagnose import CLASSES, diagnose_page, oracle_observations, page_counts, representative_stats
from awnstudio.paths import paths
from awnstudio.pipeline import reconstruct_page
from awnstudio.splits import pages
from awnstudio.truth import truth_instances

COLORS = {"OK": "#2166ac", "SHORT": "#ff7f00", "JUMP": "#c51b7d", "FALSE_LINK": "#e41a1c"}


def run_page(job):
    page, split, source = job
    observations, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    width, height = meta["width"], meta["height"]
    calibration = calibrate_cached(page)
    truth = truth_instances(page, split)
    if source != "model":
        observations = oracle_observations(truth, width, height, calibration, broken=source == "oracle_broken")
    result = reconstruct_page(page, observations, width, height, calibration, mode="assembly")
    evidence = shapely.union_all([o.geometry for o in primary(observations) if o.kind == "awn"])
    d = diagnose_page(result, truth, evidence, calibration)
    return page, d, result


def figure(page, d, result, truth, target):
    import cv2
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    image = cv2.imread(str(paths().page_image(page)))[:, :, ::-1]
    h, w = image.shape[:2]
    fig = plt.figure(figsize=(w / 200, h / 200), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.imshow((0.55 * image + 0.45 * 255).astype(np.uint8))
    for t in truth:
        for g in getattr(t.geometry, "geoms", [t.geometry]):
            x, y = g.exterior.xy
            ax.plot(x, y, color="#1a9850" if t.kind == "awn" else "0.35", lw=0.5)
    for r in d.truth:
        if not r["matched"]:
            a = np.asarray(r["axis_px"])
            ax.plot(a[:, 0], a[:, 1], color="#e41a1c", lw=2.5, ls=(0, (2, 1.5)), alpha=0.85)
    for p in d.paths:
        path = np.asarray(result.spikelets[p.spikelet].awns[p.awn].path_px)
        ax.plot(path[:, 0], path[:, 1], color=COLORS[p.cls], lw=1.6)
        if p.missing_tip_px and p.missing_tip_mm >= 2.0:
            m = np.asarray(p.missing_tip_px)
            ax.plot(m[:, 0], m[:, 1], color="#ff7f00", lw=1.6, ls=":")
    from matplotlib.lines import Line2D

    handles = [Line2D([], [], color=c, lw=2, label=k) for k, c in COLORS.items()]
    handles += [Line2D([], [], color="#e41a1c", lw=2.5, ls=(0, (2, 1.5)), label="MISSED truth awn"),
                Line2D([], [], color="#ff7f00", lw=1.6, ls=":", label="missing tip"),
                Line2D([], [], color="#1a9850", lw=0.8, label="truth outline")]
    ax.legend(handles=handles, loc="upper right", fontsize=12, framealpha=0.9)
    c = page_counts(d)
    ax.text(20, 60, f"{page}  " + "  ".join(f"{k} {c[k]}" for k in (*CLASSES, "MISSED")), fontsize=16,
            bbox=dict(facecolor="white", alpha=0.85))
    ax.set_xlim(0, w)
    ax.set_ylim(h, 0)
    ax.axis("off")
    fig.savefig(target, dpi=100, pil_kwargs={"quality": 85})
    plt.close(fig)


def summarize(counts: dict[str, dict], reps: list[dict]) -> dict:
    total: dict[str, int] = {}
    for c in counts.values():
        for k, v in c.items():
            total[k] = total.get(k, 0) + v
    n_paths = max(1, total.get("paths", 0))
    n_truth = max(1, total.get("truth_awns", 0))
    return {
        "pages": len(counts),
        "counts": total,
        "path_share": {k: total.get(k, 0) / n_paths for k in CLASSES},
        "missed_share_of_truth": total.get("MISSED", 0) / n_truth,
        "representative": representative_stats(reps),
        "hardest_pages": sorted(counts, key=lambda p: -counts[p]["errors"])[:15],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="valid", choices=["train", "valid"])
    parser.add_argument("--input", default="model", choices=["model", "oracle_whole", "oracle_broken"])
    parser.add_argument("--pages", nargs="*")
    parser.add_argument("--figures", type=int, default=0)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    todo = args.pages or [p for p in pages(args.split) if p in cached]

    out = paths().runs / "diagnosis" / f"{args.input}_{args.split}"
    (out / "figures").mkdir(parents=True, exist_ok=True)
    counts, reps, results = {}, [], {}
    with open(out / "paths.jsonl", "w") as fp, open(out / "truth_awns.jsonl", "w") as ft, \
            ProcessPoolExecutor(args.workers) as pool:
        for page, d, result in pool.map(run_page, [(p, args.split, args.input) for p in todo]):
            for p in d.paths:
                row = dataclasses.asdict(p)
                row.pop("samples_px")
                fp.write(json.dumps({"page": page, **row}) + "\n")
            for r in d.truth:
                ft.write(json.dumps({"page": page, **{k: v for k, v in r.items() if k != "axis_px"}}) + "\n")
            reps += [{"page": page, **r} for r in d.representatives]
            counts[page] = {**page_counts(d), "detached_truth_awns": d.detached_truth_awns}
            results[page] = (d, result)
            c = counts[page]
            print(page, " ".join(f"{k}={c[k]}" for k in ("paths", *CLASSES, "MISSED", "truth_awns")), flush=True)
    (out / "page_counts.json").write_text(json.dumps(counts, indent=1))
    (out / "representatives.json").write_text(json.dumps(reps, indent=1))
    summary = {"input": args.input, "split": args.split, **summarize(counts, reps)}
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: summary[k] for k in ("path_share", "missed_share_of_truth", "representative")}, indent=1))
    for page in summary["hardest_pages"][: args.figures]:
        d, result = results[page]
        figure(page, d, result, truth_instances(page, args.split), out / "figures" / f"{page}.jpg")


if __name__ == "__main__":
    main()
