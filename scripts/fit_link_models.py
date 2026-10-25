"""Fit the tracing-decision models on training pages; report calibration on validation.

    PYTHONPATH=src python scripts/fit_link_models.py
Writes models/link_models.json (committed: small, reproducible from this script).
"""
from __future__ import annotations

import json

import numpy as np

from awnstudio.linking import FEATURES, calibration_report, fit
from awnstudio.paths import REPO_ROOT, paths


def load(split, kind):
    path = paths().runs / "linkdata" / split / f"{kind}.jsonl"
    return [r for r in map(json.loads, path.read_text().splitlines()) if r["known"]]


def main():
    models, reports = {}, {}
    for kind in FEATURES:
        train = load("train", kind)
        model, report = fit(kind, train)
        valid = load("valid", kind)
        p = np.asarray([model.prob(r) for r in valid])
        y = np.asarray([bool(r["label"]) for r in valid], float)
        reports[kind] = {"train": report, "valid": {"n": len(valid), "positives": int(y.sum()), **calibration_report(p, y)}}
        models[kind] = model.to_json()
        names = ["intercept", *FEATURES[kind][0]]
        print(f"== {kind}  train n={report['n']} pos={report['positives']}  "
              f"acc {report['accuracy@0.5']:.3f} auc {report['auc']:.3f} | "
              f"valid n={len(valid)} acc {reports[kind]['valid']['accuracy@0.5']:.3f} auc {reports[kind]['valid']['auc']:.3f}")
        print("   " + "  ".join(f"{n}={w:+.3f}" for n, w in zip(names, model.weights)))
        for row in reports[kind]["valid"]["reliability"]:
            print(f"   valid {row['bin']}: n={row['n']:4d} mean_p={row['mean_p']:.2f} freq={row['freq']:.2f}")
    out = REPO_ROOT / "models" / "link_models.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"models": models, "reports": reports}, indent=1))


if __name__ == "__main__":
    main()
