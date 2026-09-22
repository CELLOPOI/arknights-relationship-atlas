"""私有反馈与有限保留的防滥用记录，不属于正式资料。"""

from typing import ClassVar

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.db import models

FEEDBACK_TYPES = [
    ("data_error", "资料纠错"), ("source", "来源补充"), ("addition", "资料补充"),
    ("site_issue", "网站问题"), ("other", "其他"),
]
FEEDBACK_STATUSES = [
    ("pending", "待处理"), ("linked", "已关联 Issue/PR"), ("duplicate", "重复"),
    ("resolved", "已解决"), ("rejected", "不采纳"),
]
web_url = URLValidator(schemes=["http", "https"])


class Feedback(models.Model):
    type = models.CharField("问题类型", max_length=20, choices=FEEDBACK_TYPES)
    description = models.TextField("说明", max_length=6000)
    person = models.ForeignKey("atlas.Person", null=True, blank=True, on_delete=models.PROTECT, verbose_name="人物")
    relationship = models.ForeignKey(
        "atlas.Relationship", null=True, blank=True, on_delete=models.PROTECT, verbose_name="关系"
    )
    source_url = models.CharField("来源链接", max_length=1500, blank=True, validators=[web_url])
    contact = models.CharField("联系方式", max_length=254, blank=True)
    status = models.CharField("处理状态", max_length=20, choices=FEEDBACK_STATUSES, default="pending")
    review_note = models.TextField("处理理由/内部备注", max_length=6000, blank=True)
    issue_url = models.CharField("关联 Issue/PR", max_length=1500, blank=True, validators=[web_url])
    processed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, verbose_name="处理人"
    )
    processed_at = models.DateTimeField("处理时间", null=True, blank=True)
    created_at = models.DateTimeField("收到时间", auto_now_add=True, db_index=True)
    version = models.PositiveIntegerField(default=1, editable=False)

    class Meta:
        ordering: ClassVar = ["-created_at", "-pk"]
        verbose_name = "访客反馈"
        verbose_name_plural = "访客反馈"
        permissions: ClassVar = [("view_feedback_contact", "Can view feedback contact details")]
        constraints: ClassVar = [models.CheckConstraint(
            condition=models.Q(person__isnull=True) | models.Q(relationship__isnull=True),
            name="feedback_at_most_one_target",
        )]

    def clean(self):
        if self.person_id and self.relationship_id:
            raise ValidationError("反馈只能关联人物或关系中的一个。")
        if self.status != "pending" and not self.review_note.strip():
            raise ValidationError({"review_note": "请填写处理理由。"})
        if self.status == "linked" and not self.issue_url:
            raise ValidationError({"issue_url": "请填写关联的 Issue/PR 链接。"})

    def __str__(self):
        return f"反馈 {self.pk} · {self.get_type_display()}"


class FeedbackReview(models.Model):
    feedback = models.ForeignKey(Feedback, on_delete=models.CASCADE, related_name="reviews")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    before = models.JSONField()
    after = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering: ClassVar = ["created_at", "pk"]
        default_permissions = ()
        verbose_name = "反馈处理记录"
        verbose_name_plural = "反馈处理记录"


class FeedbackGuard(models.Model):
    # HMAC 标识仅用于短期频率限制，不存原始 IP，不关联反馈正文。
    key = models.CharField(max_length=64, primary_key=True)
    window_started = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        default_permissions = ()


class FeedbackReceipt(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        default_permissions = ()
