"""区间计算、资格原因及新算法快照的保留边界。"""
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from .preference_models import (
    PreferenceCatalog,
    PreferenceChoice,
    PreferenceEvent,
    PreferenceOperation,
    PreferenceParticipant,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_services import quota, update_supports
from .preference_solver import PreparedBT
from .preference_statistics import (
    aggregate,
    algorithm_version,
    analyze_random,
    attach_rank_intervals,
    random_result,
    random_window_results,
)
from .test_preferences import payload, perform, setup_data


@override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=24, PREFERENCE_MIN_OPPONENTS=2,
                   PREFERENCE_MAX_INTERVAL_WIDTH=100)
class RandomStatisticsTests(SimpleTestCase):
    def setUp(self):
        self.cutoff = datetime(2026, 9, 26, 4, tzinfo=UTC)
        self.rows = []
        for uid in range(40):
            for offset, (left, right) in enumerate((("a", "b"), ("a", "c"), ("b", "c"))):
                self.rows.append({"id": len(self.rows), "participant_id": str(uid),
                                  "left_id": left, "right_id": right,
                                  "winner_id": left if (uid + offset) % 5 < 3 else right,
                                  "outcome": "choose", "strategy": "uniform-v1",
                                  "accepted_at": self.cutoff - timedelta(days=2)})

    def analyze(self, rows=None, cutoff=None, window=84):
        return analyze_random(payload(), cutoff or self.cutoff, window, self.rows if rows is None else rows)

    def test_same_effective_input_keeps_intervals_across_windows_time_and_order(self):
        original = deepcopy(self.rows)
        long = self.analyze()
        short = self.analyze(window=28)
        later = self.analyze(cutoff=self.cutoff + timedelta(hours=1))
        swapped = self.analyze([dict(row, left_id=row["right_id"], right_id=row["left_id"])
                                for row in reversed(self.rows)])
        for other in (short, later, swapped):
            self.assertEqual(long["rows"], other["rows"])
            self.assertEqual(long["diagnostics"], other["diagnostics"])
        self.assertEqual(self.rows, original)
        self.assertEqual(long["rank_reference_pool"], ["a", "b", "c"])
        self.assertEqual(long["diagnostics"]["bootstrap"]["successful"], 24)
        self.assertTrue(all(row["rank_interval"] for row in long["rows"] if row["rank"]))
        self.assertIsNone(next(row for row in long["rows"] if row["id"] == "d")["score"])

    def test_identical_windows_reuse_four_analyses_as_two_with_identical_results(self):
        subject_ids = {"a": "form:f1", "b": "person:b", "c": "person:c"}
        rows = [dict(row, left_subject_id=subject_ids[row["left_id"]],
                     right_subject_id=subject_ids[row["right_id"]]) for row in self.rows]
        with patch("atlas.preference_statistics.random_result", wraps=random_result) as calculation:
            expected = {scope: {window: calculation(payload(), self.cutoff, window, scope, rows=rows)
                                for window in (84, 28)} for scope in ("person", "form")}
            self.assertEqual(calculation.call_count, 4)
            calculation.reset_mock()
            actual = {scope: random_window_results(payload(), self.cutoff, scope, rows=rows)
                      for scope in ("person", "form")}
        self.assertEqual(calculation.call_count, 2)
        self.assertEqual(actual, expected)
        for results in actual.values():
            self.assertNotEqual(results[84]["window_start"], results[28]["window_start"])
            self.assertEqual(results[84]["window_end"], results[28]["window_end"])
            self.assertEqual(results[84]["actual_days"], 2)
            saved = deepcopy(results[84])
            results[28]["rows"][0]["score"] = -1
            results[28]["diagnostics"]["bootstrap"]["successful"] = -1
            results[28]["parameters"]["prior"] = -1
            self.assertEqual(results[84], saved)

    def test_old_noncomparison_and_exact_boundary_records_disable_reuse(self):
        for outcome in ("choose", "skip", "unfamiliar_left", "unfamiliar_both"):
            for age in (timedelta(days=28), timedelta(days=40)):
                with self.subTest(outcome=outcome, age=age):
                    old = dict(self.rows[0], id=999, participant_id="older", outcome=outcome,
                               accepted_at=self.cutoff - age)
                    rows = [*self.rows, old]
                    with patch("atlas.preference_statistics.random_result", wraps=random_result) as calculation:
                        results = random_window_results(payload(), self.cutoff, "person", rows=rows)
                    self.assertEqual(calculation.call_count, 2)
                    self.assertEqual(results[28], random_result(payload(), self.cutoff, 28, "person", rows=rows))
                    self.assertEqual(results[84], random_result(payload(), self.cutoff, 84, "person", rows=rows))
                    long_a = next(row for row in results[84]["rows"] if row["id"] == "a")
                    short_a = next(row for row in results[28]["rows"] if row["id"] == "a")
                    self.assertEqual(long_a["completed_displays"], short_a["completed_displays"] + 1)
                    if outcome.startswith("unfamiliar"):
                        self.assertEqual(long_a["unfamiliar_count"], short_a["unfamiliar_count"] + 1)

    def test_just_inside_boundary_and_empty_inputs_reuse_without_wrong_duration(self):
        boundary = self.cutoff - timedelta(days=28) + timedelta(microseconds=1)
        for rows, days in (([dict(self.rows[0], accepted_at=boundary)], 28), ([], 0)):
            with self.subTest(days=days):
                with patch("atlas.preference_statistics.random_result", wraps=random_result) as calculation:
                    results = random_window_results(payload(), self.cutoff, "person", rows=rows)
                self.assertEqual(calculation.call_count, 1)
                self.assertEqual(results[28]["actual_days"], days)
                self.assertEqual(results[28], random_result(payload(), self.cutoff, 28, "person", rows=rows))

    @override_settings(PREFERENCE_BT_MAX_ITERATIONS=1)
    def test_failed_main_fit_does_not_publish_scores_intervals_or_ranks(self):
        result = self.analyze()
        self.assertEqual(result["status"], "solver_failed")
        self.assertFalse(result["converged"])
        self.assertEqual(result["diagnostics"]["bootstrap"]["successful"], 0)
        for row in result["rows"]:
            self.assertIsNone(row["score"])
            self.assertEqual(row["interval"], [None, None])
            self.assertIsNone(row["rank"])
            self.assertIsNone(row["rank_interval"])

    def test_one_failed_resample_disables_all_intervals_without_dropping_its_failure(self):
        actual_fit = PreparedBT.fit
        calls = 0

        def one_failure(model, **options):
            nonlocal calls
            fitted = actual_fit(model, **options)
            if options.get("multipliers") is not None:
                calls += 1
                if calls == 3:
                    return replace(fitted, converged=False, iterations=5000)
            return fitted

        with patch.object(PreparedBT, "fit", one_failure):
            result = self.analyze()
        self.assertEqual(result["status"], "solver_failed")
        self.assertTrue(result["converged"])
        self.assertFalse(result["bootstrap_converged"])
        diagnostics = result["diagnostics"]["bootstrap"]
        self.assertEqual((diagnostics["successful"], diagnostics["failed"], diagnostics["extended"]), (23, 1, 1))
        self.assertEqual(result["rank_reference_pool"], [])
        for row in result["rows"]:
            self.assertEqual(row["interval"], [None, None])
            self.assertIsNone(row["rank_interval"])
            self.assertIsNone(row["rank"])
        self.assertIsNotNone(next(row for row in result["rows"] if row["id"] == "a")["score"])

    def test_unconverged_cap_sensitivity_is_not_a_valid_measure(self):
        actual_fit = PreparedBT.fit
        calls = 0

        def sensitivity_failure(model, **options):
            nonlocal calls
            fitted = actual_fit(model, **options)
            if options.get("initial") is not None and options.get("multipliers") is None:
                calls += 1
                if calls == 1:
                    return replace(fitted, converged=False)
            return fitted

        with patch.object(PreparedBT, "fit", sensitivity_failure):
            result = self.analyze()
        self.assertTrue(result["bootstrap_converged"])
        self.assertFalse(result["diagnostics"]["sensitivity"]["converged"])
        self.assertEqual(result["status"], "solver_failed")
        for row in result["rows"]:
            self.assertIsNone(row["contribution_sensitivity"])
            self.assertEqual(row["interval"], [None, None])
            self.assertIsNone(row["rank"])

    def test_statistical_uncertainty_is_distinct_from_solver_failure(self):
        with override_settings(PREFERENCE_MAX_INTERVAL_WIDTH=0):
            wide = self.analyze()
        self.assertTrue(wide["bootstrap_converged"])
        self.assertEqual({row["status"] for row in wide["rows"] if row["id"] != "d"}, {"uncertain"})
        with override_settings(PREFERENCE_MAX_SENSITIVITY_SHIFT=0):
            sensitive = self.analyze()
        self.assertTrue(any(row["status"] == "sensitive" for row in sensitive["rows"]))

    def test_absent_uniform_comparisons_do_not_fabricate_a_control_score(self):
        result = self.analyze([dict(row, strategy="coverage-v1") for row in self.rows])
        self.assertIsNone(result["diagnostics"]["uniform"])
        self.assertTrue(all(row["strategy_sensitivity"] is None for row in result["rows"]))

    def test_subject_without_uniform_comparisons_has_no_strategy_sensitivity(self):
        result = self.analyze([dict(row, strategy="coverage-v1" if "c" in
                                   (row["left_id"], row["right_id"]) else "uniform-v1") for row in self.rows])
        values = {row["id"]: row["strategy_sensitivity"] for row in result["rows"]}
        self.assertIsNotNone(values["a"])
        self.assertIsNone(values["c"])

    def test_rank_intervals_use_only_fixed_eligible_pool_and_competition_ties(self):
        rows = [{"id": pid, "status": "ready" if pid != "d" else "insufficient", "rank_interval": None}
                for pid in "abcd"]
        reference = attach_rank_intervals(rows, list("abcd"), [[70, 50, 30, 100], [30, 50, 70, 100]] * 20)
        self.assertEqual(reference, list("abc"))
        self.assertEqual([row["rank_interval"] for row in rows], [[1, 3], [2, 2], [1, 3], None])
        attach_rank_intervals(rows, list("abcd"), [[50, 50, 30, 100]] * 20)
        self.assertEqual([row["rank_interval"] for row in rows], [[1, 1], [1, 1], [3, 3], None])


@override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=4)
class AlgorithmSnapshotPreservationTests(TestCase):
    def test_new_version_only_adds_snapshots_and_preserves_original_records(self):
        _, participant = setup_data()
        body = {"version": 0, "subject_support_ids": ["form:f1"], "subject_favorite_ids": ["form:f1"],
                "legacy_support_ids": [], "legacy_favorite_ids": []}
        perform(participant, "support", lambda p, c: update_supports(p, c, body), body)
        now = timezone.now()
        for form, winner, age in (("f1", "a", 2), ("f2", "b", 1)):
            PreferenceTask.objects.create(participant=participant, catalog_id="test-v1", left_id="a", right_id="b",
                left_subject_id=f"form:{form}", right_subject_id="person:b", pair_key=f"form:{form}|person:b",
                issued_at=now - timedelta(hours=age), expires_at=now + timedelta(days=1),
                accepted_at=now - timedelta(hours=age), status="answered", outcome="choose", winner_id=winner,
                strategy="uniform-v1")
        PreferenceTask.objects.create(participant=participant, catalog_id="test-v1", left_id="c", right_id="d",
            pair_key="c|d", issued_at=now, expires_at=now + timedelta(days=1), strategy="uniform-v1")
        PreferenceChoice.objects.create(participant=participant, kind="skin", object_id="f1", choice_id="f1s1",
                                        action="choose", version=1, catalog_version="set-v1", modified_at=now)
        cutoff = timezone.now()
        old = PreferenceSnapshot.objects.create(scope="person", kind="random", window=84, cutoff=cutoff,
            catalog_version="test-v1", asset_version="test-assets", algorithm_version="bt-dual-scope-v3-original",
            payload={"rows": [{"id": "a", "score": 73.25}], "sample_size": 2})
        old_values = PreferenceSnapshot.objects.filter(pk=old.pk).values().get()
        models = (PreferenceTask, PreferenceParticipant, PreferenceChoice, PreferenceEvent,
                  PreferenceOperation, PreferenceCatalog)
        before = {model: list(model.objects.order_by("pk").values()) for model in models}
        before_quota = quota(participant, cutoff)
        with patch("atlas.preference_statistics.random_result", wraps=random_result) as calculation:
            created = aggregate(cutoff)
        self.assertEqual(calculation.call_count, 2)
        for model in models:
            self.assertEqual(list(model.objects.order_by("pk").values()), before[model])
        self.assertEqual(quota(participant, cutoff), before_quota)
        self.assertEqual(PreferenceSnapshot.objects.filter(pk=old.pk).values().get(), old_values)
        self.assertTrue(all(snapshot.algorithm_version == algorithm_version() for snapshot in created))
        self.assertTrue(algorithm_version().startswith("bt-dual-scope-v4-"))
        random = {snapshot.scope: snapshot.payload for snapshot in created if snapshot.kind == "random" and snapshot.window == 84}
        self.assertEqual((random["person"]["raw_sample_size"], random["person"]["sample_size"]), (2, 1))
        self.assertEqual(random["form"]["sample_size"], 2)
        count = PreferenceSnapshot.objects.count()
        self.assertEqual([snapshot.pk for snapshot in aggregate(cutoff)], [snapshot.pk for snapshot in created])
        self.assertEqual(PreferenceSnapshot.objects.count(), count)
