## Path classes

| split | input | paths | OK | SHORT (evidence continues / none) | JUMP | FALSE_LINK (tip overshoot / mid) | MISSED truth awns | duplicates | rep. MAE mm | rep. bias mm | rep. within 2 mm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| valid | model | 685 | 519 (75.8%) | 81 (11.8%) (68 / 13) | 21 (3.1%) | 64 (9.3%) (59 / 5) | 12 / 590 | 47 | 1.94 | -0.50 | 71.3% |
| valid | oracle_whole | 612 | 544 (88.9%) | 49 (8.0%) (49 / 0) | 19 (3.1%) | 0 (0.0%) (0 / 0) | 6 / 590 | 23 | 1.41 | -1.15 | 81.1% |
| valid | oracle_broken | 652 | 500 (76.7%) | 138 (21.2%) (130 / 8) | 14 (2.1%) | 0 (0.0%) (0 / 0) | 11 / 590 | 62 | 1.87 | -1.64 | 72.8% |
| train | model | 5586 | 4356 (78.0%) | 550 (9.8%) (472 / 78) | 180 (3.2%) | 500 (9.0%) (429 / 71) | 86 / 4869 | 348 | 1.92 | -0.74 | 75.1% |
| train | oracle_whole | 5074 | 4480 (88.3%) | 387 (7.6%) (387 / 0) | 207 (4.1%) | 0 (0.0%) (0 / 0) | 42 / 4869 | 210 | 1.55 | -1.20 | 80.5% |
| train | oracle_broken | 5470 | 4096 (74.9%) | 1217 (22.2%) (1185 / 32) | 157 (2.9%) | 0 (0.0%) (0 / 0) | 69 / 4869 | 557 | 2.20 | -1.98 | 71.4% |

## Paths whose truth awn touches another truth awn (<= 4 px)

| split | input | OK | SHORT | JUMP | FALSE_LINK |
|---|---|---|---|---|---|
| valid | model | 13% of 491 | 64% of 81 | 90% of 21 | 14% of 35 |
| valid | oracle_whole | 14% of 542 | 98% of 49 | 95% of 19 | - |
| train | model | 12% of 4154 | 67% of 550 | 95% of 180 | 16% of 272 |
| train | oracle_whole | 12% of 4460 | 94% of 387 | 100% of 207 | - |

## Hardest pages (by SHORT + JUMP + FALSE_LINK + MISSED)

- model_valid: IMG_9753, IMG_9710, IMG_9712, IMG_9700, IMG_9711, IMG_9722, IMG_9689, IMG_9795, IMG_9761, IMG_9796
- oracle_whole_valid: IMG_9753, IMG_9711, IMG_9722, IMG_9712, IMG_9710, IMG_9761, IMG_9795, IMG_9689, IMG_9688, IMG_9700
- oracle_broken_valid: IMG_9753, IMG_9711, IMG_9712, IMG_9700, IMG_9722, IMG_9761, IMG_9795, IMG_9796, IMG_9689, IMG_9688
- model_train: IMG_9727, IMG_9702, IMG_9799, IMG_9740, IMG_9763, IMG_9729, IMG_9749, IMG_9732, IMG_9737, IMG_9696
- oracle_whole_train: IMG_9732, IMG_9702, IMG_9778, IMG_9718, IMG_9727, IMG_9734, IMG_9746, IMG_9749, IMG_9763, IMG_9780
- oracle_broken_train: IMG_9732, IMG_9763, IMG_9780, IMG_9790, IMG_9799, IMG_9723, IMG_9778, IMG_9734, IMG_9698, IMG_9727
