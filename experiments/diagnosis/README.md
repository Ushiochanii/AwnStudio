# Reconstruction diagnosis: where do stitching errors come from?

Tool: `src/awnstudio/diagnose.py`, `scripts/diagnose_reconstruction.py` (tests: `tests/test_diagnose.py`).
Pipeline: `pipeline.reconstruct_page(mode="assembly")` at commit 3f7c477, lattice calibration.
Truth: reviewed whole-awn polygons (`truth_instances`); no ImageJ / accession mapping is needed.
Note: `models/link_models.json` was fit on train pages (small logistic models with 4 features each), so train numbers are only mildly optimistic.

Each reconstructed path is classified with a 2 mm evaluation threshold on contiguous runs:
OK, SHORT (truth tip missing beyond the last covered point), JUMP (runs along another truth awn),
FALSE_LINK (runs over no truth awn). Truth awns no path follows are MISSED. Inputs:

* `model`: cached model detections, i.e. the normal pipeline;
* `oracle_whole`: every truth polygon as one observation (a perfect segmentation);
* `oracle_broken`: truth polygons cut every 10 mm with a 1 mm gap (perfect but broken).

Full numbers: [tables.md](tables.md); per-run `summary_*.json`, `page_counts_*.json`.

## Findings

1. **Touching and crossing awns are the main cause.** With a perfect segmentation (`oracle_whole`)
   the pipeline still produces about 8% SHORT and 3–4% JUMP paths. 94–100% of those are on truth awns
   that touch another awn, against 12–14% of OK paths. Looking at the figures, the cause is usually
   the two awns of one spikelet lying side by side. `awngraph.build_graph` rasterises all awn masks into
   one union map, so touching awns become one skeleton line. When they separate, the tracer either
   stops (SHORT, median about 20 mm missing) or continues on the neighbour (JUMP). Better segmentation
   cannot fix this; the graph has to keep instance identity (or width / two-line evidence) where awns touch.
2. **Gaps are not bridged.** Cutting perfect polygons every 10 mm almost triples SHORT (8% → 21–22%),
   and 94–97% of those have evidence further along the awn. Gap linking is far too conservative.
3. **Most of the model's false links are overshoot at the tip.** 9% of model paths are FALSE_LINK and 86–92% of
   these overshoot the truth tip on model evidence. In the contact sheet (`tip_overshoot_examples.jpg`)
   most are real false links that continue along ruled grid lines, the page edge, glare or tape edges. A few
   are faint tips the annotator stopped short of.
4. Segmentation misses are minor: only 13 / 81 (valid) and 78 / 550 (train) SHORT paths have no evidence
   beyond the stopping point, and only 1.8–2.0% of truth awns are MISSED.
5. Representative length (longest truth awn per spikelet) on valid: MAE 1.94 mm with the model, 1.41 mm with a
   perfect segmentation. The bias is negative for all inputs (−0.5, −1.15, −1.64 mm): every input under-measures,
   and SHORT dominates once false links are removed.

## Candidate hard set

Pages ranked by SHORT + JUMP + FALSE_LINK + MISSED (see tables.md). These pages are hard for every input:
valid IMG_9753, IMG_9711, IMG_9712, IMG_9722, IMG_9710; train IMG_9727, IMG_9702, IMG_9732, IMG_9763, IMG_9799, IMG_9749.

## Figures (half scale)

Green outline = truth awn, blue = OK, orange = SHORT (dotted: missing tip), magenta = JUMP, red = FALSE_LINK,
red dashed = MISSED truth awn.

* `oracle_whole_valid_IMG_9753.jpg`, `oracle_broken_valid_IMG_9753.jpg`, `model_valid_IMG_9753.jpg`: the same page with three inputs
* `model_train_IMG_9727.jpg`: the hardest training page
* `tip_overshoot_examples.jpg`: eight FALSE_LINK tip-overshoot cases

Reproduce (WSL, `PYTHONPATH=src`):

```bash
for s in valid train; do for i in model oracle_whole oracle_broken; do
  python scripts/diagnose_reconstruction.py --split $s --input $i --figures 6 --workers 8; done; done
python experiments/diagnosis/tip_overshoot_sheet.py
python experiments/diagnosis/make_report.py
```
