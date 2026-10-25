"""Page layout: which accession column, repeat row and spikelet slot an object is in.

A page holds 5 columns (accessions) x 3 rows (biological repeats). Inside a cell the
three sampled spikelets (bottom / middle / top of the original spike) are placed at
fixed left / centre / right slots, and a missing spikelet leaves its slot empty.

Slot positions are learned once from training-page truth: for every training cell
with exactly three annotated spikelets, the normalized x of the sorted centroids are
collected and their medians become the slot anchors. Within a cell, detected
spikelets are matched to anchors by minimum total |x - anchor| (Hungarian), with an
"unassigned" option so that extra detections never displace a real slot.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .paths import paths
from .truth import ROLES, column_ranges, truth_instances

# Repeat-row centres at the 2480 px reference page height (fixed print layout).
REPEAT_CENTRES_NORM = (801.5 / 2480.0, 1562.0 / 2480.0, 2332.5 / 2480.0)


@dataclass(frozen=True)
class SlotTemplate:
    anchors: tuple[float, float, float]  # normalized x within a column, left -> right
    tolerance: float  # max deviation seen in training + margin; beyond -> unassigned


@dataclass(frozen=True)
class Placement:
    column: int
    repeat: int
    role: str | None  # None: could not be placed in a slot


def repeat_of(y: float, height: float) -> int:
    centres = [c * height for c in REPEAT_CENTRES_NORM]
    edges = [(centres[0] + centres[1]) / 2.0, (centres[1] + centres[2]) / 2.0]
    return 1 if y < edges[0] else 2 if y < edges[1] else 3


def column_of(x: float, columns: dict[int, tuple[float, float]]) -> int:
    for index, (x1, x2) in sorted(columns.items()):
        if x1 <= x < x2:
            return index
    return min(columns, key=lambda i: abs(x - sum(columns[i]) / 2.0))


@lru_cache(maxsize=1)
def slot_template() -> SlotTemplate:
    cache = paths().runs / "slot_template.json"
    if cache.exists():
        data = json.loads(cache.read_text())
        return SlotTemplate(tuple(data["anchors"]), float(data["tolerance"]))

    from .splits import pages

    values: list[list[float]] = [[], [], []]
    for page in pages("train"):
        columns = column_ranges(page)
        cells = defaultdict(list)
        for inst in truth_instances(page, "train"):
            if inst.kind != "spikelet":
                continue
            c = inst.geometry.centroid
            column = column_of(c.x, columns)
            # Page height is constant across the dataset's scans except a few 2x pages;
            # repeat bands are proportional, so read height from the crop manifest.
            cells[(column, repeat_of(c.y, _page_height(page)))].append(c.x)
        for (column, _), xs in cells.items():
            if len(xs) != 3:
                continue
            x1, x2 = columns[column]
            for slot, x in enumerate(sorted(xs)):
                values[slot].append((x - x1) / (x2 - x1))
    anchors = tuple(float(np.median(v)) for v in values)
    tolerance = max(float(np.max(np.abs(np.asarray(v) - a))) for v, a in zip(values, anchors)) + 0.02
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"anchors": anchors, "tolerance": tolerance, "cells": len(values[0])}))
    return SlotTemplate(anchors, tolerance)


@lru_cache(maxsize=None)
def _page_height(page: str) -> float:
    from .truth import _crop_manifest

    for row in _crop_manifest().values():
        if row["source"] == f"{page}.png":
            return float(row["source_size"][1])
    raise KeyError(page)


def _ordered_slots(xs: list[float], template: SlotTemplate) -> list[int | None]:
    return ordered_match(xs, template.anchors, template.tolerance)


def ordered_match(xs, anchors, skip_cost: float) -> list[int | None]:
    """Order-preserving match of left-to-right objects to left-to-right anchors.

    Minimizes sum |x - anchor| subject to anchor order following x order; an object may
    instead stay unassigned at `skip_cost`, and anchors may stay empty for free.
    Solved exactly by dynamic programming.
    """
    n, m = len(xs), len(anchors)
    inf = float("inf")
    # best[i][j]: min cost placing first i objects using only the first j slots.
    best = [[inf] * (m + 1) for _ in range(n + 1)]
    move = [[None] * (m + 1) for _ in range(n + 1)]
    for j in range(m + 1):
        best[0][j] = 0.0
    for i in range(1, n + 1):
        for j in range(m + 1):
            options = [(best[i - 1][j] + skip_cost, ("skip", j))]
            if j > 0:
                options.append((best[i][j - 1], ("unused_slot", j - 1)))
                options.append((best[i - 1][j - 1] + abs(xs[i - 1] - anchors[j - 1]), ("match", j - 1)))
            best[i][j], move[i][j] = min(options, key=lambda o: o[0])
    out: list[int | None] = [None] * n
    i, j = n, m
    while i > 0:
        kind, target = move[i][j]
        if kind == "skip":
            i -= 1
        elif kind == "unused_slot":
            j = target
        else:
            out[i - 1] = target
            i, j = i - 1, target
    return out


def place_spikelets(centroids: list[tuple[float, float]], page: str, height: float) -> list[Placement]:
    """Assign column / repeat / role to each spikelet centroid of a page."""
    columns = column_ranges(page)
    template = slot_template()
    cells = defaultdict(list)
    for index, (x, y) in enumerate(centroids):
        cells[(column_of(x, columns), repeat_of(y, height))].append(index)

    roles: dict[int, str | None] = {}
    for (column, _), members in cells.items():
        x1, x2 = columns[column]
        members = sorted(members, key=lambda i: centroids[i][0])
        nx = [(centroids[i][0] - x1) / (x2 - x1) for i in members]
        for index, slot in zip(members, _ordered_slots(nx, template)):
            roles[index] = None if slot is None else ROLES[slot]

    return [
        Placement(column_of(x, columns), repeat_of(y, height), roles[i]) for i, (x, y) in enumerate(centroids)
    ]
