"""Fit manual-protocol calibration for one method on training-page targets.

    PYTHONPATH=src python scripts/fit_protocol.py --method pfg
Requires runs/results/<method>/scored_rows_train.json (run_baseline.py --split train).
"""
import argparse
import json

from awnstudio.paths import REPO_ROOT, paths
from awnstudio.protocol import fit_protocol
from awnstudio.truth import POSITIVE_MM


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", required=True)
    args = parser.parse_args()
    rows = json.loads((paths().runs / "results" / args.method / "scored_rows_train.json").read_text())
    pairs = [(r["predicted_mm"], r["truth_mm"]) for r in rows if r["truth_mm"] >= POSITIVE_MM and r["predicted_mm"] is not None]
    protocol = fit_protocol([m for m, _ in pairs], [t for _, t in pairs])
    out = REPO_ROOT / "models" / f"protocol_{args.method}.json"
    out.write_text(json.dumps(protocol.to_json(), indent=1))
    print(args.method, protocol)


if __name__ == "__main__":
    main()
