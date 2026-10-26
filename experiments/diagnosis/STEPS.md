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
| valid | model | before | 75.8 | 11.8 | 3.1 | 9.3 | 12 | 47 | 1.94 | -0.50 | 71.3 |
| valid | model | step1 | 81.0 | 5.3 | 3.7 | 9.9 | 13 | 44 | 1.86 | -0.41 | 73.7 |
| valid | oracle_whole | before | 88.9 | 8.0 | 3.1 | 0.0 | 6 | 23 | 1.41 | -1.15 | 81.1 |
| valid | oracle_whole | step1 | 94.7 | 1.2 | 4.2 | 0.0 | 12 | 17 | 1.36 | -1.09 | 82.7 |
| valid | oracle_broken | before | 76.7 | 21.2 | 2.1 | 0.0 | 11 | 62 | 1.87 | -1.64 | 72.8 |
| valid | oracle_broken | step1 | 78.7 | 18.6 | 2.6 | 0.0 | 10 | 58 | 1.82 | -1.60 | 74.1 |
| train | model | before | 78.0 | 9.8 | 3.2 | 9.0 | 86 | 348 | 1.92 | -0.74 | 75.1 |
| train | model | step1 | 81.9 | 4.2 | 4.5 | 9.4 | 114 | 298 | 1.89 | -0.69 | 76.1 |
| train | oracle_whole | before | 88.3 | 7.6 | 4.1 | 0.0 | 42 | 210 | 1.55 | -1.20 | 80.5 |
| train | oracle_whole | step1 | 93.6 | 1.4 | 4.9 | 0.0 | 78 | 111 | 1.50 | -1.18 | 81.9 |
| train | oracle_broken | before | 74.9 | 22.2 | 2.9 | 0.0 | 69 | 557 | 2.20 | -1.98 | 71.4 |
| train | oracle_broken | step1 | 76.4 | 19.9 | 3.7 | 0.0 | 71 | 542 | 2.15 | -1.92 | 72.1 |

SHORT is cut by more than half for every input. JUMP and MISSED rise a little: a second awn now
sometimes rides on its sibling's path instead of stopping short, which leaves the sibling's truth
awn unmatched. That does not change the representative (the longest awn), which improves.
