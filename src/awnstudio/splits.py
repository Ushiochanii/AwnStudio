"""Page-level data splits (fixed by the research project's split manifest)."""
from __future__ import annotations

import json
from functools import lru_cache

from .paths import paths

VALIDATION_PAGES = (
    "IMG_9688", "IMG_9689", "IMG_9700", "IMG_9710", "IMG_9711", "IMG_9712",
    "IMG_9722", "IMG_9753", "IMG_9761", "IMG_9795", "IMG_9796",
)
# Locked test pages: scored once, after every method choice is frozen.
TEST_PAGES = (
    "IMG_9691", "IMG_9692", "IMG_9707", "IMG_9721", "IMG_9726", "IMG_9744",
    "IMG_9750", "IMG_9757", "IMG_9781", "IMG_9786", "IMG_9797",
)


@lru_cache(maxsize=1)
def split_of_page() -> dict[str, str]:
    manifest = json.loads(paths().split_manifest.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for split in ("train", "valid", "test"):
        for page in manifest["summary"][split]["pages"]:
            out[str(page)] = split
    return out


def pages(split: str) -> tuple[str, ...]:
    return tuple(sorted(page for page, s in split_of_page().items() if s == split))
