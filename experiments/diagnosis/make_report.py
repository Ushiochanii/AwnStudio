"""Collect runs/diagnosis/* into experiments/diagnosis/ (summary table, json, figures).

    PYTHONPATH=src python experiments/diagnosis/make_report.py
"""
import json
import shutil
from collections import defaultdict
from pathlib import Path

import cv2
import shapely

from awnstudio.paths import paths
from awnstudio.truth import truth_instances

HERE = Path(__file__).parent
RUNS = paths().runs / "diagnosis"
INPUTS = ("model", "oracle_whole", "oracle_broken")
FIGURES = [("oracle_whole", "valid", "IMG_9753"), ("oracle_broken", "valid", "IMG_9753"),
           ("model", "valid", "IMG_9753"), ("model", "train", "IMG_9727")]


def touching_share(name, split):
    """Share of paths, per class, whose main truth awn touches another truth awn (<= 4 px)."""
    touch, stat = {}, defaultdict(lambda: [0, 0])
    for line in open(RUNS / name / "paths.jsonl"):
        r = json.loads(line)
        if r["main"] is None:
            continue
        if r["page"] not in touch:
            awns = [t.geometry for t in truth_instances(r["page"], split) if t.kind == "awn"]
            tree = shapely.STRtree(awns)
            touch[r["page"]] = [any(int(j) != k for j in tree.query(g.buffer(4), predicate="intersects"))
                                for k, g in enumerate(awns)]
        stat[r["cls"]][0] += touch[r["page"]][r["main"]]
        stat[r["cls"]][1] += 1
    return {k: (a, b) for k, (a, b) in stat.items()}


def main():
    lines = [
        "| split | input | paths | OK | SHORT (evidence continues / none) | JUMP | FALSE_LINK (tip overshoot / mid) "
        "| MISSED truth awns | duplicates | rep. MAE mm | rep. bias mm | rep. within 2 mm |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    touch_lines = ["| split | input | " + " | ".join(("OK", "SHORT", "JUMP", "FALSE_LINK")) + " |", "|---|---|---|---|---|---|"]
    hardest = {}
    for split in ("valid", "train"):
        for inp in INPUTS:
            name = f"{inp}_{split}"
            s = json.loads((RUNS / name / "summary.json").read_text())
            shutil.copy(RUNS / name / "summary.json", HERE / f"summary_{name}.json")
            shutil.copy(RUNS / name / "page_counts.json", HERE / f"page_counts_{name}.json")
            c, n, rep = s["counts"], s["counts"]["paths"], s["representative"]
            pct = lambda k: f"{c.get(k, 0)} ({100 * c.get(k, 0) / n:.1f}%)"
            fl_tip = sum(v for k, v in c.items() if k.startswith("FALSE_LINK:") and k.endswith("tip_overshoot"))
            lines.append(
                f"| {split} | {inp} | {n} | {pct('OK')} | {pct('SHORT')} "
                f"({c.get('SHORT:evidence_continues', 0)} / {c.get('SHORT:no_evidence', 0)}) | {pct('JUMP')} | "
                f"{pct('FALSE_LINK')} ({fl_tip} / {c.get('FALSE_LINK', 0) - fl_tip}) | "
                f"{c['MISSED']} / {c['truth_awns']} | {c['duplicates']} | {rep['mae_mm']:.2f} | {rep['bias_mm']:+.2f} | "
                f"{100 * rep['within_2mm']:.1f}% |"
            )
            if inp != "oracle_broken":
                t = touching_share(name, split)
                touch_lines.append(f"| {split} | {inp} | " + " | ".join(
                    f"{100 * t[k][0] / t[k][1]:.0f}% of {t[k][1]}" if k in t else "-" for k in ("OK", "SHORT", "JUMP", "FALSE_LINK")) + " |")
            hardest[name] = s["hardest_pages"]
    for inp, split, page in FIGURES:
        img = cv2.imread(str(RUNS / f"{inp}_{split}" / "figures" / f"{page}.jpg"))
        img = cv2.resize(img, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(HERE / f"{inp}_{split}_{page}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    shutil.copy(RUNS / "tip_overshoot_examples.jpg", HERE / "tip_overshoot_examples.jpg")
    (HERE / "tables.md").write_text(
        "## Path classes\n\n" + "\n".join(lines)
        + "\n\n## Paths whose truth awn touches another truth awn (<= 4 px)\n\n" + "\n".join(touch_lines)
        + "\n\n## Hardest pages (by SHORT + JUMP + FALSE_LINK + MISSED)\n\n"
        + "\n".join(f"- {k}: {', '.join(v[:10])}" for k, v in hardest.items()) + "\n",
        encoding="utf-8",
    )
    print((HERE / "tables.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
