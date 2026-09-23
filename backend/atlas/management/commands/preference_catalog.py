"""导入草稿、审核、预览及发布喜好名录；发布必须带已审阅的预览文件。"""
import json
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from atlas.preference_editorial import create_catalog, preview_catalog, publish_catalog, review_catalog
from atlas.preference_services import PreferenceError


class Command(BaseCommand):
    help = "Manage reviewed preference catalogs without changing formal character data."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["draft", "approve", "reject", "preview", "publish"])
        parser.add_argument("--actor", required=True)
        parser.add_argument("--file")
        parser.add_argument("--catalog-version")
        parser.add_argument("--reason", default="")
        parser.add_argument("--preview")

    def handle(self, *args, **options):
        try:
            actor = get_user_model().objects.get(username=options["actor"])
            action = options["action"]
            if action == "draft":
                result = create_catalog(json.loads(Path(options["file"]).read_text()), actor, options["reason"])
                self.stdout.write(result.pk)
            elif action in ("approve", "reject"):
                review_catalog(options["catalog_version"], actor, options["reason"], action == "approve")
                self.stdout.write("Catalog reviewed.")
            elif action == "preview":
                result = preview_catalog(options["catalog_version"], actor)
                with Path(options["preview"]).open("x") as target:
                    json.dump(result, target, ensure_ascii=False, indent=2)
                self.stdout.write("Preview written; review changes before publication.")
            else:
                preview = json.loads(Path(options["preview"]).read_text())
                publish_catalog(options["catalog_version"], preview["token"], actor)
                self.stdout.write("Catalog published atomically.")
        except (PreferenceError, OSError, ValueError, TypeError, get_user_model().DoesNotExist) as exc:
            raise CommandError(str(exc)) from exc
