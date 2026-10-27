"""Zoomed view of one crossing: raw image beside the two annotated awns in distinct colours.

    PYTHONPATH=src python experiments/crossing/zoom_case.py IMG_9747 train 2300 120 2500 820 IMG_9747:4674 IMG_9747:4684
"""
import sys
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from awnstudio.paths import paths
from awnstudio.truth import truth_instances

page, split = sys.argv[1], sys.argv[2]
x0, y0, x1, y1 = map(int, sys.argv[3:7])
ids = sys.argv[7:]
img = cv2.imread(str(paths().page_image(page)))[y0:y1, x0:x1, ::-1]
truth = {t.id: t for t in truth_instances(page, split)}
fig, axes = plt.subplots(1, 2, figsize=(9, 12), dpi=120)
for ax in axes:
    ax.imshow(img, extent=(x0, x1, y1, y0))
    ax.axis("off")
axes[0].set_title(f"{page}: original")
for tid, color in zip(ids, ("#e41a1c", "#377eb8", "#4daf4a", "#984ea3")):
    g = truth[tid].geometry
    for part in getattr(g, "geoms", [g]):
        gx, gy = part.exterior.xy
        axes[1].plot(gx, gy, color=color, lw=1.2, label=tid)
axes[1].legend(loc="upper right", fontsize=8)
axes[1].set_title("annotated awns (one colour per awn)")
plt.tight_layout()
out = Path(__file__).parent / f"zoom_{page}.jpg"
fig.savefig(out, pil_kwargs={"quality": 90})
print(out)
