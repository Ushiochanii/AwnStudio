"""Probability models for tracing decisions.

Each decision type gets a logistic model  P(correct | x) = sigmoid(w . phi(x))  over a
few interpretable geometric features. Angles enter squared, which corresponds to a
Gaussian (von Mises at small angles) likelihood ratio of smooth continuation versus
an arbitrary turn; distances enter linearly and squared. Coefficients are fitted by
maximum likelihood (small L2 for numerical stability) on decisions labelled
automatically from the training-page polygons (`awnstudio.labels`), and frozen.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize


def _sq(deg: float) -> float:
    return (float(deg) / 90.0) ** 2


FEATURES = {
    # name -> (feature names, function(record) -> feature vector without intercept)
    "junction": (
        ("deflection^2", "shared_support", "width_ratio"),
        lambda r: [_sq(r["deflection_deg"]), r["shared_support"], r["width_ratio"]],
    ),
    "gap": (
        ("distance_mm", "turn_in^2", "turn_out^2", "turn_in*turn_out"),
        lambda r: [r["distance_mm"], _sq(r["turn_in_deg"]), _sq(r["turn_out_deg"]),
                   math.sqrt(_sq(r["turn_in_deg"]) * _sq(r["turn_out_deg"]))],
    ),
    "root": (
        ("distance_mm", "axis^2", "inside"),
        lambda r: [r["distance_mm"], _sq(r["axis_deg"]), float(r["inside"])],
    ),
}


@dataclass
class LogisticModel:
    kind: str
    weights: np.ndarray  # [intercept, *features]

    def design(self, records) -> np.ndarray:
        fn = FEATURES[self.kind][1]
        return np.asarray([[1.0, *fn(r)] for r in records], float)

    def prob(self, record) -> float:
        z = float(self.design([record])[0] @ self.weights)
        return 1.0 / (1.0 + math.exp(-z))

    def log_odds(self, record) -> float:
        return float(self.design([record])[0] @ self.weights)

    def to_json(self) -> dict:
        return {"kind": self.kind, "features": ["intercept", *FEATURES[self.kind][0]], "weights": self.weights.tolist()}

    @classmethod
    def from_json(cls, data) -> "LogisticModel":
        return cls(data["kind"], np.asarray(data["weights"], float))


def fit(kind: str, records, l2: float = 1e-3) -> tuple[LogisticModel, dict]:
    model = LogisticModel(kind, np.zeros(1 + len(FEATURES[kind][0])))
    X = model.design(records)
    y = np.asarray([bool(r["label"]) for r in records], float)

    def loss(w):
        z = X @ w
        ll = np.logaddexp(0.0, z) - y * z
        return ll.mean() + l2 * (w[1:] ** 2).sum()

    def grad(w):
        p = 1.0 / (1.0 + np.exp(-(X @ w)))
        g = X.T @ (p - y) / len(y)
        g[1:] += 2 * l2 * w[1:]
        return g

    res = minimize(loss, model.weights, jac=grad, method="L-BFGS-B")
    model.weights = res.x
    p = 1.0 / (1.0 + np.exp(-(X @ res.x)))
    report = {"n": len(y), "positives": int(y.sum()), "log_loss": float(res.fun), **calibration_report(p, y)}
    return model, report


def calibration_report(p: np.ndarray, y: np.ndarray, bins: int = 10) -> dict:
    """Accuracy at 0.5, AUC, and a reliability table."""
    order = np.argsort(-p)
    ys = y[order]
    tp = np.cumsum(ys)
    fp = np.cumsum(1 - ys)
    auc = float(np.trapezoid(tp / max(1, tp[-1]), fp / max(1, fp[-1]))) if len(y) else None
    edges = np.linspace(0, 1, bins + 1)
    table = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.any():
            table.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": int(m.sum()), "mean_p": float(p[m].mean()), "freq": float(y[m].mean())})
    return {"accuracy@0.5": float(((p >= 0.5) == y).mean()), "auc": auc, "reliability": table}


def load_models(path: Path) -> dict[str, LogisticModel]:
    data = json.loads(Path(path).read_text())
    return {k: LogisticModel.from_json(v) for k, v in data["models"].items()}
