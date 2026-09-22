import json

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from atlas.feedback_services import purge_feedback


class Command(BaseCommand):
    help = "Delete expired private feedback, contact details and short-lived abuse prevention records."

    def add_arguments(self, parser):
        parser.add_argument("--now", help="ISO 8601 timestamp with timezone; defaults to current time.")

    def handle(self, *args, **options):
        now = None
        if options["now"]:
            try:
                now = parse_datetime(options["now"])
            except ValueError as exc:
                raise CommandError("--now must be an ISO 8601 timestamp with timezone.") from exc
            if now is None or timezone.is_naive(now):
                raise CommandError("--now must be an ISO 8601 timestamp with timezone.")
        self.stdout.write(json.dumps(purge_feedback(now=now), sort_keys=True))
