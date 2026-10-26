"""Contact sheet of FALSE_LINK tip-overshoot cases (model input, valid): run after diagnose_reconstruction.py."""
import json, numpy as np, cv2, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
from awnstudio.paths import paths
from awnstudio.truth import truth_instances
from awnstudio.results import PageResult
base=paths().runs/"diagnosis/model_valid"
rows=[json.loads(l) for l in open(base/"paths.jsonl")]
sel=[r for r in rows if r["cls"]=="FALSE_LINK" and r["false_at_tip"]]
sel=sorted(sel,key=lambda r:-r["false_mm"])
pick=sel[::max(1,len(sel)//8)][:8]
fig,axes=plt.subplots(2,4,figsize=(16,10),dpi=110)
from awnstudio.cache import load_observations
from awnstudio.calibration import calibrate_cached
from awnstudio.pipeline import reconstruct_page
res_cache={}
for ax,r in zip(axes.flat,pick):
  p=r["page"]
  if p not in res_cache:
    obs,meta=load_observations(paths().runs/"detections"/f"{p}.json.gz")
    res_cache[p]=reconstruct_page(p,obs,meta["width"],meta["height"],calibrate_cached(p))
  path=np.asarray(res_cache[p].spikelets[r["spikelet"]].awns[r["awn"]].path_px)
  tip=path[-1]; x0,y0=int(tip[0]-90),int(tip[1]-60)
  img=cv2.imread(str(paths().page_image(p)))[:,:,::-1][max(0,y0):y0+240,max(0,x0):x0+180]
  ax.imshow(img,extent=(max(0,x0),max(0,x0)+img.shape[1],max(0,y0)+img.shape[0],max(0,y0)))
  for t in truth_instances(p,"valid"):
    if t.kind!="awn": continue
    for g in getattr(t.geometry,"geoms",[t.geometry]):
      x,y=g.exterior.xy; ax.plot(x,y,color="#1a9850",lw=1)
  ax.plot(path[:,0],path[:,1],color="#e41a1c",lw=1,alpha=0.8)
  ax.set_xlim(max(0,x0),max(0,x0)+img.shape[1]); ax.set_ylim(max(0,y0)+img.shape[0],max(0,y0))
  ax.set_title(f"{p}  over truth tip {r['false_mm']:.1f} mm",fontsize=10); ax.axis("off")
fig.suptitle("Tip overshoot (model input): red = reconstructed path, green = annotated awn outline",fontsize=13)
plt.tight_layout(); fig.savefig(paths().runs/"diagnosis/tip_overshoot_examples.jpg",pil_kwargs={"quality":85})
print(len(sel))
