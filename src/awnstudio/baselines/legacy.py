"""Adapter running the research project's maintained pipeline (Unified Growth) as a
baseline, on this repository's cached detections and calibration.

It mirrors the research Workbench orchestration (evidence -> spikelet reconciliation
-> physical seeds -> spikelet cleanup -> Unified Growth closeout -> root
normalization) and measures the representative path with the same DP1 rule.
Imports the legacy package from the read-only research checkout.
"""
from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ..detection import Observation, primary, tile_windows
from ..measurement import measure_path_mm
from ..paths import paths
from ..results import AwnResult, PageResult, SpikeletResult


def _legacy():
    root = str(paths().legacy_root / "src")
    if root not in sys.path:
        sys.path.insert(0, root)


@dataclass
class _StaticProvider:
    observations: tuple

    @property
    def provider(self):
        from awnphen.core.domain.physical import EvidenceProvider

        return EvidenceProvider.PRIMARY

    def provenance_payload(self):
        return {
            "implementation": "awnstudio.cached_detections",
            "model_identity": str(paths().weights),
            "weights_sha256": "see runs/detections meta",
        }

    def observe_page(self, *, page_id: str):
        return self.observations


def run_legacy_page(page_id: str, observations: list[Observation], width: int, height: int, calibration) -> PageResult:
    _legacy()
    from awnphen.core.io.evidence import write_evidence_snapshot
    from awnphen.core.io.reconstruction import write_physical_seed_result
    from awnphen.core.io.spikelet_cleanup import write_spikelet_cleanup_result
    from awnphen.phenotyping.detection.acquisition import RawDetectionObservation, acquire_detection_evidence
    from awnphen.phenotyping.detection.reconciliation import reconcile_detection_evidence
    from awnphen.phenotyping.physical.contracts import seed_physical_entities
    from awnphen.phenotyping.physical.spikelet_cleanup import evaluate_physical_spikelet_cleanup
    from awnphen.pipeline.physical_closeout import run_physical_closeout

    tile_index = {tuple(t): i for i, t in enumerate(tile_windows(width, height))}
    raw = tuple(
        RawDetectionObservation(
            class_id=0 if o.kind == "awn" else 1,
            class_name=o.kind,
            confidence=o.confidence,
            geometry=o.geometry,
            source_tile_id=f"tile_{tile_index[tuple(o.tile)]:04d}",
            source_prediction_index=o.prediction,
            source_component_index=o.component,
            tile_xyxy=tuple(float(v) for v in o.tile),
        )
        for o in primary(observations)
    )
    evidence = acquire_detection_evidence(page_id=page_id, source_sha256="cached", providers=(_StaticProvider(raw),))
    reconciliation = reconcile_detection_evidence(evidence.evidence)
    seeds = seed_physical_entities(reconciliation.hypotheses)
    cleanup = evaluate_physical_spikelet_cleanup(
        seeds.physical_spikelets, evidence.evidence, page_width_px=width, page_height_px=height
    )
    cal = {
        page_id: {
            "x": calibration.x_period_px,
            "y": calibration.y_period_px,
            "adequate": calibration.adequate,
            "page_width_px": width,
            "page_height_px": height,
        }
    }
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp)
        for name in ("phase2", "seeds", "cleanup"):
            (ws / name / page_id).mkdir(parents=True)
        write_evidence_snapshot(evidence, ws / "phase2" / page_id / "evidence_snapshot.json")
        write_physical_seed_result(seeds, ws / "seeds" / page_id / "physical_seed_result.json")
        write_spikelet_cleanup_result(cleanup, ws / "cleanup" / page_id / "spikelet_cleanup_result.json")
        run_physical_closeout(
            repository_root=ws,  # like the Workbench: no reviewed per-page overrides
            pages=(page_id,),
            phase2_root=ws / "phase2",
            seed_root=ws / "seeds",
            cleanup_root=ws / "cleanup",
            output_root=ws / "closeout",
            calibration=cal,
        )
        reps = json.loads(
            (ws / "closeout/02_root_normalized" / page_id / "representative_result.json").read_text(encoding="utf-8")
        )["representatives"]

    active = {str(v) for v in cleanup.active_physical_spikelet_ids}
    spikelets = {
        str(s.seed_hypothesis_id): SpikeletResult(id=str(s.physical_spikelet_id), geometry=s.geometry)
        for s in seeds.physical_spikelets
        if str(s.physical_spikelet_id) in active
    }
    for rep in reps:
        if rep.get("status") != "SELECTED" or not rep.get("raw_path"):
            continue
        spikelet = spikelets.get(str(rep.get("canonical_spikelet_id") or rep["spikelet_id"]))
        if spikelet is None:
            continue
        path = [tuple(map(float, p)) for p in rep["raw_path"]]
        spikelet.awns.append(
            AwnResult(path, measure_path_mm(path, calibration), meta={"candidate_id": rep["candidate_id"]})
        )
        spikelet.representative = len(spikelet.awns) - 1
    return PageResult(
        page_id, "legacy_unified_growth", calibration.x_period_px, calibration.y_period_px, list(spikelets.values())
    )
