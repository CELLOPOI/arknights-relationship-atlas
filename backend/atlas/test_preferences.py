import copy
import json
import os
import subprocess
import sys
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .models import Faction, Person, User
from .preference_editorial import (
    create_catalog,
    preview_catalog,
    publish_catalog,
    purge,
    review_catalog,
    review_risk,
    revise_snapshots,
)
from .preference_models import (
    PreferenceCatalog,
    PreferenceChoice,
    PreferenceControl,
    PreferenceEvent,
    PreferenceParticipant,
    PreferenceRiskSignal,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_services import (
    PreferenceError,
    answer_task,
    digest,
    issue_task,
    operation,
    quota,
    update_choice,
    update_supports,
)
from .preference_statistics import aggregate, fit_bt, random_result
from .preference_views import credential_hash


def payload():
    return {"version": "test-v1", "asset_version": "test-assets", "source_version": "fixed-source",
            "persons": [{"id": p, "name": p, "aliases": [], "kind": "operator", "eligible": True,
                         "representative_url": "/avatars/a.webp", "form_catalog_version": "test-v1", "form_ids": ["f1", "f2"] if p == "a" else []}
                        for p in ("a", "b", "c", "d")],
            "forms": [{"id": f, "person_id": "a", "name": f, "profession": "CASTER", "order": 0,
                       "catalog_version": "set-v1", "complete": True, "eligible": True,
                       "default_appearance_id": f + "s1", "appearance_ids": [f + "s1", f + "s2"]}
                      for f in ("f1", "f2")],
            "appearances": [{"id": f + s, "form_id": f, "name": s, "kind": "base",
                             "eligible": True, "image_url": "/assets/preferences/full/a.webp",
                             "thumbnail_url": "/assets/preferences/thumb/a.webp"}
                            for f in ("f1", "f2") for s in ("s1", "s2")],
            "professions": [{"id": "CASTER", "name": "术师", "icon_url": "/assets/preferences/professions/c.png"}]}


def setup_data():
    actor = User.objects.create_superuser("editor", "editor@example.test", "test-password-not-real")
    catalog = PreferenceCatalog.objects.create(version="test-v1", payload=payload(), digest=digest(payload()),
                                               status="published", created_by=actor, published_at=timezone.now())
    PreferenceControl.objects.create(pk=1, catalog=catalog)
    participant = PreferenceParticipant.objects.create(credential_hash=credential_hash("test-credential"))
    return actor, participant


def perform(participant, scope, callback, body=None, key=None):
    return operation(participant.pk, key or str(uuid.uuid4()), scope, body or {}, callback)


@override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=12)
class PreferenceTests(TestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()
        self.client.cookies["atlas_preferences"] = "test-credential"

    def test_identity_csrf_and_private_cache_no_client_id(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post("/api/preferences/identity/", "{}", content_type="application/json").status_code, 403)
        client.get("/api/preferences/catalog/")
        token = client.cookies["csrftoken"].value
        result = client.post("/api/preferences/identity/", "{}", content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.cookies["atlas_preferences"]["httponly"])
        self.assertEqual(result["Cache-Control"], "private, no-store")
        self.assertNotIn("participant_id", result.json())
        self.assertEqual(client.get("/api/preferences/state/").json()["supports"]["version"], 0)
        result = client.post("/api/preferences/identity/", '{"visitor_id":"other"}', content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(result.status_code, 400)

    def test_get_does_not_issue_and_two_tabs_restore_same_task(self):
        self.client.get("/api/preferences/state/")
        self.assertEqual(PreferenceTask.objects.count(), 0)
        first = perform(self.participant, "task", issue_task)
        second = perform(self.participant, "task", issue_task)
        self.assertEqual(first["task"], second["task"])
        self.assertEqual(second["quota"]["weekly_used"], 1)

    def test_retry_answer_skip_consumes_no_win_and_key_conflict(self):
        result = perform(self.participant, "task", issue_task)
        task_id = result["task"]["id"]
        body = {"outcome": "unfamiliar"}
        callback = lambda p, c: answer_task(p, c, task_id, body)
        one = perform(self.participant, "answer", callback, body, "retry-key")
        two = perform(self.participant, "answer", callback, body, "retry-key")
        self.assertEqual(one, two)
        self.assertEqual(PreferenceTask.objects.filter(status="answered").count(), 1)
        self.assertEqual(one["quota"]["weekly_used"], 1)
        with self.assertRaisesMessage(PreferenceError, "同一操作标识"):
            perform(self.participant, "answer", callback, {"outcome": "tie"}, "retry-key")
        data = random_result(payload(), timezone.now(), 28)
        self.assertEqual(data["sample_size"], 0)
        self.assertEqual(sum(r["unfamiliar_count"] for r in data["rows"]), 2)

    def test_expiration_keeps_quota_but_server_void_refunds(self):
        perform(self.participant, "task", issue_task)
        task = PreferenceTask.objects.get()
        task.expires_at = timezone.now() - timedelta(seconds=1)
        task.save()
        perform(self.participant, "task", issue_task)
        self.assertEqual(quota(self.participant)["weekly_used"], 2)
        current = PreferenceControl.objects.get()
        current.paused_objects = ["a", "b", "c", "d"]
        current.save()
        with self.assertRaises(PreferenceError):
            perform(self.participant, "task", issue_task)
        # 失败事务不会返还未完成的作废；后台故障确认服务原子作废。
        from .preference_services import invalidate_tasks
        invalidate_tasks(current, timezone.now())
        self.assertEqual(quota(self.participant)["weekly_used"], 1)

    @override_settings(PREFERENCE_WEEKLY_LIMIT=1)
    def test_week_boundary_still_obeys_rolling_and_person_limits(self):
        now = timezone.datetime(2026, 9, 21, 0, 0, tzinfo=timezone.get_fixed_timezone(480))
        with patch("atlas.preference_services.timezone.now", return_value=now - timedelta(seconds=1)):
            first = perform(self.participant, "task", issue_task)
            perform(self.participant, "answer", lambda p, c: answer_task(p, c, first["task"]["id"], {"outcome": "skip"}))
        with patch("atlas.preference_services.timezone.now", return_value=now):
            self.assertEqual(quota(self.participant)["weekly_used"], 0)
            self.assertEqual(quota(self.participant)["rolling_used"], 1)
            with override_settings(PREFERENCE_ROLLING_LIMIT=1):
                with self.assertRaises(PreferenceError) as raised:
                    perform(self.participant, "task", issue_task)
                self.assertEqual(raised.exception.code, "quota_exhausted")
        cutoff = now + timedelta(days=28) - timedelta(seconds=1)
        self.assertEqual(quota(self.participant, cutoff)["rolling_used"], 0)

    def test_pair_dedup_and_person_three_display_limit(self):
        for _ in range(6):
            try:
                result = perform(self.participant, "task", issue_task)
            except PreferenceError as error:
                self.assertEqual(error.code, "no_eligible_pair")
                break
            perform(self.participant, "answer", lambda p, c, result=result: answer_task(p, c, result["task"]["id"], {"outcome": "skip"}))
        from collections import Counter
        counts = Counter(pid for row in PreferenceTask.objects.values_list("left_id", "right_id") for pid in row)
        self.assertTrue(all(count <= 3 for count in counts.values()))
        self.assertEqual(PreferenceTask.objects.values("pair_key").distinct().count(), PreferenceTask.objects.count())
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "task", issue_task)
        self.assertEqual(raised.exception.code, "no_eligible_pair")

    def test_support_subset_whole_list_version_and_cooldown(self):
        body = {"version": 0, "support_ids": ["a", "b"], "favorite_ids": ["a"]}
        result = perform(self.participant, "support", lambda p, c: update_supports(p, c, body))
        self.assertEqual(result["version"], 1)
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "support", lambda p, c: update_supports(p, c, body))
        self.assertEqual(raised.exception.code, "version_conflict")
        body["version"] = 1
        self.assertEqual(perform(self.participant, "support", lambda p, c: update_supports(p, c, body))["version"], 1)
        body.update(support_ids=[], favorite_ids=[])
        with self.assertRaises(PreferenceError) as raised:
            perform(self.participant, "support", lambda p, c: update_supports(p, c, body))
        self.assertEqual(raised.exception.code, "cooldown")
        body.update(support_ids=["a"], favorite_ids=["b"])
        with self.assertRaises(PreferenceError):
            perform(self.participant, "support", lambda p, c: update_supports(p, c, body))

    def choice(self, **changes):
        body = {"version": 0, "catalog_version": "set-v1", "action": "choose", "choice_id": "f1s1", **changes}
        return perform(self.participant, "choice", lambda p, c: update_choice(p, c, "skin", "f1", body))

    def test_choice_withdraw_does_not_evade_cooldown_and_objects_independent(self):
        self.choice()
        self.choice(version=1, action="withdraw", choice_id=None)
        with self.assertRaises(PreferenceError) as raised:
            self.choice(version=2)
        self.assertEqual(raised.exception.code, "cooldown")
        body = {"version": 0, "catalog_version": "set-v1", "action": "none"}
        result = perform(self.participant, "choice", lambda p, c: update_choice(p, c, "skin", "f2", body))
        self.assertEqual(result["action"], "none")

    def test_new_catalog_confirmation_during_cooldown_and_removed_choice_correction(self):
        self.choice()
        catalog = PreferenceCatalog.objects.get()
        catalog.payload["forms"][0]["catalog_version"] = "set-v2"
        catalog.save()
        body = {"version": 1, "catalog_version": "set-v2"}
        result = perform(self.participant, "confirm", lambda p, c: update_choice(p, c, "skin", "f1", body, True))
        self.assertTrue(result["confirmed"])
        self.assertEqual(result["version"], 2)
        catalog.payload["appearances"] = [a for a in catalog.payload["appearances"] if a["id"] != "f1s1"]
        catalog.payload["appearances"].append({**catalog.payload["appearances"][0], "id": "f1s3"})
        catalog.payload["forms"][0]["catalog_version"] = "set-v3"
        catalog.save()
        self.choice(version=2, catalog_version="set-v3", choice_id="f1s2")
        self.assertTrue(PreferenceEvent.objects.filter(kind="choice_correction").exists())

    def test_foreign_skin_incomplete_catalog_single_option_and_pause_rejected(self):
        for kwargs in ({"choice_id": "f2s1"}, {"catalog_version": "old"}):
            with self.assertRaises(PreferenceError):
                self.choice(**kwargs)
        catalog = PreferenceCatalog.objects.get()
        catalog.payload["forms"][0]["complete"] = False
        catalog.save()
        with self.assertRaises(PreferenceError):
            self.choice()
        # 皮肤完整性不影响人物形态偏好。
        body = {"version": 0, "catalog_version": "test-v1", "action": "choose", "choice_id": "f1"}
        self.assertEqual(perform(self.participant, "form", lambda p, c: update_choice(p, c, "form", "a", body))["choice_id"], "f1")
        current = PreferenceControl.objects.get()
        current.writes_enabled = False
        current.save()
        with self.assertRaises(PreferenceError):
            perform(self.participant, "task", issue_task)

    def test_real_snapshot_support_denominator_none_and_risk_correction(self):
        body = {"version": 0, "support_ids": ["a", "b"], "favorite_ids": ["a"]}
        perform(self.participant, "support", lambda p, c: update_supports(p, c, body))
        self.choice()
        cutoff = timezone.now()
        aggregate(cutoff)
        support = PreferenceSnapshot.objects.get(scope="person", kind="support")
        rows = {r["id"]: r for r in support.payload["rows"]}
        self.assertEqual(rows["a"]["share"], 1)
        self.assertEqual(rows["b"]["share"], 1)
        self.assertEqual(rows["a"]["favorite_count"], 1)
        self.assertEqual(PreferenceSnapshot.objects.get(kind="skin", object_id="f1").payload["sample_size"], 1)
        count = PreferenceSnapshot.objects.count()
        aggregate(cutoff)
        self.assertEqual(PreferenceSnapshot.objects.count(), count)
        review_risk(self.participant.pk, "excluded", self.actor, "Synthetic automation confirmed")
        revise_snapshots(self.actor, "Synthetic risk correction")
        corrected = PreferenceSnapshot.objects.filter(scope="person", kind="support").first()
        self.assertEqual(corrected.payload["participant_count"], 0)
        self.assertEqual(corrected.supersedes_id, support.pk)
        self.assertEqual(support.payload["participant_count"], 1)
        review_risk(self.participant.pk, "accepted", self.actor, "Appeal accepted")
        revise_snapshots(self.actor, "Appeal restoration")
        self.assertEqual(PreferenceSnapshot.objects.filter(scope="person", kind="support").first().payload["participant_count"], 1)

    def test_bt_cycle_separation_disconnected_and_cluster_uncertainty(self):
        rows = [{"left_id": a, "right_id": b, "winner_id": a} for a, b in (("a", "b"), ("b", "c"), ("c", "a"))]
        estimates, converged = fit_bt(["a", "b", "c"], rows)
        self.assertTrue(converged)
        self.assertEqual({round(v) for v in estimates.values()}, {50})
        estimates, _ = fit_bt(["a", "b"], [rows[0]] * 100)
        self.assertLess(estimates["a"], 100)
        now = timezone.now()
        PreferenceTask.objects.create(participant=self.participant, catalog_id="test-v1", left_id="a", right_id="b",
            pair_key="a|b", strategy="uniform-v1", status="answered", issued_at=now, expires_at=now + timedelta(days=1),
            accepted_at=now, outcome="choose", winner_id="a")
        with override_settings(PREFERENCE_MIN_COMPARISONS=1, PREFERENCE_MIN_PARTICIPANTS=1, PREFERENCE_MIN_OPPONENTS=1):
            result = random_result(payload(), now + timedelta(seconds=1), 28)
        self.assertEqual(result["participant_count"], 1)
        self.assertTrue(all(r["rank"] is None for r in result["rows"]))
        self.assertEqual(result["uncertainty_method"], "participant_cluster_percentile_95")

    def test_cleanup_preserves_current_choices_and_snapshot(self):
        self.choice()
        body = {"version": 0, "support_ids": ["a"], "favorite_ids": []}
        perform(self.participant, "support", lambda p, c: update_supports(p, c, body))
        aggregate(timezone.now())
        PreferenceEvent.objects.filter(kind__in=["choice", "support"]).update(created_at=timezone.now() - timedelta(days=200))
        signal = PreferenceRiskSignal.objects.create(participant=self.participant, source_hash="x", signal="test")
        PreferenceRiskSignal.objects.filter(pk=signal.pk).update(created_at=timezone.now() - timedelta(days=31))
        purge()
        self.assertEqual(PreferenceRiskSignal.objects.count(), 0)
        self.assertEqual(PreferenceChoice.objects.count(), 1)
        self.assertTrue(PreferenceSnapshot.objects.exists())
        self.assertEqual(PreferenceEvent.objects.filter(kind__in=["choice", "support"]).count(), 2)
        self.assertEqual(PreferenceParticipant.objects.get(pk=self.participant.pk).support_ids, ["a"])
        with self.assertRaises(PreferenceError) as raised:
            aggregate(timezone.now() - timedelta(days=100))
        self.assertEqual(raised.exception.code, "outside_retention")

    def test_api_errors_idempotency_unknown_fields_and_empty_history(self):
        result = self.client.post("/api/preferences/tasks/", json.dumps({"operation_key": "valid-key", "left_id": "a"}), content_type="application/json")
        self.assertEqual(result.status_code, 400)
        self.assertEqual(self.client.get("/api/preferences/rankings/").json()["status"], "no_data")
        self.assertEqual(self.client.get("/api/preferences/trends/").json()["snapshots"], [])
        self.assertEqual(self.client.get("/api/preferences/pairs/?left_id=a&right_id=b").json()["sample_size"], 0)
        self.assertEqual(self.client.get("/api/preferences/records/").json()["records"], [])
        for age in (60, 0):
            PreferenceSnapshot.objects.create(kind="support", cutoff=timezone.now() - timedelta(days=age),
                catalog_version="test-v1", algorithm_version="test", asset_version="test-assets",
                payload={"rows": [{"id": "a", "count": 1}]})
        self.assertEqual(self.client.get("/api/preferences/trends/?kind=support").json()["changes"], {"7": None, "28": None})

    def test_source_shared_by_many_visitors_is_not_an_exclusion_reason(self):
        for _ in range(22):
            client = Client()
            result = client.post("/api/preferences/identity/", "{}", content_type="application/json")
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["risk_status"], "accepted")
        self.assertTrue(PreferenceRiskSignal.objects.filter(signal="identity_creation_burst").exists())

    def test_rate_limit_keeps_current_task_and_other_endpoint_available(self):
        body = json.dumps({"operation_key": "same-retry-key"})
        for _ in range(60):
            self.assertEqual(self.client.post("/api/preferences/tasks/", body, content_type="application/json").status_code, 200)
        response = self.client.post("/api/preferences/tasks/", body, content_type="application/json")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["code"], "rate_limited")
        self.assertEqual(PreferenceTask.objects.count(), 1)
        self.assertEqual(self.client.get("/api/preferences/state/").status_code, 200)

    def test_registration_cleanup_keeps_baseline_for_later_historical_replay(self):
        from .preference_statistics import current_states
        now = timezone.now()
        first = PreferenceEvent.objects.create(participant=self.participant, kind="support",
            after={"support_ids": ["a"], "favorite_ids": []}, created_at=now - timedelta(days=200))
        second = PreferenceEvent.objects.create(participant=self.participant, kind="support",
            after={"support_ids": ["b"], "favorite_ids": []}, created_at=now - timedelta(days=20))
        PreferenceParticipant.objects.filter(pk=self.participant.pk).update(
            support_version=2, support_ids=["b"], created_at=now - timedelta(days=220))
        purge(now)
        self.assertEqual(PreferenceEvent.objects.filter(pk__in=[first.pk, second.pk]).count(), 2)
        states, _ = current_states(now - timedelta(days=30))
        self.assertEqual(states[self.participant.pk]["support_ids"], ["a"])

    def test_catalog_workflow_atomic_rejects_stale_preview_and_permission(self):
        with override_settings(FORMAL_DATA_MANAGED=False):
            faction = Faction.objects.create(id="test-faction", name="测试")
            for pid in ("a", "b", "c", "d"):
                Person.objects.create(id=pid, name=pid, faction=faction)
        candidate = copy.deepcopy(payload())
        candidate["version"] = "test-v2"
        with patch("atlas.preference_editorial.validate_catalog", side_effect=lambda p: p):
            create_catalog(candidate, self.actor, "Verified fixture")
            with self.assertRaises(PreferenceError):
                preview_catalog("test-v2", self.actor)
            review_catalog("test-v2", self.actor, "Checked source")
            preview = preview_catalog("test-v2", self.actor)
            current = PreferenceControl.objects.get()
            current.revision += 1
            current.save()
            with self.assertRaises(PreferenceError):
                publish_catalog("test-v2", preview["token"], self.actor)
            self.assertEqual(PreferenceControl.objects.get().catalog_id, "test-v1")
            previous_preview = preview_catalog("test-v2", self.actor)
            review_catalog("test-v2", self.actor, "Needs another look", False)
            review_catalog("test-v2", self.actor, "Second review complete")
            with self.assertRaises(PreferenceError):
                publish_catalog("test-v2", previous_preview["token"], self.actor)
            preview = preview_catalog("test-v2", self.actor)
            publish_catalog("test-v2", preview["token"], self.actor)
            self.assertEqual(PreferenceControl.objects.get().catalog_id, "test-v2")
            with self.assertRaises(PreferenceError):
                publish_catalog("test-v2", preview["token"], self.actor)
        ordinary = User.objects.create_user("ordinary", password="test-password")
        with self.assertRaises(PreferenceError):
            review_risk(self.participant.pk, "excluded", ordinary, "Not authorized")

    def test_catalog_republication_cannot_reassign_historical_ids_and_voids_old_tasks(self):
        first = perform(self.participant, "task", issue_task)
        second = payload()
        second["version"] = "test-v2"
        second["forms"] = [form for form in second["forms"] if form["id"] != "f1"]
        second["appearances"] = [skin for skin in second["appearances"] if skin["form_id"] != "f1"]
        second["persons"][0]["form_ids"] = ["f2"]
        second["persons"][0]["form_catalog_version"] = "test-v2"
        with patch("atlas.preference_editorial.validate_catalog", side_effect=lambda p: p):
            create_catalog(second, self.actor, "Remove form")
            review_catalog("test-v2", self.actor, "Verified")
            preview = preview_catalog("test-v2", self.actor)
            publish_catalog("test-v2", preview["token"], self.actor)
            self.assertEqual(PreferenceTask.objects.get(pk=first["task"]["id"]).status, "void")
            self.assertEqual(quota(self.participant)["rolling_used"], 0)
            with self.assertRaises(PreferenceError):
                perform(self.participant, "answer", lambda p, c: answer_task(p, c, first["task"]["id"], {"outcome": "skip"}))
            third = payload()
            third["version"] = "test-v3"
            third["forms"][0]["person_id"] = "b"
            create_catalog(third, self.actor, "Attempt reassign")
            review_catalog("test-v3", self.actor, "Reviewed")
            preview = preview_catalog("test-v3", self.actor)
            with self.assertRaises(PreferenceError) as error:
                publish_catalog("test-v3", preview["token"], self.actor)
            self.assertEqual(error.exception.code, "stable_id_reassigned")
            self.assertEqual(PreferenceControl.objects.get().catalog_id, "test-v2")

    def test_confirmation_version_cannot_be_reused_for_different_historical_set(self):
        second = copy.deepcopy(payload())
        second["version"] = "test-v2"
        second["forms"][0]["catalog_version"] = "set-v2"
        with patch("atlas.preference_editorial.validate_catalog", side_effect=lambda p: p):
            create_catalog(second, self.actor, "Catalog update")
            review_catalog("test-v2", self.actor, "Checked")
            publish_catalog("test-v2", preview_catalog("test-v2", self.actor)["token"], self.actor)
            third = copy.deepcopy(payload())
            third["version"] = "test-v3"
            third["appearances"].append({**third["appearances"][0], "id": "f1s3"})
            create_catalog(third, self.actor, "Invalid confirmation version reuse")
            review_catalog("test-v3", self.actor, "Checked")
            with self.assertRaises(PreferenceError) as error:
                publish_catalog("test-v3", preview_catalog("test-v3", self.actor)["token"], self.actor)
            self.assertEqual(error.exception.code, "candidate_version_reused")

    def test_same_cutoff_catalogs_recompute_independently(self):
        cutoff = timezone.now()
        aggregate(cutoff)
        second = copy.deepcopy(payload())
        second["version"] = "test-v2"
        PreferenceCatalog.objects.create(version="test-v2", payload=second, digest=digest(second), status="published",
                                         created_by=self.actor, published_at=cutoff)
        current = PreferenceControl.objects.get()
        current.catalog_id = "test-v2"
        current.revision += 1
        current.save()
        aggregate(cutoff)
        review_risk(self.participant.pk, "excluded", self.actor, "Synthetic review")
        revise_snapshots(self.actor, "Synthetic correction")
        snapshots = PreferenceSnapshot.objects.filter(kind="random", window=84, cutoff=cutoff, revision=2)
        self.assertEqual(set(snapshots.values_list("catalog_version", flat=True)), {"test-v1", "test-v2"})
        self.assertTrue(all(row.supersedes_id for row in snapshots))
        response = self.client.get("/api/preferences/rankings/").json()
        self.assertEqual(response["snapshot"]["catalog_version"], "test-v2")

    def test_backup_restore_rebuilds_state_without_cache(self):
        from django.conf import settings
        from django.core import serializers

        from .preference_models import PreferenceOperation
        task = perform(self.participant, "task", issue_task)
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task["task"]["id"], {"outcome": "skip"}))
        support = {"version": 0, "support_ids": ["a"], "favorite_ids": ["a"]}
        perform(self.participant, "support", lambda p, c: update_supports(p, c, support))
        self.choice()
        aggregate(timezone.now())
        models = [User, PreferenceCatalog, PreferenceControl, PreferenceParticipant, PreferenceTask,
                  PreferenceChoice, PreferenceOperation, PreferenceEvent, PreferenceSnapshot]
        data = serializers.serialize("json", [obj for model in models for obj in model.objects.all()])
        script = """
import os, sys
os.environ['DATABASE_URL'] = ''
os.environ['DJANGO_DEBUG'] = '1'
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
from config import settings
settings.DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': sys.argv[1]}}
settings.CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
import django
django.setup()
from django.core.management import call_command
from django.core import serializers
call_command('migrate', verbosity=0, interactive=False)
with open(sys.argv[2]) as fixture:
    for obj in serializers.deserialize('json', fixture.read()):
        obj.save()
from atlas.preference_models import PreferenceParticipant, PreferenceTask, PreferenceSnapshot
from atlas.preference_services import state
value = state(PreferenceParticipant.objects.get())
assert value['quota']['rolling_used'] == 1
assert value['supports']['support_ids'] == ['a']
assert value['supports']['version'] == 1
assert value['choices'][0]['choice_id'] == 'f1s1'
assert value['choices'][0]['confirmed']
assert PreferenceTask.objects.get().status == 'answered'
assert PreferenceSnapshot.objects.filter(scope="person", kind='support').get().payload['participant_count'] == 1
print('RESTORE_OK')
"""
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "synthetic.json"
            fixture.write_text(data)
            result = subprocess.run([sys.executable, "-c", script, str(Path(tmp) / "restore.sqlite3"), str(fixture)],
                                    cwd=settings.BASE_DIR, env={**os.environ, "DATABASE_URL": ""},
                                    capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("RESTORE_OK", result.stdout)

    def test_implicit_form_confirmation_version_tracks_set_not_labels(self):
        from .preference_services import catalog_payload, choice_context
        catalog = PreferenceCatalog.objects.get()
        for person in catalog.payload["persons"]:
            person.pop("form_catalog_version", None)
        catalog.save()
        before = catalog_payload()["persons"][0]["form_catalog_version"]
        self.assertEqual(before, choice_context(catalog.payload, "form", "a")[2])
        catalog.payload["persons"][0]["name"] = "Corrected name"
        catalog.payload["version"] = "new-global-label"
        catalog.save()
        self.assertEqual(before, catalog_payload()["persons"][0]["form_catalog_version"])
        catalog.payload["forms"][1]["eligible"] = False
        catalog.save()
        self.assertNotEqual(before, catalog_payload()["persons"][0]["form_catalog_version"])

    def test_explicit_recompute_produces_reasoned_revision(self):
        cutoff = timezone.now()
        aggregate(cutoff)
        aggregate(cutoff, reason="Algorithm input audit", force_revision=True)
        snapshot = PreferenceSnapshot.objects.filter(scope="person", kind="support").first()
        self.assertEqual(snapshot.revision, 1)
        self.assertIsNotNone(snapshot.supersedes_id)
        self.assertEqual(snapshot.reason, "Algorithm input audit")

    def test_management_command_parsers_and_sided_unfamiliar(self):
        from django.core.management import get_commands, load_command_class
        for name in ("preference_catalog", "aggregate_preferences", "purge_preferences", "review_preference_risk", "simulate_preferences"):
            command = load_command_class(get_commands()[name], name)
            self.assertTrue(command.create_parser("manage.py", name).format_help())
        result = perform(self.participant, "task", issue_task)
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, result["task"]["id"], {"outcome": "unfamiliar_left"}))
        data = random_result(payload(), timezone.now(), 28)
        rows = {row["id"]: row for row in data["rows"]}
        self.assertEqual(rows[result["task"]["left_id"]]["unfamiliar_count"], 1)
        self.assertEqual(rows[result["task"]["right_id"]]["unfamiliar_count"], 0)

    def test_new_asset_hash_validation_and_real_catalog_mapping(self):
        from django.conf import settings

        from .preference_editorial import validate_catalog
        real = json.loads((settings.BASE_DIR.parent / "data/preferences/catalog.json").read_text())
        with override_settings(FORMAL_DATA_MANAGED=False):
            faction = Faction.objects.create(id="test-faction", name="测试")
            Person.objects.bulk_create([Person(id=p["id"], name=p["name"], faction=faction) for p in real["persons"]])
        validate_catalog(real)
        with tempfile.TemporaryDirectory() as tmp, override_settings(PREFERENCE_ASSET_ROOT=tmp):
            with self.assertRaises(PreferenceError) as raised:
                validate_catalog(real)
            self.assertEqual(raised.exception.code, "asset_missing")


@skipUnless(connection.vendor == "postgresql", "PostgreSQL row-lock verification")
class PreferenceConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()

    def concurrent(self, callbacks):
        barrier = Barrier(len(callbacks))
        def run(callback):
            close_old_connections()
            barrier.wait()
            try:
                return callback()
            except PreferenceError as exc:
                return exc.code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=len(callbacks)) as pool:
            return list(pool.map(run, callbacks))

    def test_concurrent_issue_answer_and_support_version(self):
        results = self.concurrent([lambda: perform(self.participant, "task", issue_task) for _ in range(2)])
        self.assertEqual(results[0]["task"]["id"], results[1]["task"]["id"])
        self.assertEqual(PreferenceTask.objects.count(), 1)
        task_id = results[0]["task"]["id"]
        body = {"outcome": "choose", "winner_id": results[0]["task"]["left_id"]}
        answers = self.concurrent([lambda: perform(self.participant, "answer", lambda p, c: answer_task(p, c, task_id, body), body, "concurrent-answer") for _ in range(2)])
        self.assertEqual(answers[0], answers[1])
        self.assertEqual(PreferenceTask.objects.filter(status="answered").count(), 1)
        support = {"version": 0, "support_ids": ["a"], "favorite_ids": []}
        results = self.concurrent([lambda: perform(self.participant, "support", lambda p, c: update_supports(p, c, support)) for _ in range(2)])
        self.assertEqual(sum(result == "version_conflict" for result in results), 1)

    def test_concurrent_choice_version_and_publication(self):
        body = {"version": 0, "catalog_version": "set-v1", "action": "choose", "choice_id": "f1s1"}
        results = self.concurrent([lambda: perform(self.participant, "choice", lambda p, c: update_choice(p, c, "skin", "f1", body)) for _ in range(2)])
        self.assertEqual(sum(result == "version_conflict" for result in results), 1)
        self.assertEqual(PreferenceChoice.objects.count(), 1)
        with patch("atlas.preference_editorial.validate_catalog", side_effect=lambda p: p):
            candidates = []
            for version in ("candidate-v2", "candidate-v3"):
                data = copy.deepcopy(payload())
                data["version"] = version
                create_catalog(data, self.actor, "Parallel fixture")
                review_catalog(version, self.actor, "Checked")
                candidates.append((version, preview_catalog(version, self.actor)["token"]))
            results = self.concurrent([lambda pair=pair: publish_catalog(pair[0], pair[1], self.actor) for pair in candidates])
        self.assertEqual(sum(result == "preview_conflict" for result in results), 1)
        self.assertEqual(PreferenceCatalog.objects.filter(status="published").count(), 2)
