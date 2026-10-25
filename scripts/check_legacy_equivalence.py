"""Check that ported stages reproduce the frozen research implementation.

Usage (WSL, ROCm env):
    PYTHONPATH=src python scripts/check_legacy_equivalence.py calibration
    PYTHONPATH=src python scripts/check_legacy_equivalence.py detection --pages IMG_9688
"""
from __future__ import annotations

import argparse
import sys

import cv2

from awnstudio.paths import paths
from awnstudio.splits import VALIDATION_PAGES


def legacy_import():
    sys.path.insert(0, str(paths().legacy_root / "src"))


def check_calibration(pages):
    legacy_import()
    from awnphen.phenotyping.measurement.calibration import calibrate_grid_v2

    from awnstudio.calibration import calibrate_page

    worst = 0.0
    for page in pages:
        image = cv2.imread(str(paths().page_image(page)))
        new = calibrate_page(image, method="median")
        x_old, y_old, qc, _ = calibrate_grid_v2(image)
        dx = abs(new.x_period_px - x_old["period_px"])
        dy = abs(new.y_period_px - y_old["period_px"])
        same_qc = new.adequate == qc["affine_scale_adequate"] and list(new.qc_reasons) == qc["qc_reasons"]
        worst = max(worst, dx, dy)
        print(f"{page} x={new.x_period_px:.6f} y={new.y_period_px:.6f} dx={dx:.2e} dy={dy:.2e} qc_same={same_qc}")
    print("max abs period difference:", worst)
    return worst == 0.0


def check_detection(pages, device):
    legacy_import()
    from pathlib import Path
    import tempfile, shutil

    from awnphen.phenotyping.detection.providers import PrimaryEvidenceProvider

    from awnstudio.detection import TiledSegmenter

    segmenter = TiledSegmenter(paths().weights, device=device)
    ok = True
    for page in pages:
        image = cv2.imread(str(paths().page_image(page)))
        new = segmenter.predict_page(image)
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy2(paths().page_image(page), Path(tmp) / f"{page}.png")
            provider = PrimaryEvidenceProvider(
                model=segmenter.model, page_dir=Path(tmp), weights_path=paths().weights,
                tile_size=640, stride=320, model_imgsz=640, confidence=0.05, nms_iou=0.7, device=device,
            )
            old = provider.observe_page(page_id=page)
        same = len(new) == len(old) and all(
            n.kind == o.class_name
            and abs(n.confidence - o.confidence) < 1e-9
            and n.geometry.equals_exact(o.geometry, 1e-9)
            for n, o in zip(new, old)
        )
        ok &= same
        print(f"{page} new={len(new)} legacy={len(old)} identical={same}")
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["calibration", "detection"])
    parser.add_argument("--pages", nargs="*", default=list(VALIDATION_PAGES))
    parser.add_argument("--device", default="0")
    args = parser.parse_args()
    ok = check_calibration(args.pages) if args.stage == "calibration" else check_detection(args.pages, args.device)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
