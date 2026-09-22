from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from atlas.source_data import compare_data, digest, export_database, json_bytes, snapshot_data


class Command(BaseCommand):
    help = "Export formal data only and compare against an existing snapshot without changing the database."

    def add_arguments(self, parser):
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--snapshot", type=Path)

    def handle(self, *args, **options):
        output = options["output"]
        if output.exists():
            raise CommandError("Output already exists; choose a new export directory.")
        if connection.in_atomic_block:
            raise CommandError("Export requires its own read-only transaction; do not call it inside atomic().")
        try:
            with transaction.atomic():
                if connection.vendor == "postgresql":
                    with connection.cursor() as cursor:
                        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                data = export_database()
            differences = compare_data(snapshot_data(options["snapshot"]), data) if options["snapshot"] else None
        except ValidationError as exc:
            raise CommandError(str(exc)) from exc
        summary = {"data_digest": digest(data), "counts": {k: len(v) for k, v in data.items() if isinstance(v, list)}}
        output.mkdir(parents=True, mode=0o700)
        (output / "formal-data.json").write_bytes(json_bytes(data))
        if differences is not None:
            (output / "differences.json").write_bytes(json_bytes(differences))
            summary["differences"] = len(differences)
        (output / "summary.json").write_bytes(json_bytes(summary))
        self.stdout.write(json_bytes(summary).decode())
