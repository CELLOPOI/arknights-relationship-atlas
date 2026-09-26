"""纯数值回归：不初始化 Django，不连接数据库。"""
import json
import math
import unittest

import numpy as np

from .preference_solver import PreparedBT


def comparison(a, b, winner, weight=1):
    return {"left_id": a, "right_id": b, "winner_id": winner, "weight": weight}


class PreparedBTTests(unittest.TestCase):
    def setUp(self):
        self.ids = ["a", "b", "c"]
        self.rows = [comparison(*values) for values in (
            ("a", "b", "a", 4), ("a", "b", "b", 1), ("a", "c", "c", 2),
            ("b", "c", "b", 3), ("b", "c", "c", 1))]

    def test_legacy_mm_golden_and_side_invariance(self):
        # 旧版纯 Python MM 在 tolerance=1e-12 下产生的固定回归值。
        expected = [54.016728578247694, 46.715496623794074, 49.267774797958246]
        fit = PreparedBT(self.ids, self.rows).fit(tolerance=1e-12, gradient_tolerance=1e-12)
        self.assertTrue(fit.converged)
        np.testing.assert_allclose(list(fit.scores.values()), expected, atol=1e-9, rtol=0)
        swapped = [dict(row, left_id=row["right_id"], right_id=row["left_id"]) for row in self.rows]
        other = PreparedBT(self.ids, swapped).fit(tolerance=1e-12, gradient_tolerance=1e-12)
        np.testing.assert_allclose(fit.abilities, other.abilities, atol=1e-12)
        self.assertAlmostEqual(sum(fit.scores.values()), 150)

    def test_bootstrap_multiplicity_matches_materialized_rows(self):
        multipliers = [2, 0, 3, 1, 0]
        prepared = PreparedBT(self.ids, self.rows)
        fit = prepared.fit(multipliers=multipliers)
        duplicated = [dict(row) for row, count in zip(self.rows, multipliers) for _ in range(count)]
        expected = PreparedBT(self.ids, duplicated).fit()
        np.testing.assert_allclose(fit.abilities, expected.abilities, atol=1e-12)
        self.assertEqual(self.rows[0]["weight"], 4)

    def test_joint_weight_and_prior_scaling_preserves_solution(self):
        prepared = PreparedBT(self.ids, self.rows)
        base = prepared.fit()
        scaled = prepared.fit(prior=1.5, multipliers=np.full(len(self.rows), 3.0))
        np.testing.assert_allclose(base.abilities, scaled.abilities, atol=1e-12)
        self.assertAlmostEqual(scaled.objective, 3 * base.objective)
        # 宽松的步长条件不能绕过梯度验收。
        rejected = prepared.fit(max_iterations=1, tolerance=10, gradient_tolerance=1e-12)
        self.assertFalse(rejected.converged)

    def test_warm_start_and_explicit_exhaustion(self):
        prepared = PreparedBT(self.ids, self.rows)
        short = prepared.fit(max_iterations=1)
        self.assertFalse(short.converged)
        self.assertEqual(short.iterations, 1)
        self.assertGreater(short.gradient_residual, 1e-6)
        cold = prepared.fit()
        initial = cold.abilities.copy()
        warm = prepared.fit(initial=initial)
        self.assertTrue(warm.converged)
        self.assertLess(warm.iterations, cold.iterations)
        np.testing.assert_array_equal(initial, cold.abilities)
        np.testing.assert_allclose(list(cold.scores.values()), list(warm.scores.values()), atol=1e-5)
        json.dumps(short.diagnostics(), allow_nan=False)
        self.assertNotIn("abilities", short.diagnostics())

    def test_weak_bridge_needs_more_than_500_iterations(self):
        ids = list(map(str, range(10)))
        rows = []
        for start in (0, 5):
            for i in range(start, start + 5):
                for j in range(i + 1, start + 5):
                    rows.extend((comparison(str(i), str(j), str(i), 10),
                                 comparison(str(i), str(j), str(j), 10)))
        rows.extend((comparison("0", "5", "0", 2), comparison("0", "5", "5", 1)))
        prepared = PreparedBT(ids, rows)
        short = prepared.fit(max_iterations=500)
        fit = prepared.fit()
        self.assertFalse(short.converged)
        self.assertTrue(fit.converged)
        self.assertGreater(fit.iterations, 500)
        self.assertLess(max(abs(fit.scores[p] - short.scores[p]) for p in ids), .01)
        self.assertGreaterEqual(fit.objective, short.objective)

    def test_objective_and_normalized_gradient_against_independent_formula(self):
        prepared = PreparedBT(self.ids, self.rows)
        fit = prepared.fit(tolerance=1e-12, gradient_tolerance=1e-12)
        abilities = dict(zip(self.ids, fit.abilities))
        objective = sum(row["weight"] * math.log(abilities[row["winner_id"]]
                        / (abilities[row["left_id"]] + abilities[row["right_id"]])) for row in self.rows)
        objective += sum(.5 * math.log(value / (1 + value) ** 2) for value in abilities.values())
        gradients, degrees = dict.fromkeys(self.ids, 0.0), dict.fromkeys(self.ids, 1.0)
        for pid, value in abilities.items():
            gradients[pid] = .5 - value / (1 + value)
        for row in self.rows:
            total = abilities[row["left_id"]] + abilities[row["right_id"]]
            gradients[row["winner_id"]] += row["weight"]
            for pid in (row["left_id"], row["right_id"]):
                gradients[pid] -= row["weight"] * abilities[pid] / total
                degrees[pid] += row["weight"]
        self.assertAlmostEqual(fit.objective, objective, places=12)
        self.assertAlmostEqual(fit.gradient_residual, max(abs(gradients[p]) / degrees[p] for p in self.ids),
                               places=14)
        self.assertLess(fit.gradient_residual, 1e-12)
        previous = prepared.fit(max_iterations=1)
        for _ in range(15):
            current = prepared.fit(max_iterations=1, initial=previous.abilities)
            self.assertGreaterEqual(current.objective + 1e-12, previous.objective)
            previous = current

    def test_empty_and_zero_weight_data(self):
        empty = PreparedBT([], []).fit()
        self.assertEqual(empty.scores, {})
        self.assertTrue(empty.converged)
        self.assertEqual(empty.iterations, 0)
        fit = PreparedBT(self.ids, []).fit()
        self.assertEqual(fit.scores, dict.fromkeys(self.ids, 50.0))
        zero = PreparedBT(self.ids, self.rows).fit(multipliers=np.zeros(len(self.rows)))
        np.testing.assert_array_equal(zero.abilities, fit.abilities)
        self.assertTrue(zero.converged)

    def test_invalid_inputs_are_rejected(self):
        for ids, rows in ((["a", "a"], []), (self.ids, [comparison("a", "a", "a")]),
                          (self.ids, [comparison("a", "b", "c")]),
                          (self.ids, [comparison("a", "z", "a")]),
                          (self.ids, [comparison("a", "b", "a", -1)]),
                          (self.ids, [comparison("a", "b", "a", float("nan"))])):
            with self.subTest(ids=ids, rows=rows), self.assertRaises(ValueError):
                PreparedBT(ids, rows)
        prepared = PreparedBT(self.ids, self.rows)
        for kwargs in ({"prior": 0}, {"tolerance": float("nan")}, {"gradient_tolerance": -1},
                       {"max_iterations": 0}, {"initial": [0, 1, 1]}, {"initial": [1]},
                       {"multipliers": [1]}, {"multipliers": [-1] * 5},
                       {"multipliers": [float("inf")] * 5}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                prepared.fit(**kwargs)
