from datetime import timedelta

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .feedback_models import Feedback, FeedbackGuard, FeedbackReceipt, FeedbackReview


def review_values(item):
    return {name: getattr(item, name) for name in ("status", "review_note", "issue_url")}


@transaction.atomic
def review_feedback(pk, *, actor, expected_version, status, review_note, issue_url):
    if not actor.is_active or not actor.is_staff or not actor.has_perm("atlas.change_feedback"):
        raise PermissionDenied("需要反馈处理权限。")
    item = Feedback.objects.select_for_update().get(pk=pk)
    if item.version != expected_version:
        raise ValidationError("这条反馈已被其他维护者处理，请重新打开核对后再保存。")
    before = review_values(item)
    item.status, item.review_note, item.issue_url = status, review_note, issue_url
    item.full_clean()
    if before != review_values(item):
        item.version += 1
        item.processed_by = actor
        item.processed_at = timezone.now()
        item.save(update_fields=["status", "review_note", "issue_url", "version", "processed_by", "processed_at"])
        FeedbackReview.objects.create(feedback=item, actor=actor, before=before, after=review_values(item))
    return item


@transaction.atomic
def purge_feedback(*, now=None):
    now = now or timezone.now()
    contacts = Feedback.objects.filter(
        created_at__lte=now - timedelta(days=settings.FEEDBACK_CONTACT_RETENTION_DAYS)
    ).exclude(contact="").update(contact="")
    expired = Feedback.objects.filter(created_at__lte=now - timedelta(days=settings.FEEDBACK_RETENTION_DAYS))
    feedback_count = expired.count()
    expired.delete()
    guards, _ = FeedbackGuard.objects.filter(expires_at__lte=now).delete()
    receipts, _ = FeedbackReceipt.objects.filter(expires_at__lte=now).delete()
    return {"contacts_cleared": contacts, "feedback_deleted": feedback_count,
            "guards_deleted": guards, "receipts_deleted": receipts}
