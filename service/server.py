"""Local AwnStudio service: the web workbench plus calibration and measurement jobs.

    PYTHONPATH=src python service/server.py --device 0          # GPU (ROCm / CUDA)
    PYTHONPATH=src python service/server.py --no-model          # editing + samples only

Endpoints
    GET    /                         web/ (static)
    GET    /api/health               service and model state
    GET    /api/models               the detection model(s) this service can run
    POST   /api/calibrate            body: image bytes -> grid calibration
    POST   /api/resolution?force=0   body: image bytes -> resolution assessment
    POST   /api/resize?scale=        body: image bytes -> resampled PNG
    POST   /api/jobs?name=&x_period_px=&y_period_px=
                                     body: image bytes -> {"id"}; one job runs at a time
    GET    /api/jobs/<id>?since=n    state, stage, tiles, detection evidence found since
                                     item n (live preview), and finally the result
    DELETE /api/jobs/<id>            cancel a queued or running job
    GET    /api/samples              development pages with a cached result
    GET    /api/samples/<id>/image   page image
    GET    /api/samples/<id>/result  result (with stages when detections are cached)

The scientific behaviour lives in the awnstudio package; this file only adapts it
to HTTP. A measurement is: grid calibration (unless the caller supplies periods)
-> tiled detection -> staged reconstruction (identical to
awnstudio.pipeline.reconstruct_page, see staged.py).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import queue
import re
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

MAX_UPLOAD = 200 * 1024 * 1024
KEEP_JOBS = 50
SAMPLE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")

# Resolution gate: ratio of the observed grid period to the period at the
# development reference geometry (the scale the model was trained at).
REFERENCE_PERIOD_PX = 59.0
REJECT_RATIO = 0.30  # below: refuse unless the person forces an upscale
TRIGGER_RATIO = 0.50  # below: upscale to the reference scale
OVERSCALE_RATIO = 2.00  # above: downscale ...
OVERSCALE_TARGET_RATIO = 1.30  # ... to this ratio


def decode_image(data: bytes):
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("could not decode the image")
    return image


def calibration_json(calibration) -> dict:
    return {
        "x_period_px": calibration.x_period_px,
        "y_period_px": calibration.y_period_px,
        "adequate": bool(calibration.adequate),
        "qc_reasons": list(calibration.qc_reasons),
    }


def assess_resolution(image, force: bool = False) -> dict:
    """Decide whether a page must be resampled before measurement."""
    from awnstudio.calibration import calibrate_page

    height, width = image.shape[:2]
    out = {"status": "sufficient", "action": "pass_through", "scale_factor": 1.0, "ratio": None,
           "input_width": width, "input_height": height, "output_width": width, "output_height": height}
    try:
        calibration = calibrate_page(image)
    except Exception:
        calibration = None
    if calibration is None or not calibration.adequate:
        return {**out, "status": "unassessed"}
    ratio = (calibration.x_period_px + calibration.y_period_px) / 2 / REFERENCE_PERIOD_PX
    out["ratio"] = ratio
    scale = 1.0
    if ratio > OVERSCALE_RATIO:
        out.update(status="overscale", action="downscaled")
        scale = OVERSCALE_TARGET_RATIO / ratio
    elif ratio < REJECT_RATIO and not force:
        return {**out, "status": "too_low", "action": "blocked"}
    elif ratio < TRIGGER_RATIO:
        out.update(status="forced_low" if ratio < REJECT_RATIO else "low", action="upscaled", forced=ratio < REJECT_RATIO)
        scale = 1.0 / ratio
    out.update(scale_factor=scale, output_width=max(1, round(width * scale)), output_height=max(1, round(height * scale)))
    return out


def resample_png(image, scale: float) -> bytes:
    import cv2

    if not 0.05 <= scale <= 8:
        raise ValueError("scale out of range")
    height, width = image.shape[:2]
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = cv2.resize(image, size, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4)
    ok, data = cv2.imencode(".png", resized)
    if not ok:
        raise ValueError("could not encode the image")
    return data.tobytes()


class JobCancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    name: str
    image: bytes | None
    periods: tuple[float, float] | None
    state: str = "queued"  # queued | running | done | error | cancelled
    # queued | loading | calibrate | detect | fuse | graph | assemble | measure | alternatives
    stage: str = "queued"
    progress: float = 0.0
    tiles: list[int] = field(default_factory=lambda: [0, 0])  # done, total
    evidence: list[dict] = field(default_factory=list)  # live detection preview
    result: dict | None = None
    error: str | None = None
    cancel_requested: bool = False
    created: float = field(default_factory=time.time)

    def public(self, since: int = 0) -> dict:
        out = {
            "id": self.id, "name": self.name, "state": self.state, "stage": self.stage, "progress": self.progress,
            "tiles": {"done": self.tiles[0], "total": self.tiles[1]},
            "evidence_count": len(self.evidence),
        }
        if self.state == "running" and since < len(self.evidence):
            out["evidence"] = self.evidence[since:]
            out["evidence_from"] = since
        if self.result is not None:
            out["result"] = self.result
        if self.error:
            out["error"] = self.error
        return out


class _TileSpy:
    """Wraps the YOLO model inside TiledSegmenter so each tile's masks can be
    previewed as soon as that tile is predicted. Predictions are unchanged."""

    def __init__(self, model, on_result):
        self._model, self._on_result = model, on_result

    def predict(self, *args, **kwargs):
        results = self._model.predict(*args, **kwargs)
        self._on_result(results[0])
        return results

    def __getattr__(self, name):
        return getattr(self._model, name)


class Measurer:
    """Owns the model and runs jobs one at a time on a worker thread."""

    def __init__(self, weights: Path | None, device: str, enabled: bool):
        self.weights = weights
        self.device = device
        self.enabled = enabled
        self.model_state = "unloaded" if enabled else "disabled"
        self.model_error: str | None = None
        self.segmenter = None
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        self.current: str | None = None
        threading.Thread(target=self._worker, daemon=True).start()

    # -- jobs
    def submit(self, name: str, image: bytes, periods) -> Job:
        if not self.enabled:
            raise RuntimeError("the service was started without a model")
        job = Job(uuid.uuid4().hex[:12], name, image, periods)
        with self.lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
            while len(self.order) > KEEP_JOBS:
                old = self.jobs.get(self.order[0])
                if old and old.state in ("queued", "running"):
                    break
                self.jobs.pop(self.order.pop(0), None)
        self.queue.put(job.id)
        return job

    def cancel(self, job_id: str) -> bool:
        """Cancel a queued job now, or a running one at its next progress step."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job.state == "queued":
                job.state, job.image = "cancelled", None
                return True
            if job and job.state == "running":
                job.cancel_requested = True
                return True
        return False

    def _worker(self):
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if not job or job.state != "queued":
                continue
            self.current = job_id
            job.state = "running"
            try:
                job.result = self._run(job)
                job.state, job.progress = "done", 1.0
            except JobCancelled:
                job.state = "cancelled"
            except Exception as error:  # reported to the browser
                traceback.print_exc()
                job.state, job.error = "error", f"{type(error).__name__}: {error}"
            finally:
                job.image = None
                job.evidence = []
                self.current = None

    def _load(self):
        if self.segmenter is not None:
            return self.segmenter
        self.model_state = "loading"
        try:
            from awnstudio.detection import TiledSegmenter

            self.segmenter = TiledSegmenter(self.weights, device=self.device)
            self.model_state = "ready"
        except Exception as error:
            self.model_state, self.model_error = "error", f"{type(error).__name__}: {error}"
            raise
        return self.segmenter

    def _check(self, job: Job):
        if job.cancel_requested:
            raise JobCancelled()

    def _run(self, job: Job) -> dict:
        from awnstudio.calibration import Calibration, calibrate_page
        from awnstudio.detection import CLASS_NAMES, PRIMARY_CONFIDENCE, mask_components, tile_windows
        from staged import evidence_item, reconstruct_staged

        started = time.perf_counter()
        timings = {}
        job.stage = "loading"
        segmenter = self._load()
        image = decode_image(job.image)
        height, width = image.shape[:2]
        if job.periods:
            calibration = Calibration(*job.periods)
        else:
            job.stage = "calibrate"
            t0 = time.perf_counter()
            calibration = calibrate_page(image)
            timings["calibrate"] = time.perf_counter() - t0
        self._check(job)

        tiles = tile_windows(width, height)
        job.tiles = [0, len(tiles)]
        job.stage = "detect"

        def preview(result):
            """Live evidence of the tile just predicted (display only)."""
            index = job.tiles[0]
            if result.masks is None or index >= len(tiles):
                return
            masks = result.masks.data.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy().astype(int)
            scores = result.boxes.conf.cpu().numpy()
            for mask, cls, score in zip(masks, classes, scores):
                if score < PRIMARY_CONFIDENCE:
                    continue
                for geometry in mask_components(mask, tiles[index]):
                    item = evidence_item(_Observation(CLASS_NAMES[int(cls)], float(score), geometry))
                    if item["rings"]:
                        job.evidence.append(item)

        def progress(done: int, total: int):
            job.tiles = [done, total]
            job.progress = 0.8 * done / max(1, total)
            self._check(job)

        model = segmenter.model
        segmenter.model = _TileSpy(model, preview)
        t0 = time.perf_counter()
        try:
            observations = segmenter.predict_page(image, progress=progress)
        finally:
            segmenter.model = model
        timings["detect"] = time.perf_counter() - t0
        self._check(job)

        order = ["fuse", "graph", "assemble", "measure", "alternatives"]

        def on_stage(name):
            self._check(job)
            job.stage = name
            job.progress = 0.8 + 0.2 * order.index(name) / len(order)

        page_id = Path(job.name).stem or job.id
        page, stages = reconstruct_staged(page_id, observations, width, height, calibration, on_stage=on_stage)
        stages["timings"] = {**timings, **stages["timings"]}
        result = page.to_json()
        result.update({
            "width": width,
            "height": height,
            "calibration": calibration_json(calibration),
            "model": self.weights.name if self.weights else None,
            "elapsed_s": time.perf_counter() - started,
            "stages": stages,
        })
        return result

    def health(self) -> dict:
        busy = self.current is not None or not self.queue.empty()
        return {
            "ok": True,
            "busy": busy,
            "model": {
                "state": self.model_state,
                "error": self.model_error,
                "weights": str(self.weights) if self.weights else None,
                "device": self.device,
            },
        }

    def models(self) -> dict:
        if not self.weights:
            return {"default": None, "models": []}
        model = {
            "id": self.weights.parent.parent.name or self.weights.stem,
            "name": self.weights.parent.parent.name or self.weights.name,
            "weights": str(self.weights),
            "available": self.enabled and self.weights.exists(),
            "device": "cpu" if self.device == "cpu" else "gpu",
        }
        return {"default": model["id"], "models": [model]}


@dataclass(frozen=True)
class _Observation:
    kind: str
    confidence: float
    geometry: object


class Samples:
    """Development pages that already have a cached reconstruction result."""

    def __init__(self, results_dir: Path | None, image_of, detections_dir: Path | None = None, calibrate=None):
        self.dir = results_dir
        self.image_of = image_of
        self.detections_dir = detections_dir
        self.calibrate = calibrate
        self._staged: dict[str, bytes] = {}
        self._lock = threading.Lock()

    def _locked(self) -> set[str]:
        try:
            from awnstudio.splits import TEST_PAGES
        except Exception:
            TEST_PAGES = ()
        return set(TEST_PAGES)

    def list(self) -> list[dict]:
        if not self.dir or not self.dir.is_dir():
            return []
        locked = self._locked()
        out = []
        for path in sorted(self.dir.glob("*.json")):
            page = path.stem
            if page in locked or not page.startswith("IMG_"):
                continue
            image = self.image_of(page)
            if image and image.exists():
                out.append({"id": page})
        return out

    def result(self, page: str) -> Path | None:
        if not SAMPLE_ID.match(page) or page in self._locked() or not self.dir:
            return None
        path = self.dir / f"{page}.json"
        return path if path.exists() else None

    def staged_result(self, page: str) -> bytes | None:
        """The cached result recomputed with stages from cached detections, if any."""
        if not self.result(page) or not self.detections_dir or not self.calibrate:
            return None
        detections = self.detections_dir / f"{page}.json.gz"
        if not detections.exists():
            return None
        with self._lock:
            if page not in self._staged:
                from awnstudio.cache import load_observations
                from staged import reconstruct_staged

                observations, meta = load_observations(detections)
                calibration = self.calibrate(page)
                result, stages = reconstruct_staged(page, observations, meta["width"], meta["height"], calibration)
                data = result.to_json()
                data.update({"width": meta["width"], "height": meta["height"], "calibration": calibration_json(calibration),
                             "stages": stages})
                self._staged[page] = json.dumps(data).encode("utf-8")
            return self._staged[page]

    def image(self, page: str) -> Path | None:
        if not self.result(page):
            return None
        image = self.image_of(page)
        return image if image and image.exists() else None


def make_handler(measurer: Measurer, samples: Samples):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AwnStudio/0.2"

        def log_message(self, fmt, *args):
            if not self.path.startswith("/api/jobs/"):
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        # -- responses
        def _send(self, status: int, body: bytes, content_type: str, cache: str = "no-store"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, data, status: int = 200):
            self._send(status, json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, status: int, message: str):
            self._json({"error": message}, status)

        def _file(self, path: Path, cache: str = "no-cache"):
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix in (".mjs", ".js"):
                kind = "text/javascript"
            if kind.startswith("text/") or kind in ("application/json", "image/svg+xml"):
                kind += "; charset=utf-8"
            self._send(200, path.read_bytes(), kind, cache)

        def _body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                raise ValueError("missing or oversized request body")
            return self.rfile.read(length)

        # -- routing
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            url = urlparse(self.path)
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            parts = [p for p in url.path.split("/") if p]
            if parts[:1] != ["api"]:
                return self._static(url.path)
            if parts == ["api", "health"]:
                return self._json(measurer.health())
            if parts == ["api", "models"]:
                return self._json(measurer.models())
            if len(parts) == 3 and parts[1] == "jobs":
                job = measurer.jobs.get(parts[2])
                if not job:
                    return self._error(404, "unknown job")
                since = int(query.get("since", "0") or 0) if query.get("since", "0").isdigit() else 0
                return self._json(job.public(since))
            if parts == ["api", "samples"]:
                return self._json(samples.list())
            if len(parts) == 4 and parts[1] == "samples":
                if parts[3] == "image":
                    path = samples.image(parts[2])
                    return self._file(path, "max-age=3600") if path else self._error(404, "unknown sample")
                if parts[3] == "result":
                    try:
                        staged = samples.staged_result(parts[2])
                    except Exception:
                        traceback.print_exc()
                        staged = None
                    if staged:
                        return self._send(200, staged, "application/json; charset=utf-8", "no-cache")
                    path = samples.result(parts[2])
                    return self._file(path, "no-cache") if path else self._error(404, "unknown sample")
            self._error(404, "not found")

        def do_POST(self):
            url = urlparse(self.path)
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == "/api/calibrate":
                    from awnstudio.calibration import calibrate_page

                    return self._json(calibration_json(calibrate_page(decode_image(self._body()))))
                if url.path == "/api/resolution":
                    return self._json(assess_resolution(decode_image(self._body()), force=query.get("force") == "1"))
                if url.path == "/api/resize":
                    scale = float(query.get("scale", "nan"))
                    return self._send(200, resample_png(decode_image(self._body()), scale), "image/png")
                if url.path == "/api/jobs":
                    periods = None
                    if "x_period_px" in query and "y_period_px" in query:
                        periods = (float(query["x_period_px"]), float(query["y_period_px"]))
                        if not all(p > 0 for p in periods):
                            raise ValueError("periods must be positive")
                    job = measurer.submit(query.get("name", "page"), self._body(), periods)
                    return self._json({"id": job.id}, 202)
            except RuntimeError as error:
                return self._error(503, str(error))
            except ValueError as error:
                return self._error(400, str(error))
            except Exception as error:
                traceback.print_exc()
                return self._error(500, f"{type(error).__name__}: {error}")
            self._error(404, "not found")

        def do_DELETE(self):
            parts = [p for p in urlparse(self.path).path.split("/") if p]
            if len(parts) == 3 and parts[:2] == ["api", "jobs"]:
                return self._json({"cancelled": measurer.cancel(parts[2])})
            self._error(404, "not found")

        def _static(self, path: str):
            if path == "/favicon.ico":
                path = "/assets/icon.svg"
            relative = path.lstrip("/") or "index.html"
            target = (WEB / relative).resolve()
            if target.is_dir():
                target = target / "index.html"
            if WEB.resolve() not in target.parents or not target.is_file():
                return self._error(404, "not found")
            self._file(target)

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--device", default="0", help="torch device for detection, e.g. 0 or cpu")
    parser.add_argument("--weights", type=Path, help="segmentation weights (default: configs/paths.yaml)")
    parser.add_argument("--no-model", action="store_true", help="serve editing and samples only")
    parser.add_argument("--preload", action="store_true", help="load the model at start-up")
    args = parser.parse_args(argv)

    weights, results_dir, image_of, detections_dir, calibrate = args.weights, None, lambda page: None, None, None
    try:
        from awnstudio.calibration import calibrate_cached
        from awnstudio.paths import paths

        p = paths()
        weights = weights or p.weights
        results_dir = p.runs / "results" / "pfg"
        detections_dir = p.runs / "detections"
        image_of = p.page_image
        calibrate = calibrate_cached
    except Exception as error:
        print(f"paths.yaml unavailable ({error}); samples disabled", file=sys.stderr)

    enabled = not args.no_model and weights is not None
    measurer = Measurer(weights, args.device, enabled)
    if enabled and args.preload:
        measurer._load()
    samples = Samples(results_dir, image_of, detections_dir, calibrate)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(measurer, samples))
    print(f"AwnStudio on http://{args.host}:{args.port}/  (model: {measurer.model_state})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
