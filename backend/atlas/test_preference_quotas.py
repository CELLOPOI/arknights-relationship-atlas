from collections import Counter
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase, override_settings
from django.utils import timezone

from .preference_algorithm import weight_comparisons
from .preference_models import PreferenceControl, PreferenceTask
from .preference_services import PreferenceError, answer_task, issue_task, quota
from .test_preferences import perform, setup_data


class ExpandedPreferenceQuotaTests(TestCase):
    def setUp(self):
        _, self.participant = setup_data()
        self.now = timezone.datetime(2026, 9, 23, 12, tzinfo=timezone.get_fixed_timezone(480))
        self.clock = patch("atlas.preference_services.timezone.now", return_value=self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def historical_tasks(self, count, age=0):
        # 历史名录中的人物不必仍在当前小型测试目录，已派发额度仍须计入。
        issued = self.now - timedelta(days=age)
        PreferenceTask.objects.bulk_create([
            PreferenceTask(participant=self.participant, catalog_id="test-v1", left_id=f"old-left-{index}",
                           right_id=f"old-right-{index}", pair_key=f"old-left-{index}|old-right-{index}",
                           strategy="uniform-v1", status="answered", outcome="skip", issued_at=issued,
                           expires_at=issued + timedelta(days=1), accepted_at=issued)
            for index in range(count)
        ])

    def test_existing_120_issued_tasks_survive_upgrade_and_can_continue(self):
        self.historical_tasks(120)
        with override_settings(PREFERENCE_WEEKLY_LIMIT=120, PREFERENCE_ROLLING_LIMIT=480, PREFERENCE_PERSON_LIMIT=3):
            self.assertEqual(quota(self.participant)["remaining"], 0)
        result = perform(self.participant, "task", issue_task)
        self.assertEqual(result["quota"]["weekly_limit"], 300)
        self.assertEqual(result["quota"]["rolling_limit"], 1200)
        self.assertEqual(result["quota"]["person_limit"], 6)
        self.assertEqual(result["quota"]["weekly_used"], 121)
        self.assertEqual(result["quota"]["rolling_used"], 121)
        self.assertEqual(result["quota"]["remaining"], 179)
        self.assertEqual(PreferenceTask.objects.count(), 121)

    def test_300th_weekly_task_is_allowed_but_301st_is_rejected(self):
        self.historical_tasks(299)
        task = perform(self.participant, "task", issue_task)["task"]
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task["id"], {"outcome": "skip"}))
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "task", issue_task)
        self.assertEqual(raised.exception.code, "quota_exhausted")
        self.assertEqual(quota(self.participant)["weekly_used"], 300)
        self.assertEqual(PreferenceTask.objects.count(), 300)

    def test_1200th_rolling_task_is_allowed_without_resetting_previous_weeks(self):
        self.historical_tasks(1199, age=8)
        task = perform(self.participant, "task", issue_task)["task"]
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task["id"], {"outcome": "skip"}))
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "task", issue_task)
        self.assertEqual(raised.exception.code, "quota_exhausted")
        self.assertEqual(quota(self.participant)["weekly_used"], 1)
        self.assertEqual(quota(self.participant)["rolling_used"], 1200)

    def test_sixth_family_exposure_is_allowed_but_seventh_is_not(self):
        current = PreferenceControl.objects.get()
        catalog = current.catalog
        # 两个人物、两个形态；其他对位均未出现，失败只能来自人物展示上限。
        catalog.payload["persons"] = [person for person in catalog.payload["persons"] if person["id"] in ("a", "b")]
        catalog.save(update_fields=["payload"])
        for index in range(5):
            PreferenceTask.objects.create(participant=self.participant, catalog=catalog, left_id="a",
                right_id=f"historical-{index}", left_subject_id=f"form:f{index % 2 + 1}",
                right_subject_id=f"person:historical-{index}", pair_key=f"historical-pair-{index}",
                strategy="uniform-v1", status="answered", outcome="skip", issued_at=self.now,
                expires_at=self.now + timedelta(days=1), accepted_at=self.now)
        task = perform(self.participant, "task", issue_task)["task"]
        self.assertIn("a", (task["left_id"], task["right_id"]))
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task["id"], {"outcome": "skip"}))
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "task", issue_task)
        self.assertEqual(raised.exception.code, "no_eligible_pair")
        self.assertGreater(quota(self.participant)["remaining"], 0)
        self.assertEqual(sum("a" in pair for pair in PreferenceTask.objects.values_list("left_id", "right_id")), 6)

    def test_higher_issue_quota_keeps_full_window_contribution_caps(self):
        rows = [{"id": str(index), "participant_id": "active", "left_id": str(index % 581),
                 "right_id": str((index * 17 + 1) % 581), "winner_id": str(index % 581),
                 "outcome": "choose"} for index in range(settings.PREFERENCE_ROLLING_LIMIT)]
        weighted = weight_comparisons(rows, settings.PREFERENCE_WEIGHT_TOTAL_CAP, settings.PREFERENCE_WEIGHT_PERSON_CAP)
        evidence = Counter()
        for row in weighted:
            evidence[row["left_id"]] += row["weight"]
            evidence[row["right_id"]] += row["weight"]
        self.assertEqual(settings.PREFERENCE_WEIGHT_TOTAL_CAP, 50)
        self.assertEqual(settings.PREFERENCE_WEIGHT_PERSON_CAP, 1)
        self.assertAlmostEqual(sum(row["weight"] for row in weighted), 50)
        self.assertLessEqual(max(evidence.values()), 1 + 1e-9)
