import copy
import io
import uuid
import zipfile

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from .candidate_models import Candidate, CandidateEdit
from .release_models import ReleaseState
from .releasing import release_changes
from .source_data import (
    KEYS,
    canonical_data,
    compare_data,
    digest,
    export_database,
    json_bytes,
    source_filename,
)


def require_permission(actor, action):
    if not actor.is_active or not actor.is_staff or not actor.has_perm(f"atlas.{action}_candidate"):
        raise PermissionDenied("需要相应的资料候选权限。")


def locked_baseline():
    # 所有候选操作与发布器固定先锁发布状态，再锁候选，避免相反顺序导致死锁。
    state = ReleaseState.objects.select_for_update().get(pk=1)
    if not state.current_id:
        raise ValidationError("尚无正式发布基线，请先通过资料发布命令建立首个版本。")
    current = state.current
    if compare_data(current.formal_snapshot, export_database()):
        raise ValidationError("数据库正式资料与发布基线不一致，请先核查数据漂移。")
    return current


def baseline_data(release):
    return copy.deepcopy({**release.formal_snapshot, **release.narratives})


def check_baseline(candidate, release):
    if candidate.base_release_id != release.pk or candidate.base_digest != release.manifest["data_digest"]:
        raise ValidationError("正式资料已发布新版本，请重新创建候选并核对原有修改。")


def validate_proposal(candidate, proposed, release):
    if not isinstance(proposed, dict) or proposed.get(KEYS[candidate.section]) != candidate.record_id:
        raise ValidationError("候选不能改变稳定 ID。")
    data = baseline_data(release)
    records = data[candidate.section]
    records[:] = [row for row in records if row[KEYS[candidate.section]] != candidate.record_id]
    records.append(copy.deepcopy(proposed))
    data = canonical_data(data)
    release_changes(release.formal_snapshot, data)
    return data


@transaction.atomic
def create_candidate(*, actor, section, record_id, expected_release, expected_digest, relationship_id=""):
    require_permission(actor, "add")
    release = locked_baseline()
    if release.pk != expected_release or release.manifest["data_digest"] != expected_digest:
        raise ValidationError("创建页面的发布基线已过期，请重新打开。")
    if section not in KEYS:
        raise ValidationError("资料类型无效。")
    before = next((copy.deepcopy(r) for r in release.formal_snapshot[section]
                   if r[KEYS[section]] == record_id), None)
    if before is None:
        if section != "evidence" or record_id or relationship_id not in {
            row["id"] for row in release.formal_snapshot["relationships"]
        }:
            raise ValidationError("请选择基线中已有的资料；新增仅支持独立证据。")
        record_id = "evidence_" + uuid.uuid4().hex
        proposed = {"id": record_id, "relationship_id": relationship_id, "quote": "", "sources": [], "published": True}
    else:
        if relationship_id:
            raise ValidationError("现有资料候选不接受额外关系目标。")
        proposed = copy.deepcopy(before)
    item = Candidate.objects.create(
        section=section, record_id=record_id, base_release=release, base_digest=release.manifest["data_digest"],
        before=before, proposed=proposed, created_by=actor, updated_by=actor,
    )
    CandidateEdit.objects.create(candidate=item, version=1, proposed=proposed, actor=actor)
    return item


@transaction.atomic
def save_candidate(pk, *, actor, expected_version, proposed, private_note):
    require_permission(actor, "change")
    release = locked_baseline()
    item = Candidate.objects.select_for_update().get(pk=pk)
    if item.change_set_id:
        raise ValidationError("此候选已纳入资料修订，请从所属修订编辑。")
    check_baseline(item, release)
    if type(expected_version) is not int or expected_version != item.version:
        raise ValidationError("候选已被其他维护者更新，请重新打开核对后再保存。")
    validate_proposal(item, proposed, release)
    if not isinstance(private_note, str) or len(private_note) > 6000:
        raise ValidationError("私有备注须为最多 6000 字的文本。")
    item.proposed = copy.deepcopy(proposed)
    item.private_note = private_note
    item.version += 1
    item.updated_by = actor
    item.save(update_fields=["proposed", "private_note", "version", "updated_by", "updated_at"])
    CandidateEdit.objects.create(candidate=item, version=item.version, proposed=proposed, actor=actor)
    return item


@transaction.atomic
def export_candidate(pk, *, actor, expected_version):
    require_permission(actor, "view")
    release = locked_baseline()
    item = Candidate.objects.select_for_update().get(pk=pk)
    if item.change_set_id:
        raise ValidationError("关联资料应一起审核发布；公开快照请从资料发布页面导出。")
    check_baseline(item, release)
    if type(expected_version) is not int or expected_version != item.version:
        raise ValidationError("候选版本已变化，请重新打开后导出。")
    validate_proposal(item, item.proposed, release)
    path = source_filename(item.section, item.record_id)
    manifest = {
        "schema_version": release.formal_snapshot["schema_version"], "base_release": release.pk,
        "base_digest": item.base_digest, "candidate_id": item.pk, "candidate_version": item.version,
        "section": item.section, "record_id": item.record_id, "record_digest": digest(item.proposed),
        "source_path": release.manifest["source_path"], "files": [path],
    }
    output = io.BytesIO()
    # 固定归档时间与条目顺序，重复导出的相同版本逐字节一致。
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in (("candidate-manifest.json", manifest), ("source/" + path, item.proposed)):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, json_bytes(value))
    return output.getvalue()
