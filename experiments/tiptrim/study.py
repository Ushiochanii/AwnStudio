"""Offline study of tip trimming by image appearance (model input, step-1 pipeline).

Phase "cache": per page, run the pipeline without trimming and store every awn path
sampled every SPACING_MM with appearance features and truth labels.
Phase "eval": fit a tip-region classifier on train (real awn tip vs. overshoot tail),
choose the per-sample bias b of the suffix rule on train by representative MAE, and
report train / valid.

Features per sample: CIELAB core (5 x 5 px), background ring (19-29 px) and core-ring, plus core
minus the median core of the path's own body (10-60% of its length): an awn's tip is
fainter than its body but keeps its hue, a grid line or tape edge does not.

    PYTHONPATH=src python experiments/tiptrim/study.py cache --split train
    PYTHONPATH=src python experiments/tiptrim/study.py eval

Result (step-1 pipeline, model input): tip-region AUC 0.71 train / 0.69 valid; the best
bias (1.5, chosen on train) changes representative MAE 1.607 -> 1.600 (train) and
1.753 -> 1.749 (valid). Colour cannot tell a faint real tip from a grid line or tape edge
reliably, so tip trimming by appearance was not adopted. A first, per-point version
(all pixels, sum of log-odds against a prior) trimmed real awns by ~17 mm.
"""
import argparse
import json
import pickle
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np
import shapely
from shapely.geometry import LineString

from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.diagnose import diagnose_page, truth_awns
from awnstudio.paths import paths
from awnstudio.pipeline import reconstruct_page
from awnstudio.splits import pages
from awnstudio.truth import truth_instances

SPACING_MM = 0.5
CORE_PX = 5
RING_INNER_PX = 19
RING_OUTER_PX = 29
FEATURE_NAMES = ("L", "a", "b", "L_bg", "a_bg", "b_bg", "dL", "da", "db")


def feature_maps(image_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(core mean, ring mean) CIELAB maps, float32 (h, w, 3)."""
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    core = cv2.blur(lab, (CORE_PX, CORE_PX))
    outer = cv2.blur(lab, (RING_OUTER_PX, RING_OUTER_PX)) * RING_OUTER_PX ** 2
    inner = cv2.blur(lab, (RING_INNER_PX, RING_INNER_PX)) * RING_INNER_PX ** 2
    ring = (outer - inner) / (RING_OUTER_PX ** 2 - RING_INNER_PX ** 2)
    return core, ring


def point_features(image_bgr: np.ndarray, points, maps=None) -> np.ndarray:
    points = np.asarray(points, float).reshape(-1, 2)
    if not len(points):
        return np.zeros((0, len(FEATURE_NAMES)))
    core, ring = maps if maps is not None else feature_maps(image_bgr)
    h, w = core.shape[:2]
    x = np.clip(np.round(points[:, 0]).astype(int), 0, w - 1)
    y = np.clip(np.round(points[:, 1]).astype(int), 0, h - 1)
    c, r = core[y, x], ring[y, x]
    return np.hstack([c, r, c - r]).astype(float)
OUT = paths().runs / "tiptrim"


def cache_page(job):
    page, split = job
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    cal = calibrate_cached(page)
    truth = truth_instances(page, split)
    result = reconstruct_page(page, obs, meta["width"], meta["height"], cal)
    evidence = shapely.union_all([o.geometry for o in primary(obs) if o.kind == "awn"])
    diag = diagnose_page(result, truth, evidence, cal)
    awns, spikelets = truth_awns(truth, cal)
    any_awn = shapely.union_all([a.mask for a in awns]) if awns else None
    maps = feature_maps(cv2.imread(str(paths().page_image(page))))
    mm = float(np.mean(cal.mm_per_px))
    by_awn = {(p.spikelet, p.awn): p for p in diag.paths}
    rows = []
    for si, s in enumerate(result.spikelets):
        for ai, a in enumerate(s.awns):
            d = by_awn.get((si, ai))
            if d is None:
                continue
            line = LineString(a.path_px)
            n = max(2, int(line.length * mm / SPACING_MM))
            pts = np.asarray([line.interpolate(t, normalized=True).coords[0] for t in np.linspace(0, 1, n)])
            main = awns[d.main].mask if d.main is not None else None
            rows.append({
                "spikelet": si, "awn": ai, "cls": d.cls, "detail": d.detail, "length_mm": a.length_mm,
                "main_len_mm": awns[d.main].length_mm if d.main is not None else None,
                "points": pts.astype(np.float32),
                "feat": point_features(None, pts, maps).astype(np.float32),
                "on_main": shapely.contains_xy(main, pts[:, 0], pts[:, 1]) if main is not None else np.zeros(len(pts), bool),
                "on_any": shapely.contains_xy(any_awn, pts[:, 0], pts[:, 1]) if any_awn is not None else np.zeros(len(pts), bool),
            })
    return page, {"paths": rows, "reps": diag.representatives, "mm_per_px": cal.mm_per_px}


def features(row):
    f = row["feat"]
    n = len(f)
    body = f[int(0.1 * n): max(int(0.1 * n) + 1, int(0.6 * n)), :3]
    rel = f[:, :3] - np.median(body, axis=0)
    return np.hstack([f, rel])


def fit_logistic(X, y, l2=1e-3):
    from scipy.optimize import minimize

    X1 = np.hstack([np.ones((len(X), 1)), X])
    sw = np.where(y > 0, 0.5 / max(1, y.sum()), 0.5 / max(1, (1 - y).sum()))

    def f(w):
        z = X1 @ w
        ll = sw * (y * -np.logaddexp(0, -z) + (1 - y) * -np.logaddexp(0, z))
        g = X1.T @ (sw * (y - 1 / (1 + np.exp(-z))))
        return -ll.sum() + l2 * (w[1:] @ w[1:]), -g + 2 * l2 * np.r_[0, w[1:]]

    return minimize(f, np.zeros(X1.shape[1]), jac=True, method="L-BFGS-B").x


def tip_samples(data):
    X, y = [], []
    for page in data.values():
        for r in page["paths"]:
            n = len(r["feat"])
            F = features(r)
            last_on = np.nonzero(r["on_main"])[0]
            if not len(last_on):
                continue
            last_on = last_on.max()
            tip_zone = np.arange(int(0.7 * n), last_on + 1)
            tip_zone = tip_zone[r["on_main"][tip_zone]]
            tail = np.arange(last_on + 1, n)
            tail = tail[~r["on_any"][tail]]
            X += [F[tip_zone], F[tail]]
            y += [np.ones(len(tip_zone)), np.zeros(len(tail))]
    return np.vstack(X), np.concatenate(y)


def trimmed_fraction(r, w, mu, sd, bias):
    """Fraction of the path kept by the suffix rule (1 = untouched)."""
    F = (features(r) - mu) / sd
    clutter = -(w[0] + F @ w[1:]) - bias
    suffix = np.cumsum(clutter[::-1])[::-1]
    suffix[0] = -np.inf  # never cut the whole path
    k = int(np.argmax(suffix))
    return 1.0 if suffix[k] <= 0 else k / (len(clutter) - 1)


def rep_mae(data, w, mu, sd, bias):
    errs = []
    for page in data.values():
        new = {}
        for r in page["paths"]:
            new.setdefault(r["spikelet"], []).append(r["length_mm"] * trimmed_fraction(r, w, mu, sd, bias))
        for rep in page["reps"]:
            if rep["pred_mm"] is None:
                continue
            errs.append(max(new.get(rep["pred_spikelet"], [rep["pred_mm"]])) - rep["truth_mm"])
    e = np.asarray(errs)
    return float(np.abs(e).mean()), float(e.mean()), float((np.abs(e) <= 2).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["cache", "eval"])
    ap.add_argument("--split", default="train")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.phase == "cache":
        cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
        data = {}
        with ProcessPoolExecutor(8) as pool:
            for page, d in pool.map(cache_page, [(p, a.split) for p in pages(a.split) if p in cached]):
                data[page] = d
        (OUT / f"{a.split}.pkl").write_bytes(pickle.dumps(data))
        return
    train = pickle.loads((OUT / "train.pkl").read_bytes())
    valid = pickle.loads((OUT / "valid.pkl").read_bytes())
    X, y = tip_samples(train)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    w = fit_logistic((X - mu) / sd, y)
    Xv, yv = tip_samples(valid)
    for name, XX, yy in (("train", X, y), ("valid", Xv, yv)):
        p = 1 / (1 + np.exp(-(w[0] + ((XX - mu) / sd) @ w[1:])))
        order = np.argsort(p)
        ranks = np.empty(len(p))
        ranks[order] = np.arange(1, len(p) + 1)
        n1, n0 = yy.sum(), len(yy) - yy.sum()
        print(f"{name} tip samples: tip {int(n1)} tail {int(n0)} AUC {(ranks[yy > 0].sum() - n1 * (n1 + 1) / 2) / (n1 * n0):.3f}")
    print("no trimming      train MAE %.3f bias %+.3f <=2 %.3f" % rep_mae(train, w, mu, sd, np.inf),
          "| valid MAE %.3f bias %+.3f <=2 %.3f" % rep_mae(valid, w, mu, sd, np.inf))
    best = None
    for bias in [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]:
        tr = rep_mae(train, w, mu, sd, bias)
        print(f"bias {bias:3.1f}  train MAE {tr[0]:.3f} bias {tr[1]:+.3f} <=2 {tr[2]:.3f}", end="")
        va = rep_mae(valid, w, mu, sd, bias)
        print(f" | valid MAE {va[0]:.3f} bias {va[1]:+.3f} <=2 {va[2]:.3f}")
        if best is None or tr[0] < best[1]:
            best = (bias, tr[0])
    print("chosen on train: bias", best[0])
    (OUT / "model.json").write_text(json.dumps({"mean": mu.tolist(), "std": sd.tolist(), "weights": w.tolist(),
                                                "bias": best[0], "spacing_mm": SPACING_MM}))


if __name__ == "__main__":
    main()
