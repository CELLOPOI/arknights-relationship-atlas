import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from pathlib import Path
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.core.management import call_command
from django.db import DatabaseError, close_old_connections, connection, connections
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .admin_site import login_wait
from .models import User
from .ops_models import AdminLoginGuard
from .release_models import ReleaseState
from .source_data import export_database
from .test_releasing import TEST_ASSET_VERSION, legacy_fixture, package_for, publish


class OperationsTests(TestCase):
    def test_readiness_requires_release_and_matching_assets(self):
        legacy_fixture()
        self.assertEqual(self.client.get("/api/ready/").json()["reason"], "data_release_missing")
        publish(package_for(export_database()))
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "assets.json"
            manifest.write_text(json.dumps({"version": TEST_ASSET_VERSION}))
            with override_settings(ASSET_MANIFEST_PATH=str(manifest)):
                self.assertEqual(self.client.get("/api/ready/").json()["status"], "ready")
                manifest.write_text(json.dumps({"version": "different-assets"}))
                self.assertEqual(self.client.get("/api/ready/").status_code, 503)
                self.assertEqual(self.client.get("/api/ready/").json()["reason"], "asset_version_mismatch")

    def test_readiness_handles_missing_migrations_and_unavailable_database(self):
        with patch("atlas.ops_views.MigrationExecutor") as executor:
            executor.return_value.migration_plan.return_value = ["pending"]
            self.assertEqual(self.client.get("/api/ready/").json()["reason"], "migrations_pending")
        with patch("atlas.ops_views.readiness", side_effect=DatabaseError("private connection details")):
            response = self.client.get("/api/ready/")
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private", response.content.decode())

    @override_settings(ADMIN_LOGIN_IP_LIMIT=3, ADMIN_LOGIN_ACCOUNT_LIMIT=2)
    def test_admin_login_is_csrf_protected_and_limited_without_blocking_public_reading(self):
        User.objects.create_superuser("maintainer", "admin@example.test", "Password-5938!")
        csrf_client = APIClient(enforce_csrf_checks=True)
        response = csrf_client.post("/admin/login/", {"username": "maintainer", "password": "wrong"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(AdminLoginGuard.objects.count(), 0)
        client = APIClient()
        for _ in range(2):
            self.assertEqual(client.post("/admin/login/", {"username": "maintainer", "password": "wrong"}).status_code, 200)
        response = client.post("/admin/login/", {"username": "maintainer", "password": "Password-5938!"})
        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response)
        self.assertEqual(client.get("/api/session/").status_code, 200)
        self.assertEqual(client.get("/admin/login/").status_code, 200)
        # 其他来源不因一个来源的错误尝试而被锁定账号。
        response = client.post("/admin/login/", {"username": "maintainer", "password": "Password-5938!"},
                               REMOTE_ADDR="192.0.2.2")
        self.assertEqual(response.status_code, 302)

    def test_expired_login_identifiers_are_removed(self):
        now = timezone.now()
        AdminLoginGuard.objects.create(key="a" * 64, window_started=now - timedelta(hours=1),
                                       expires_at=now - timedelta(minutes=1), count=3)
        AdminLoginGuard.objects.create(key="b" * 64, window_started=now,
                                       expires_at=now + timedelta(minutes=15), count=1)
        call_command("purge_private_records", stdout=StringIO())
        self.assertEqual(list(AdminLoginGuard.objects.values_list("key", flat=True)), ["b" * 64])


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locking")
@override_settings(ADMIN_LOGIN_IP_LIMIT=1, ADMIN_LOGIN_ACCOUNT_LIMIT=1)
class LoginConcurrencyTests(TransactionTestCase):
    def test_concurrent_login_attempts_cannot_bypass_limit(self):
        ReleaseState.objects.get_or_create(pk=1)
        barrier = Barrier(2)

        def attempt():
            close_old_connections()
            try:
                request = RequestFactory().post("/admin/login/", {"username": "maintainer"})
                barrier.wait(timeout=10)
                return login_wait(request)
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(attempt) for _ in range(2)]
            waits = [future.result(timeout=20) for future in futures]
        self.assertEqual(sum(wait == 0 for wait in waits), 1)
