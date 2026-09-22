"""Bind data publication to the selected local resource inventory."""

from django.conf import settings
from django.core.exceptions import ValidationError

from .resource_manifest import validate_manifest
from .source_data import read_json


def validate_release_assets(package, manifest_path=None):
    try:
        manifest = validate_manifest(read_json(manifest_path or settings.ASSET_MANIFEST_PATH))
    except (ValueError, ValidationError) as exc:
        raise ValidationError("Resource manifest is missing or invalid; restore the reviewed resource inventory.") from exc
    if manifest["version"] != package["manifest"]["asset_version"]:
        raise ValidationError("Release asset version does not match the selected resource manifest.")
    paths = {"/" + row["path"] for row in manifest["files"]} | {"/avatars/unknown.svg"}
    # 通用头像随前端代码提供；正式指定的头像必须来自配套素材，不能上线后才发现断链。
    missing = [row["id"] for row in package["data"]["people"]
               if row["published"] and row["avatar"] and row["avatar"] not in paths]
    if missing:
        raise ValidationError("Published people reference avatars absent from the resource package: " + ", ".join(missing))
    return manifest
