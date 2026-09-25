import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin
from django.db import connection, connections, transaction
from django.test import Client, TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from .preference_admin import ControlAdmin
from .preference_editorial import delete_batches, purge
from .preference_models import PreferenceCatalog, PreferenceControl, PreferenceEvent, PreferenceRate
from .preference_statistics import current_states
from .test_preferences import payload, setup_data


class PreferenceBoundaryTests(TestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()

    def test_control_save_preserves_concurrent_catalog_and_retention(self):
        stale = PreferenceControl.objects.get(pk=1)
        stale.writes_enabled = False
        next_payload = payload()
        next_payload["version"] = "test-v2"
        catalog = PreferenceCatalog.objects.create(pk="test-v2", payload=next_payload, digest="synthetic",
                                                   status="published", created_by=self.actor)
        retained = timezone.now() - timedelta(days=180)
        PreferenceControl.objects.filter(pk=1).update(catalog=catalog, retained_since=retained,
                                                      aggregation_error="synthetic_error", revision=5)
        ControlAdmin(PreferenceControl, admin.site).save_model(
            SimpleNamespace(user=self.actor), stale, SimpleNamespace(changed_data=["writes_enabled"]), True)
        current = PreferenceControl.objects.get(pk=1)
        self.assertEqual((current.catalog_id, current.retained_since, current.aggregation_error),
                         ("test-v2", retained, "synthetic_error"))
        self.assertFalse(current.writes_enabled)
        self.assertEqual(current.revision, 6)
        self.assertEqual(PreferenceEvent.objects.get(kind="controls").after, {"writes_enabled": False})

    def test_admin_rejects_stale_control_form_and_accepts_current_form(self):
        self.client.force_login(self.actor)
        url = reverse("admin:atlas_preferencecontrol_change", args=[1])
        PreferenceControl.objects.filter(pk=1).update(revision=1, tasks_enabled=False)
        data = {"revision_token": "0", "reads_enabled": "on", "writes_enabled": "on", "tasks_enabled": "on",
                "supports_enabled": "on", "choices_enabled": "on", "paused_objects": "[]", "_save": "Save"}
        rejected = self.client.post(url, data)
        self.assertContains(rejected, "运行状态已被其他操作更新")
        self.assertFalse(PreferenceControl.objects.get(pk=1).tasks_enabled)
        data["revision_token"] = "1"
        self.assertEqual(self.client.post(url, data).status_code, 302)
        self.assertTrue(PreferenceControl.objects.get(pk=1).tasks_enabled)

    def test_cleanup_keeps_last_anchor_across_choice_corrections_and_ties(self):
        now = timezone.now()
        old = now - timedelta(days=200)
        events = []
        for kind in ("choice", "choice_correction", "choice"):
            events.append(PreferenceEvent.objects.create(
                participant=self.participant, object_id="skin:f1", kind=kind, created_at=old,
                after={"choice_id": f"choice-{len(events)}"}))
        recent = PreferenceEvent.objects.create(participant=self.participant, object_id="skin:f1", kind="choice",
                                                created_at=now - timedelta(days=20), after={"choice_id": "recent"})
        type(self.participant).objects.filter(pk=self.participant.pk).update(created_at=old - timedelta(days=1))
        result = purge(now)
        self.assertEqual(result["events"], 2)
        self.assertEqual(list(PreferenceEvent.objects.order_by("pk").values_list("pk", flat=True)),
                         [events[-1].pk, recent.pk])
        self.assertEqual(current_states(now - timedelta(days=30))[1][(self.participant.pk, "skin:f1")],
                         {"choice_id": "choice-2"})

    def test_cleanup_queries_do_not_grow_per_current_registration(self):
        old = timezone.now() - timedelta(days=200)
        PreferenceEvent.objects.bulk_create([
            PreferenceEvent(participant=self.participant, kind="choice", object_id=f"skin:synthetic-{i}",
                            created_at=old, after={"choice_id": "old"}) for i in range(600)
        ])
        with CaptureQueriesContext(connection) as queries:
            purge()
        self.assertLess(len(queries), 30)
        self.assertEqual(PreferenceEvent.objects.count(), 600)

    def test_cleanup_failure_keeps_retention_boundary_and_can_resume(self):
        now = timezone.now()
        with patch("atlas.preference_editorial.delete_batches", side_effect=RuntimeError("Synthetic failure")), self.assertRaises(RuntimeError):
            purge(now)
        self.assertEqual(PreferenceControl.objects.get(pk=1).retained_since, now - timedelta(days=180))
        purge(now)
        self.assertEqual(PreferenceControl.objects.get(pk=1).retained_since, now - timedelta(days=180))

    def test_delete_batch_rechecks_concurrently_refreshed_rate(self):
        now = timezone.now()
        guard = PreferenceRate.objects.create(pk="synthetic", window_started=now, expires_at=now - timedelta(seconds=1))
        query = PreferenceRate.objects.filter(expires_at__lt=now)
        original = type(query).delete

        def refresh_then_delete(target):
            PreferenceRate.objects.filter(pk=guard.pk).update(expires_at=now + timedelta(minutes=2))
            return original(target)

        with patch.object(type(query), "delete", refresh_then_delete):
            self.assertEqual(delete_batches(query), 0)
        self.assertTrue(PreferenceRate.objects.filter(pk=guard.pk).exists())


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row-lock verification")
class PreferenceCleanupConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()

    def test_identity_issue_and_answer_complete_during_cleanup(self):
        cleaning, resume = Event(), Event()

        def paused_delete(query, **kwargs):
            self.assertFalse(connection.in_atomic_block)
            cleaning.set()
            if not resume.wait(10):
                raise RuntimeError("Cleanup concurrency test timed out")
            return delete_batches(query, **kwargs)

        def run_cleanup():
            try:
                return purge()
            finally:
                connections.close_all()

        with patch("atlas.preference_editorial.delete_batches", side_effect=paused_delete), ThreadPoolExecutor(max_workers=1) as pool:
            job = pool.submit(run_cleanup)
            try:
                self.assertTrue(cleaning.wait(5))
                with connection.cursor() as cursor:
                    cursor.execute("SET lock_timeout = '1500ms'")
                fresh = Client()
                self.assertEqual(fresh.post("/api/preferences/identity/", "{}", content_type="application/json").status_code, 200)
                issued = fresh.post("/api/preferences/tasks/", json.dumps({"operation_key": "cleanup-dispatch"}), content_type="application/json")
                self.assertEqual(issued.status_code, 200)
                task = issued.json()["task"]
                answer = fresh.post(f"/api/preferences/tasks/{task['id']}/answer/", json.dumps({
                    "operation_key": "cleanup-answer", "outcome": "choose", "winner_id": task["left_id"]}), content_type="application/json")
                self.assertEqual(answer.status_code, 200)
                self.assertFalse(job.done())
            finally:
                resume.set()
                with connection.cursor() as cursor:
                    cursor.execute("RESET lock_timeout")
            job.result(timeout=5)

    def test_cleanup_rejects_outer_transaction(self):
        with transaction.atomic(), self.assertRaises(RuntimeError):
            purge()
