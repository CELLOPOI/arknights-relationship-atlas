import random
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase, override_settings
from django.utils import timezone

from .preference_editorial import purge
from .preference_models import (
    PreferenceControl,
    PreferenceEvent,
    PreferenceParticipant,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_proximity import STRATEGY, proximity_pair
from .preference_services import answer_task, issue_task
from .preference_statistics import algorithm_version, random_result
from .preference_subjects import subjects
from .test_preferences import perform, setup_data


@override_settings(PREFERENCE_COVERAGE_FRACTION=0, PREFERENCE_PROXIMITY_FRACTION=1)
class ProximityPairTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        clock = patch("atlas.preference_services.timezone.now", return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)
        rng = patch("atlas.preference_services.secrets.SystemRandom", side_effect=lambda: random.Random(17))
        rng.start()
        self.addCleanup(rng.stop)
        _, self.participant = setup_data()
        self.other = self.new_participant()
        self.current = PreferenceControl.objects.get(pk=1)
        self.current.catalog.payload["persons"][-1]["kind"] = "npc"
        self.current.catalog.save(update_fields=["payload"])
        self.candidates = subjects(self.current.catalog.payload)

    def new_participant(self):
        return PreferenceParticipant.objects.create(credential_hash=uuid.uuid4().hex * 2)

    def snapshot(self, changes=None, **metadata):
        rows = [{"id": sid, "score": 50, "status": "ready", "rank_interval": [1, 5],
                 "comparisons": 60, "weighted_evidence": 40, "participants": 50,
                 "effective_participants": 45, "opponents": 20, "interval": [40, 60],
                 **(changes or {}).get(sid, {})} for sid in self.candidates]
        values = {"scope": "form", "kind": "random", "window": 28,
                  "cutoff": self.now - timedelta(minutes=10), "catalog_version": "test-v1",
                  "asset_version": "test-assets", "algorithm_version": algorithm_version(), "revision": 0,
                  "payload": {"rows": rows}}
        return PreferenceSnapshot.objects.create(**(values | metadata))

    def only(self, *ids):
        return {sid: {"status": "insufficient"} for sid in self.candidates if sid not in ids}

    def history(self, left, right, participant=None, **changes):
        issued = self.now - timedelta(hours=1)
        values = {"participant": participant or self.other, "catalog_id": "test-v1",
                  "left_id": self.candidates[left]["person_id"], "right_id": self.candidates[right]["person_id"],
                  "left_subject_id": left, "right_subject_id": right,
                  "pair_key": "|".join(sorted((left, right))), "strategy": "uniform-v1",
                  "status": "answered", "outcome": "choose", "winner_id": self.candidates[left]["person_id"],
                  "issued_at": issued, "expires_at": issued + timedelta(days=1), "accepted_at": issued}
        return PreferenceTask.objects.create(**(values | changes))

    def issue(self, participant=None, key=None):
        result = perform(participant or self.participant, "task", issue_task, key=key)
        return PreferenceTask.objects.get(pk=result["task"]["id"])

    def details(self, task):
        self.assertEqual(task.strategy, STRATEGY)
        event = PreferenceEvent.objects.get(kind="proximity_task_issued", object_id=str(task.pk))
        self.assertEqual({event.after["target_subject_id"], event.after["opponent_subject_id"]},
                         {task.left_subject_id, task.right_subject_id})
        return event.after

    def test_targets_high_middle_and_low_scores_including_forms_and_npcs(self):
        for score, interval in ((89, [1, 20]), (50, [250, 350]), (11, [550, 624])):
            with self.subTest(score=score):
                PreferenceSnapshot.objects.all().delete()
                self.snapshot(self.only("form:f2", "person:d") | {
                    "form:f2": {"score": score, "rank_interval": interval},
                    "person:d": {"score": score + 1, "rank_interval": interval},
                })
                task = self.issue(self.new_participant())
                self.assertEqual({task.left_subject_id, task.right_subject_id}, {"form:f2", "person:d"})
                self.assertEqual(self.details(task)["score_gap"], 1)

    def test_requires_close_scores_overlapping_ranks_and_ready_rows(self):
        for changes in ({"score": 55.001}, {"rank_interval": [6, 20]}, {"status": "insufficient"},
                        {"status": "solver_failed"}, {"score": None}, {"rank_interval": None}):
            with self.subTest(changes=changes):
                PreferenceSnapshot.objects.all().delete()
                self.snapshot(self.only("form:f1", "person:b") | {"person:b": changes})
                task = self.issue(self.new_participant())
                self.assertEqual(task.strategy, "coverage-form-v2")
                event = PreferenceEvent.objects.get(kind="coverage_task_issued", object_id=str(task.pk))
                self.assertEqual(event.after["proximity_fallback"], "no_eligible_neighbor")
        PreferenceSnapshot.objects.all().delete()
        self.snapshot(self.only("form:f1", "person:b") | {"person:b": {"score": 55, "rank_interval": [5, 10]}})
        self.assertEqual(self.issue(self.new_participant()).strategy, STRATEGY)

    def test_missing_stale_and_incompatible_snapshots_use_coverage(self):
        for metadata in (None, {"cutoff": self.now - timedelta(minutes=60)},
                         {"cutoff": self.now + timedelta(seconds=1)}, {"revision": 1},
                         {"catalog_version": "old-catalog"}, {"algorithm_version": "old-algorithm"},
                         {"asset_version": "old-assets"}, {"window": 84}, {"scope": "person"}):
            with self.subTest(metadata=metadata):
                PreferenceSnapshot.objects.all().delete()
                if metadata is not None:
                    self.snapshot(**metadata)
                task = self.issue(self.new_participant())
                self.assertEqual(task.strategy, "coverage-form-v2")
                event = PreferenceEvent.objects.get(kind="coverage_task_issued", object_id=str(task.pk))
                self.assertEqual(event.after["proximity_fallback"], "snapshot_unavailable")

    def test_newer_incompatible_snapshot_does_not_hide_usable_result(self):
        good = self.snapshot(self.only("form:f1", "person:b"))
        self.snapshot(cutoff=self.now - timedelta(minutes=1), algorithm_version="old-algorithm")
        self.assertEqual(self.details(self.issue())["snapshot_id"], good.pk)

    def test_targets_rotate_across_the_pool_even_after_skips(self):
        self.snapshot()
        first = self.issue()
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, first.pk, {"outcome": "skip"}))
        second = self.issue(self.new_participant())
        self.assertFalse({first.left_subject_id, first.right_subject_id}
                         & {second.left_subject_id, second.right_subject_id})
        self.details(second)

    def test_new_participant_contributions_take_priority(self):
        self.snapshot(self.only("form:f1", "person:b", "person:c"))
        for sid in ("person:b", "person:c"):
            self.history(sid, "person:d", self.participant,
                         issued_at=self.now - timedelta(days=40), accepted_at=self.now - timedelta(days=40))
        self.assertEqual(self.details(self.issue())["target_subject_id"], "form:f1")

    def prepare_opponent_test(self):
        self.snapshot(self.only("form:f1", "person:b", "person:c"))
        self.history("person:b", "person:d", strategy=STRATEGY)
        self.history("person:c", "person:d", strategy=STRATEGY)

    def test_chooses_under_compared_opponents_using_distinct_valid_participants(self):
        self.prepare_opponent_test()
        for _ in range(4):
            self.history("form:f1", "person:b")
        self.history("form:f1", "person:c")
        self.history("person:c", "form:f1", self.new_participant())
        held = self.new_participant()
        held.risk_status = "excluded"
        held.save(update_fields=["risk_status"])
        self.history("form:f1", "person:b", held)
        self.history("form:f1", "person:b", self.new_participant(), risk_status="pending")
        details = self.details(self.issue())
        self.assertEqual(details["target_subject_id"], "form:f1")
        self.assertEqual(details["opponent_subject_id"], "person:b")
        self.assertEqual(details["direct_participants"], 1)

    def test_live_pending_comparisons_reduce_repeated_pair_dispatch(self):
        self.prepare_opponent_test()
        self.history("form:f1", "person:b", status="pending", accepted_at=None, outcome="", winner_id="")
        self.assertEqual(self.details(self.issue())["opponent_subject_id"], "person:c")

    def test_expired_void_future_and_old_tasks_do_not_become_evidence(self):
        self.snapshot(self.only("form:f1", "person:b"))
        self.history("form:f1", "person:b", status="pending", accepted_at=None,
                     expires_at=self.now, outcome="", winner_id="")
        self.history("form:f1", "person:b", status="void")
        self.history("form:f1", "person:b", issued_at=self.now + timedelta(seconds=1),
                     accepted_at=self.now + timedelta(seconds=1))
        self.history("form:f1", "person:b", issued_at=self.now - timedelta(days=28),
                     accepted_at=self.now - timedelta(days=28))
        details = self.details(self.issue())
        self.assertEqual(details["direct_participants"], 0)
        self.assertEqual(details["pending_pair_tasks"], 0)

    def test_legacy_and_form_pair_restrictions_force_coverage_fallback(self):
        self.snapshot(self.only("form:f1", "person:b"))
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                participant = self.new_participant()
                changes = {"pair_key": "a|b", "left_subject_id": "", "right_subject_id": ""} if legacy else {}
                self.history("form:f1", "person:b", participant,
                             issued_at=self.now - timedelta(days=40), accepted_at=self.now - timedelta(days=40), **changes)
                self.assertEqual(self.issue(participant).strategy, "coverage-form-v2")

    def test_same_person_forms_never_match_and_pauses_are_respected(self):
        self.snapshot(self.only("form:f1", "form:f2"))
        self.assertEqual(self.issue().strategy, "coverage-form-v2")
        PreferenceSnapshot.objects.all().delete()
        self.snapshot(self.only("form:f2", "person:b"))
        for paused in (["form:f2"], ["f2"], ["a"]):
            with self.subTest(paused=paused):
                self.current.paused_objects = paused
                self.current.save(update_fields=["paused_objects"])
                task = self.issue(self.new_participant())
                self.assertEqual(task.strategy, "coverage-form-v2")
                self.assertNotIn("form:f2", (task.left_subject_id, task.right_subject_id))

    def test_person_exposure_cap_is_shared_by_forms(self):
        self.snapshot(self.only("form:f2", "person:b"))
        for index in range(settings.PREFERENCE_PERSON_LIMIT):
            self.history(f"form:f{index % 2 + 1}", "person:c", self.participant)
        task = self.issue()
        self.assertEqual(task.strategy, "coverage-form-v2")
        self.assertNotIn("a", (task.left_id, task.right_id))

    def test_pending_recovery_and_operation_retry_do_not_duplicate_tasks_or_audit(self):
        self.snapshot()
        first = self.issue(key="proximity-first-task")
        self.assertEqual(first.pk, self.issue().pk)
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, first.pk, {"outcome": "skip"}))
        self.assertEqual(first.pk, self.issue(key="proximity-first-task").pk)
        self.assertEqual(PreferenceTask.objects.count(), 1)
        self.assertEqual(PreferenceEvent.objects.filter(kind="proximity_task_issued").count(), 1)

    @override_settings(PREFERENCE_COVERAGE_FRACTION=.1, PREFERENCE_PROXIMITY_FRACTION=.3)
    def test_strategy_boundaries_preserve_sixty_percent_uniform_path(self):
        self.snapshot()
        for draw, expected in ((0, "coverage-form-v2"), (.09999, "coverage-form-v2"),
                               (.1, STRATEGY), (.39999, STRATEGY), (.4, "uniform-v1"), (.99999, "uniform-v1")):
            with self.subTest(draw=draw), patch("atlas.preference_services.secrets.SystemRandom") as factory:
                rng = random.Random(17)
                rng.random = lambda draw=draw: draw
                factory.return_value = rng
                if expected == "uniform-v1":
                    with patch("atlas.preference_services.proximity_pair", side_effect=AssertionError("Unexpected proximity query")), \
                         patch("atlas.preference_services.coverage_targets", side_effect=AssertionError("Unexpected coverage query")):
                        task = self.issue(self.new_participant())
                else:
                    task = self.issue(self.new_participant())
                self.assertEqual(task.strategy, expected)
        config = self.client.get("/api/preferences/runtime/").json()["config"]
        self.assertEqual(config["coverage_fraction"], .1)
        self.assertEqual(config["proximity_fraction"], .3)

    @override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=12)
    def test_answers_enter_both_views_once_without_becoming_uniform_votes(self):
        snapshot = self.snapshot(self.only("form:f1", "person:b"))
        before = snapshot.payload
        task = self.issue()
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task.pk, {
            "outcome": "choose", "winner_id": task.left_id,
        }))
        for scope in ("form", "person"):
            result = random_result(self.current.catalog.payload, self.now, 28, scope)
            self.assertEqual(result["sample_size"], 1)
            self.assertEqual(result["weighted_evidence"], 1)
            self.assertIsNone(result["diagnostics"]["uniform"])
        snapshot.refresh_from_db()
        self.assertEqual(snapshot.payload, before)

    def test_queries_are_bounded_and_proximity_audit_follows_detail_retention(self):
        self.snapshot()
        with self.assertNumQueries(5):
            pair, _ = proximity_pair(self.current, self.participant, self.candidates,
                                     ["a", "b", "c", "d"], set(), self.now, random.Random(17))
        self.assertEqual(len(pair), 2)
        task = self.issue()
        old = PreferenceEvent.objects.create(kind="proximity_task_issued", object_id="old-task",
            created_at=self.now - timedelta(days=settings.PREFERENCE_DETAIL_RETENTION_DAYS + 1))
        purge(self.now)
        self.assertFalse(PreferenceEvent.objects.filter(pk=old.pk).exists())
        self.assertTrue(PreferenceEvent.objects.filter(kind="proximity_task_issued", object_id=str(task.pk)).exists())
