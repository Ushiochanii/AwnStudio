"""Render the awn evidence graph of one page over the image (debug view).

    PYTHONPATH=src python scripts/render_graph.py IMG_9688 out.png [x1 y1 x2 y2]
"""
import sys

import cv2
import numpy as np

from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.detection import primary
from awnstudio.paths import paths


def main():
    page, out = sys.argv[1], sys.argv[2]
    crop = list(map(int, sys.argv[3:7])) if len(sys.argv) >= 7 else None
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    graph = build_graph(primary(obs), meta["width"], meta["height"])
    image = cv2.imread(str(paths().page_image(page)))
    tint = image.copy()
    tint[graph.evidence.astype(bool)] = (0.5 * tint[graph.evidence.astype(bool)] + (0, 90, 0)).astype(np.uint8)
    rng = np.random.default_rng(0)
    for e in graph.edges.values():
        color = tuple(int(c) for c in rng.integers(60, 255, 3))
        cv2.polylines(tint, [np.round(e.path).astype(np.int32)], False, color, 2)
    for n, (x, y) in graph.nodes.items():
        d = graph.degree(n)
        cv2.circle(tint, (int(x), int(y)), 5, (0, 0, 255) if d == 1 else (255, 0, 255), -1)
    if crop:
        x1, y1, x2, y2 = crop
        tint = tint[y1:y2, x1:x2]
    cv2.imwrite(out, tint)


if __name__ == "__main__":
    main()
