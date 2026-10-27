# Fitted reconstruction models

Reconstruction is fitted to the evidence of one segmentation detector, so each detector
has its own link models and length protocol (registry: `src/awnstudio/detectors.py`;
ids are the web workbench's model ids).

| detector (model id) | link models | protocol |
|---|---|---|
| `controlled-v2-stage1` (YOLO11n-seg 640, default) | `link_models.json` | `protocol_pfg.json` |
| `mask2former-swin-large` (Mask2Former Swin-L) | `link_models.mask2former-swin-large.json` | `protocol_pfg.mask2former-swin-large.json` |

Other detectors follow the same pattern (`link_models.<id>.json`, `protocol_pfg.<id>.json`);
when a detector has no fitted files, the default detector's files are used.
`protocol_legacy.json` belongs to the legacy baseline method.

Selecting a detector in code:

```python
from awnstudio.detectors import detector, list_detectors
from awnstudio.detection import TiledSegmenter
from awnstudio.pipeline import models_for, reconstruct_page

list_detectors()                      # [{id, name, adapter, default, available}, ...]
det = detector("mask2former-swin-large")
observations = TiledSegmenter(det.weights, adapter=det.adapter).predict_page(image_bgr)
link_models, protocol = models_for(det.id)  # falls back to the default detector's files
result = reconstruct_page(page_id, observations, width, height, calibration, models=link_models)
reported_mm = protocol.apply(result.spikelets[0].length_mm)
```

Refitting for a detector (train pages only; WSL, `PYTHONPATH=src`):

```bash
python scripts/run_detection.py --split train valid --detector mask2former-swin-large
DETECTOR=mask2former-swin-large bash scripts/develop_cycle.sh
```

Official validation result (11 pages, 300 ImageJ targets, protocol applied, each detector with its
own fitted files): YOLO `controlled-v2-stage1` MAE 1.414 mm, median 0.760 mm, within 2 mm 85.2%;
Mask2Former `mask2former-swin-large` MAE 2.027 mm, median 1.065 mm, within 2 mm 77.6%.
