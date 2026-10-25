"""Project paths, resolved from configs/paths.yaml (+ optional paths.local.yaml)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _expand(values: dict[str, str]) -> dict[str, str]:
    pattern = re.compile(r"\$\{(\w+)\}")
    out = dict(values)
    for _ in range(8):
        changed = False
        for key, value in out.items():
            new = pattern.sub(lambda m: out[m.group(1)], str(value))
            if new != value:
                out[key], changed = new, True
        if not changed:
            return out
    raise ValueError("cyclic reference in paths.yaml")


@dataclass(frozen=True)
class Paths:
    legacy_root: Path
    raw_pages: Path
    weights: Path
    annotations: Path
    split_manifest: Path
    crop_manifest: Path
    page_annotations: Path
    length_truth: Path
    validation_cell_truth: Path
    accession_mapping: Path
    runs: Path

    def page_image(self, page_id: str) -> Path:
        return self.raw_pages / f"{page_id}.JPG"


@lru_cache(maxsize=1)
def paths() -> Paths:
    values = yaml.safe_load((REPO_ROOT / "configs/paths.yaml").read_text(encoding="utf-8"))
    local = REPO_ROOT / "configs/paths.local.yaml"
    if local.exists():
        values.update(yaml.safe_load(local.read_text(encoding="utf-8")) or {})
    values = _expand(values)
    return Paths(**{key: Path(values[key]) for key in Paths.__dataclass_fields__})
