"""Compare Claude's by-eye awn polylines against the COCO ground truth for one crop."""
import json
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.optimize import linear_sum_assignment
from skimage.morphology import skeletonize

HERE = Path(__file__).parent
TOL = 12  # px tolerance (original resolution) for a centerline to count as "on" an awn
# GT labels only the crop's own grid cell (between the two vertical rules);
# spikes at the left/right edges belong to neighbouring column crops.
CELL_X = (242, 900)

gt = json.loads((HERE / "gt.json").read_text())
img_info = gt["images"][0]
W, H = img_info["width"], img_info["height"]
img = cv2.cvtColor(cv2.imread(str(HERE / img_info["file_name"])), cv2.COLOR_BGR2RGB)

pred_raw = json.loads((HERE / "claude_awns.json").read_text())
s = pred_raw["display_scale"]
preds_all = [np.array(p, float) * s for p in pred_raw["awns"]]
in_cell = lambda p: CELL_X[0] <= p[:, 0].mean() <= CELL_X[1]
preds = [p for p in preds_all if in_cell(p)]
preds_out = [p for p in preds_all if not in_cell(p)]


def poly_mask(seg):
    m = np.zeros((H, W), np.uint8)
    for poly in seg:
        cv2.fillPoly(m, [np.array(poly, np.int32).reshape(-1, 2)], 1)
    return m


def line_mask(p, th=1):
    m = np.zeros((H, W), np.uint8)
    cv2.polylines(m, [p.astype(np.int32)], False, 1, th)
    return m


def skel_len(sk):
    ys, xs = np.nonzero(sk)
    pts = set(zip(ys, xs))
    L = 0.0
    for y, x in pts:
        for dy, dx, w in ((0, 1, 1), (1, 0, 1), (1, 1, 2**0.5), (1, -1, 2**0.5)):
            if (y + dy, x + dx) in pts:
                L += w
    return L


gt_awns = [a for a in gt["annotations"] if a["category_id"] == 1]
gt_masks = [poly_mask(a["segmentation"]) for a in gt_awns]
gt_skels = [skeletonize(m > 0).astype(np.uint8) for m in gt_masks]
gt_lens = [skel_len(k) for k in gt_skels]
pred_lines = [line_mask(p) for p in preds]
pred_lens = [float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1))) for p in preds]

kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * TOL + 1, 2 * TOL + 1))
gt_dil = [cv2.dilate(m, kern) for m in gt_masks]
pred_dil = [cv2.dilate(l, kern) for l in pred_lines]

# pairwise score: mean of (pred centerline on GT) and (GT skeleton covered by pred)
S = np.zeros((len(preds), len(gt_awns)))
for i, (l, ld) in enumerate(zip(pred_lines, pred_dil)):
    for j, (gd, k) in enumerate(zip(gt_dil, gt_skels)):
        prec = (l & gd).sum() / max(l.sum(), 1)
        rec = (k & ld).sum() / max(k.sum(), 1)
        S[i, j] = 2 * prec * rec / max(prec + rec, 1e-9)
ri, ci = linear_sum_assignment(-S)
matches = [(i, j, S[i, j]) for i, j in zip(ri, ci) if S[i, j] >= 0.5]

# pixel-level (centerline) precision / recall over the cell
union_gt = np.clip(sum(gt_dil), 0, 1)
union_pred_line = np.clip(sum(pred_lines), 0, 1)
union_pred_dil = np.clip(sum(pred_dil), 0, 1)
union_skel = np.clip(sum(gt_skels), 0, 1)
px_prec = (union_pred_line & union_gt).sum() / union_pred_line.sum()
px_rec = (union_skel & union_pred_dil).sum() / union_skel.sum()

rows = []
for i, j, sc in matches:
    rows.append((j, gt_lens[j], pred_lens[i], sc))
rows.sort(key=lambda r: (gt_awns[r[0]]["bbox"][1] // 600, gt_awns[r[0]]["bbox"][0]))
len_err = [abs(p - g) / g for _, g, p, _ in rows]
report = {
    "gt_awns": len(gt_awns),
    "pred_awns_in_cell": len(preds),
    "pred_awns_outside_cell": len(preds_out),
    "matched": len(matches),
    "instance_precision": len(matches) / len(preds),
    "instance_recall": len(matches) / len(gt_awns),
    "centerline_precision": float(px_prec),
    "centerline_recall": float(px_rec),
    "tolerance_px": TOL,
    "length_mape": float(np.mean(len_err)) if len_err else None,
    "length_pairs_px": [
        {"gt_id": gt_awns[j]["id"], "gt_len": round(g), "claude_len": round(p), "match": round(sc, 2)}
        for j, g, p, sc in rows
    ],
}
(HERE / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

# ---------- figure ----------
matched_pred = {i for i, _, _ in matches}
matched_gt = {j for _, j, _ in matches}
fig, axes = plt.subplots(1, 4, figsize=(20, 11.5), dpi=110)
titles = ["Original", f"Ground truth ({len(gt_awns)} awns)", f"Claude by eye ({len(preds)} awns in cell)", "Comparison"]
for ax, t in zip(axes, titles):
    ax.imshow(img)
    ax.set_title(t, fontsize=15)
    ax.axis("off")
    if t != "Original":
        for x in CELL_X:
            ax.axvline(x, color="0.4", ls=":", lw=1)

for j, m in enumerate(gt_masks):
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    for c in cs:
        c = c[:, 0]
        axes[1].fill(c[:, 0], c[:, 1], color="#1a9850", alpha=0.55, lw=0)
        axes[1].plot(c[:, 0], c[:, 1], color="#1a9850", lw=1.2)
        col = "#1a9850" if j in matched_gt else "#d73027"
        axes[3].fill(c[:, 0], c[:, 1], color=col, alpha=0.55, lw=0)
for i, p in enumerate(preds):
    axes[2].plot(p[:, 0], p[:, 1], color="#c51b7d", lw=2.2)
    col = "#2166ac" if i in matched_pred else "#ff7f00"
    axes[3].plot(p[:, 0], p[:, 1], color=col, lw=1.8)
for p in preds_out:
    axes[2].plot(p[:, 0], p[:, 1], color="#c51b7d", lw=2.2, ls="--", alpha=0.6)

from matplotlib.lines import Line2D
from matplotlib.patches import Patch
axes[3].legend(
    handles=[
        Patch(color="#1a9850", alpha=0.6, label="GT awn found"),
        Patch(color="#d73027", alpha=0.6, label="GT awn missed"),
        Line2D([], [], color="#2166ac", lw=2, label="Claude line, matched"),
        Line2D([], [], color="#ff7f00", lw=2, label="Claude line, false positive"),
    ],
    loc="lower right", fontsize=10, framealpha=0.9,
)
fig.suptitle(
    f"{img_info['file_name']}  |  instance P={report['instance_precision']:.2f} R={report['instance_recall']:.2f}"
    f"  |  centerline P={px_prec:.2f} R={px_rec:.2f} (±{TOL}px)"
    + (f"  |  length error {report['length_mape']*100:.1f}%" if len_err else ""),
    fontsize=15,
)
plt.tight_layout()
fig.savefig(HERE / "compare.png", bbox_inches="tight")
