from django.core.management.base import BaseCommand
from django.utils import timezone

from atlas.feedback_services import purge_feedback
from atlas.ops_models import AdminLoginGuard
from atlas.source_data import json_bytes


class Command(BaseCommand):
    help = "Remove expired feedback/contact/rate-limit records according to the configured retention policy."

    def handle(self, *args, **options):
        now = timezone.now()
        summary = purge_feedback(now=now)
        summary["admin_login_guards_deleted"], _ = AdminLoginGuard.objects.filter(expires_at__lte=now).delete()
        self.stdout.write(json_bytes(summary).decode())
