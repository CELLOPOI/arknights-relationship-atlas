"""预编译稀疏比较网络的 Bradley–Terry 求解器，不访问数据库。"""
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BTFit:
    scores: dict
    abilities: np.ndarray
    converged: bool
    iterations: int
    max_log_step: float
    gradient_residual: float
    objective: float

    def diagnostics(self):
        return {
            "converged": self.converged,
            "iterations": self.iterations,
            "max_log_step": self.max_log_step,
            "gradient_residual": self.gradient_residual,
            "objective": self.objective,
        }


class PreparedBT:
    def __init__(self, ids, rows):
        self.ids = tuple(ids)
        if len(set(self.ids)) != len(self.ids):
            raise ValueError("BT ids must be unique")
        index = {pid: position for position, pid in enumerate(self.ids)}
        edge_index, left, right, row_edges, winners, weights = {}, [], [], [], [], []
        for row in rows:
            a, b, winner = row["left_id"], row["right_id"], row["winner_id"]
            if a not in index or b not in index or a == b or winner not in (a, b):
                raise ValueError("BT comparisons must contain distinct known ids and a valid winner")
            weight = float(row.get("weight", 1.0))
            if not np.isfinite(weight) or weight < 0:
                raise ValueError("BT weights must be finite and nonnegative")
            pair = tuple(sorted((index[a], index[b])))
            if pair not in edge_index:
                edge_index[pair] = len(left)
                left.append(pair[0])
                right.append(pair[1])
            row_edges.append(edge_index[pair])
            winners.append(index[winner])
            weights.append(weight)
        self._left = np.asarray(left, dtype=np.intp)
        self._right = np.asarray(right, dtype=np.intp)
        self._row_edges = np.asarray(row_edges, dtype=np.intp)
        self._winners = np.asarray(winners, dtype=np.intp)
        self._weights = np.asarray(weights, dtype=float)

    def fit(self, *, prior=.5, max_iterations=5000, tolerance=1e-6,
            gradient_tolerance=1e-6, initial=None, multipliers=None):
        for value in (prior, tolerance, gradient_tolerance):
            if not np.isfinite(value) or value <= 0:
                raise ValueError("BT prior and tolerances must be finite and positive")
        if isinstance(max_iterations, bool) or not isinstance(max_iterations, int) or max_iterations < 1:
            raise ValueError("BT max_iterations must be a positive integer")
        weights = self._weights
        if multipliers is not None:
            multipliers = np.asarray(multipliers, dtype=float)
            if (multipliers.shape != weights.shape or not np.all(np.isfinite(multipliers))
                    or np.any(multipliers < 0)):
                raise ValueError("BT multipliers must match rows and be finite and nonnegative")
            with np.errstate(over="ignore", invalid="ignore"):
                weights = weights * multipliers
            if not np.all(np.isfinite(weights)):
                raise ValueError("BT multiplied weights must be finite")
        n = len(self.ids)
        abilities = np.ones(n) if initial is None else np.array(initial, dtype=float, copy=True)
        if abilities.shape != (n,) or not np.all(np.isfinite(abilities)) or np.any(abilities <= 0):
            raise ValueError("BT initial abilities must be finite, positive and match ids")
        if not n:
            return BTFit({}, abilities, True, 0, 0.0, 0.0, 0.0)
        counts = np.bincount(self._row_edges, weights=weights, minlength=len(self._left))
        wins = np.bincount(self._winners, weights=weights, minlength=n)
        degree = (np.bincount(self._left, weights=counts, minlength=n)
                  + np.bincount(self._right, weights=counts, minlength=n))
        if not np.all(np.isfinite(degree)) or not np.all(np.isfinite(wins)):
            raise ValueError("BT aggregate weights must be finite")
        converged = False
        try:
            with np.errstate(over="raise", divide="raise", invalid="raise"):
                for iteration in range(1, max_iterations + 1):
                    pair_denominator = counts / (abilities[self._left] + abilities[self._right])
                    denominator = (2 * prior / (abilities + 1)
                                   + np.bincount(self._left, weights=pair_denominator, minlength=n)
                                   + np.bincount(self._right, weights=pair_denominator, minlength=n))
                    updated = (wins + prior) / denominator
                    logs = np.log(updated)
                    shift = 0.0
                    # 同一目标下优化共同尺度；两两概率不变，锚点项达到最大值。
                    for _ in range(12):
                        probabilities = 1 / (1 + np.exp(-np.clip(logs + shift, -40, 40)))
                        gradient = probabilities.sum() - n / 2
                        curvature = (probabilities * (1 - probabilities)).sum()
                        if not curvature or abs(gradient) < 1e-10:
                            break
                        shift -= np.clip(gradient / curvature, -2, 2)
                    logs += shift
                    updated = np.exp(logs)
                    step = float(np.max(np.abs(logs - np.log(abilities))))
                    abilities = updated
                    if step < tolerance or iteration == max_iterations:
                        residual, objective = self._diagnostics(logs, counts, wins, degree, prior)
                        if step < tolerance and residual < gradient_tolerance:
                            converged = True
                            break
                # 沿用含自身的固定参照池平均预测胜率，不进行极值拉伸。
                scores = 100 * (1 / (1 + np.exp(np.clip(logs[None, :] - logs[:, None], -709, 709)))).mean(axis=1)
        except FloatingPointError as error:
            raise ValueError("BT numerical values exceeded the finite calculation range") from error
        if not np.all(np.isfinite(scores)) or not np.isfinite(objective) or not np.isfinite(residual):
            raise ValueError("BT diagnostics must remain finite")
        return BTFit(dict(zip(self.ids, map(float, scores))), abilities, converged,
                     iteration, step, residual, objective)

    def _diagnostics(self, logs, counts, wins, degree, prior):
        left_probability = 1 / (1 + np.exp(np.clip(logs[self._right] - logs[self._left], -709, 709)))
        expected = (np.bincount(self._left, weights=counts * left_probability, minlength=len(self.ids))
                    + np.bincount(self._right, weights=counts * (1 - left_probability), minlength=len(self.ids)))
        anchor_probability = 1 / (1 + np.exp(np.clip(-logs, -709, 709)))
        # log能力的目标梯度为胜量+prior−期望胜量−2prior×锚点胜率。
        # 除以该人物比较总量+2prior，避免高参与量本身放大停止条件。
        residual = float(np.max(np.abs(wins + prior - expected - 2 * prior * anchor_probability)
                                   / (degree + 2 * prior)))
        # 向量归约无需调用 BLAS，避免短点积唤醒多个线程并在迭代期间忙等。
        objective = float(np.sum(wins * logs)
                          - np.sum(counts * np.logaddexp(logs[self._left], logs[self._right]))
                          + prior * np.sum(logs - 2 * np.logaddexp(0, logs)))
        return residual, objective
