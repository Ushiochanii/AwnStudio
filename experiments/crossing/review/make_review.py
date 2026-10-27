"""Review sheets for sibling crossings: straight through or bounce back?

Cases: on train pages (model input, current pipeline without repair), every two selected
awns of the SAME spikelet that enter one crossing cluster by different arms and leave it
by different arms. Of the two possible arm pairings, "straight" is the one with the
smaller summed squared deflection, "bounce" the other.

Per case three panels around the crossing: (a) image only, (b) the pairing implied by the
manual annotation (arms labelled with the one truth awn they lie on; "unknown" when an
arm is on no single truth awn), (c) the pairing the crossing repair would choose. In (b)
and (c) the two awns are red and blue. 12 cases per sheet; review.csv lists every case
with an empty user_verdict column (straight / bounce / unsure).

    PYTHONPATH=src python experiments/crossing/review/make_review.py
"""
import csv
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import shapely

from awnstudio.assembly import assemble
from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.crossings import _passes, _utility, core_clusters
from awnstudio.detection import primary
from awnstudio.events import arrive_dir, depart_dir
from awnstudio.geometry import angle_between
from awnstudio.labels import POLYGON_TOLERANCE_PX
from awnstudio.paths import paths
from awnstudio.pipeline import default_models
from awnstudio.spikelets import fuse_spikelets
from awnstudio.splits import pages
from awnstudio.tracer import Tracer
from awnstudio.truth import truth_instances

HERE = Path(__file__).parent
HALF_W, HALF_H = 90, 150  # crop half size around the crossing, px
PER_SHEET = 12
ARM_PX = 160  # how much of each arm is drawn


def page_cases(page):
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    obs = primary(obs)
    cal = calibrate_cached(page)
    sx, sy = cal.mm_per_px
    spk = fuse_spikelets(obs, meta["width"], meta["height"], sx * sy)
    g = build_graph(obs, meta["width"], meta["height"])
    tracer = Tracer(g, [s.geometry for s in spk], cal, default_models())
    choice = tracer.models["choice"]
    truth = truth_instances(page, "train")
    awn_polys = [t.geometry.buffer(POLYGON_TOLERANCE_PX) for t in truth if t.kind == "awn"]
    tree = shapely.STRtree(awn_polys)

    def identity(e):
        p = g.edges[e].path[:: max(1, len(g.edges[e].path) // 25)]
        geom = shapely.LineString(p) if len(p) > 1 else shapely.Point(p[0])
        fr = sorted(((shapely.contains_xy(awn_polys[int(k)], p[:, 0], p[:, 1]).mean(), int(k))
                     for k in tree.query(geom)), reverse=True)
        return fr[0][1] if fr and fr[0][0] >= 0.6 and (len(fr) < 2 or fr[1][0] <= 0.3) else None

    def d2(a, na, b, nb):
        da, db = arrive_dir(g, a, na, cal), depart_dir(g, b, nb, cal)
        return ((180.0 if da is None or db is None else angle_between(da, db)) / 90.0) ** 2

    def arm(e, node):  # the part of edge e next to `node`, ARM_PX long
        p = g.oriented_path(e, g.other(e, node))[::-1]  # starts at node
        s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))])
        return p[s <= ARM_PX]

    cluster = core_clusters(g)
    selected = assemble(tracer)
    passes = {k: _passes(g, cluster, sel.trace) for k, sel in enumerate(selected)}
    cases = []
    for k1 in range(len(selected)):
        for k2 in range(k1 + 1, len(selected)):
            if selected[k1].spikelet != selected[k2].spikelet:
                continue
            for c1, i1, j1 in passes[k1]:
                for c2, i2, j2 in passes[k2]:
                    t1, t2 = selected[k1].trace.edges, selected[k2].trace.edges
                    if c1 != c2:
                        continue
                    a1, a2, b1, b2 = t1[i1][0], t2[i2][0], t1[j1][0], t2[j2][0]
                    if a1 == a2 or b1 == b2:
                        continue
                    na1, na2, nb1, nb2 = g.other(*t1[i1]), g.other(*t2[i2]), t1[j1][1], t2[j2][1]
                    current = [(a1, na1, b1, nb1), (a2, na2, b2, nb2)]
                    alt = [(a1, na1, b2, nb2), (a2, na2, b1, nb1)]
                    straight, bounce = (current, alt) if sum(d2(*x) for x in current) <= sum(d2(*x) for x in alt) \
                        else (alt, current)
                    ids = {e: identity(e) for e in (a1, a2, b1, b2)}
                    truth_pair = None
                    for name, pairing in (("straight", straight), ("bounce", bounce)):
                        if all(ids[a] is not None and ids[a] == ids[b] for a, _, b, _ in pairing) and \
                                ids[pairing[0][0]] != ids[pairing[1][0]]:
                            truth_pair = name
                    u = lambda pairing: sum(_utility(g, cal, choice, *x) for x in pairing)
                    repair_pair = "straight" if u(straight) >= u(bounce) else "bounce"
                    centre = np.mean([g.nodes[n] for n in (na1, na2, nb1, nb2)], axis=0)
                    cases.append({
                        "page": page, "x": float(centre[0]), "y": float(centre[1]),
                        "truth_says": truth_pair or "unknown", "repair_says": repair_pair,
                        "pairings": {name: [(arm(a, na), arm(b, nb)) for a, na, b, nb in p]
                                     for name, p in (("straight", straight), ("bounce", bounce))},
                    })
    return cases


def panel(ax, img, case, pairing_name, title):
    x, y = int(case["x"]), int(case["y"])
    x0, y0 = max(0, x - HALF_W), max(0, y - HALF_H)
    x1, y1 = min(img.shape[1], x + HALF_W), min(img.shape[0], y + HALF_H)
    ax.imshow(img[y0:y1, x0:x1], extent=(x0, x1, y1, y0))
    if pairing_name in ("straight", "bounce"):
        for (pa, pb), color in zip(case["pairings"][pairing_name], ("#e41a1c", "#377eb8")):
            for p in (pa, pb):
                ax.plot(p[:, 0], p[:, 1], color=color, lw=1.6, alpha=0.75)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.set_title(title, fontsize=7)
    ax.axis("off")


def main():
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    cases = []
    with ProcessPoolExecutor(8) as pool:
        for c in pool.map(page_cases, [p for p in pages("train") if p in cached]):
            cases += c
    cases.sort(key=lambda c: (c["page"], c["y"], c["x"]))
    for k, c in enumerate(cases, start=1):
        c["id"] = k
    with open(HERE / "review.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["case", "page", "x", "y", "truth_says", "repair_says", "user_verdict"])
        for c in cases:
            w.writerow([c["id"], c["page"], round(c["x"]), round(c["y"]), c["truth_says"], c["repair_says"], ""])
    images = {}
    for start in range(0, len(cases), PER_SHEET):
        chunk = cases[start:start + PER_SHEET]
        fig, axes = plt.subplots(4, 9, figsize=(12, 4 * 2.9), dpi=100)
        for ax in axes.flat:
            ax.axis("off")
        for slot, c in enumerate(chunk):
            img = images.setdefault(c["page"], cv2.imread(str(paths().page_image(c["page"])))[:, :, ::-1])
            row, col = divmod(slot, 3)
            axs = axes[row, 3 * col: 3 * col + 3]
            panel(axs[0], img, c, None, f"#{c['id']} {c['page']}")
            panel(axs[1], img, c, c["truth_says"], f"annotation: {c['truth_says']}")
            panel(axs[2], img, c, c["repair_says"], f"repair: {c['repair_says']}")
        fig.suptitle("Sibling crossings: is it STRAIGHT through or BOUNCE back? (a) image, (b) annotation, "
                     "(c) repair; red / blue = the two awns", fontsize=9)
        plt.tight_layout(rect=(0, 0, 1, 0.97))
        fig.savefig(HERE / f"review_{start // PER_SHEET + 1:02d}.jpg", pil_kwargs={"quality": 85})
        plt.close(fig)
    print(len(cases), "cases;", {k: sum(c["truth_says"] == k for c in cases) for k in ("straight", "bounce", "unknown")},
          "repair:", {k: sum(c["repair_says"] == k for c in cases) for k in ("straight", "bounce")})


if __name__ == "__main__":
    main()
