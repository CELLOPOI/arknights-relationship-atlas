import hashlib
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.source_data import (
    canonical_data,
    compare_data,
    digest,
    json_bytes,
    read_json,
    snapshot_data,
    write_source,
)


class Command(BaseCommand):
    help = "Build the first Git source from a reviewed database export and preserved legacy snapshot."

    def add_arguments(self, parser):
        parser.add_argument("--export", dest="export_path", type=Path, required=True)
        parser.add_argument("--snapshot", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--reviewed-differences-digest")

    def handle(self, *args, **options):
        try:
            database = canonical_data(read_json(options["export_path"]))
            snapshot = snapshot_data(options["snapshot"])
            differences = compare_data(snapshot, database)
            if differences and options["reviewed_differences_digest"] != digest(differences):
                raise CommandError(
                    "Database differs from the legacy snapshot. Review the export differences first; "
                    f"then supply --reviewed-differences-digest {digest(differences)} to retain database edits."
                )
            source = {**database, "conditional": snapshot["conditional"], "provenance": snapshot["provenance"]}
            inputs = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(options["snapshot"].glob("*.json"))}
            report = read_json(options["snapshot"] / "report.json")
            metadata = {
                "origin": "reviewed-database-export-and-legacy-snapshot",
                "database_export_digest": digest(database), "legacy_snapshot_files": inputs,
                "review_version": report["reviewVersion"], "differences_count": len(differences),
                "reviewed_differences_digest": digest(differences),
            }
            write_source(source, options["output"], metadata=metadata)
        except (ValidationError, KeyError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json_bytes({"data_digest": digest(canonical_data(source)), **metadata}).decode())
