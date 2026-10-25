"""Deterministic on-disk cache for per-page detection results."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

from shapely import wkb

from .detection import Observation


def save_observations(path: Path, observations: list[Observation], meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": meta,
        "observations": [
            {
                "kind": o.kind,
                "confidence": o.confidence,
                "tile": list(o.tile),
                "prediction": o.prediction,
                "component": o.component,
                "wkb": wkb.dumps(o.geometry, hex=True),
            }
            for o in observations
        ],
    }
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle)


def load_observations(path: Path) -> tuple[list[Observation], dict]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    observations = [
        Observation(
            row["kind"],
            float(row["confidence"]),
            wkb.loads(row["wkb"], hex=True),
            tuple(row["tile"]),
            int(row["prediction"]),
            int(row["component"]),
        )
        for row in payload["observations"]
    ]
    return observations, payload["meta"]
