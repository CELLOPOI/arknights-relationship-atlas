"""Shared standard-library resource manifest contract for packaging and publication."""

import hashlib
import json
from pathlib import PurePosixPath

RESOURCE_DIRS = ("assets", "avatars", "illustrations")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def valid_path(value):
    path = PurePosixPath(value)
    return (isinstance(value, str) and "\\" not in value and not path.is_absolute()
            and all(part not in ("", ".", "..") for part in value.split("/"))
            and (value == "favicon.svg" or path.parts[0] in RESOURCE_DIRS))


def validate_manifest(manifest):
    if (not isinstance(manifest, dict) or set(manifest) != {"schema_version", "version", "rights_status", "files"}
            or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1
            or manifest["rights_status"] not in ("unreviewed", "cleared", "limited")
            or not isinstance(manifest["files"], list) or not manifest["files"]):
        raise ValueError("Invalid resource manifest")
    seen = set()
    for record in manifest["files"]:
        if (not isinstance(record, dict) or set(record) != {"path", "bytes", "sha256"}
                or not isinstance(record["path"], str) or not valid_path(record["path"])
                or type(record["bytes"]) is not int or not 0 <= record["bytes"] <= 2**53 - 1
                or not isinstance(record["sha256"], str) or len(record["sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in record["sha256"])):
            raise ValueError("Invalid resource record")
        if record["path"] in seen:
            raise ValueError("Duplicate resource path")
        seen.add(record["path"])
    if "favicon.svg" not in seen or any(not any(p.startswith(name + "/") for p in seen) for name in RESOURCE_DIRS):
        raise ValueError("Resource manifest is incomplete")
    if manifest["version"] != "atlas-assets-" + sha(canonical(manifest["files"]))[:24]:
        raise ValueError("Resource version does not match file inventory")
    return manifest
