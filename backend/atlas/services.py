from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.forms.models import model_to_dict
from django.utils import timezone

from .models import Evidence, Person, Relationship, Revision, Submission


def snapshot(obj):
    return model_to_dict(obj)


def record_revision(obj, actor, before, reason):
    after = snapshot(obj)
    if before != after:
        Revision.objects.create(
            target_type=obj._meta.model_name,
            target_id=str(obj.pk),
            actor=actor,
            before=before,
            after=after,
            reason=reason,
        )


@transaction.atomic
def review_submission(submission_id, reviewer, approve, review_note=""):
    if settings.FORMAL_DATA_MANAGED:
        raise ValidationError("旧投稿审核已停止直接写入正式资料，请整理为资料候选并提交 PR。")
    if not reviewer.is_staff or not reviewer.has_perm("atlas.change_submission"):
        raise PermissionDenied
    submission = Submission.objects.select_for_update().get(pk=submission_id)
    if submission.status != "pending":
        raise ValidationError("这条补充已经处理，不能重复审核。")
    if approve:
        model = Person if submission.person_id else Relationship
        if not reviewer.has_perm(f"atlas.change_{model._meta.model_name}"):
            raise PermissionDenied
        target = model.objects.select_for_update().get(pk=submission.person_id or submission.relationship_id)
        if target.version != submission.base_version:
            raise ValidationError("正式资料已发生变化，请核对当前内容后重新整理此补充。")
        patch = submission.proposed_changes
        if not isinstance(patch, dict) or not patch:
            raise ValidationError("采纳前请填写实际应用的修改；仅填写审核意见不会修改资料。")
        allowed = (
            {"name", "aliases", "faction_id", "group_id", "group_name", "is_operator", "avatar", "published"}
            if model is Person
            else {"kind", "awareness_from_id", "note", "published", "evidence"}
        )
        if set(patch) - allowed:
            raise ValidationError("候选修改包含不允许的字段。")
        additions = patch.get("evidence", [])
        if not isinstance(additions, list) or len(additions) > 30:
            raise ValidationError("新增证据应为列表，最多 30 条。")
        before = snapshot(target)
        for key, value in patch.items():
            if key != "evidence":
                setattr(target, key, value)
        target.version += 1
        target.full_clean()
        target.save()
        for item in additions:
            if not isinstance(item, dict) or set(item) - {"quote", "sources"}:
                raise ValidationError("证据字段应为 quote 和 sources。")
            evidence = Evidence(
                relationship=target, quote=item.get("quote", ""), sources=item.get("sources", [])
            )
            evidence.full_clean()
            evidence.save()
            record_revision(evidence, reviewer, {}, f"submission:{submission.pk}")
        record_revision(target, reviewer, before, f"submission:{submission.pk}")
    submission.status = "approved" if approve else "rejected"
    submission.reviewer = reviewer
    submission.review_note = review_note or submission.review_note
    submission.reviewed_at = timezone.now()
    submission.save()
    return submission
