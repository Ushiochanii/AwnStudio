"""Before/after table of two diagnosis snapshots (runs/diagnosis_<tag>/).

    PYTHONPATH=src python experiments/diagnosis/compare.py before step1
"""
import json
import sys

from awnstudio.paths import paths


def row(tag, name):
    s = json.loads((paths().runs / f"diagnosis_{tag}" / name / "summary.json").read_text())
    c, n, r = s["counts"], s["counts"]["paths"], s["representative"]
    return (f"{100 * c['OK'] / n:.1f} | {100 * c['SHORT'] / n:.1f} | {100 * c['JUMP'] / n:.1f} | "
            f"{100 * c['FALSE_LINK'] / n:.1f} | {c['MISSED']} | {c['duplicates']} | {r['mae_mm']:.2f} | "
            f"{r['bias_mm']:+.2f} | {100 * r['within_2mm']:.1f}")


def main(tags):
    print("| split | input | version | OK % | SHORT % | JUMP % | FALSE % | MISSED | dup | rep MAE | rep bias | rep <=2mm % |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for split in ("valid", "train"):
        for inp in ("model", "oracle_whole", "oracle_broken"):
            for tag in tags:
                print(f"| {split} | {inp} | {tag} | {row(tag, f'{inp}_{split}')} |")


if __name__ == "__main__":
    main(sys.argv[1:])
