"""Truth identity of every annotated spikelet on a validation / test page.

Measurement accuracy is evaluated separately from automatic page-layout parsing: each
predicted spikelet is matched to a reviewed spikelet polygon, and that polygon's
(column, repeat, role) identity comes from truth alone.

Within a repeat row the annotated spikelets, sorted left to right, consist of five
consecutive groups (columns 1..5). The cell truth states which roles are physically
present in each cell, hence the size of every group; because slots keep their
left / centre / right order and empty slots are not closed up, the k-th spikelet of a
group carries the k-th present role in (bottom, middle, top) order.
"""
from __future__ import annotations

from dataclasses import dataclass

from .layout import _page_height, ordered_match, repeat_of, slot_template
from .truth import ROLES, TruthInstance, cell_truth, column_ranges, truth_instances


@dataclass(frozen=True)
class SpikeletIdentity:
    instance: TruthInstance
    column: int
    repeat: int
    role: str


def truth_spikelet_identities(page_id: str, split: str = "valid") -> tuple[list[SpikeletIdentity], list[str]]:
    """Return identities and a list of rows whose counts disagree with cell truth."""
    height = _page_height(page_id)
    rows: dict[int, list[TruthInstance]] = {1: [], 2: [], 3: []}
    for inst in truth_instances(page_id, split):
        if inst.kind == "spikelet":
            rows[repeat_of(inst.geometry.centroid.y, height)].append(inst)

    cells = cell_truth()
    out, problems = [], []
    for repeat, members in rows.items():
        members.sort(key=lambda inst: inst.geometry.centroid.x)
        present = []
        for column in range(1, 6):
            truth = cells.get(f"{page_id}:C{column}R{repeat}")
            present.append(sorted(truth["present_roles"], key=ROLES.index) if truth else None)
        if any(p is None for p in present):
            problems.append(f"{page_id} R{repeat}: cell truth missing")
            continue
        expected = [(column, role) for column, roles in enumerate(present, start=1) for role in roles]
        if len(expected) == len(members):
            for inst, (column, role) in zip(members, expected):
                out.append(SpikeletIdentity(inst, column, repeat, role))
            continue
        # Annotation count differs from cell truth (an unannotated or merged spikelet):
        # align in order against nominal slot positions; unmatched members are dropped.
        problems.append(f"{page_id} R{repeat}: {len(members)} annotated vs {len(expected)} expected")
        columns, template = column_ranges(page_id), slot_template()
        anchors = [
            columns[c][0] + template.anchors[ROLES.index(role)] * (columns[c][1] - columns[c][0])
            for c, role in expected
        ]
        width = sum(b - a for a, b in columns.values()) / len(columns)
        xs = [inst.geometry.centroid.x for inst in members]
        for inst, slot in zip(members, ordered_match(xs, anchors, skip_cost=width)):
            if slot is not None:
                out.append(SpikeletIdentity(inst, expected[slot][0], repeat, expected[slot][1]))
    return out, problems
