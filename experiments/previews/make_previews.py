"""Before / after preview sheets of hard stitching cases (model input, valid + train pages).

Categories, selected automatically from the truth polygons:
* crossing     - an awn of the spikelet intersects an awn of a DIFFERENT spikelet;
* curved       - the spikelet's most curved awn (lowest chord / arc ratio), most curved first;
* side_by_side - two sibling awns lie within 4 px of each other over >= 10 mm.

Before = assembly of commit 3f7c477 (baseline), after = current assembly. Each example
is drawn as two panels on the original image: thin green = truth awn outlines, coloured =
reconstructed awns of the matched spikelet, thick = representative (reported) awn. Lengths
are raw pipeline lengths (before the protocol calibration). Per category the sheet shows
one example improved by the change, successes and failures (|error| > 2 mm after), picked
at random (fixed seed) within each group.

    git show 3f7c477:src/awnstudio/assembly.py > runs/assembly_3f7c477.py
    PYTHONPATH=src python experiments/previews/make_previews.py
"""
import importlib.util
import random
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import shapely

import awnstudio.pipeline as pipeline
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.diagnose import diagnose_page, truth_awns
from awnstudio.paths import REPO_ROOT, paths
from awnstudio.splits import pages
from awnstudio.truth import truth_instances

HERE = Path(__file__).parent
MARGIN_PX = 250
SIDE_PX, SIDE_MM = 4.0, 10.0
COLORS = ["#2166ac", "#c51b7d", "#ff7f00", "#6a3d9a", "#33a02c"]
CLS_COLOR = {"OK": "#1a9850", "SHORT": "#ff7f00", "JUMP": "#c51b7d", "FALSE_LINK": "#d73027", None: "0.3"}


def _old_assemble():
    spec = importlib.util.spec_from_file_location("awnstudio.assembly_3f7c477", REPO_ROOT / "runs" / "assembly_3f7c477.py")
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "awnstudio"
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.assemble


def _run(page, obs, meta, cal, assemble):
    current = pipeline.assemble
    pipeline.assemble = assemble
    try:
        return pipeline.reconstruct_page(page, obs, meta["width"], meta["height"], cal)
    finally:
        pipeline.assemble = current


def page_cases(job):
    page, split = job
    obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
    cal = calibrate_cached(page)
    mm = float(np.mean(cal.mm_per_px))
    truth = truth_instances(page, split)
    awns, spikelets = truth_awns(truth, cal)
    evidence = shapely.union_all([o.geometry for o in primary(obs) if o.kind == "awn"])
    results, diags = {}, {}
    for version, assemble in (("before", _old_assemble()), ("after", pipeline.assemble)):
        results[version] = _run(page, obs, meta, cal, assemble)
        diags[version] = diagnose_page(results[version], truth, evidence, cal)

    def rep_of(version, t):
        for r in diags[version].representatives:
            if r["truth_spikelet"] == t:
                s = results[version].spikelets[r["pred_spikelet"]]
                cls = {(p.spikelet, p.awn): p.cls for p in diags[version].paths}
                return {"spikelet": s, "pred_mm": r["pred_mm"], "truth_mm": r["truth_mm"],
                        "cls": cls.get((r["pred_spikelet"], s.representative))}
        return None

    cases = []
    for t in range(len(spikelets)):
        own = [a for a in awns if a.spikelet == t and a.axis is not None]
        if not own:
            continue
        b, a = rep_of("before", t), rep_of("after", t)
        if b is None or a is None or b["pred_mm"] is None or a["pred_mm"] is None:
            continue
        others = [x for x in awns if x.spikelet is not None and x.spikelet != t]
        cats = {}
        if any(x.geometry.intersects(o.geometry) for x in own for o in others):
            cats["crossing"] = 1.0
        ratio = min(x.axis.length and np.linalg.norm(np.subtract(x.axis.coords[-1], x.axis.coords[0])) / x.axis.length
                    for x in own)
        if ratio < 0.97:
            cats["curved"] = 1.0 - ratio
        for i in range(len(own)):
            for j in range(i + 1, len(own)):
                near = own[i].axis.intersection(own[j].geometry.buffer(SIDE_PX))
                if near.length * mm >= SIDE_MM:
                    cats["side_by_side"] = max(cats.get("side_by_side", 0.0), near.length * mm)
        if cats:
            cases.append({"page": page, "split": split, "truth_spikelet": t, "cats": cats, "before": b, "after": a,
                          "own": [x.geometry for x in own], "spikelet_geom": spikelets[t],
                          "truth_awns": [x.geometry for x in awns]})
    return cases


def draw(ax, img, case, version, box):
    x0, y0, x1, y1 = box
    ax.imshow(img[y0:y1, x0:x1], extent=(x0, x1, y1, y0))
    window = shapely.box(x0, y0, x1, y1)
    for g in case["truth_awns"]:
        if g.intersects(window):
            for part in getattr(g, "geoms", [g]):
                gx, gy = part.exterior.xy
                ax.plot(gx, gy, color="#1a9850", lw=0.6)
    r = case[version]
    for k, w in enumerate(r["spikelet"].awns):
        p = np.asarray(w.path_px)
        thick = k == r["spikelet"].representative
        ax.plot(p[:, 0], p[:, 1], color=COLORS[k % len(COLORS)], lw=2.6 if thick else 1.2, alpha=0.9)
    err = r["pred_mm"] - r["truth_mm"]
    ax.set_title(f"{version}: measured {r['pred_mm']:.1f} mm ({err:+.1f})  [{r['cls']}]", fontsize=11,
                 color=CLS_COLOR.get(r["cls"], "0.3") if abs(err) > 2 else "black")
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.axis("off")


def crop_box(case, shape):
    geoms = [*case["own"], case["spikelet_geom"]]
    for version in ("before", "after"):
        for w in case[version]["spikelet"].awns:
            geoms.append(shapely.LineString(w.path_px))
    x0, y0, x1, y1 = shapely.union_all(geoms).bounds
    return (int(max(0, x0 - MARGIN_PX)), int(max(0, y0 - MARGIN_PX)),
            int(min(shape[1], x1 + MARGIN_PX)), int(min(shape[0], y1 + MARGIN_PX)))


def pick(pool, n=4, seed=0):
    rng = random.Random(seed)
    err = lambda c, v: abs(c[v]["pred_mm"] - c[v]["truth_mm"])
    improved = [c for c in pool if err(c, "before") > 2 and err(c, "after") <= 2]
    success = [c for c in pool if err(c, "after") <= 2 and c not in improved]
    failure = [c for c in pool if err(c, "after") > 2]
    chosen = []
    for name, group, k in (("improved", improved, 1), ("success", success, 1), ("failure", failure, 2)):
        chosen += [(c, name) for c in rng.sample(group, min(k, len(group)))]
    rest = [c for c in success if all(c is not x for x, _ in chosen)]
    chosen += [(c, "success") for c in rng.sample(rest, min(n - len(chosen), len(rest)))]
    return chosen[:n], {"improved": len(improved), "success": len(success), "failure": len(failure)}


def sheet(category, pool, target):
    chosen, counts = pick(pool)
    fig, axes = plt.subplots(len(chosen), 2, figsize=(18, 7.5 * len(chosen)), dpi=100)
    axes = np.atleast_2d(axes)
    images = {}
    lines = []
    for row, (case, group) in zip(axes, chosen):
        img = images.setdefault(case["page"], cv2.imread(str(paths().page_image(case["page"])))[:, :, ::-1])
        box = crop_box(case, img.shape)
        for ax, version in zip(row, ("before", "after")):
            draw(ax, img, case, version, box)
        truth_mm = case["after"]["truth_mm"]
        row[0].text(0.01, 0.99, f"{case['page']} ({case['split']})  {category}  [{group}]\n"
                                f"truth longest awn {truth_mm:.1f} mm", transform=row[0].transAxes, va="top",
                    fontsize=12, bbox=dict(facecolor="white", alpha=0.85))
        lines.append(f"{case['page']} ({case['split']}), {group}: truth {truth_mm:.1f} mm, before "
                     f"{case['before']['pred_mm']:.1f} [{case['before']['cls']}], after {case['after']['pred_mm']:.1f} "
                     f"[{case['after']['cls']}]")
    fig.suptitle(f"{category.replace('_', ' ')}: {len(pool)} spikelets on valid + train pages; after the change "
                 f"{counts['success'] + counts['improved']} within 2 mm ({counts['improved']} of them fixed by it), "
                 f"{counts['failure']} off by > 2 mm\n"
                 "green = annotated awns, coloured = reconstructed awns of the spikelet, thick = reported (longest) awn; "
                 "lengths before protocol calibration", fontsize=13)
    plt.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(target, pil_kwargs={"quality": 85})
    plt.close(fig)
    return lines


def main():
    cached = {p.name.split(".")[0] for p in (paths().runs / "detections").glob("*.json.gz")}
    jobs = [(p, s) for s in ("valid", "train") for p in pages(s) if p in cached]
    cases = []
    with ProcessPoolExecutor(8) as pool:
        for c in pool.map(page_cases, jobs):
            cases += c
    for category in ("crossing", "curved", "side_by_side"):
        pool_ = [c for c in cases if category in c["cats"]]
        if category == "curved":  # the strongest bends
            pool_ = sorted(pool_, key=lambda c: -c["cats"]["curved"])[:40]
        target = HERE / f"preview_{category}.jpg"
        print(f"== {target.name}")
        for line in sheet(category, pool_, target):
            print("   " + line)


if __name__ == "__main__":
    main()
