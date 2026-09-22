"""真实 PostgreSQL 双连接验证，不用 SQLite 结果替代数据库锁验收。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless

from django.core.exceptions import ValidationError
from django.db import close_old_connections, connection
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient

from .feedback_models import Feedback, FeedbackReview
from .feedback_services import review_feedback
from .models import User


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locks")
@override_settings(FEEDBACK_RATE_PER_HOUR=5)
class FeedbackConcurrencyTests(TransactionTestCase):
    def parallel(self, action):
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return action(index)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(worker, range(2)))

    def test_parallel_duplicate_creates_one_private_record(self):
        statuses = self.parallel(lambda _: APIClient().post(
            "/api/feedback/", {"type": "other", "description": "同时提交同一条反馈。"}, format="json"
        ).status_code)
        self.assertEqual(statuses, [202, 202])
        self.assertEqual(Feedback.objects.count(), 1)

    @override_settings(FEEDBACK_RATE_PER_HOUR=1)
    def test_parallel_submissions_cannot_exceed_rate_limit(self):
        statuses = self.parallel(lambda i: APIClient().post(
            "/api/feedback/", {"type": "other", "description": f"不同反馈 {i}"}, format="json"
        ).status_code)
        self.assertEqual(sorted(statuses), [202, 429])
        self.assertEqual(Feedback.objects.count(), 1)

    def test_parallel_review_rejects_one_stale_version(self):
        admin = User.objects.create_superuser("feedback_admin", "admin@example.test", "Atlas-admin-5938!")
        item = Feedback.objects.create(type="other", description="等待核查。")

        def review(index):
            try:
                review_feedback(item.pk, actor=User.objects.get(pk=admin.pk), expected_version=1,
                                status="resolved", review_note=f"处理记录 {index}", issue_url="")
                return "saved"
            except ValidationError:
                return "stale"

        self.assertEqual(sorted(self.parallel(review)), ["saved", "stale"])
        self.assertEqual(FeedbackReview.objects.count(), 1)
        item.refresh_from_db()
        self.assertEqual(item.version, 2)
