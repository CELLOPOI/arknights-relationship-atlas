import io
import json
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .feedback_models import Feedback, FeedbackGuard, FeedbackReceipt, FeedbackReview
from .feedback_services import purge_feedback, review_feedback
from .importing import import_bundle
from .models import Person, User
from .tests import EVIDENCE, GRAPH


@override_settings(
    COMMUNITY_ENABLED=False,
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    FEEDBACK_RATE_PER_HOUR=5,
)
class FeedbackTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        with override_settings(FORMAL_DATA_MANAGED=False):
            import_bundle(GRAPH, EVIDENCE)
        cls.staff = User.objects.create_user("feedback_staff", "staff@example.test", "Atlas-staff-5938!", is_staff=True)
        cls.reader = User.objects.create_user("feedback_reader", "reader@example.test", "Atlas-reader-5938!")

    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        response = self.client.get("/api/session/")
        self.token = response.cookies["csrftoken"].value
        self.payload = {"type": "data_error", "description": "人物关系的原文需要核查。"}

    def submit(self, payload=None, **kwargs):
        return self.client.post("/api/feedback/", self.payload if payload is None else payload,
                                format="json", HTTP_X_CSRFTOKEN=self.token, **kwargs)

    def test_anonymous_acceptance_has_no_public_identifier_or_read_route(self):
        response = self.submit({**self.payload, "targetType": "relationship", "targetId": "char_a|char_b",
                                "sourceUrl": "https://example.test/story", "contact": "可选联系方式"})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"detail": "反馈已收到，维护者会核查。"})
        item = Feedback.objects.get()
        self.assertEqual(item.relationship_id, "char_a|char_b")
        self.assertEqual(item.contact, "可选联系方式")
        self.assertEqual(self.client.get("/api/feedback/").status_code, 405)
        self.assertEqual(self.client.get(f"/api/feedback/{item.pk}/").status_code, 404)
        self.assertEqual(self.client.get("/admin/atlas/feedback/").status_code, 302)
        self.assertTrue(self.client.get("/api/session/").json()["feedbackEnabled"])
        self.assertIsNone(self.client.get("/api/session/").json()["user"])

    def test_anonymous_csrf_and_origin_are_enforced(self):
        self.assertEqual(self.client.post("/api/feedback/", self.payload, format="json").status_code, 403)
        self.assertEqual(self.submit(HTTP_ORIGIN="https://evil.example").status_code, 403)
        self.assertEqual(self.submit(HTTP_ORIGIN="http://testserver").status_code, 202)
        self.assertEqual(Feedback.objects.count(), 1)

    def test_strict_fields_types_lengths_and_link_protocols(self):
        invalid = [[], {**self.payload, "unknown": "x"}, {**self.payload, "type": "bad"},
                   {**self.payload, "description": 3}, {**self.payload, "description": " "},
                   {**self.payload, "description": "a" * 6001}, {**self.payload, "contact": "x" * 255},
                   {**self.payload, "targetType": "person"}, {**self.payload, "targetId": "char_a"},
                   {**self.payload, "sourceUrl": "javascript:alert(1)"},
                   {**self.payload, "sourceUrl": "ftp://example.test/x"},
                   {**self.payload, "sourceUrl": "http://user:password@example.test"},
                   {**self.payload, "sourceUrl": "http://["}]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.submit(payload).status_code, 400)
        self.assertEqual(Feedback.objects.count(), 0)

    def test_unknown_and_unpublished_targets_are_rejected(self):
        Person.objects.filter(pk="char_b").update(published=False)
        for kind, key in (("person", "missing"), ("person", "char_b"), ("relationship", "char_a|char_b")):
            self.assertEqual(self.submit({**self.payload, "targetType": kind, "targetId": key}).status_code, 404)
        self.assertEqual(Feedback.objects.count(), 0)

    def test_body_and_media_limits_precede_parsing(self):
        response = self.client.post("/api/feedback/", json.dumps({**self.payload, "description": "a" * 33000}),
                                    content_type="application/json", HTTP_X_CSRFTOKEN=self.token)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.post("/api/feedback/", self.payload,
                                        HTTP_X_CSRFTOKEN=self.token).status_code, 415)
        self.assertEqual(Feedback.objects.count(), 0)

    def test_honeypot_gets_confirmation_without_record(self):
        self.assertEqual(self.submit({**self.payload, "website": "bot.example"}).status_code, 202)
        self.assertEqual(Feedback.objects.count(), 0)

    def test_database_rate_limit_duplicate_suppression_and_expiry(self):
        now = timezone.now()
        with patch("atlas.feedback_views.timezone.now", return_value=now):
            for _ in range(5):
                self.assertEqual(self.submit().status_code, 202)
            self.assertEqual(Feedback.objects.count(), 1)
            response = self.submit({**self.payload, "description": "另一条反馈"})
            self.assertEqual(response.status_code, 429)
            self.assertGreater(int(response["Retry-After"]), 0)
        self.assertEqual(FeedbackGuard.objects.get().count, 5)
        with patch("atlas.feedback_views.timezone.now", return_value=now + timedelta(hours=1, seconds=1)):
            self.assertEqual(self.submit().status_code, 202)
            self.assertEqual(Feedback.objects.count(), 1)
        with patch("atlas.feedback_views.timezone.now", return_value=now + timedelta(hours=25)):
            self.assertEqual(self.submit().status_code, 202)
            self.assertEqual(Feedback.objects.count(), 2)
        self.assertNotIn("127.0.0.1", FeedbackGuard.objects.get().key)

    def test_untrusted_forwarding_headers_do_not_bypass_rate_limit(self):
        with override_settings(FEEDBACK_RATE_PER_HOUR=1):
            self.assertEqual(self.submit(HTTP_X_FORWARDED_FOR="203.0.113.1").status_code, 202)
            self.assertEqual(self.submit(HTTP_X_FORWARDED_FOR="203.0.113.2").status_code, 429)
        with override_settings(FEEDBACK_RATE_PER_HOUR=1, FEEDBACK_TRUSTED_PROXY_IPS=("127.0.0.1",)):
            self.assertEqual(self.submit(HTTP_X_FORWARDED_FOR="203.0.113.1").status_code, 202)
            self.assertEqual(self.submit(HTTP_X_FORWARDED_FOR="203.0.113.2").status_code, 202)

    def test_queue_permissions_and_contact_visibility(self):
        self.submit({**self.payload, "contact": "private-contact@example.test"})
        item = Feedback.objects.get()
        self.client.force_login(self.reader)
        self.assertEqual(self.client.get("/admin/atlas/feedback/").status_code, 302)
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get("/admin/atlas/feedback/").status_code, 403)
        self.staff.user_permissions.add(Permission.objects.get(codename="view_feedback"))
        self.assertEqual(self.client.get("/admin/atlas/feedback/").status_code, 200)
        response = self.client.get(f"/admin/atlas/feedback/{item.pk}/change/")
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, item.contact)
        self.staff.user_permissions.add(Permission.objects.get(codename="view_feedback_contact"))
        self.assertContains(self.client.get(f"/admin/atlas/feedback/{item.pk}/change/"), item.contact)

    def test_review_audit_and_stale_version_rejection(self):
        self.submit({**self.payload, "contact": "private@example.test"})
        item = Feedback.objects.get()
        kwargs = {"actor": self.staff, "expected_version": 1, "status": "linked",
                  "review_note": "已核查，等待资料 PR。", "issue_url": "https://github.com/example/repo/issues/1"}
        with self.assertRaises(PermissionDenied):
            review_feedback(item.pk, **kwargs)
        self.staff.user_permissions.add(Permission.objects.get(codename="change_feedback"))
        self.staff = User.objects.get(pk=self.staff.pk)
        kwargs["actor"] = self.staff
        result = review_feedback(item.pk, **kwargs)
        self.assertEqual(result.version, 2)
        self.assertEqual(result.processed_by, self.staff)
        self.assertEqual(FeedbackReview.objects.count(), 1)
        self.assertNotIn("contact", FeedbackReview.objects.get().after)
        with self.assertRaises(ValidationError):
            review_feedback(item.pk, **{**kwargs, "status": "rejected"})
        item.refresh_from_db()
        self.assertEqual(item.status, "linked")
        self.assertEqual(FeedbackReview.objects.count(), 1)

    def test_admin_form_stale_submission_is_validation_error(self):
        self.submit()
        item = Feedback.objects.get()
        self.staff.user_permissions.add(Permission.objects.get(codename="change_feedback"))
        self.client = APIClient()
        self.client.force_login(self.staff)
        path = f"/admin/atlas/feedback/{item.pk}/change/"
        payload = {"status": "resolved", "review_note": "已修复。", "issue_url": "", "version_token": 1,
                   "reviews-TOTAL_FORMS": 0, "reviews-INITIAL_FORMS": 0, "reviews-MIN_NUM_FORMS": 0,
                   "reviews-MAX_NUM_FORMS": 0, "_save": "保存"}
        self.assertEqual(self.client.post(path, payload).status_code, 302)
        payload.update(status="rejected", review_note="陈旧页面操作。")
        response = self.client.post(path, payload)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "已被其他维护者处理")
        item.refresh_from_db()
        self.assertEqual(item.status, "resolved")
        self.assertEqual(FeedbackReview.objects.count(), 1)

    def test_retention_cleanup_uses_expiry_and_does_not_modify_formal_data(self):
        self.submit({**self.payload, "contact": "private@example.test"})
        item = Feedback.objects.get()
        now = timezone.now()
        Feedback.objects.filter(pk=item.pk).update(created_at=now - timedelta(days=91))
        FeedbackGuard.objects.update(expires_at=now - timedelta(seconds=1))
        FeedbackReceipt.objects.update(expires_at=now - timedelta(seconds=1))
        people = list(Person.objects.values())
        result = purge_feedback(now=now)
        self.assertEqual(result["contacts_cleared"], 1)
        self.assertFalse(FeedbackGuard.objects.exists())
        self.assertFalse(FeedbackReceipt.objects.exists())
        item.refresh_from_db()
        self.assertEqual(item.contact, "")
        self.assertEqual(item.description, self.payload["description"])
        output = io.StringIO()
        call_command("purge_feedback", now=(now + timedelta(days=365)).isoformat(), stdout=output)
        self.assertEqual(json.loads(output.getvalue())["feedback_deleted"], 1)
        self.assertEqual(list(Person.objects.values()), people)
