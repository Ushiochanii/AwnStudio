"""Render one spikelet's reconstructed awns without / with crossing repair.

    PYTHONPATH=src python experiments/crossing/render_case.py IMG_9747 2370 879 2300 120 2500 830
(page, a point near the spikelet, crop box x0 y0 x1 y1)
"""
import sys
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from shapely.geometry import Point

import awnstudio.pipeline as pipeline
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.paths import paths

page = sys.argv[1]
here = Point(float(sys.argv[2]), float(sys.argv[3]))
x0, y0, x1, y1 = map(int, sys.argv[4:8])
obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
cal = calibrate_cached(page)
img = cv2.imread(str(paths().page_image(page)))[y0:y1, x0:x1, ::-1]
fig, axes = plt.subplots(1, 2, figsize=(9, 12), dpi=120)
for ax, repaired in zip(axes, (False, True)):
    pipeline.REPAIR_CROSSINGS = repaired
    result = pipeline.reconstruct_page(page, obs, meta["width"], meta["height"], cal)
    s = min(result.spikelets, key=lambda s: s.geometry.centroid.distance(here))
    ax.imshow(img, extent=(x0, x1, y1, y0))
    for k, (w, color) in enumerate(zip(s.awns, ("#377eb8", "#c51b7d", "#ff7f00", "#4daf4a"))):
        p = np.asarray(w.path_px)
        ax.plot(p[:, 0], p[:, 1], color=color, lw=2.4 if k == s.representative else 1.4,
                label=f"{w.length_mm:.1f} mm" + (" (reported)" if k == s.representative else ""))
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.axis("off")
    ax.legend(loc="upper right", fontsize=9)
    ax.set_title(("with" if repaired else "without") + " crossing repair")
plt.tight_layout()
out = Path(__file__).parent / f"repair_{page}.jpg"
fig.savefig(out, pil_kwargs={"quality": 90})
print(out)
