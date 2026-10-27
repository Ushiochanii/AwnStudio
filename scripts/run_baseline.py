"""Run a reconstruction method on cached detections and score it on validation truth.

    PYTHONPATH=src python scripts/run_baseline.py --method legacy
"""
from __future__ import annotations

import argparse
import dataclasses
import json


from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detectors import DETECTORS, detector
from awnstudio.evaluate import format_summary, score_page, summarize
from awnstudio.protocol import load_protocol
from awnstudio.results import PageResult
from awnstudio.splits import VALIDATION_PAGES, pages
from awnstudio.truth import accession_mapping


def run_method(method: str, page: str, detector_id: str | None = None) -> PageResult:
    observations, meta = load_observations(detector(detector_id).detections_dir / f"{page}.json.gz")
    calibration = calibrate_cached(page, "median" if method == "legacy" else "lattice")
    if method == "legacy":
        from awnstudio.baselines.legacy import run_legacy_page

        return run_legacy_page(page, observations, meta["width"], meta["height"], calibration)
    if method.startswith("pfg"):
        from awnstudio.pipeline import reconstruct_page

        mode = method.split("_", 1)[1] if "_" in method else "assembly"
        return reconstruct_page(page, observations, meta["width"], meta["height"], calibration, mode=mode,
                                detector_id=detector_id)
    raise ValueError(method)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", default="legacy")
    parser.add_argument("--split", default="valid", choices=["valid", "train"])
    parser.add_argument("--pages", nargs="*")
    parser.add_argument("--reuse", action="store_true", help="score saved results without re-running")
    parser.add_argument("--detector", choices=sorted(DETECTORS))
    args = parser.parse_args()
    if not args.pages:
        args.pages = list(VALIDATION_PAGES) if args.split == "valid" else [
            p for p in pages("train") if p in accession_mapping()  # pages with readable accessions
        ]

    det = detector(args.detector)
    out_dir = det.results_dir(args.method)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for page in args.pages:
        target = out_dir / f"{page}.json"
        if args.reuse and target.exists():
            result = PageResult.from_json(json.loads(target.read_text()))
        else:
            result = run_method(args.method, page, args.detector)
            target.write_text(json.dumps(result.to_json()))
        page_rows = score_page(result, args.split)
        rows.extend(page_rows)
        print(format_summary(page, summarize(page_rows)), flush=True)
    summary = summarize(rows)
    (out_dir / f"summary_{args.split}.json").write_text(json.dumps(summary, indent=2))
    (out_dir / f"scored_rows_{args.split}.json").write_text(json.dumps([r.__dict__ for r in rows], indent=1))
    print(format_summary(f"ALL[{args.method}]", summary))
    protocol_path = det.protocol_path(args.method)
    if protocol_path.exists():
        protocol = load_protocol(protocol_path)
        calibrated = [dataclasses.replace(r, predicted_mm=protocol.apply(r.predicted_mm)) for r in rows]
        cal_summary = summarize(calibrated)
        (out_dir / f"summary_{args.split}_protocol.json").write_text(json.dumps(cal_summary, indent=2))
        print(format_summary(f"ALL[{args.method}+protocol a={protocol.intercept:.3f} b={protocol.slope:.4f}]", cal_summary))


if __name__ == "__main__":
    main()
