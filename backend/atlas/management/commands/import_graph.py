import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.importing import import_bundle


class Command(BaseCommand):
    help = "Validate and import a graph/evidence snapshot atomically."

    def add_arguments(self, parser):
        parser.add_argument("--data", type=Path, required=True)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--update-existing", action="store_true")

    def handle(self, *args, **options):
        try:
            directory = options["data"]
            graph = json.loads((directory / "graph.json").read_text())
            evidence = json.loads((directory / "evidence.json").read_text())
            result = import_bundle(
                graph, evidence, dry_run=options["dry_run"], update_existing=options["update_existing"]
            )
        except (ValidationError, OSError, ValueError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))
