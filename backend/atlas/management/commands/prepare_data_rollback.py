from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.releasing import prepare_rollback, validate_package
from atlas.source_data import digest, load_source, read_json, write_source


class Command(BaseCommand):
    help = "Prepare reviewable rollback source after Git revert, preserving added IDs as withdrawn records."

    def add_arguments(self, parser):
        parser.add_argument("--source", type=Path, required=True, help="Desired source after Git revert.")
        parser.add_argument("--current-package", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)

    def handle(self, *args, **options):
        try:
            desired, manifest = load_source(options["source"])
            current = read_json(options["current_package"])
            validate_package(current)
            data = prepare_rollback(desired, current["data"])
            write_source(data, options["output"], metadata={**manifest["metadata"],
                         "rollback_of": current["manifest"]["release_id"], "rollback_package_digest": digest(current)})
        except ValidationError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write("Prepared rollback source. Review and commit it, then build a new release version.")
