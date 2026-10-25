# AwnStudio workbench

Browser workbench for measuring wheat awn length on scanned spikelet pages:

```text
Import -> Calibrate -> Measure -> Review (inspect, correct, confirm) -> Export
```

Plain ES modules, no build step and no runtime dependencies. The page is served by
the local service in `service/`, which also runs calibration and measurement with
the `awnstudio` package.

## Run

From WSL, with the ROCm environment:

```bash
service/run.sh --device 0            # http://127.0.0.1:8790/
service/run.sh --no-model            # editing, samples and calibration only
```

The model loads on the first measurement. One measurement runs at a time; the
browser queues batch work and can stop after the current image.

## What the workbench does

- **Import** JPEG / PNG / WebP pages (files, folder or drag and drop). The 5 mm
  graph-paper grid is detected right after import when the service is reachable.
- **Calibrate** with the grid (anisotropic x / y scale), a known distance drawn on
  the image, or a direct mm/px value; optionally copy it to uncalibrated images of
  the same pixel size. Changing the scale re-computes lengths immediately and flags
  that the reconstruction itself used the old scale.
- **Measure** one image or all pending images. Lengths in the browser are computed
  exactly as the service does (Douglas-Peucker at 1 px, then the calibrated arc
  length), so the numbers agree with `PageResult.length_mm`.
- **Review**: layers (photo, outlines, awn candidates, measurement paths, labels),
  a score threshold that hides weak candidates and flags weak representatives,
  status filters, search, per-spikelet review reasons, confirmation, keyboard
  navigation.
- **Inspect** the selected spikelet: its awn candidates with score, root and trace
  probability, hops and gaps; choose another candidate as the representative.
- **Edit**: move / insert / remove vertices of the awn path and the outline, redraw
  the awn, add a missed spikelet, rename IDs, delete, box-select, undo / redo.
  Any edit clears confirmation; the automatic result stays available and can be
  restored.
- **Save**: every change is autosaved in the browser (IndexedDB). *Save project*
  downloads a self-contained JSON file with the images embedded; *Open project*
  restores it.
- **Export**: CSV per image (`ID, Awn length (mm)`), a ZIP of all images, or a
  detailed project CSV with automatic and final length, review state, score and
  calibration.
- English, 简体中文 and 日本語 (partial, falls back to English); light and dark themes.

## Keyboard

| Key | Action |
| --- | --- |
| V / N / A / R | select · add spikelet · redraw awn · two-point calibration |
| Enter / double-click | finish drawing; otherwise confirm the selection |
| Esc | cancel drawing / clear selection |
| Delete / Backspace | delete the selection, or the last drawn point |
| C | confirm / unconfirm |
| J, K or ↓, ↑ | next / previous spikelet in the list |
| , . U | previous / next candidate · use it as representative |
| F · 0 · + − | zoom to selection · fit page · zoom |
| Ctrl+Z · Ctrl+Y | undo · redo |
| Space-drag, middle-drag | pan |

## Modules

| File | Role |
| --- | --- |
| `js/geometry.mjs` | points, paths, polygons, WKT rings, reading order |
| `js/calibration.mjs` | calibrations and calibrated length |
| `js/result.mjs` | service `PageResult` JSON -> editable spikelet records |
| `js/review.mjs` | review status, reasons and filters |
| `js/edits.mjs` | manual corrections |
| `js/history.mjs` | undo / redo |
| `js/project.mjs`, `js/store.mjs` | project files and browser autosave |
| `js/export.mjs` | CSV and ZIP |
| `js/api.mjs` | service client |
| `js/viewer.mjs` | canvas drawing and pointer interaction |
| `js/i18n.mjs`, `js/settings.mjs`, `js/icons.mjs` | copy, preferences, icons |
| `js/app.mjs` | wiring |

## Tests

```bash
node --test web/tests/
AWNSTUDIO_SAMPLE=runs/results/pfg/IMG_9687.json node --test web/tests/   # also checks a real result
```
