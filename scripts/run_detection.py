"""Run tiled detection once per page and cache the raw observations.

    PYTHONPATH=src python scripts/run_detection.py --split valid train
Locked test pages are refused unless --allow-test is given.
"""
from __future__ import annotations

import argparse
import hashlib
import time

import cv2

from awnstudio.cache import save_observations
from awnstudio.detection import OBSERVATION_FLOOR, TiledSegmenter
from awnstudio.paths import paths
from awnstudio.splits import TEST_PAGES, pages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", nargs="+", default=["valid"])
    parser.add_argument("--pages", nargs="*")
    parser.add_argument("--device", default="0")
    parser.add_argument("--allow-test", action="store_true")
    args = parser.parse_args()

    todo = list(args.pages or [p for s in args.split for p in pages(s)])
    if not args.allow_test and set(todo) & set(TEST_PAGES):
        raise SystemExit("refusing to touch locked test pages without --allow-test")

    out_dir = paths().runs / "detections"
    weights_sha = hashlib.sha256(paths().weights.read_bytes()).hexdigest()
    segmenter = TiledSegmenter(paths().weights, device=args.device)
    for page in todo:
        target = out_dir / f"{page}.json.gz"
        if target.exists():
            continue
        started = time.perf_counter()
        image = cv2.imread(str(paths().page_image(page)))
        observations = segmenter.predict_page(image)
        save_observations(
            target,
            observations,
            {
                "page_id": page,
                "width": image.shape[1],
                "height": image.shape[0],
                "weights_sha256": weights_sha,
                "confidence_floor": OBSERVATION_FLOOR,
            },
        )
        print(f"{page} {len(observations)} obs {time.perf_counter() - started:.1f}s", flush=True)


if __name__ == "__main__":
    main()
