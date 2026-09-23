from django.core.management.base import BaseCommand

from atlas.preference_editorial import purge


class Command(BaseCommand):
    help = "Purge expired preference details and risk signals while preserving current registrations and snapshots."

    def handle(self, *args, **options):
        self.stdout.write(str(purge()))
