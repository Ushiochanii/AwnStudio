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
    # At a junction on an awn, does a second awn of the same spikelet leave along b?
    "branch": (
        ("deflection^2", "shared_support", "width_ratio"),
        lambda r: [_sq(r["deflection_deg"]), r["shared_support"], r["width_ratio"]],
    ),
    "gap": (
        ("distance_mm", "turn_in^2", "turn_out^2", "turn_in*turn_out"),
        lambda r: [r["distance_mm"], _sq(r["turn_in_deg"]), _sq(r["turn_out_deg"]),
                   math.sqrt(_sq(r["turn_in_deg"]) * _sq(r["turn_out_deg"]))],
    ),
    "root": (
        ("distance_mm", "axis^2", "inside", "up"),
        lambda r: [r["distance_mm"], _sq(r["axis_deg"]), float(r["inside"]), r["up"]],
    ),
    # Is an evidence edge part of some awn (vs. clutter: label text, debris, tape edges)?
    "edge": (
        ("confidence", "log_length_mm", "half_width_mm", "terminal_ends"),
        lambda r: [r["confidence"], math.log(max(r["length_mm"], 1e-3)), r["half_width_mm"], r["terminal"]],
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


@dataclass
class ChoiceModel:
    """Conditional logit for the continuation decision at the end of an edge.

    At a decision point the options are: each junction continuation, each gap jump, and
    stopping. Utilities are linear in the option features (separate weights for
    junction and gap options) and a learned constant for stopping, which differs
    between a junction node and an end point. P(option) = softmax(utilities).
    Fitted by maximum likelihood on decision points whose arriving edge lies on a
    truth awn; the chosen option is the labelled continuation, or "stop" when none is.
    """

    junction: np.ndarray  # weights over [1, junction features]
    gap: np.ndarray  # weights over [1, gap features]
    stop: np.ndarray  # [stop utility at junction node, at end point]

    def utilities(self, junction_opts, gap_opts, at_junction: bool) -> np.ndarray:
        fj, fg = FEATURES["junction"][1], FEATURES["gap"][1]
        u = [float(np.dot(self.junction, [1.0, *fj(r)])) for r in junction_opts]
        u += [float(np.dot(self.gap, [1.0, *fg(r)])) for r in gap_opts]
        u.append(float(self.stop[0 if at_junction else 1]))
        return np.asarray(u)

    def probabilities(self, junction_opts, gap_opts, at_junction: bool) -> np.ndarray:
        u = self.utilities(junction_opts, gap_opts, at_junction)
        u = u - u.max()
        e = np.exp(u)
        return e / e.sum()

    def to_json(self):
        return {"junction": self.junction.tolist(), "gap": self.gap.tolist(), "stop": self.stop.tolist(),
                "features": {"junction": ["intercept", *FEATURES["junction"][0]],
                             "gap": ["intercept", *FEATURES["gap"][0]],
                             "stop": ["at_junction", "at_end_point"]}}

    @classmethod
    def from_json(cls, d):
        return cls(np.asarray(d["junction"]), np.asarray(d["gap"]), np.asarray(d["stop"]))


def decision_points(junction_rows, gap_rows):
    """Group option records into decision points keyed by (page, arriving edge, node)."""
    points: dict[tuple, dict] = {}
    for r in junction_rows:
        p = points.setdefault((r["page"], r["a"], r["node"]), {"j": [], "g": [], "at_junction": True, "known": r["known"]})
        p["j"].append(r)
    for r in gap_rows:
        p = points.setdefault((r["page"], r["a"], r["i"]), {"j": [], "g": [], "at_junction": False, "known": r["known"]})
        p["g"].append(r)
    return [p for p in points.values() if p["known"]]


def fit_choice(points, l2: float = 1e-3) -> ChoiceModel:
    nj, ng = 1 + len(FEATURES["junction"][0]), 1 + len(FEATURES["gap"][0])
    fj, fg = FEATURES["junction"][1], FEATURES["gap"][1]
    data = []
    for p in points:
        X = [[1.0, *fj(r)] for r in p["j"]] + [[1.0, *fg(r)] for r in p["g"]]
        kinds = [0] * len(p["j"]) + [1] * len(p["g"])
        labels = [bool(r["label"]) for r in p["j"] + p["g"]]
        data.append((X, kinds, labels, 0 if p["at_junction"] else 1))

    def unpack(w):
        return w[:nj], w[nj:nj + ng], w[nj + ng:]

    def nll(w):
        wj, wg, ws = unpack(w)
        total = 0.0
        for X, kinds, labels, stop_kind in data:
            u = [float(np.dot(wj if k == 0 else wg, x)) for x, k in zip(X, kinds)] + [ws[stop_kind]]
            u = np.asarray(u)
            m = u.max()
            logz = m + np.log(np.exp(u - m).sum())
            chosen = [i for i, lab in enumerate(labels) if lab] or [len(u) - 1]
            uc = u[chosen]
            mc = uc.max()
            total -= (mc + np.log(np.exp(uc - mc).sum())) - logz
        return total / len(data) + l2 * (np.sum(wj[1:] ** 2) + np.sum(wg[1:] ** 2))

    w0 = np.zeros(nj + ng + 2)
    res = minimize(nll, w0, method="L-BFGS-B")
    wj, wg, ws = unpack(res.x)
    return ChoiceModel(wj, wg, ws)


def load_models(path: Path) -> dict:
    data = json.loads(Path(path).read_text())
    models = {k: LogisticModel.from_json(v) for k, v in data["models"].items()}
    if "choice" in data:
        models["choice"] = ChoiceModel.from_json(data["choice"])
    return models
