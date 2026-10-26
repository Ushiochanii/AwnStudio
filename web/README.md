# AwnStudio workbench

Browser workbench for measuring wheat awn length on scanned spikelet pages:

```text
Import -> Calibrate -> Measure -> Review (inspect, correct, confirm) -> Export
```

Plain ES modules, no build step and no runtime dependencies. The page is served by
the local service in `service/`, which also runs calibration and measurement with
the `awnstudio` package. English is the product language; 简体中文 and 日本語 are
translations chosen in Settings.

## Run

From WSL, with the ROCm environment:

```bash
service/run.sh --device 0            # http://127.0.0.1:8790/
service/run.sh --no-model            # editing, samples and calibration only
```

The model loads on the first measurement. One measurement runs at a time; the
browser queues batch work and can stop after the current image.

## Design

The direction is a graph-paper lab notebook: the scan is the subject and the
measurement is the only accent. The canvas lies on the same cyan 5 mm grid the
spikelets are mounted on, awns are straw gold, numbers are monospaced, and the rest
of the interface stays quiet ink on paper. The one moment that is staged is the
measurement itself: detection evidence appears tile by tile under a scan line,
then the reconstruction replays (evidence, seeds, growth hops, candidates) and
every awn is traced from root to tip as its length appears.

## What the workbench does

- **Import** JPEG / PNG / WebP pages (files, folder or drag and drop, natural
  order). The resolution is checked against the scale the model was trained at:
  low-resolution pages are upscaled, very large ones downscaled, pages below the
  limit are only accepted after a confirmation. The 5 mm graph-paper grid is then
  detected automatically.
- **Calibrate** with the grid (anisotropic x / y scale), a known distance drawn on
  the image, or a direct mm/px value (click the scale chip); optionally copy it to
  uncalibrated images of the same pixel size. Measuring an uncalibrated image opens
  calibration first and continues afterwards.
- **Measure** one image or all pending images. While the service works, the live
  detection evidence is drawn as tiles finish, with stage, tile progress, an
  elapsed timer and cancellation. Batches report measured / failed / skipped and can
  stop after the current image. Lengths in the browser are computed exactly as the
  service does (Douglas-Peucker at 1 px, then the calibrated arc length).
- **Display layers**: Evidence (detection masks, opacity by confidence), Growth
  (each awn traced from its seed, one colour per hop, dashed across gaps),
  Candidates (all candidates, the representative in gold, a floating navigator to
  promote another one) and Editable. Hold Ctrl (or pin the eye) for the original
  image; the photo can be hidden.
- **Review**: status filters, a review queue sorted by severity with unseen items in
  bold, search, a sortable table, per-spikelet reasons, a floating confirm button at
  the awn tip, keyboard navigation, statistics (n, mean ± SD, median, review
  progress, a length histogram that filters the table).
- **Inspect** the selected awn step by step (seed, each growth hop, measurement
  path) with a slider or ← →, optionally with the other candidates, plus run
  information and stage timings.
- **Edit**: move / insert / remove vertices, box-select vertices (B) and delete
  them, redraw or delete the awn, add a missed spikelet, rename IDs inline in the
  table, undo / redo. Any edit clears confirmation; the automatic result can be
  restored.
- **Save**: autosave in the browser (IndexedDB); *Save project* downloads a
  self-contained JSON file with the images embedded; *Open project* restores it.
- **Export** through a download dialog with a preview: CSV per image, a ZIP of all
  images, a detailed project CSV, or a summary CSV per image.
- Settings are grouped as in the original workbench (input, measurement, display,
  editing, storage, general); light and dark themes.

## Keyboard

Press `?` in the workbench for the full list.

| Key | Action |
| --- | --- |
| V · B · N · A · R | select · box-select vertices · add spikelet · redraw awn · two-point calibration |
| 1 · 2 · 3 · 4 | evidence · growth · candidates · editable layer |
| Ctrl (hold) | original image |
| Enter / double-click | finish drawing; otherwise confirm the selection |
| Esc | cancel drawing / clear selection |
| Delete / Backspace | delete the selection, selected vertices, or the last drawn point |
| C | confirm / reopen |
| J, K or ↓, ↑ | next / previous spikelet in the list |
| ← → | previous / next inspection step |
| , . U | previous / next candidate · use it as representative |
| F · 0 · + − | zoom to selection · fit page · zoom |
| Ctrl+Z · Ctrl+Y | undo · redo |
| Space-drag, middle-drag | pan |

## Modules

| File | Role |
| --- | --- |
| `js/geometry.mjs` | points, paths, polygons, WKT rings, reading order |
| `js/calibration.mjs` | calibrations and calibrated length |
| `js/result.mjs` | service result -> editable spikelet records (with growth and alternatives) |
| `js/layers.mjs` | display layers, colours, tile windows |
| `js/inspect.mjs` | seed -> hops -> path steps of one candidate |
| `js/review.mjs` | review status, reasons, severity and filters |
| `js/edits.mjs` | manual corrections |
| `js/history.mjs` | undo / redo |
| `js/project.mjs`, `js/store.mjs` | project files and browser autosave |
| `js/export.mjs` | CSV and ZIP |
| `js/api.mjs` | service client (jobs with live evidence) |
| `js/viewer.mjs` | canvas: layers, live scan, reveal, inspection overlay, pointer editing, minimap |
| `js/stats.mjs` | summary statistics and histogram bins |
| `js/i18n.mjs`, `js/settings.mjs`, `js/icons.mjs`, `js/shortcuts.mjs` | copy, preferences, icons, shortcut list |
| `js/app.mjs` | wiring |

## Tests

```bash
node --test web/tests/
AWNSTUDIO_SAMPLE=runs/results/pfg/IMG_9687.json node --test web/tests/   # also checks a real result
PYTHONPATH=src python -m unittest discover -s service/tests             # service; staged test uses cached detections
```
