# AwnStudio

Automated wheat awn length measurement from digitized spikelet pages.

This repository is a clean re-implementation of the `wheat-awn-phenotyping` research
project. The trained segmentation model and the raw page images are reused from that
project by read-only reference (`configs/paths.yaml`); they are not stored here.

Status: under construction. See [docs/PLAN.md](docs/PLAN.md).

## Environment

WSL2 Ubuntu, ROCm PyTorch environment (`/root/.venvs/wheat_awn_rocm`):

```bash
export HSA_ENABLE_DXG_DETECTION=1
export PYTHONPATH=src
python scripts/run_detection.py --split valid      # cache tiled detections
python scripts/check_legacy_equivalence.py calibration
```
