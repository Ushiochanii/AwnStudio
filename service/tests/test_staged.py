"""The staged reconstruction must reproduce awnstudio.pipeline.reconstruct_page.

Needs the cached detections under runs/ (skipped otherwise):
    PYTHONPATH=src python -m unittest discover -s service/tests
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "service"))
sys.path.insert(0, str(ROOT / "src"))

PAGE = "IMG_9687"
DETECTIONS = ROOT / "runs" / "detections" / f"{PAGE}.json.gz"


@unittest.skipUnless(DETECTIONS.exists(), "cached detections not available")
class StagedTest(unittest.TestCase):
    def test_same_result_as_pipeline(self):
        from awnstudio.cache import load_observations
        from awnstudio.calibration import calibrate_cached
        from awnstudio.pipeline import reconstruct_page
        from staged import reconstruct_staged

        observations, meta = load_observations(DETECTIONS)
        calibration = calibrate_cached(PAGE)
        args = (PAGE, observations, meta["width"], meta["height"], calibration)
        expected = reconstruct_page(*args).to_json()
        started = time.perf_counter()
        page, stages = reconstruct_staged(*args)
        elapsed = time.perf_counter() - started
        self.assertEqual(json.dumps(page.to_json(), sort_keys=True), json.dumps(expected, sort_keys=True))

        chosen = sum(len(s["awns"]) for s in expected["spikelets"])
        self.assertEqual(sum(len(v) for v in stages["growth"].values()), chosen)
        self.assertGreater(len(stages["evidence"]), 0)
        self.assertTrue(all(item["rings"] for item in stages["evidence"]))
        for items in stages["alternatives"].values():
            for item in items:
                self.assertGreaterEqual(len(item["path"]), 2)
        for awns in stages["growth"].values():
            for awn in awns:
                self.assertTrue(awn["hops"])
        print(f"\nstaged reconstruction {elapsed:.1f} s, timings {stages['timings']}, "
              f"evidence json {len(json.dumps(stages['evidence'])) // 1024} KiB")


if __name__ == "__main__":
    unittest.main()
