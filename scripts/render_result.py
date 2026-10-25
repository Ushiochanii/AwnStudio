"""Debug view: evidence graph + reconstructed awns of one page (optionally cropped
around one spikelet).

    PYTHONPATH=src python scripts/render_result.py pfg IMG_9712 out.png [S036]
"""
import json
import sys

import cv2
import numpy as np

from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.detection import primary
from awnstudio.paths import paths
from awnstudio.results import PageResult
from awnstudio.truth import truth_instances
from awnstudio.splits import split_of_page


def main():
    method, page, out = sys.argv[1:4]
    focus = sys.argv[4] if len(sys.argv) > 4 else None
    result = PageResult.from_json(json.loads((paths().runs / "results" / method / f"{page}.json").read_text()))
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    graph = build_graph(primary(obs), meta["width"], meta["height"])
    img = cv2.imread(str(paths().page_image(page)))
    ev = graph.evidence.astype(bool)
    img[ev] = (0.55 * img[ev] + (0, 80, 0)).astype(np.uint8)
    for t in truth_instances(page, split_of_page()[page]):
        if t.kind == "awn":
            for g in getattr(t.geometry, "geoms", [t.geometry]):
                cv2.polylines(img, [np.round(np.asarray(g.exterior.coords)).astype(np.int32)], True, (255, 200, 0), 1)
    for e in graph.edges.values():
        cv2.polylines(img, [np.round(e.path).astype(np.int32)], False, (0, 160, 255), 1)
    for n, (x, y) in graph.nodes.items():
        cv2.circle(img, (int(x), int(y)), 4, (0, 0, 255) if graph.degree(n) == 1 else (255, 0, 255), -1)
    box = None
    for s in result.spikelets:
        for g in getattr(s.geometry, "geoms", [s.geometry]):
            cv2.polylines(img, [np.round(np.asarray(g.exterior.coords)).astype(np.int32)], True, (255, 0, 0), 2)
        for k, a in enumerate(s.awns):
            color = (0, 0, 255) if k == s.representative else (0, 255, 255)
            cv2.polylines(img, [np.round(np.asarray(a.path_px)).astype(np.int32)], False, color, 2)
        x, y = s.geometry.centroid.coords[0]
        cv2.putText(img, f"{s.id} {s.length_mm or 0:.1f}", (int(x) - 40, int(y) + 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 200), 2)
        if s.id == focus:
            pts = np.vstack([np.asarray(s.geometry.envelope.exterior.coords)] + [np.asarray(a.path_px) for a in s.awns])
            x1, y1 = pts.min(axis=0) - 250
            x2, y2 = pts.max(axis=0) + 250
            box = [max(0, int(x1)), max(0, int(y1)), int(x2), int(y2)]
    if box:
        img = img[box[1]:box[3], box[0]:box[2]]
    cv2.imwrite(out, img)


if __name__ == "__main__":
    main()
