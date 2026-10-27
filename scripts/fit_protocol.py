"""Fit manual-protocol calibration for one method on training-page targets.

    PYTHONPATH=src python scripts/fit_protocol.py --method pfg [--detector ID]
Requires the method's scored_rows_train.json (run_baseline.py --split train); writes the
detector's protocol file (awnstudio.detectors).
"""
import argparse
import json

from awnstudio.detectors import DETECTORS, detector
from awnstudio.protocol import fit_protocol
from awnstudio.truth import POSITIVE_MM


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", required=True)
    parser.add_argument("--detector", choices=sorted(DETECTORS))
    args = parser.parse_args()
    det = detector(args.detector)
    rows = json.loads((det.results_dir(args.method) / "scored_rows_train.json").read_text())
    pairs = [(r["predicted_mm"], r["truth_mm"]) for r in rows if r["truth_mm"] >= POSITIVE_MM and r["predicted_mm"] is not None]
    protocol = fit_protocol([m for m, _ in pairs], [t for _, t in pairs])
    out = det.protocol_path(args.method)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(protocol.to_json(), indent=1))
    print(args.method, protocol)


if __name__ == "__main__":
    main()
