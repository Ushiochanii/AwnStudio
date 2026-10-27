"""Print the evidence graph around one spikelet's traces (debug a crossing).

    PYTHONPATH=src python experiments/crossing/inspect_case.py IMG_9747 51.0 [x y]
(the reported length finds the spikelet; with x y the spikelet nearest that page point is used)
"""
import sys

import numpy as np

from awnstudio.assembly import assemble
from awnstudio.awngraph import build_graph
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.detection import primary
from awnstudio.measurement import measure_path_mm, trim_root
from awnstudio.paths import paths
from awnstudio.pipeline import default_models
from awnstudio.spikelets import fuse_spikelets
from awnstudio.tracer import Tracer

page, target = sys.argv[1], float(sys.argv[2])
obs, meta = load_observations(paths().runs / "detections" / f"{page}.json.gz")
obs = primary(obs)
cal = calibrate_cached(page)
sx, sy = cal.mm_per_px
spk = fuse_spikelets(obs, meta["width"], meta["height"], sx * sy)
g = build_graph(obs, meta["width"], meta["height"])
tracer = Tracer(g, [s.geometry for s in spk], cal, default_models())
chosen = assemble(tracer)
lengths = {}
for sel in chosen:
    path = trim_root(tracer.trace_path(sel.trace).tolist(), spk[sel.spikelet].geometry)
    lengths.setdefault(sel.spikelet, []).append((measure_path_mm(path, cal), sel))
if len(sys.argv) >= 5:
    from shapely.geometry import Point

    here = Point(float(sys.argv[3]), float(sys.argv[4]))
    s = min(lengths, key=lambda k: spk[k].geometry.centroid.distance(here))
else:
    s = min(lengths, key=lambda k: min(abs(L - target) for L, _ in lengths[k]))
print("spikelet", s, "at", np.round(spk[s].geometry.centroid.coords[0]))
for L, sel in lengths[s]:
    print(f"awn {L:.1f} mm  p_root {sel.p_root:.2f}  trace prob {sel.trace.prob:.3f}")
    for e, start in sel.trace.edges:
        end = g.other(e, start)
        print(f"   edge {e:5d} {tracer.edge_len[e]:6.2f} mm  {start}(deg {g.degree(start)}) -> {end}(deg {g.degree(end)})"
              f"  support {sorted(g.edges[e].support)[:6]}")
    last = sel.trace.edges
    for (e, start) in last:
        node = g.other(e, start)
        jopts, _ = tracer.options.get((e, node), ([], []))
        for o in jopts:
            print(f"      at node {node} from {e}: -> {o.b} deflection {o.deflection_deg:5.1f}  shared {o.shared_support:.2f}")

for e in sorted({e for _, sel in lengths[s] for e, _ in sel.trace.edges} | {27, 29}):
    ed = g.edges.get(e)
    if ed is None:
        continue
    ru, rv = (float(g.distance[int(round(g.nodes[n][1])), int(round(g.nodes[n][0]))]) for n in (ed.u, ed.v))
    print(f"edge {e}: {ed.length_px:.1f} px, half-width {ed.half_width_px:.1f} px, node radii {ru:.1f} / {rv:.1f}, "
          f"nodes {ed.u}(deg {g.degree(ed.u)}) {ed.v}(deg {g.degree(ed.v)})")
