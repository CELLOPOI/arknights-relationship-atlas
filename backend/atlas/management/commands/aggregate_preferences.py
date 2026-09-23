from django.core.management.base import BaseCommand, CommandError
from django.utils.dateparse import parse_datetime

from atlas.preference_services import PreferenceError, control
from atlas.preference_statistics import aggregate


class Command(BaseCommand):
    help = "Aggregate actual preference records; schedule at least every 15 minutes, retaining daily snapshots."

    def add_arguments(self, parser):
        parser.add_argument("--cutoff")
        parser.add_argument("--catalog-version", help="Use a published historical catalog without replacing old snapshots.")
        parser.add_argument("--revise", action="store_true")
        parser.add_argument("--reason", default="")

    def handle(self, *args, **options):
        cutoff = parse_datetime(options["cutoff"]) if options["cutoff"] else None
        if options["cutoff"] and (cutoff is None or cutoff.tzinfo is None):
            raise CommandError("Cutoff must be an ISO timestamp with timezone.")
        try:
            snapshots = aggregate(cutoff, reason=options["reason"], catalog_version=options["catalog_version"],
                                  force_revision=options["revise"])
        except Exception as exc:
            current = control()
            current.aggregation_error = exc.code if isinstance(exc, PreferenceError) else type(exc).__name__
            current.save(update_fields=["aggregation_error"])
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"Saved {len(snapshots)} snapshots.")
