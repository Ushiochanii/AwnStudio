"""HTTP behaviour of the local service without a model.

    PYTHONPATH=src python -m unittest discover -s service/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        (root / "results").mkdir()
        (root / "images").mkdir()
        for page in ("IMG_0001", "IMG_0002"):
            (root / "results" / f"{page}.json").write_text(json.dumps({"page_id": page, "spikelets": []}))
            (root / "images" / f"{page}.JPG").write_bytes(b"\xff\xd8\xff")
        (root / "results" / "summary.json").write_text("{}")
        samples = server.Samples(root / "results", lambda page: root / "images" / f"{page}.JPG")
        samples._locked = lambda: {"IMG_0002"}
        cls.measurer = server.Measurer(None, "cpu", enabled=False)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(cls.measurer, samples))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, path, method="GET", body=None):
        req = urllib.request.Request(self.base + path, data=body, method=method)
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_health_reports_disabled_model(self):
        status, _, body = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["model"]["state"], "disabled")

    def test_static_files_and_modules(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"AwnStudio", body)
        status, headers, _ = self.request("/js/app.mjs")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))
        status, headers, _ = self.request("/favicon.ico")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("image/svg+xml"))

    def test_static_paths_cannot_escape_web(self):
        for path in ("/../service/server.py", "/%2e%2e/service/server.py", "/js/../../README.md"):
            status, _, _ = self.request(path)
            self.assertEqual(status, 404, path)

    def test_jobs_are_refused_without_a_model(self):
        status, _, body = self.request("/api/jobs?name=a.jpg", "POST", b"\xff\xd8\xff")
        self.assertEqual(status, 503)
        self.assertIn("without a model", json.loads(body)["error"])

    def test_bad_requests(self):
        self.assertEqual(self.request("/api/jobs", "POST", b"")[0], 400)
        self.assertEqual(self.request("/api/jobs?x_period_px=-1&y_period_px=50", "POST", b"x")[0], 400)
        self.assertEqual(self.request("/api/jobs/nope")[0], 404)
        self.assertEqual(self.request("/api/nothing")[0], 404)

    def test_samples_skip_locked_pages_and_non_pages(self):
        status, _, body = self.request("/api/samples")
        self.assertEqual(json.loads(body), [{"id": "IMG_0001"}])
        self.assertEqual(self.request("/api/samples/IMG_0001/result")[0], 200)
        self.assertEqual(self.request("/api/samples/IMG_0001/image")[0], 200)
        self.assertEqual(self.request("/api/samples/IMG_0002/image")[0], 404)
        self.assertEqual(self.request("/api/samples/..%2fx/result")[0], 404)

    def test_cancel_marks_queued_and_running_jobs(self):
        job = server.Job("j1", "a.jpg", b"", None)
        self.measurer.jobs[job.id] = job
        self.assertTrue(self.measurer.cancel("j1"))
        self.assertEqual(job.state, "cancelled")
        running = server.Job("j2", "b.jpg", b"", None, state="running")
        self.measurer.jobs[running.id] = running
        self.assertTrue(self.measurer.cancel("j2"))
        self.assertTrue(running.cancel_requested)
        self.assertFalse(self.measurer.cancel("missing"))


if __name__ == "__main__":
    unittest.main()


class ResolutionTest(unittest.TestCase):
    def grid(self, period: float, width: int = 3508, height: int = 2480):
        import cv2
        import numpy as np

        image = np.full((height, width, 3), 255, np.uint8)
        for x in np.arange(0, width, period):
            cv2.line(image, (int(round(x)), 0), (int(round(x)), height - 1), (200, 160, 60), 2)
        for y in np.arange(0, height, period):
            cv2.line(image, (0, int(round(y))), (width - 1, int(round(y))), (200, 160, 60), 2)
        return image

    def test_reference_scale_passes(self):
        result = server.assess_resolution(self.grid(59.0))
        self.assertIn(result["status"], ("sufficient", "unassessed"))
        self.assertEqual(result["scale_factor"], 1.0)

    def test_resample_png(self):
        import cv2
        import numpy as np

        data = server.resample_png(self.grid(59.0, 400, 300), 0.5)
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(image.shape[:2], (150, 200))
        with self.assertRaises(ValueError):
            server.resample_png(self.grid(59.0, 40, 30), 100)
