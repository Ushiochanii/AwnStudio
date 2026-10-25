"""Run a reconstruction method on cached detections and score it on validation truth.

    PYTHONPATH=src python scripts/run_baseline.py --method legacy
"""
from __future__ import annotations

import argparse
import json


from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.evaluate import format_summary, score_page, summarize
from awnstudio.paths import paths
from awnstudio.results import PageResult
from awnstudio.splits import VALIDATION_PAGES


def run_method(method: str, page: str) -> PageResult:
    observations, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    calibration = calibrate_cached(page)
    if method == "legacy":
        from awnstudio.baselines.legacy import run_legacy_page

        return run_legacy_page(page, observations, meta["width"], meta["height"], calibration)
    if method == "pfg":
        from awnstudio.pipeline import reconstruct_page

        return reconstruct_page(page, observations, meta["width"], meta["height"], calibration)
    raise ValueError(method)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", default="legacy")
    parser.add_argument("--pages", nargs="*", default=list(VALIDATION_PAGES))
    parser.add_argument("--reuse", action="store_true", help="score saved results without re-running")
    args = parser.parse_args()

    out_dir = paths().runs / "results" / args.method
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for page in args.pages:
        target = out_dir / f"{page}.json"
        if args.reuse and target.exists():
            result = PageResult.from_json(json.loads(target.read_text()))
        else:
            result = run_method(args.method, page)
            target.write_text(json.dumps(result.to_json()))
        page_rows = score_page(result)
        rows.extend(page_rows)
        print(format_summary(page, summarize(page_rows)), flush=True)
    summary = summarize(rows)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    (out_dir / "scored_rows.json").write_text(json.dumps([r.__dict__ for r in rows], indent=1))
    print(format_summary(f"ALL[{args.method}]", summary))


if __name__ == "__main__":
    main()
