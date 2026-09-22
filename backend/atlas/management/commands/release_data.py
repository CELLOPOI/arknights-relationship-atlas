from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from atlas.releasing import apply_release, preview_release
from atlas.source_data import json_bytes, read_json


class Command(BaseCommand):
    help = "Preview or atomically apply a versioned data package. Data rollback uses a new release after Git revert."

    def add_arguments(self, parser):
        parser.add_argument("--package", type=Path, required=True)
        operation = parser.add_mutually_exclusive_group(required=True)
        operation.add_argument("--preview", type=Path, help="Write a signed preview to a new local file.")
        operation.add_argument("--apply", type=Path, help="Apply using the saved preview file.")

    def handle(self, *args, **options):
        try:
            package = read_json(options["package"])
            if options["preview"]:
                output = options["preview"]
                if output.exists():
                    raise CommandError("Preview output already exists; choose a new file.")
                result = preview_release(package)
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open("xb") as file:
                    output.chmod(0o600)
                    file.write(json_bytes(result))
                result = {k: v for k, v in result.items() if k not in ("preview_token", "changes")}
                result["preview_file"] = str(output)
            else:
                preview = read_json(options["apply"])
                if not isinstance(preview, dict) or not isinstance(preview.get("preview_token"), str):
                    raise CommandError("Preview does not contain an application token; preview the package again.")
                result = apply_release(package, preview["preview_token"])
        except (ValidationError, OSError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json_bytes(result).decode())
