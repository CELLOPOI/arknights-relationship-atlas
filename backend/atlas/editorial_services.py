"""资料修订、审核、发布与回退；锁顺序为发布状态、修订、条目、反馈。"""

import copy
import io
import uuid
import zipfile

from django.conf import settings
from django.core import signing
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .candidate_models import Candidate, CandidateEdit
from .candidate_services import baseline_data, locked_baseline
from .editorial_models import ChangeSet, ChangeSetEvent
from .feedback_models import Feedback
from .feedback_services import review_feedback
from .release_assets import preference_avatar_assets, validate_release_assets
from .release_models import DataRelease, ReleaseState
from .releasing import _persist_rows, formal_data, narrative_changes, prepare_rollback, release_changes
from .resource_manifest import validate_manifest
from .source_data import (
    FIELDS,
    KEYS,
    MODELS,
    SECTIONS,
    canonical_data,
    compare_data,
    compile_graph,
    digest,
    export_database,
    json_bytes,
    read_json,
    source_records,
)

PREVIEW_SALT = "atlas-editorial-preview-v1"


def require(actor, action):
    if not actor.is_active or not actor.is_staff or not actor.has_perm(f"atlas.{action}_changeset"):
        raise PermissionDenied("需要相应的资料修订权限。")


def event(batch, actor, action, detail=None):
    ChangeSetEvent.objects.create(change_set=batch, actor=actor, action=action,
                                  version=batch.version, detail=detail or {})


def touch(batch, actor, action, detail=None):
    batch.version += 1
    batch.updated_by = actor
    batch.save()
    event(batch, actor, action, detail)


def locked_batch(pk, version, *, check_base=True):
    release = locked_baseline()
    batch = ChangeSet.objects.select_for_update(of=("self",)).select_related("base_release", "rollback_target").get(pk=pk)
    if type(version) is not int or version != batch.version:
        raise ValidationError("修订已被其他维护者更新，请重新打开核对后再操作。")
    if check_base and batch.base_release_id != release.pk:
        raise ValidationError("正式资料已发布新版本，请先更新修订基线，再重新审核。")
    return batch, release


def require_draft(batch):
    if batch.status != "draft":
        raise ValidationError("只有草稿可以编辑；请先退回草稿。")


def batch_data(batch, *, validate=True):
    data = baseline_data(batch.base_release)
    if batch.rollback_target_id:
        return prepare_rollback(baseline_data(batch.rollback_target), data)
    for item in batch.records.filter(included=True).order_by("pk"):
        key = KEYS[item.section]
        data[item.section] = [row for row in data[item.section] if row[key] != item.record_id]
        data[item.section].append(copy.deepcopy(item.proposed))
    return canonical_data(data) if validate else data


def current_asset_version():
    try:
        return validate_manifest(read_json(settings.ASSET_MANIFEST_PATH))["version"]
    except (ValueError, ValidationError) as exc:
        raise ValidationError("素材清单不可用，请先恢复正确的资源清单。") from exc


def reviewed_digest(data):
    supplementary = preference_avatar_assets(data)
    return digest({"data": data, "preference_avatar_assets": supplementary}) if supplementary else digest(data)


def checked_data(batch):
    data = batch_data(batch)
    changes = release_changes(batch.base_release.formal_snapshot, formal_data(data))
    state = ReleaseState(current=batch.base_release)
    changes += narrative_changes(state, data)
    # 确认素材可用，再进入审核。原文、方向和条件叙事由共同 schema 检查。
    asset_version = batch.asset_version if batch.status == "approved" else current_asset_version()
    if not changes and asset_version == batch.base_release.manifest["asset_version"]:
        raise ValidationError("修订没有资料变化，素材版本也未变化，请先编辑条目。")
    validate_release_assets({"manifest": {"asset_version": asset_version}, "data": data})
    return data, changes, asset_version


@transaction.atomic
def create_change_set(*, actor, title, description="", feedback_id=None, rollback_target_id=None):
    require(actor, "add")
    release = locked_baseline()
    feedback = None
    if feedback_id:
        if not actor.has_perm("atlas.change_feedback") or not actor.has_perm("atlas.view_feedback"):
            raise PermissionDenied("关联反馈需要查看和处理反馈权限。")
        feedback = Feedback.objects.get(pk=feedback_id)
    target = DataRelease.objects.get(pk=rollback_target_id) if rollback_target_id else None
    if target and target.pk == release.pk:
        raise ValidationError("所选版本已是当前版本，无需回退。")
    batch = ChangeSet(title=title.strip(), description=description, base_release=release,
                      created_by=actor, updated_by=actor, feedback=feedback, rollback_target=target)
    batch.full_clean()
    batch.save()
    event(batch, actor, "created", {"rollback_target": rollback_target_id,
                                  "title": batch.title, "description": description})
    return batch


@transaction.atomic
def edit_change_set(pk, *, actor, expected_version, title, description):
    require(actor, "change")
    batch, _ = locked_batch(pk, expected_version, check_base=False)
    require_draft(batch)
    batch.title, batch.description = title.strip(), description
    batch.full_clean()
    touch(batch, actor, "edited", {"title": batch.title, "description": description})
    return batch


def default_record(section, record_id):
    row = {}
    for key in FIELDS[section]:
        if key == KEYS[section]:
            row[key] = record_id
        elif key in ("aliases", "stable_keys", "sources"):
            row[key] = []
        else:
            field = MODELS[section]._meta.get_field(
                key.removesuffix("_id") if key.endswith("_id") and key not in ("group_id", "external_id") else key)
            row[key] = field.get_default() if field.has_default() else None if field.null else ""
    if section == "relationships":
        row["kind"] = "mutual"
    return row


@transaction.atomic
def add_record(pk, *, actor, expected_version, section, record_id="", new_id=""):
    require(actor, "change")
    if not actor.has_perm("atlas.add_candidate"):
        raise PermissionDenied("需要创建资料候选权限。")
    batch, release = locked_batch(pk, expected_version)
    require_draft(batch)
    if batch.rollback_target_id:
        raise ValidationError("回退修订按目标版本生成，不接受额外条目。")
    if section not in FIELDS:
        raise ValidationError("资料类型无效。")
    before = next((copy.deepcopy(row) for row in release.formal_snapshot[section]
                   if row[KEYS[section]] == record_id), None)
    if record_id and before is None:
        raise ValidationError("所选资料不在当前基线中。")
    if before is None:
        if section == "identities" and not new_id.strip():
            raise ValidationError("新增身份映射须填写实际游戏角色 ID。")
        record_id = new_id.strip() or f"{section.rstrip('s')}_{uuid.uuid4().hex}"
        if len(record_id) > (220 if section == "relationships" else 250 if section == "evidence" else 100):
            raise ValidationError("稳定 ID 过长。")
        if any(row[KEYS[section]] == record_id for row in release.formal_snapshot[section]):
            raise ValidationError("稳定 ID 已存在，请选择修改现有资料。")
    existing = batch.records.filter(section=section, record_id=record_id).first()
    if existing:
        if existing.included:
            raise ValidationError("该条资料已在本次修订中。")
        if existing.base_release_id != release.pk:
            existing.before = before
            existing.proposed = before if before is not None else default_record(section, record_id)
            existing.base_release, existing.base_digest = release, release.manifest["data_digest"]
            existing.version += 1
            CandidateEdit.objects.create(candidate=existing, version=existing.version,
                                         proposed=existing.proposed, actor=actor)
        existing.included, existing.updated_by = True, actor
        existing.save()
        touch(batch, actor, "record_restored", {"candidate": existing.pk})
        return existing
    item = Candidate.objects.create(change_set=batch, section=section, record_id=record_id,
        base_release=release, base_digest=release.manifest["data_digest"], before=before,
        proposed=before if before is not None else default_record(section, record_id),
        created_by=actor, updated_by=actor)
    CandidateEdit.objects.create(candidate=item, version=1, proposed=item.proposed, actor=actor)
    touch(batch, actor, "record_added", {"candidate": item.pk})
    return item


def validate_draft_record(item, proposed):
    if not isinstance(proposed, dict) or set(proposed) != set(FIELDS[item.section]):
        raise ValidationError("资料字段不完整或含有未知字段。")
    if proposed[KEYS[item.section]] != item.record_id:
        raise ValidationError("候选不能改变稳定 ID。")
    immutable = ("person_a_id", "person_b_id") if item.section == "relationships" else (
        ("relationship_id",) if item.section == "evidence" else ())
    if item.before and any(proposed[key] != item.before[key] for key in immutable):
        raise ValidationError("已有关系的端点和证据所属关系不能改变，请新增资料。")
    values = {key: value for key, value in proposed.items() if not (item.section == "evidence" and key == "id")}
    obj = MODELS[item.section](**values)
    relation_fields = [field.name for field in obj._meta.fields if field.is_relation]
    obj.full_clean(exclude=relation_fields, validate_unique=False, validate_constraints=False)
    if item.section == "relationships":
        proposed["person_a_id"], proposed["person_b_id"] = obj.person_a_id, obj.person_b_id
        if not isinstance(proposed["stable_keys"], list) or not all(
            isinstance(value, str) and value for value in proposed["stable_keys"]
        ):
            raise ValidationError("原始稳定键须为非空文本列表。")
    available = batch_data(item.change_set, validate=False)
    for key in ("faction_id", "person_id", "person_a_id", "person_b_id", "awareness_from_id", "relationship_id"):
        if key not in proposed or (key == "awareness_from_id" and proposed[key] is None):
            continue
        section = "factions" if key == "faction_id" else "relationships" if key == "relationship_id" else "people"
        if proposed[key] not in {row[KEYS[section]] for row in available[section]}:
            raise ValidationError("请选择基线或本次修订中的有效关联资料。")
    return proposed


@transaction.atomic
def save_record(pk, *, actor, expected_version, expected_change_set_version, proposed, private_note):
    require(actor, "change")
    if not actor.has_perm("atlas.change_candidate"):
        raise PermissionDenied("需要编辑资料候选权限。")
    # 先只读所属修订，再按固定顺序加锁。
    group_id = Candidate.objects.values_list("change_set_id", flat=True).get(pk=pk)
    batch, _ = locked_batch(group_id, expected_change_set_version)
    require_draft(batch)
    item = Candidate.objects.select_for_update().get(pk=pk, change_set=batch, included=True)
    if type(expected_version) is not int or item.version != expected_version:
        raise ValidationError("候选已被其他维护者更新，请重新打开核对后再保存。")
    item.change_set = batch
    item.proposed = validate_draft_record(item, copy.deepcopy(proposed))
    if not isinstance(private_note, str) or len(private_note) > 6000:
        raise ValidationError("私有备注最多 6000 字。")
    item.private_note = private_note
    item.version += 1
    item.updated_by = actor
    item.save()
    CandidateEdit.objects.create(candidate=item, version=item.version, proposed=item.proposed, actor=actor)
    touch(batch, actor, "record_saved", {"candidate": item.pk, "version": item.version})
    return item


@transaction.atomic
def remove_record(pk, *, actor, expected_version, candidate_id):
    require(actor, "change")
    batch, _ = locked_batch(pk, expected_version, check_base=False)
    require_draft(batch)
    item = batch.records.select_for_update().get(pk=candidate_id, included=True)
    item.included = False
    item.save(update_fields=["included"])
    touch(batch, actor, "record_removed", {"candidate": item.pk})


@transaction.atomic
def adopt_candidate(pk, *, actor, expected_version):
    require(actor, "add")
    if not actor.has_perm("atlas.change_candidate"):
        raise PermissionDenied("需要编辑资料候选权限。")
    release = locked_baseline()
    item = Candidate.objects.select_for_update().get(pk=pk)
    if item.change_set_id or item.version != expected_version or item.base_release_id != release.pk:
        raise ValidationError("候选已归入修订或版本已变化，请刷新核对。")
    batch = create_change_set(actor=actor, title=f"{item.get_section_display()}修订 · {item.record_id}")
    item.change_set = batch
    item.save(update_fields=["change_set"])
    touch(batch, actor, "record_added", {"candidate": item.pk})
    return batch


@transaction.atomic
def rebase_change_set(pk, *, actor, expected_version):
    require(actor, "change")
    batch, current = locked_batch(pk, expected_version, check_base=False)
    require_draft(batch)
    if batch.base_release_id == current.pk:
        return batch
    updates = []
    for item in batch.records.filter(included=True):
        latest = next((row for row in current.formal_snapshot[item.section]
                       if row[KEYS[item.section]] == item.record_id), None)
        if latest != item.before:
            raise ValidationError(f"资料 {item.record_id} 已被其他发布修改；请移除此条，再从当前基线重新添加并核对。")
        updates.append(item)
    old = batch.base_release_id
    batch.base_release = current
    for item in updates:
        item.base_release, item.base_digest = current, current.manifest["data_digest"]
        item.save(update_fields=["base_release", "base_digest"])
    touch(batch, actor, "rebased", {"previous": old, "current": current.pk})
    return batch


@transaction.atomic
def transition(pk, *, actor, expected_version, action, note=""):
    require(actor, "review" if action in ("approve", "return") else "change")
    batch, _ = locked_batch(pk, expected_version, check_base=action in ("submit", "approve"))
    if not isinstance(note, str) or len(note) > 6000:
        raise ValidationError("审核意见最多 6000 字。")
    if action == "submit":
        require_draft(batch)
        checked_data(batch)
        if not batch.description.strip():
            raise ValidationError("请填写修改说明与依据，再提交审核。")
        batch.status = "submitted"
    elif action == "approve":
        if batch.status != "submitted":
            raise ValidationError("只有待审核修订可以通过审核。")
        if not note.strip():
            raise ValidationError("请填写审核意见。")
        data, _, asset_version = checked_data(batch)
        batch.status, batch.review_digest, batch.asset_version = "approved", reviewed_digest(data), asset_version
        batch.reviewed_by, batch.reviewed_at, batch.review_note = actor, timezone.now(), note.strip()
    elif action in ("return", "withdraw"):
        if batch.status not in ("submitted", "approved"):
            raise ValidationError("只有待审核或已通过修订可以退回草稿。")
        if not note.strip():
            raise ValidationError("请填写退回或撤回理由。")
        batch.status, batch.review_digest, batch.asset_version = "draft", "", ""
        batch.reviewed_by, batch.reviewed_at, batch.review_note = None, None, ""
    elif action == "cancel":
        require_draft(batch)
        batch.status = "cancelled"
    else:
        raise ValidationError("修订操作无效。")
    touch(batch, actor, action, {"note": note, "data_digest": batch.review_digest})
    return batch


@transaction.atomic
def preview_publication(pk, *, actor, expected_version):
    require(actor, "publish")
    batch, release = locked_batch(pk, expected_version)
    if batch.status != "approved":
        raise ValidationError("请先完成审核，再预览发布。")
    data, changes, asset_version = checked_data(batch)
    if batch.review_digest != reviewed_digest(data):
        raise ValidationError("内容与已审核版本不一致，请退回重新审核。")
    feedback_state = None
    if batch.feedback_id:
        if not actor.has_perm("atlas.change_feedback") or not actor.has_perm("atlas.view_feedback"):
            raise PermissionDenied("此修订关联反馈，发布还需要查看和处理反馈权限。")
        feedback = Feedback.objects.select_for_update().get(pk=batch.feedback_id)
        feedback_state = {"id": feedback.pk, "version": feedback.version, "status": feedback.get_status_display()}
    token = signing.dumps({"id": batch.pk, "version": batch.version, "base": release.pk,
                           "digest": reviewed_digest(data), "asset": asset_version, "actor": actor.pk,
                           "feedback": feedback_state}, salt=PREVIEW_SALT)
    return {"token": token, "data": data, "changes": changes, "asset_version": asset_version,
            "feedback": feedback_state}


@transaction.atomic
def publish_change_set(pk, *, actor, expected_version, preview_token):
    require(actor, "publish")
    batch, release = locked_batch(pk, expected_version, check_base=False)
    if batch.status == "published":
        raise ValidationError("此修订已发布，请查看对应发布版本。")
    preview = preview_publication(pk, actor=actor, expected_version=expected_version)
    try:
        signed = signing.loads(preview_token, salt=PREVIEW_SALT, max_age=3600)
        expected = signing.loads(preview["token"], salt=PREVIEW_SALT)
    except (signing.BadSignature, TypeError) as exc:
        raise ValidationError("发布预览已失效，请重新预览。") from exc
    if signed != expected:
        raise ValidationError("内容、基线或操作账号已变化，请重新预览发布。")
    data, changes = preview["data"], preview["changes"]
    release_id = f"{'rollback' if batch.rollback_target_id else 'editorial'}-{batch.pk}-v{batch.version}"
    metadata = {"origin": "database", "release_id": release_id}
    files = {name: digest(value) for name, value in source_records(data, metadata).items()}
    manifest = {"schema_version": data["schema_version"], "metadata": metadata, "files": files,
                "source_digest": digest(files), "data_digest": digest(data), "graph_digest": digest(compile_graph(data)),
                "counts": {section: len(data[section]) for section in SECTIONS}, "release_id": release_id,
                "git_commit": None, "expected_previous": release.pk, "asset_version": preview["asset_version"],
                "working_tree_dirty": False, "source_path": "database"}
    supplementary = preference_avatar_assets(data)
    if supplementary:
        manifest["preference_avatar_assets"] = supplementary
    _persist_rows(data, changes, actor, f"release:{release_id}")
    if compare_data(formal_data(data), export_database()):
        raise ValidationError("发布后资料与审核快照不一致，本次发布已撤销。")
    published = DataRelease.objects.create(
        id=release_id, origin="rollback" if batch.rollback_target_id else "editorial",
        package_digest=digest({"manifest": manifest, "data": data}), manifest=manifest,
        formal_snapshot=formal_data(data), narratives={key: data[key] for key in ("conditional", "provenance")},
        changes=[{key: row[key] for key in ("section", "id", "action")} for row in changes], previous=release, actor=actor)
    ReleaseState.objects.filter(pk=1).update(current=published, authority="database")
    if batch.feedback_id:
        # 发布和反馈结案在同一事务内；失败时两者一起撤销。
        feedback = Feedback.objects.select_for_update().get(pk=batch.feedback_id)
        review_feedback(feedback.pk, actor=actor, expected_version=feedback.version, status="resolved",
                        review_note=f"资料修订 {batch.pk} 已发布：{release_id}", issue_url=feedback.issue_url)
    batch.status, batch.published_release = "published", published
    touch(batch, actor, "published", {"release": published.pk})
    return published


def export_release(release):
    """公开快照只含正式资料和版本信息，排除后台账号、反馈与内部审核记录。"""
    data = baseline_data(release)
    files = source_records(data, {"release_id": release.pk, "data_digest": digest(data),
                                  "asset_version": release.manifest["asset_version"], "origin": release.origin})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, json_bytes(value))
    return output.getvalue()
