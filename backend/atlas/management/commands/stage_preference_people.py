"""把已冻结的人物补录送入既有资料修订草稿，不绕过审核发布。"""
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from atlas.editorial_services import add_record, create_change_set, save_record
from atlas.release_models import ReleaseState
from atlas.source_data import KEYS, read_json


class Command(BaseCommand):
    help = "Stage missing preference people and identities for ordinary editorial review."

    def add_arguments(self, parser):
        parser.add_argument("--actor", required=True)
        parser.add_argument("--file", type=Path, required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        try:
            actor = get_user_model().objects.get(username=options["actor"])
            payload = read_json(options["file"])
            baseline = ReleaseState.objects.select_related("current").get(pk=1).current.formal_snapshot
            missing = []
            for section in ("people", "identities"):
                existing = {row[KEYS[section]]: row for row in baseline[section]}
                for proposed in payload[section]:
                    key = proposed[KEYS[section]]
                    if key in existing:
                        if section == "identities" and existing[key]["person_id"] != proposed["person_id"]:
                            raise ValidationError(f"Identity {key} belongs to another stable person; resolve before staging.")
                        continue
                    missing.append((section, key, proposed))
            if not missing:
                self.stdout.write("No missing records; existing formal data preserved.")
                return
            batch = create_change_set(actor=actor, title=payload["title"], description=payload["description"])
            for section, key, proposed in missing:
                batch.refresh_from_db()
                item = add_record(batch.pk, actor=actor, expected_version=batch.version, section=section, new_id=key)
                batch.refresh_from_db()
                save_record(item.pk, actor=actor, expected_version=item.version,
                            expected_change_set_version=batch.version, proposed=proposed,
                            private_note=payload.get("review_note", ""))
            self.stdout.write(f"Draft {batch.pk}: {len(missing)} records; review, preview and publish in the editorial workflow.")
        except (ValidationError, OSError, ValueError, KeyError, get_user_model().DoesNotExist,
                ReleaseState.DoesNotExist) as exc:
            raise CommandError(str(exc)) from exc
