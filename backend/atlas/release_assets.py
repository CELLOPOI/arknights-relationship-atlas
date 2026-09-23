"""Bind data publication to the selected local resource inventory."""

import hashlib
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError

from .resource_manifest import validate_manifest
from .source_data import read_json


def preference_avatar_assets(data):
    urls = {p["avatar"] for p in data["people"] if p["published"]
            and p["avatar"].startswith("/assets/preferences/")}
    if not urls:
        return None
    manifest = read_json(settings.PREFERENCE_MANIFEST_PATH)
    files = {row["path"]: row for row in manifest["files"]}
    root = Path(settings.PREFERENCE_ASSET_ROOT).resolve()
    selected = {}
    for url in sorted(urls):
        relative = url.removeprefix("/assets/preferences/")
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or relative not in files:
            raise ValidationError("Supplementary avatar is absent from the fixed preference inventory.")
        try:
            raw = target.read_bytes()
        except OSError as exc:
            raise ValidationError("Supplementary avatar is unavailable.") from exc
        row = files[relative]
        if len(raw) != row["bytes"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValidationError("Supplementary avatar failed its fixed hash check.")
        selected[url] = row["sha256"]
    return {"version": manifest["version"], "files": selected}


def validate_release_assets(package, manifest_path=None):
    try:
        manifest = validate_manifest(read_json(manifest_path or settings.ASSET_MANIFEST_PATH))
    except (ValueError, ValidationError) as exc:
        raise ValidationError("Resource manifest is missing or invalid; restore the reviewed resource inventory.") from exc
    if manifest["version"] != package["manifest"]["asset_version"]:
        raise ValidationError("Release asset version does not match the selected resource manifest.")
    paths = {"/" + row["path"] for row in manifest["files"]} | {"/avatars/unknown.svg"}
    supplementary = preference_avatar_assets(package["data"])
    if supplementary:
        paths.update(supplementary["files"])
    expected = package["manifest"].get("preference_avatar_assets")
    if expected is not None and expected != supplementary:
        raise ValidationError("Supplementary avatars no longer match the reviewed release.")
    # 通用头像随前端代码提供；正式指定的头像必须来自配套素材，不能上线后才发现断链。
    missing = [row["id"] for row in package["data"]["people"]
               if row["published"] and row["avatar"] and row["avatar"] not in paths]
    if missing:
        raise ValidationError("Published people reference avatars absent from the resource package: " + ", ".join(missing))
    return manifest
