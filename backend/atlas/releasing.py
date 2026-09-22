"""受控资料发布：全局发布行锁、带基线的预览、差异审计和原子应用。"""

import re
from pathlib import PurePosixPath

from django.conf import settings
from django.core import signing
from django.core.exceptions import ValidationError
from django.db import transaction

from .models import Evidence, Identity, Relationship
from .release_assets import validate_release_assets
from .release_models import DataRelease, ReleaseState
from .services import record_revision, snapshot
from .source_data import (
    FIELDS,
    KEYS,
    MODELS,
    canonical_data,
    compare_data,
    compile_graph,
    digest,
    evidence_id,
    export_database,
    source_records,
    validate_data,
)

PREVIEW_SALT = "atlas-data-release-preview-v1"


def formal_data(data):
    return {"schema_version": data["schema_version"], **{key: data[key] for key in FIELDS},
            "conditional": [], "provenance": {}}


def build_package(compiled, *, release_id, git_commit, expected_previous, asset_version, dirty=False,
                  source_path="data/source"):
    manifest = {
        **compiled["manifest"], "release_id": release_id, "git_commit": git_commit,
        "expected_previous": expected_previous, "asset_version": asset_version, "working_tree_dirty": dirty,
        "source_path": source_path,
    }
    package = {"manifest": manifest, "data": compiled["data"], "graph": compiled["graph"]}
    validate_package(package)
    return package


def validate_package(package):
    if not isinstance(package, dict) or set(package) != {"manifest", "data", "graph"}:
        raise ValidationError("Invalid release package fields.")
    manifest = package["manifest"]
    fields = {"schema_version", "files", "source_digest", "metadata", "data_digest", "graph_digest", "counts",
              "release_id", "git_commit", "expected_previous", "asset_version", "working_tree_dirty", "source_path"}
    if not isinstance(manifest, dict) or set(manifest) != fields:
        raise ValidationError("Invalid release manifest fields.")
    version_pattern = r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}"
    for key in ("release_id", "asset_version"):
        if not isinstance(manifest[key], str) or not re.fullmatch(version_pattern, manifest[key]):
            raise ValidationError(f"Invalid {key}.")
    previous = manifest["expected_previous"]
    if previous is not None and (not isinstance(previous, str) or not re.fullmatch(version_pattern, previous)):
        raise ValidationError("Invalid expected previous release.")
    if previous == manifest["release_id"]:
        raise ValidationError("A release cannot be its own previous version.")
    if not isinstance(manifest["git_commit"], str) or not re.fullmatch(r"[0-9a-f]{40}", manifest["git_commit"]):
        raise ValidationError("Release requires a full Git commit hash.")
    if type(manifest["working_tree_dirty"]) is not bool:
        raise ValidationError("Invalid working tree state.")
    source_path = manifest["source_path"]
    if (not isinstance(source_path, str) or not source_path or PurePosixPath(source_path).is_absolute()
            or any(p in ("..", ".") for p in source_path.split("/")) or "\\" in source_path):
        raise ValidationError("Invalid source path.")
    validate_data(package["data"])
    files = manifest["files"]
    if not isinstance(files, dict) or not files or any(
        not isinstance(k, str) or not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v)
        for k, v in files.items()
    ):
        raise ValidationError("Invalid source file inventory.")
    canonical = canonical_data(package["data"])
    if (type(manifest["schema_version"]) is not int
            or manifest["schema_version"] != canonical["schema_version"]
            or not isinstance(manifest["metadata"], dict)
            or files != {name: digest(row) for name, row in source_records(canonical, manifest["metadata"]).items()}
            or manifest["source_digest"] != digest(files)
            or manifest["data_digest"] != digest(canonical)
            or manifest["graph_digest"] != digest(package["graph"])
            or package["graph"] != compile_graph(canonical)
            or not isinstance(manifest["counts"], dict)
            or any(type(v) is not int for v in manifest["counts"].values())
            or manifest["counts"] != {k: len(v) for k, v in canonical.items() if k != "schema_version"}):
        raise ValidationError("Release content does not match its manifest.")


def _current_snapshot(state):
    actual = export_database()
    if state.current_id:
        drift = compare_data(state.current.formal_snapshot, actual)
        if drift:
            raise ValidationError({"drift": [f"{x['section']}:{x['id']}" for x in drift]})
    return actual


def release_changes(before, after):
    changes = compare_data(before, after)
    for change in changes:
        old, new = change["before"], change["after"]
        if new is None:
            # 撤下必须显式保留 ID；包括证据和身份也不能因文件遗漏而消失。
            raise ValidationError(f"Missing record: {change['section']}:{change['id']}; use explicit withdrawal.")
        change["action"] = "add" if old is None else "update"
        if old and "published" in old and old["published"] != new["published"]:
            change["action"] = "republish" if new["published"] else "withdraw"
        if old and change["section"] == "relationships" and any(
            old[k] != new[k] for k in ("person_a_id", "person_b_id")
        ):
            raise ValidationError("A stable relationship ID cannot change its endpoints.")
        if old and change["section"] == "evidence" and old["relationship_id"] != new["relationship_id"]:
            raise ValidationError("A stable evidence ID cannot move to a different relationship.")
    return changes


def prepare_rollback(desired, current):
    """Git revert 后保留新增 ID，将其显式撤下；历史条件资料仍保留用于追溯。"""
    desired, current = canonical_data(desired), canonical_data(current)
    result = {**desired}
    for section in FIELDS:
        key = KEYS[section]
        records = {row[key]: row for row in desired[section]}
        for row in current[section]:
            if row[key] not in records:
                records[row[key]] = {**row, **({"published": False} if "published" in row else {})}
        result[section] = list(records.values())
    conditionals = {row["key"]: row for row in current["conditional"]}
    conditionals.update({row["key"]: row for row in desired["conditional"]})
    result["conditional"] = list(conditionals.values())
    result["provenance"] = {**current["provenance"], **desired["provenance"]}
    return canonical_data(result)


def narrative_changes(state, data):
    previous = state.current.narratives if state.current_id else {"conditional": [], "provenance": {}}
    changes = []
    for section in ("conditional", "provenance"):
        old = {r["key"]: r for r in previous[section]} if section == "conditional" else previous[section]
        new = {r["key"]: r for r in data[section]} if section == "conditional" else data[section]
        for key in sorted(old.keys() | new.keys()):
            if key not in new:
                raise ValidationError(f"Missing narrative record: {section}:{key}; retain the source record.")
            if old.get(key) != new[key]:
                changes.append({"section": section, "id": key, "before": old.get(key), "after": new[key],
                                "action": "add" if key not in old else "update"})
    return changes


@transaction.atomic
def preview_release(package):
    validate_package(package)
    # singleton 由迁移建立；即使空库首次发布也必须争用同一把锁。
    state = ReleaseState.objects.select_for_update().get(pk=1)
    if state.authority == "database":
        raise ValidationError("正式资料已由后台管理，请在后台创建修订；Git 快照不能覆盖已发布资料。")
    before = _current_snapshot(state)
    manifest = package["manifest"]
    existing = DataRelease.objects.filter(pk=manifest["release_id"]).first()
    token = signing.dumps({"package_digest": digest(package), "base_digest": digest(before),
                           "current_release": state.current_id}, salt=PREVIEW_SALT)
    if existing:
        if state.current_id != existing.pk or existing.package_digest != digest(package):
            raise ValidationError("Release ID already exists with different contents or has been superseded.")
        if not settings.DEBUG:
            validate_release_assets(package)
        return {"already_applied": True, "release_id": existing.pk, "changes": [], "preview_token": token}
    if manifest["expected_previous"] != state.current_id:
        raise ValidationError("Expected previous release does not match the database.")
    if not settings.DEBUG:
        validate_release_assets(package)
    changes = release_changes(before, formal_data(package["data"])) + narrative_changes(state, package["data"])
    return {"release_id": manifest["release_id"], "current_release": state.current_id,
            "package_digest": digest(package), "base_digest": digest(before), "changes": changes,
            "preview_token": token}


def _persist_rows(data, changes, actor, reason):
    indexes = {section: {row[KEYS[section]]: row for row in data[section]} for section in FIELDS}
    changed = {(row["section"], row["id"]) for row in changes}
    affected_relationships = set()
    evidence_rows = {evidence_id(e): e for e in Evidence.objects.all()}
    for section in FIELDS:
        for key, row in indexes[section].items():
            # 证据源 ID 首次绑定可以没有内容差异，但仍需持久化，防止新库自增键变化。
            if (section, key) not in changed and section != "evidence":
                continue
            if section == "evidence":
                obj = evidence_rows.get(key)
                if obj and obj.source_id == key and (section, key) not in changed:
                    continue
                before = snapshot(obj) if obj else {}
                values = {k: v for k, v in row.items() if k != "id"}
                if obj is None:
                    obj = Evidence(**values, source_id=key)
                else:
                    for field, value in values.items():
                        setattr(obj, field, value)
                    obj.source_id = key
                obj.full_clean()
                if (section, key) in changed or before.get("source_id") != key:
                    obj.save()
                    record_revision(obj, actor, before, reason)
                if (section, key) in changed:
                    affected_relationships.add(row["relationship_id"])
                continue
            model = MODELS[section]
            obj = (Identity.objects.filter(external_id=key).first() if section == "identities"
                   else model.objects.filter(pk=key).first())
            before = snapshot(obj) if obj else {}
            if obj is None:
                obj = model(**row)
            else:
                for field, value in row.items():
                    setattr(obj, field, value)
                if hasattr(obj, "version"):
                    obj.version += 1
            obj.full_clean()
            obj.save()
            record_revision(obj, actor, before, reason)
    for key in affected_relationships:
        if ("relationships", key) not in changed:
            obj = Relationship.objects.get(pk=key)
            before = snapshot(obj)
            obj.version += 1
            obj.save(update_fields=["version", "updated_at"])
            record_revision(obj, actor, before, reason)


@transaction.atomic
def apply_release(package, preview_token, *, actor=None):
    validate_package(package)
    if not settings.DEBUG and package["manifest"]["working_tree_dirty"]:
        raise ValidationError("Production cannot apply a package built from uncommitted work.")
    try:
        preview = signing.loads(preview_token, salt=PREVIEW_SALT, max_age=3600)
    except (signing.BadSignature, TypeError) as exc:
        raise ValidationError("Invalid or expired release preview; preview again.") from exc
    if not isinstance(preview, dict) or preview.get("package_digest") != digest(package):
        raise ValidationError("Release package changed after preview.")
    if not settings.DEBUG:
        validate_release_assets(package)
    state = ReleaseState.objects.select_for_update().get(pk=1)
    if state.authority == "database":
        raise ValidationError("正式资料已由后台管理，请在后台创建修订；Git 快照不能覆盖已发布资料。")
    before = _current_snapshot(state)
    manifest = package["manifest"]
    existing = DataRelease.objects.filter(pk=manifest["release_id"]).first()
    if existing:
        if existing.package_digest == digest(package) and state.current_id == existing.pk:
            return {"already_applied": True, "release_id": existing.pk}
        raise ValidationError("Release ID already exists with different contents or has been superseded.")
    if (manifest["expected_previous"] != state.current_id
            or preview.get("current_release") != state.current_id or preview.get("base_digest") != digest(before)):
        raise ValidationError("Database baseline changed after preview; preview again.")
    expected = formal_data(package["data"])
    changes = release_changes(before, expected) + narrative_changes(state, package["data"])
    _persist_rows(package["data"], changes, actor, f"release:{manifest['release_id']}")
    if compare_data(expected, export_database()):
        raise ValidationError("Post-apply data does not match the release package.")
    release = DataRelease.objects.create(id=manifest["release_id"], package_digest=digest(package),
                                         manifest=manifest, formal_snapshot=expected,
                                         narratives={k: package["data"][k] for k in ("conditional", "provenance")},
                                         changes=[{k: row[k] for k in ("section", "id", "action")} for row in changes],
                                         previous_id=state.current_id, actor=actor)
    state.current = release
    state.save(update_fields=["current"])
    return {"release_id": release.pk, "changes": len(changes), "already_applied": False}
