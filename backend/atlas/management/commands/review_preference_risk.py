from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from atlas.preference_editorial import review_risk, revise_snapshots
from atlas.preference_services import PreferenceError


class Command(BaseCommand):
    help = "Audit a risk decision and create corrected snapshots within the retained detail window."

    def add_arguments(self, parser):
        parser.add_argument("participant")
        parser.add_argument("--status", choices=["accepted", "pending", "excluded"], required=True)
        parser.add_argument("--actor", required=True)
        parser.add_argument("--reason", required=True)

    def handle(self, *args, **options):
        try:
            actor = get_user_model().objects.get(username=options["actor"])
            revision = review_risk(options["participant"], options["status"], actor, options["reason"])
            count = revise_snapshots(actor, options["reason"])
            self.stdout.write(f"Risk revision {revision}; corrected {count} cutoffs.")
        except (PreferenceError, get_user_model().DoesNotExist) as exc:
            raise CommandError(str(exc)) from exc
