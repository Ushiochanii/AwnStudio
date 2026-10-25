"""Result records shared by the pipeline, baselines, evaluation and the web service."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from shapely import wkt
from shapely.geometry.base import BaseGeometry


@dataclass
class AwnResult:
    path_px: list[tuple[float, float]]  # measurement path, root -> tip
    length_mm: float
    complete: bool = True
    score: float | None = None  # method-specific confidence / posterior
    meta: dict = field(default_factory=dict)


@dataclass
class SpikeletResult:
    id: str
    geometry: BaseGeometry
    awns: list[AwnResult] = field(default_factory=list)
    representative: int | None = None  # index into awns
    meta: dict = field(default_factory=dict)

    @property
    def length_mm(self) -> float | None:
        """Representative awn length; None when no awn was reconstructed."""
        return None if self.representative is None else self.awns[self.representative].length_mm


@dataclass
class PageResult:
    page_id: str
    method: str
    x_period_px: float
    y_period_px: float
    spikelets: list[SpikeletResult]
    meta: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "page_id": self.page_id,
            "method": self.method,
            "x_period_px": self.x_period_px,
            "y_period_px": self.y_period_px,
            "meta": self.meta,
            "spikelets": [
                {
                    "id": s.id,
                    "geometry_wkt": s.geometry.wkt,
                    "representative": s.representative,
                    "meta": s.meta,
                    "awns": [asdict(a) for a in s.awns],
                }
                for s in self.spikelets
            ],
        }

    @classmethod
    def from_json(cls, data: dict) -> "PageResult":
        return cls(
            page_id=data["page_id"],
            method=data["method"],
            x_period_px=float(data["x_period_px"]),
            y_period_px=float(data["y_period_px"]),
            meta=data.get("meta", {}),
            spikelets=[
                SpikeletResult(
                    id=s["id"],
                    geometry=wkt.loads(s["geometry_wkt"]),
                    representative=s["representative"],
                    meta=s.get("meta", {}),
                    awns=[AwnResult(**{**a, "path_px": [tuple(p) for p in a["path_px"]]}) for a in s["awns"]],
                )
                for s in data["spikelets"]
            ],
        )
