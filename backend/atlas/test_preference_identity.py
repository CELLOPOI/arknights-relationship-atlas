import copy
from collections import Counter
from datetime import timedelta
from itertools import combinations, product
from unittest.mock import patch

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .preference_algorithm import weight_comparisons
from .preference_models import PreferenceControl, PreferenceParticipant, PreferenceSnapshot, PreferenceTask
from .preference_services import (
    PreferenceError,
    answer_task,
    issue_task,
    quota,
    support_data,
    update_supports,
)
from .preference_statistics import aggregate, random_result, registration_results
from .preference_subjects import project_comparisons, subjects
from .test_preferences import perform, setup_data


@override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=4, PREFERENCE_COOLDOWN_HOURS=0)
class PreferenceIdentityTests(TestCase):
    def setUp(self):
        self.actor, self.participant = setup_data()
        self.current = PreferenceControl.objects.get()
        self.catalog = self.current.catalog.payload
        self.client.cookies["atlas_preferences"] = "test-credential"

    def answer(self, left="form:f1", right="person:b", winner="a", age=0, participant=None):
        now = timezone.now() - timedelta(seconds=age)
        return PreferenceTask.objects.create(participant=participant or self.participant, catalog=self.current.catalog,
            left_id="a", right_id="b", left_subject_id=left, right_subject_id=right, pair_key=f"{left}|{right}",
            issued_at=now, expires_at=now + timedelta(days=1), accepted_at=now, status="answered", outcome="choose",
            winner_id=winner, strategy="uniform-v1")

    def support(self, selected, favorites=None, legacy=None):
        self.participant.refresh_from_db()
        body = {"version": self.participant.support_version, "subject_support_ids": selected,
                "subject_favorite_ids": favorites or [], "legacy_support_ids": legacy or [], "legacy_favorite_ids": []}
        return perform(self.participant, "support", lambda p, c: update_supports(p, c, body), body)

    def test_one_answer_projects_both_sides_without_giving_siblings_votes(self):
        self.answer()
        now = timezone.now()
        person = random_result(self.catalog, now, 84)
        form = random_result(self.catalog, now, 84, "form")
        self.assertEqual(person["sample_size"], 1)
        self.assertEqual(form["sample_size"], 1)
        rows = {r["id"]: r for r in form["rows"]}
        self.assertEqual(rows["form:f1"]["comparisons"], 1)
        self.assertEqual(rows["person:b"]["comparisons"], 1)
        self.assertEqual(rows["form:f2"]["comparisons"], 0)
        self.assertIsNone(rows["form:f2"]["score"])
        self.assertGreater(rows["form:f1"]["score"], rows["person:b"]["score"])
        self.assertEqual(PreferenceTask.objects.count(), 1)

    def test_person_pair_dedup_uses_latest_even_when_other_form_loses(self):
        self.answer(age=20)
        self.answer(left="form:f2", winner="b", age=10)
        now = timezone.now()
        person = random_result(self.catalog, now, 84)
        form = random_result(self.catalog, now, 84, "form")
        self.assertEqual((person["raw_sample_size"], person["sample_size"]), (2, 1))
        self.assertEqual(form["sample_size"], 2)
        rows = {r["id"]: r for r in person["rows"]}
        self.assertGreater(rows["b"]["score"], rows["a"]["score"])
        self.assertLessEqual(rows["a"]["weighted_evidence"], 1)

    def test_legacy_answer_never_creates_form_history(self):
        self.answer(left="", right="", age=10)
        now = timezone.now()
        self.assertEqual(random_result(self.catalog, now, 84)["sample_size"], 1)
        self.assertEqual(random_result(self.catalog, now, 84, "form")["sample_size"], 0)
        self.answer(left="form:f2", winner="b")
        self.assertEqual(random_result(self.catalog, timezone.now(), 84)["sample_size"], 1)

    def test_task_carries_fixed_form_and_consumes_one_quota(self):
        result = perform(self.participant, "task", issue_task)
        task = result["task"]
        self.assertTrue(task["left_subject_id"])
        self.assertEqual(task["left"]["person_id"], task["left_id"])
        self.assertNotEqual(task["left_id"], task["right_id"])
        restored = perform(self.participant, "task", issue_task)
        self.assertEqual(restored["task"], task)
        perform(self.participant, "answer", lambda p, c: answer_task(p, c, task["id"], {"outcome": "choose", "winner_id": task["left_id"]}))
        self.assertEqual(quota(self.participant)["weekly_used"], 1)
        self.assertEqual(random_result(self.catalog, timezone.now(), 84, "form")["sample_size"], 1)

    def test_family_exposure_limit_applies_across_forms(self):
        self.answer(left="form:f1")
        self.answer(left="form:f2")
        self.answer(left="form:f1")
        for _ in range(1):
            result = perform(self.participant, "task", issue_task)
            self.assertNotIn("a", (result["task"]["left_id"], result["task"]["right_id"]))
            perform(self.participant, "answer", lambda p, c, result=result: answer_task(p, c, result["task"]["id"], {"outcome": "skip"}))

    def test_aliases_do_not_remove_real_alters(self):
        cat = copy.deepcopy(self.catalog)
        base = cat["forms"][0]
        cat["forms"] = [{**base, "id": id} for id in ["char_509_acast", "char_612_accast", "f2"]]
        self.assertEqual(set(subjects(cat)), {"form:char_509_acast", "form:f2", "person:b", "person:c", "person:d"})
        cat["forms"][0]["complete"] = False
        self.assertIn("form:char_612_accast", subjects(cat))

    @override_settings(PREFERENCE_SUPPORT_LIMIT=1, PREFERENCE_FAVORITE_LIMIT=1)
    def test_supports_use_person_union_and_withdraw_automatically(self):
        saved = self.support(["form:f1", "form:f2"], ["form:f2"])
        self.assertEqual(saved["support_ids"], ["a"])
        self.assertEqual(saved["favorite_ids"], ["a"])
        with self.assertRaises(PreferenceError):
            self.support(["form:f1", "person:b"])
        with self.assertRaises(PreferenceError):
            self.support(["form:f1", "form:f2"], ["form:f1", "form:f2"])
        now = timezone.now()
        person = next(registration_results(self.catalog, now))[2]
        form = next(registration_results(self.catalog, now, "form"))[2]
        self.assertEqual(person["sample_size"], 1)
        self.assertEqual(form["sample_size"], 2)
        self.assertEqual(self.support(["form:f2"])["support_ids"], ["a"])
        self.assertEqual(self.support([])["support_ids"], [])

    def test_legacy_support_stays_unspecified_and_cannot_be_forged(self):
        body = {"version": 0, "support_ids": ["a"], "favorite_ids": ["a"]}
        perform(self.participant, "support", lambda p, c: update_supports(p, c, body), body)
        self.participant.refresh_from_db()
        self.assertEqual(support_data(self.participant)["subject_support_ids"], [])
        self.assertEqual(self.support(["form:f1"], legacy=["a"])["support_ids"], ["a"])
        self.assertEqual(self.support([], legacy=["a"])["support_ids"], ["a"])
        with self.assertRaises(PreferenceError):
            self.support([], legacy=["b"])
        self.assertEqual(self.support([])["support_ids"], [])

    def test_scopes_have_distinct_snapshots_queries_pairs_and_trends(self):
        self.answer()
        cutoff = timezone.now()
        aggregate(cutoff)
        self.assertEqual(PreferenceSnapshot.objects.filter(kind="random", window=84).count(), 2)
        for scope in ("person", "form"):
            result = self.client.get(f"/api/preferences/rankings/?kind=random&scope={scope}").json()
            self.assertEqual(result["snapshot"]["scope"], scope)
            trend = self.client.get(f"/api/preferences/trends/?kind=random&scope={scope}").json()
            self.assertTrue(all(s["scope"] == scope for s in trend["snapshots"]))
        pair = self.client.get("/api/preferences/pairs/?scope=form&left_id=form:f1&right_id=person:b").json()
        self.assertEqual((pair["left_wins"], pair["right_wins"]), (1, 0))
        self.assertEqual(self.client.get("/api/preferences/pairs/?left_id=a&right_id=b").json()["sample_size"], 1)
        self.assertEqual(self.client.get("/api/preferences/rankings/?scope=invalid").status_code, 400)
        total = PreferenceSnapshot.objects.count()
        aggregate(cutoff)
        self.assertEqual(PreferenceSnapshot.objects.count(), total)

    def test_catalog_exposes_subjects_and_rejects_paused_form(self):
        result = self.client.get("/api/preferences/catalog/").json()
        self.assertEqual(len(result["catalog"]["subjects"]), 5)
        task = self.answer()
        task.status, task.accepted_at, task.outcome, task.winner_id = "pending", None, "", ""
        task.save()
        self.current.paused_objects = ["f1"]
        self.current.save()
        with self.assertRaises(PreferenceError):
            answer_task(self.participant, self.current, task.pk, {"outcome": "choose", "winner_id": "a"})

    def test_person_sampling_pool_does_not_repeat_multi_form_owners(self):
        with patch("atlas.preference_services.secrets.SystemRandom") as factory:
            rng = factory.return_value
            rng.random.return_value = 1
            rng.choice.side_effect = lambda items: items[0]
            perform(self.participant, "task", issue_task)
        self.assertEqual(rng.shuffle.call_args_list[0].args[0], ["a", "b", "c", "d"])

    def test_excluded_participants_do_not_contribute_to_either_scope(self):
        self.answer()
        PreferenceParticipant.objects.filter(pk=self.participant.pk).update(risk_status="excluded")
        for scope in ("person", "form"):
            self.assertEqual(random_result(self.catalog, timezone.now(), 84, scope)["sample_size"], 0)


class PreferenceIdentitySimulationTests(SimpleTestCase):
    def test_unequal_form_counts_preserve_person_pairs_and_caps(self):
        # 不同人物有 1–3 个形态；每位参与者比较所有跨人物形态对。
        families = {f"p{i}": [f"form:p{i}-{j}" for j in range(n)] for i, n in enumerate([1, 3, 2, 1, 3, 2])}
        candidates = {sid: {"person_id": pid} for pid, ids in families.items() for sid in ids}
        rows, now = [], timezone.now()
        for uid in range(20):
            for left, right in combinations(families, 2):
                for a, b in product(families[left], families[right]):
                    rows.append({"id": len(rows), "participant_id": uid, "left_id": left, "right_id": right,
                                 "left_subject_id": a, "right_subject_id": b, "winner_id": left if uid % 2 else right,
                                 "outcome": "choose", "accepted_at": now + timedelta(seconds=len(rows))})
        person = weight_comparisons(list(project_comparisons(rows, "person", candidates)))
        form = weight_comparisons(list(project_comparisons(rows, "form", candidates)))
        self.assertEqual(len(person), 20 * 15)
        self.assertEqual(len(form), len(rows))
        self.assertGreater(len(form), len(person))
        degree = Counter(pid for row in person for pid in (row["left_id"], row["right_id"]))
        self.assertEqual(set(degree.values()), {100})
        for scope_rows in (person, form):
            totals, by_object = Counter(), Counter()
            for row in scope_rows:
                totals[row["participant_id"]] += row["weight"]
                for pid in (row["left_id"], row["right_id"]):
                    by_object[row["participant_id"], pid] += row["weight"]
            self.assertLessEqual(max(totals.values()), 50 + 1e-9)
            self.assertLessEqual(max(by_object.values()), 1 + 1e-9)


class PreferenceIdentityMigrationTests(TransactionTestCase):
    def test_existing_data_remains_person_scoped_without_fabricated_forms(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old_target = [("atlas", "0010_preference_snapshot_catalog_key")]
        try:
            executor.migrate(old_target)
            apps = executor.loader.project_state(old_target).apps
            actor = apps.get_model("atlas", "User").objects.create(username="migration-fixture")
            catalog = apps.get_model("atlas", "PreferenceCatalog").objects.create(
                version="migration-fixture", payload={}, digest="test", created_by=actor)
            participant = apps.get_model("atlas", "PreferenceParticipant").objects.create(
                credential_hash="migration-fixture", support_ids=["a"], favorite_ids=["a"], support_version=7)
            now = timezone.now()
            task = apps.get_model("atlas", "PreferenceTask").objects.create(
                participant=participant, catalog=catalog, left_id="a", right_id="b", winner_id="a",
                pair_key="a|b", strategy="uniform-v1", status="answered", outcome="choose",
                issued_at=now, expires_at=now + timedelta(days=1), accepted_at=now)
            payload = {"rows": [{"id": "a", "score": 60}], "sample_size": 1}
            snapshot = apps.get_model("atlas", "PreferenceSnapshot").objects.create(
                kind="random", window=84, cutoff=now, catalog_version=catalog.pk,
                algorithm_version="legacy-v2", asset_version="assets-v2", payload=payload)
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
            saved = PreferenceParticipant.objects.get(pk=participant.pk)
            self.assertEqual((saved.support_ids, saved.favorite_ids, saved.support_version), (["a"], ["a"], 7))
            self.assertEqual((saved.subject_support_ids, saved.subject_favorite_ids), ([], []))
            vote = PreferenceTask.objects.get(pk=task.pk)
            self.assertEqual((vote.left_id, vote.right_id, vote.winner_id, vote.pair_key), ("a", "b", "a", "a|b"))
            self.assertEqual((vote.left_subject_id, vote.right_subject_id), ("", ""))
            restored = PreferenceSnapshot.objects.get(pk=snapshot.pk)
            self.assertEqual((restored.scope, restored.algorithm_version, restored.payload), ("person", "legacy-v2", payload))
        finally:
            MigrationExecutor(connection).migrate(latest)
