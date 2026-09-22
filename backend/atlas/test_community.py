"""Community shutdown must also cover existing users and sessions."""

import os
import runpy
from pathlib import Path
from unittest.mock import patch

from django.core import mail, signing
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from .importing import import_bundle
from .models import Comment, Favorite, Report, Submission, User
from .tests import EVIDENCE, GRAPH


class CommunityDefaultsTests(SimpleTestCase):
    def test_community_and_registration_default_to_closed(self):
        with patch.dict(os.environ, DJANGO_DEBUG="1"):
            for name in ("COMMUNITY_ENABLED", "REGISTRATION_ENABLED", "DATABASE_URL"):
                os.environ.pop(name, None)
            values = runpy.run_path(str(Path(__file__).resolve().parents[1] / "config/settings.py"))
        self.assertIs(values["COMMUNITY_ENABLED"], False)
        self.assertIs(values["REGISTRATION_ENABLED"], False)


@override_settings(
    FORMAL_DATA_MANAGED=False,
    COMMUNITY_ENABLED=False,
    REGISTRATION_ENABLED=True,
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
)
class CommunityGateTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        import_bundle(GRAPH, EVIDENCE)
        cls.user = User.objects.create_user("legacy", "legacy@example.test", "Atlas-reader-5938!")
        cls.pending = User.objects.create_user(
            "pending", "pending@example.test", "Atlas-pending-5938!", is_active=False
        )
        cls.admin = User.objects.create_superuser("maintainer", "admin@example.test", "Atlas-admin-5938!")
        cls.favorite = Favorite.objects.create(user=cls.user, person_id="char_a")
        cls.comment = Comment.objects.create(author=cls.user, person_id="char_a", body="已有评论")
        Report.objects.create(reporter=cls.user, comment=cls.comment, reason="已有举报")
        Submission.objects.create(author=cls.user, person_id="char_a", body="已有投稿", base_version=1)

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def snapshot(self):
        return {model.__name__: list(model.objects.order_by("pk").values())
                for model in (User, Favorite, Comment, Report, Submission)}

    def assert_closed(self, response):
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "账号社区暂未开放。", "code": "community_disabled"})

    def test_all_legacy_routes_reject_existing_sessions_without_changing_records(self):
        target = {"targetType": "person", "targetId": "char_a"}
        requests = (
            ("get", "/api/favorites/", {}),
            ("post", "/api/favorites/", {"targetType": "person", "targetId": "char_b"}),
            ("delete", "/api/favorites/", {"id": self.favorite.pk}),
            ("get", "/api/comments/", target),
            ("post", "/api/comments/", {**target, "body": "新评论"}),
            ("delete", f"/api/comments/{self.comment.pk}/", {}),
            ("post", f"/api/comments/{self.comment.pk}/report/", {"reason": "新举报"}),
            ("get", "/api/submissions/", {}),
            ("post", "/api/submissions/", {**target, "body": "新投稿", "evidence": "原文"}),
        )
        for user in (None, self.user, self.admin):
            if user:
                self.client.force_login(user)
            else:
                self.client.logout()
            before = self.snapshot()
            for method, path, payload in requests:
                with self.subTest(user=user, method=method, path=path):
                    self.assert_closed(getattr(self.client, method)(path, payload, format="json"))
            self.assertEqual(self.snapshot(), before)

    def test_account_actions_do_not_create_activate_reset_or_send_mail(self):
        from django.contrib.auth.tokens import default_token_generator

        token = signing.dumps({"uid": self.pending.pk, "email": self.pending.email}, salt="atlas-email")
        requests = {
            "register": {"username": "newreader", "email": "new@example.test", "password": "Atlas-new-5938!"},
            "login": {"username": self.user.username, "password": "Atlas-reader-5938!"},
            "verify": {"token": token},
            "resend": {"email": self.pending.email},
            "forgot": {"email": self.user.email},
            "reset": {"uid": self.user.pk, "token": default_token_generator.make_token(self.user),
                      "password": "Atlas-changed-5938!"},
        }
        before = self.snapshot()
        for action, payload in requests.items():
            with self.subTest(action=action):
                self.assert_closed(self.client.post(f"/api/auth/{action}/", payload, format="json"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(mail.outbox), 0)
        self.assertIsNone(self.client.get("/api/session/").json()["user"])

    def test_public_graph_people_and_evidence_remain_available(self):
        self.assertEqual(self.client.get("/api/graph/").status_code, 200)
        self.assertEqual(self.client.get("/api/people/char_a/").json()["id"], "char_a")
        edge = self.client.get("/api/relationships/char_a|char_b/").json()
        self.assertEqual(edge["quote"], EVIDENCE["char_a|char_b"]["quote"])
        self.assertEqual(edge["sources"], EVIDENCE["char_a|char_b"]["sources"])
        self.assertTrue(edge["evidence"])

    def test_session_capabilities_and_csrf_protected_logout_remain_available(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        response = self.client.get("/api/session/")
        self.assertEqual(response.json()["user"]["id"], self.user.pk)
        self.assertIs(response.json()["communityEnabled"], False)
        self.assertIs(response.json()["registrationEnabled"], False)
        self.assertIn("csrftoken", response.cookies)
        self.assertEqual(self.client.post("/api/auth/logout/", {}, format="json").status_code, 403)
        self.assertEqual(self.client.post(
            "/api/auth/logout/", {}, format="json", HTTP_X_CSRFTOKEN=response.cookies["csrftoken"].value
        ).status_code, 200)
        self.assertIsNone(self.client.get("/api/session/").json()["user"])

    def test_admin_login_is_independent_and_regular_users_remain_denied(self):
        response = self.client.post("/admin/login/?next=/admin/", {
            "username": self.admin.username, "password": "Atlas-admin-5938!", "next": "/admin/"
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get("/admin/").status_code, 200)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/admin/").status_code, 302)

    def test_registration_still_requires_its_separate_switch(self):
        with override_settings(COMMUNITY_ENABLED=True, REGISTRATION_ENABLED=False):
            capabilities = self.client.get("/api/session/").json()
            self.assertIs(capabilities["communityEnabled"], True)
            self.assertIs(capabilities["registrationEnabled"], False)
            response = self.client.post("/api/auth/register/", {}, format="json")
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"], "注册暂未开放。")
