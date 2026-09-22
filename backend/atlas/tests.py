import copy
import re
from importlib import import_module
from types import SimpleNamespace

from django.core import mail
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .importing import import_bundle
from .models import (
    Comment,
    Faction,
    Favorite,
    ImportBatch,
    Person,
    Relationship,
    Report,
    Revision,
    Submission,
    User,
)
from .services import review_submission

GRAPH = {
    "factions": [{"id": "rhodes", "name": "罗德岛", "order": 1}],
    "nodes": [
        {"id": "char_a", "name": "甲", "aliases": ["甲"], "factionId": "rhodes"},
        {"id": "char_b", "name": "乙", "aliases": ["乙"], "factionId": "rhodes"},
        {"id": "person_c", "name": "丙", "aliases": ["丙"], "factionId": "rhodes", "isOperator": False},
    ],
    "edges": [
        {"id": "char_a|char_b", "source": "char_a", "target": "char_b", "kind": "mutual"},
        {
            "id": "char_a|person_c",
            "source": "char_a",
            "target": "person_c",
            "kind": "awareness",
            "from": "person_c",
            "to": "char_a",
        },
    ],
}
EVIDENCE = {
    edge["id"]: {
        "quote": "测试原文。",
        "note": "测试说明。",
        "sources": [{"kind": "story", "source": "test.txt", "line": 1, "endLine": 2}],
    }
    for edge in GRAPH["edges"]
}


@override_settings(
    FORMAL_DATA_MANAGED=False,
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    COMMUNITY_ENABLED=True,
    REGISTRATION_ENABLED=True,
)
class AtlasTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        import_bundle(GRAPH, EVIDENCE)
        cls.user = User.objects.create_user(
            "reader", "reader@example.test", "Atlas-reader-5938!", email_verified=True
        )
        cls.other = User.objects.create_user("other", "other@example.test", "Atlas-other-5938!")
        cls.admin = User.objects.create_superuser("editor", "editor@example.test", "Atlas-editor-5938!")

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def target(self, kind="person"):
        return {"targetType": kind, "targetId": "char_a" if kind == "person" else "char_a|char_b"}

    def test_graph_scopes_and_direction(self):
        operators = self.client.get("/api/graph/").json()
        complete = self.client.get("/api/graph/?scope=all").json()
        self.assertEqual((len(operators["nodes"]), len(operators["edges"])), (2, 1))
        self.assertEqual((len(complete["nodes"]), len(complete["edges"])), (3, 2))
        self.assertEqual(complete["edges"][1]["from"], "person_c")
        self.assertEqual(complete["npcCount"], 1)
        self.assertEqual(self.client.get("/api/graph/?scope=invalid").status_code, 400)

    def test_invalid_numeric_identifiers_are_client_errors(self):
        self.client.force_login(self.user)
        for invalid in ({}, [], "invalid", -1, "9" * 100):
            self.assertEqual(
                self.client.delete("/api/favorites/", {"id": invalid}, format="json").status_code, 400
            )
        self.assertEqual(
            self.client.post(
                "/api/auth/reset/", {"uid": "9" * 100, "token": "invalid"}, format="json"
            ).status_code,
            400,
        )

    def test_malformed_payload_and_overflowing_page_are_client_errors(self):
        self.client.force_login(self.user)
        for path in ("favorites/", "comments/", "submissions/", "auth/reset/"):
            self.assertEqual(self.client.post("/api/" + path, [], format="json").status_code, 400)
        for page in ("invalid", "0", "-1", "9" * 100):
            self.assertEqual(self.client.get("/api/favorites/", {"page": page}).status_code, 400)

    def test_npc_promotion_keeps_identity_and_favorites(self):
        npc = Person.objects.get(pk="person_c")
        Favorite.objects.create(user=self.user, person=npc)
        npc.is_operator = True
        npc.save()
        self.assertEqual(len(self.client.get("/api/graph/").json()["nodes"]), 3)
        self.assertTrue(Favorite.objects.filter(person_id="person_c").exists())

    def test_npc_avatar_provenance_round_trip_and_validation(self):
        graph = copy.deepcopy(GRAPH)
        graph["nodes"][2].update(
            avatar="/avatars/person_c.webp",
            avatarSource="https://prts.wiki/w/File:Npc_medic.png",
            avatarIsGeneric=True,
        )
        import_bundle(graph, EVIDENCE, update_existing=True)
        person = self.client.get("/api/people/person_c/").json()
        self.assertTrue(person["avatarIsGeneric"])
        self.assertEqual(person["avatarSource"], graph["nodes"][2]["avatarSource"])
        complete = self.client.get("/api/graph/?scope=all").json()
        npc = next(n for n in complete["nodes"] if n["id"] == "person_c")
        self.assertEqual(npc["avatar"], "/avatars/person_c.webp")
        graph["nodes"][2]["avatarIsGeneric"] = "false"
        with self.assertRaises(ValidationError):
            import_bundle(graph, EVIDENCE, update_existing=True)

    def test_rhodes_correction_preserves_identity_and_existing_edits(self):
        Faction.objects.create(pk="unknown", name="未归属")
        Faction.objects.create(pk="rainbow", name="彩虹小队")
        ids = (
            "char_508_aguard", "char_509_acast", "char_510_amedic",
            "char_511_asnipe", "char_513_apionr", "char_615_acspec",
        )
        for pk in ids:
            Person.objects.create(pk=pk, name=pk, faction_id="unknown")
        Person.objects.create(pk="person_future", name="新人物", faction_id="unknown")
        Person.objects.filter(pk=ids[-1]).update(faction_id="rainbow", version=7)
        favorite = Favorite.objects.create(user=self.user, person_id=ids[0])
        relationships = list(Relationship.objects.values())
        historical_apps = MigrationExecutor(connection).loader.project_state(
            [("atlas", "0001_initial")]
        ).apps
        migration = import_module("atlas.migrations.0002_rhodes_elite_factions")
        for _ in range(2):
            migration.assign_rhodes(historical_apps, SimpleNamespace(connection=connection))
        for pk in ids[:-1]:
            person = Person.objects.get(pk=pk)
            self.assertEqual((person.faction_id, person.version), ("rhodes", 2))
        edited = Person.objects.get(pk=ids[-1])
        self.assertEqual((edited.faction_id, edited.version), ("rainbow", 7))
        self.assertEqual(Person.objects.get(pk="person_future").faction_id, "unknown")
        self.assertTrue(Favorite.objects.filter(pk=favorite.pk, person_id=ids[0]).exists())
        self.assertEqual(list(Relationship.objects.values()), relationships)
        revisions = Revision.objects.filter(reason="faction-correction:rhodes-elites:2026-09-18")
        self.assertEqual(revisions.count(), 5)
        for revision in revisions:
            self.assertEqual(revision.before["faction"], "unknown")
            self.assertEqual(revision.after["faction"], "rhodes")

    def test_unpublished_person_and_relations_are_not_public(self):
        Person.objects.filter(pk="char_a").update(published=False)
        self.assertEqual(self.client.get("/api/people/char_a/").status_code, 404)
        self.assertEqual(self.client.get("/api/relationships/char_a|char_b/").status_code, 404)
        self.assertEqual(self.client.get("/api/graph/").json()["edges"], [])

    def test_evidence_preserves_quote_and_sources(self):
        result = self.client.get("/api/relationships/char_a|char_b/").json()
        self.assertEqual(result["quote"], EVIDENCE["char_a|char_b"]["quote"])
        self.assertEqual(result["sources"], EVIDENCE["char_a|char_b"]["sources"])

    def test_anonymous_writes_and_admin_access_are_denied(self):
        self.assertEqual(
            self.client.post("/api/comments/", {**self.target(), "body": "Hello"}).status_code, 403
        )
        self.assertEqual(self.client.post("/api/favorites/", self.target()).status_code, 403)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/admin/atlas/person/").status_code, 302)

    def test_favorites_are_idempotent_and_private(self):
        self.client.force_login(self.user)
        for kind in ("person", "relationship"):
            for _ in range(2):
                self.assertEqual(self.client.post("/api/favorites/", self.target(kind)).status_code, 201)
        self.assertEqual(Favorite.objects.filter(user=self.user).count(), 2)
        favorite = Favorite.objects.filter(user=self.user).first()
        self.client.force_login(self.other)
        self.assertEqual(self.client.get("/api/favorites/").json()["count"], 0)
        self.client.delete("/api/favorites/", {"id": favorite.pk}, format="json")
        self.assertTrue(Favorite.objects.filter(pk=favorite.pk).exists())

    def test_comment_publication_owner_deletion_and_report(self):
        self.client.force_login(self.user)
        result = self.client.post(
            "/api/comments/", {**self.target(), "body": "<script>example</script> 原文讨论"}
        )
        self.assertEqual(result.status_code, 201)
        comment_id = result.json()["id"]
        self.client.force_login(self.other)
        self.assertEqual(self.client.delete(f"/api/comments/{comment_id}/").status_code, 404)
        for expected in (201, 200):
            self.assertEqual(
                self.client.post(f"/api/comments/{comment_id}/report/", {"reason": "测试举报"}).status_code,
                expected,
            )
        self.assertEqual(Report.objects.count(), 1)
        self.client.logout()
        public = self.client.get("/api/comments/", self.target()).json()
        self.assertEqual(public["count"], 1)
        self.assertIn("<script>", public["results"][0]["body"])
        self.client.force_login(self.user)
        self.assertEqual(self.client.delete(f"/api/comments/{comment_id}/").status_code, 204)
        self.assertEqual(self.client.get("/api/comments/", self.target()).json()["count"], 0)

    def test_hidden_comments_are_excluded(self):
        Comment.objects.create(author=self.user, person_id="char_a", body="隐藏", status="hidden")
        self.assertEqual(self.client.get("/api/comments/", self.target()).json()["results"], [])

    def test_submission_ignores_privileged_fields(self):
        self.client.force_login(self.user)
        result = self.client.post(
            "/api/submissions/",
            {
                **self.target(),
                "body": "补充姓名",
                "status": "approved",
                "author": self.other.pk,
                "base_version": 999,
                "proposed_changes": {"name": "攻击"},
            },
            format="json",
        )
        self.assertEqual(result.status_code, 201)
        item = Submission.objects.get(pk=result.json()["id"])
        self.assertEqual(
            (item.status, item.author_id, item.base_version, item.proposed_changes),
            ("pending", self.user.pk, 1, {}),
        )
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲")

    def submission(self, **kwargs):
        return Submission.objects.create(
            author=self.user,
            person_id="char_a",
            body="修正名称",
            base_version=Person.objects.get(pk="char_a").version,
            proposed_changes={"name": "甲新名"},
            **kwargs,
        )

    def test_approval_changes_data_with_audit_and_cannot_repeat(self):
        item = self.submission()
        review_submission(item.pk, self.admin, True, "证据已核实")
        self.assertEqual(Person.objects.get(pk="char_a").name, "甲新名")
        self.assertEqual(Person.objects.get(pk="char_a").version, 2)
        self.assertTrue(Revision.objects.filter(reason=f"submission:{item.pk}").exists())
        with self.assertRaises(ValidationError):
            review_submission(item.pk, self.admin, True)

    def test_approval_requires_editor_and_current_version(self):
        item = self.submission()
        with self.assertRaises(PermissionDenied):
            review_submission(item.pk, self.user, True)
        Person.objects.filter(pk="char_a").update(version=2)
        with self.assertRaises(ValidationError):
            review_submission(item.pk, self.admin, True)
        item.refresh_from_db()
        self.assertEqual(item.status, "pending")

    def test_invalid_evidence_rolls_back_whole_approval(self):
        relation = Relationship.objects.get(pk="char_a|char_b")
        item = Submission.objects.create(
            author=self.user,
            relationship=relation,
            body="补充",
            base_version=relation.version,
            proposed_changes={
                "note": "不应保存",
                "evidence": [
                    {"quote": "新的原文", "sources": [{"kind": "story", "source": "a.txt", "line": -1}]}
                ],
            },
        )
        before = Revision.objects.count()
        with self.assertRaises(ValidationError):
            review_submission(item.pk, self.admin, True)
        relation.refresh_from_db()
        self.assertEqual(relation.note, "测试说明。")
        self.assertEqual(Revision.objects.count(), before)

    def test_database_rejects_invalid_direction_and_double_target(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Relationship.objects.filter(pk="char_a|char_b").update(
                kind="awareness", awareness_from_id="person_c"
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            Favorite.objects.create(user=self.user, person_id="char_a", relationship_id="char_a|char_b")

    def test_csrf_is_required_for_anonymous_login_and_authenticated_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        credentials = {"username": "reader", "password": "Atlas-reader-5938!"}
        self.assertEqual(client.post("/api/auth/login/", credentials).status_code, 403)
        client.get("/api/session/")
        csrf = client.cookies["csrftoken"].value
        self.assertEqual(client.post("/api/auth/login/", credentials, HTTP_X_CSRFTOKEN=csrf).status_code, 200)
        self.assertEqual(client.post("/api/comments/", {**self.target(), "body": "CSRF"}).status_code, 403)
        csrf = client.cookies["csrftoken"].value
        self.assertEqual(
            client.post(
                "/api/comments/", {**self.target(), "body": "CSRF"}, HTTP_X_CSRFTOKEN=csrf
            ).status_code,
            201,
        )

    def test_register_verify_login_and_reset_password(self):
        registration = {
            "username": "newreader",
            "email": "new@example.test",
            "password": "Atlas-reader-9723!",
        }
        self.assertEqual(self.client.post("/api/auth/register/", registration).status_code, 201)
        self.assertFalse(User.objects.get(username="newreader").is_active)
        token = re.search(r"token=([^#\s]+)", mail.outbox[-1].body).group(1)
        self.assertEqual(self.client.post("/api/auth/verify/", {"token": token}).status_code, 200)
        self.assertEqual(self.client.post("/api/auth/login/", registration).status_code, 200)
        self.client.post("/api/auth/logout/")
        self.client.post("/api/auth/forgot/", {"email": registration["email"]})
        uid = re.search(r"uid=(\d+)", mail.outbox[-1].body).group(1)
        token = re.search(r"token=([^#\s]+)", mail.outbox[-1].body).group(1)
        self.assertEqual(
            self.client.post(
                "/api/auth/reset/", {"uid": uid, "token": token, "password": "Atlas-reader-NEW-9723!"}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                "/api/auth/reset/", {"uid": uid, "token": token, "password": "Atlas-reader-NEW-9723!"}
            ).status_code,
            400,
        )

    def test_repeated_import_does_not_overwrite_admin_edits(self):
        Person.objects.filter(pk="char_a").update(name="后台修正")
        result = import_bundle(GRAPH, EVIDENCE)
        self.assertTrue(result["already_imported"])
        self.assertEqual(Person.objects.get(pk="char_a").name, "后台修正")

    def test_dry_run_rolls_back_and_does_not_create_batch(self):
        graph = copy.deepcopy(GRAPH)
        graph["nodes"].append(
            {"id": "person_d", "name": "丁", "aliases": [], "factionId": "rhodes", "isOperator": False}
        )
        batches = ImportBatch.objects.count()
        result = import_bundle(graph, EVIDENCE, dry_run=True)
        self.assertTrue(result["dry_run"])
        self.assertFalse(Person.objects.filter(pk="person_d").exists())
        self.assertEqual(ImportBatch.objects.count(), batches)

    def test_invalid_import_rolls_back_earlier_new_rows(self):
        graph = copy.deepcopy(GRAPH)
        graph["nodes"].append(
            {"id": "person_d", "name": "丁", "aliases": [], "factionId": "rhodes", "isOperator": False}
        )
        graph["edges"].append(
            {"id": "duplicate_pair", "source": "char_a", "target": "char_b", "kind": "mutual"}
        )
        with self.assertRaises(ValidationError):
            import_bundle(graph, {**EVIDENCE, "duplicate_pair": EVIDENCE["char_a|char_b"]})
        self.assertFalse(Person.objects.filter(pk="person_d").exists())

    def test_evidence_only_import_invalidates_pending_revision(self):
        item = Submission.objects.create(
            author=self.user,
            relationship_id="char_a|char_b",
            body="补充",
            base_version=1,
            proposed_changes={"note": "旧版本修改"},
        )
        evidence = copy.deepcopy(EVIDENCE)
        evidence["char_a|char_b"]["quote"] = "新核查原文。"
        import_bundle(GRAPH, evidence, update_existing=True)
        with self.assertRaises(ValidationError):
            review_submission(item.pk, self.admin, True)

    def test_admin_edit_and_import_pages_are_usable(self):
        self.client.force_login(self.admin)
        for path in (
            "/admin/atlas/person/",
            "/admin/atlas/person/char_a/change/",
            "/admin/atlas/relationship/char_a%7Cchar_b/change/",
            "/admin/atlas/person/import/",
        ):
            self.assertEqual(self.client.get(path).status_code, 200, path)
