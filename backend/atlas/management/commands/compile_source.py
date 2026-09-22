from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.source_data import compile_source, json_bytes


class Command(BaseCommand):
    help = "Validate and deterministically compile Git source data without accessing the database."

    def add_arguments(self, parser):
        parser.add_argument("--source", type=Path, default=Path("data/source"))
        parser.add_argument("--output", type=Path)

    def handle(self, *args, **options):
        try:
            result = compile_source(options["source"])
        except ValidationError as exc:
            raise CommandError(str(exc)) from exc
        output = options["output"]
        if output:
            if output.exists():
                raise CommandError("Output already exists; choose a new build directory.")
            output.mkdir(parents=True)
            for name, value in result.items():
                (output / f"{name}.json").write_bytes(json_bytes(value))
        self.stdout.write(json_bytes({k: result["manifest"][k] for k in ("source_digest", "data_digest", "counts")}).decode())
