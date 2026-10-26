# Optimisation steps (before / after)

Primary metric: representative length (longest awn per spikelet), both the diagnosis
"rep" columns and the official ImageJ evaluation (`run_baseline.py --method pfg --split valid`,
with the frozen protocol). The per-path class shares come second. A step is kept only if
the model-input OK rate improves on train and valid and the official valid MAE does not get worse.

Official valid baseline (commit 3f7c477): MAE 1.855 raw, **1.490** with protocol, within 2 mm 83.6%.

## Step 1: shared ridges in assembly (kept)

Mechanism check (`why_short.py`, oracle_whole valid): 46 of 49 SHORT paths stopped because the
edge continuing along their truth awn was owned by another selected awn **of the same spikelet**;
3 had no graph option; all 19 JUMPs switched where two awns separate.

Change: two awns of one spikelet may share any edge (capacity 2 per spikelet, one spikelet per
edge except crossing cores); branch traces may rejoin the parent's later edges; two awns of one
spikelet never take an identical edge set.

Official valid: MAE 1.865 raw, **1.447** with protocol (−0.043), within 2 mm 83.9%.

| split | input | version | OK % | SHORT % | JUMP % | FALSE % | MISSED | dup | rep MAE | rep bias | rep <=2mm % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| valid | model | before | 75.8 | 11.8 | 3.1 | 9.3 | 12 | 47 | 1.80 | +0.77 | 77.0 |
| valid | model | step1 | 81.0 | 5.3 | 3.7 | 9.9 | 13 | 44 | 1.75 | +0.85 | 78.3 |
| valid | oracle_whole | before | 88.9 | 8.0 | 3.1 | 0.0 | 6 | 23 | 0.27 | +0.12 | 97.3 |
| valid | oracle_whole | step1 | 94.7 | 1.2 | 4.2 | 0.0 | 12 | 17 | 0.26 | +0.18 | 97.3 |
| valid | oracle_broken | before | 76.7 | 21.2 | 2.1 | 0.0 | 11 | 62 | 1.27 | -0.38 | 87.0 |
| valid | oracle_broken | step1 | 78.7 | 18.6 | 2.6 | 0.0 | 10 | 58 | 1.25 | -0.33 | 87.0 |
| train | model | before | 78.0 | 9.8 | 3.2 | 9.0 | 86 | 348 | 1.61 | +0.52 | 83.6 |
| train | model | step1 | 81.9 | 4.2 | 4.5 | 9.4 | 114 | 298 | 1.61 | +0.57 | 83.7 |
| train | oracle_whole | before | 88.3 | 7.6 | 4.1 | 0.0 | 42 | 210 | 0.41 | +0.06 | 97.1 |
| train | oracle_whole | step1 | 93.6 | 1.4 | 4.9 | 0.0 | 78 | 111 | 0.38 | +0.08 | 97.3 |
| train | oracle_broken | before | 74.9 | 22.2 | 2.9 | 0.0 | 69 | 557 | 1.59 | -0.73 | 82.3 |
| train | oracle_broken | step1 | 76.4 | 19.9 | 3.7 | 0.0 | 71 | 542 | 1.56 | -0.66 | 82.7 |

"rep" columns use truth lengths measured with the pipeline's own convention (DP1-simplified
axis). The first version of this table summed the raw skeleton staircase, which is about 3%
(≈1.2 mm) longer and made every input look too short; "before" was re-run with the fixed
diagnosis on commit 434e9f3.

SHORT is cut by more than half for every input. JUMP and MISSED rise a little: a second awn now
sometimes rides on its sibling's path instead of stopping short, which leaves the sibling's truth
awn unmatched. That does not change the representative (the longest awn), which improves.

## Where the remaining representative error comes from (step 1)

`rep_errors.py`: with a perfect segmentation the representative is within 0.26 mm (valid), so
stitching itself is nearly solved once the masks are right. With model input (valid, MAE 1.75):

| class of the representative path | share of total abs. error | mean error |
|---|---|---|
| OK | 61% | +0.64 mm (systematic, handled by the protocol calibration) |
| FALSE_LINK tip overshoot | 22% | +7.2 mm |
| SHORT, no evidence beyond the stop | 11% | −8.0 mm |
| JUMP | 5% | +1.9 mm |

Train: 55% / 20% / 7% / 10%. JUMPs are almost all onto the sibling awn of the same spikelet
(24 of 25 on valid), so keeping instance identity through merged ridges would gain little for the
longest-awn phenotype and was postponed. `overshoot.py` (train): only 71 hops step off the truth
at the tip, against 429 overshooting paths, so most overshoot is inside the last edge: the model's
mask itself runs on along a grid line, glare or tape edge. The stitching cannot see this; the image can.
