import random
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase, override_settings
from django.utils import timezone

from .preference_coverage import STRATEGY, coverage_targets
from .preference_editorial import purge
from .preference_models import (
    PreferenceControl,
    PreferenceEvent,
    PreferenceParticipant,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_services import answer_task, issue_task
from .preference_statistics import algorithm_version
from .preference_subjects import subjects
from .test_preferences import perform, setup_data


@override_settings(PREFERENCE_COVERAGE_FRACTION=1, PREFERENCE_PROXIMITY_FRACTION=0)
class FormCoverageTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        clock = patch("atlas.preference_services.timezone.now", return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)
        _, self.participant = setup_data()
        self.other = self.new_participant()
        self.current = PreferenceControl.objects.get(pk=1)
        self.candidates = subjects(self.current.catalog.payload)

    def new_participant(self):
        return PreferenceParticipant.objects.create(credential_hash=uuid.uuid4().hex * 2)

    def snapshot(self, changes=None, **metadata):
        rows = [{"id": sid, "comparisons": 60, "weighted_evidence": 40,
                 "participants": 50, "effective_participants": 45, "opponents": 20,
                 "interval": [30, 50], **(changes or {}).get(sid, {})} for sid in self.candidates]
        values = {"scope": "form", "kind": "random", "window": 28,
                  "cutoff": self.now - timedelta(minutes=10), "catalog_version": "test-v1",
                  "asset_version": "test-assets", "algorithm_version": algorithm_version(), "revision": 0,
                  "payload": {"rows": rows}}
        return PreferenceSnapshot.objects.create(**(values | metadata))

    def history(self, left, right, participant=None, **changes):
        issued = self.now - timedelta(hours=1)
        values = {"participant": participant or self.other, "catalog_id": "test-v1",
                  "left_id": self.candidates[left]["person_id"], "right_id": self.candidates[right]["person_id"],
                  "left_subject_id": left, "right_subject_id": right,
                  "pair_key": "|".join(sorted((left, right))), "strategy": "uniform-v1",
                  "status": "answered", "outcome": "choose", "winner_id": self.candidates[left]["person_id"],
                  "issued_at": issued, "expires_at": issued + timedelta(days=1), "accepted_at": issued}
        return PreferenceTask.objects.create(**(values | changes))

    def issue(self, participant=None):
        result = perform(participant or self.participant, "task", issue_task)
        return PreferenceTask.objects.get(pk=result["task"]["id"])

    def target(self, task):
        event = PreferenceEvent.objects.get(kind="coverage_task_issued", object_id=str(task.pk))
        self.assertEqual(event.after["strategy"], STRATEGY)
        self.assertIn(event.after["target_subject_id"], (task.left_subject_id, task.right_subject_id))
        return event.after

    def expose_other_subjects(self):
        for _ in range(8):
            self.history("form:f1", "person:b")
            self.history("person:c", "person:d")

    def test_cold_start_covers_the_unseen_form_of_an_exposed_person(self):
        self.expose_other_subjects()
        task = self.issue()
        details = self.target(task)
        self.assertEqual(details["target_subject_id"], "form:f2")
        self.assertEqual(details["reason"], "subject_exposure")
        self.assertIsNone(details["snapshot_id"])
        self.assertNotEqual(task.left_id, task.right_id)

    def test_effective_evidence_takes_priority_over_raw_exposure(self):
        self.snapshot({"form:f2": {"weighted_evidence": 5}})
        for _ in range(25):
            self.history("form:f2", "person:c")
        details = self.target(self.issue())
        self.assertEqual(details["target_subject_id"], "form:f2")
        self.assertEqual(details["reason"], "weighted_evidence")
        self.assertEqual(details["sample_before"]["weighted_evidence"], 5)

    def test_unjudged_deficient_form_preferred_to_repeated_contribution(self):
        self.snapshot({"form:f2": {"effective_participants": 20}, "person:b": {"effective_participants": 10}})
        self.history("person:b", "person:c", self.participant,
                     issued_at=self.now - timedelta(days=40), accepted_at=self.now - timedelta(days=40))
        self.assertEqual(self.target(self.issue())["target_subject_id"], "form:f2")

    def test_new_tasks_spread_reservations_before_next_snapshot(self):
        snapshot = self.snapshot({"form:f1": {"effective_participants": 28},
                                  "form:f2": {"effective_participants": 29}})
        first = self.issue()
        self.assertEqual(self.target(first)["target_subject_id"], "form:f1")
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, first.pk, {"outcome": "skip"}))
        self.assertEqual(self.target(self.issue(self.new_participant()))["target_subject_id"], "form:f2")
        self.assertEqual(self.target(self.issue(self.new_participant()))["target_subject_id"], "form:f1")
        # 派题占位不能写进正式样本；下一份快照将按真正的答案重新计算。
        snapshot.refresh_from_db()
        self.assertEqual(snapshot.payload["rows"][0]["effective_participants"], 28)

    def test_unaccounted_answers_and_live_pending_tasks_reserve_but_voids_do_not(self):
        self.snapshot({"form:f1": {"effective_participants": 28}, "form:f2": {"effective_participants": 29}})
        for changes, expected in (
            ({"status": "pending", "accepted_at": None, "outcome": "", "winner_id": ""}, "form:f2"),
            ({"accepted_at": self.now}, "form:f2"),
            ({"status": "void", "accepted_at": self.now}, "form:f1"),
            ({"status": "pending", "accepted_at": None, "expires_at": self.now}, "form:f1"),
        ):
            with self.subTest(changes=changes):
                PreferenceTask.objects.all().delete()
                self.history("form:f1", "person:c", **changes)
                self.assertEqual(self.target(self.issue())["target_subject_id"], expected)

    def test_stale_or_incompatible_snapshots_fall_back_to_subject_exposure(self):
        self.expose_other_subjects()
        for metadata in (
            {"cutoff": self.now - timedelta(minutes=settings.PREFERENCE_AGGREGATION_INTERVAL_MINUTES * 2)},
            {"cutoff": self.now + timedelta(seconds=1)}, {"revision": 1},
            {"catalog_version": "old-catalog"}, {"algorithm_version": "old-algorithm"},
            {"asset_version": "old-assets"}, {"window": 84}, {"scope": "person"},
        ):
            with self.subTest(metadata=metadata):
                PreferenceSnapshot.objects.all().delete()
                self.snapshot({"person:b": {"comparisons": 0}}, **metadata)
                task = self.issue(self.new_participant())
                details = self.target(task)
                self.assertEqual(details["target_subject_id"], "form:f2")
                self.assertIsNone(details["snapshot_id"])
                task.delete()

    def test_matching_snapshot_not_hidden_by_newer_incompatible_result(self):
        good = self.snapshot({"form:f2": {"effective_participants": 0}})
        self.snapshot({"person:b": {"effective_participants": 0}},
                      cutoff=self.now - timedelta(minutes=1), algorithm_version="old-algorithm")
        details = self.target(self.issue())
        self.assertEqual(details["target_subject_id"], "form:f2")
        self.assertEqual(details["snapshot_id"], good.pk)

    def test_wide_intervals_receive_coverage_after_basic_sample_thresholds(self):
        self.snapshot({"form:f1": {"effective_participants": 29}, "form:f2": {"interval": [20, 60]}})
        self.assertEqual(self.target(self.issue())["target_subject_id"], "form:f1")
        details = self.target(self.issue(self.new_participant()))
        self.assertEqual(details["target_subject_id"], "form:f2")
        self.assertEqual(details["reason"], "interval")

    def test_paused_forms_and_shared_person_limit_still_apply(self):
        self.snapshot({"form:f2": {"effective_participants": 0}})
        self.current.paused_objects = ["form:f2", "f1"]
        self.current.save(update_fields=["paused_objects"])
        task = self.issue()
        self.assertNotIn("a", (task.left_id, task.right_id))
        task.delete()
        self.current.paused_objects = []
        self.current.save(update_fields=["paused_objects"])
        for index in range(settings.PREFERENCE_PERSON_LIMIT):
            self.history(f"form:f{index % 2 + 1}", f"person:{'b' if index % 2 else 'c'}", self.participant)
        task = self.issue()
        self.assertNotIn("a", (task.left_id, task.right_id))

    def test_exhausted_form_pairs_continue_to_another_target(self):
        self.snapshot({"form:f2": {"effective_participants": 0}})
        for other in ("b", "c", "d"):
            self.history("form:f2", f"person:{other}", self.participant,
                         issued_at=self.now - timedelta(days=40), accepted_at=self.now - timedelta(days=40))
        task = self.issue()
        self.assertNotIn("form:f2", (task.left_subject_id, task.right_subject_id))
        self.target(task)

    def test_legacy_person_pair_restrictions_also_block_target_forms(self):
        self.snapshot({"form:f2": {"effective_participants": 0}})
        for other in ("b", "c", "d"):
            self.history("form:f2", f"person:{other}", self.participant, pair_key=f"a|{other}",
                         left_subject_id="", right_subject_id="",
                         issued_at=self.now - timedelta(days=40), accepted_at=self.now - timedelta(days=40))
        task = self.issue()
        self.assertNotIn("a", (task.left_id, task.right_id))
        self.target(task)

    def test_pending_task_recovery_does_not_duplicate_reservations_or_audit(self):
        first = self.issue()
        second = self.issue()
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(PreferenceTask.objects.count(), 1)
        self.assertEqual(PreferenceEvent.objects.filter(kind="coverage_task_issued").count(), 1)

    @override_settings(PREFERENCE_COVERAGE_FRACTION=0)
    def test_uniform_strategy_keeps_its_original_path(self):
        with patch("atlas.preference_services.coverage_targets", side_effect=AssertionError("Unexpected coverage query")):
            task = self.issue()
        self.assertEqual(task.strategy, "uniform-v1")
        self.assertFalse(PreferenceEvent.objects.filter(kind="coverage_task_issued").exists())

    def test_coverage_query_count_is_fixed_and_history_is_aggregated(self):
        self.expose_other_subjects()
        self.snapshot()
        with self.assertNumQueries(4):
            targets, _ = coverage_targets(self.current, self.participant, self.candidates,
                                           ["a", "b", "c", "d"], self.now, random.Random(42))
        self.assertEqual(len(targets), 5)

    def test_coverage_audit_follows_task_detail_retention(self):
        task = self.issue()
        current_event = PreferenceEvent.objects.get(kind="coverage_task_issued", object_id=str(task.pk))
        old_event = PreferenceEvent.objects.create(
            participant=self.other, kind="coverage_task_issued", object_id="old-task",
            created_at=self.now - timedelta(days=settings.PREFERENCE_DETAIL_RETENTION_DAYS + 1))
        purge(self.now)
        self.assertFalse(PreferenceEvent.objects.filter(pk=old_event.pk).exists())
        self.assertTrue(PreferenceEvent.objects.filter(pk=current_event.pk).exists())
