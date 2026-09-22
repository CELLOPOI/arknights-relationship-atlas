import re
import uuid

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import F, Q


def person_id():
    return "person_" + uuid.uuid4().hex


def relationship_id():
    return "rel_" + uuid.uuid4().hex


def validate_aliases(value):
    if (
        not isinstance(value, list)
        or len(value) > 200
        or any(not isinstance(v, str) or not v.strip() or len(v) > 200 for v in value)
    ):
        raise ValidationError("别名必须是非空文本列表，每项最多 200 字。")


def validate_sources(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValidationError("来源必须是列表，最多 100 项。")
    for source in value:
        if not isinstance(source, dict) or set(source) - {"kind", "source", "line", "endLine", "version"}:
            raise ValidationError("来源字段无效。")
        if (
            source.get("kind") not in {"story", "profile", "manual"}
            or not isinstance(source.get("source"), str)
            or not 1 <= len(source["source"].strip()) <= 1500
        ):
            raise ValidationError("请填写有效的来源种类和出处。")
        for key in ("line", "endLine"):
            if key in source and (type(source[key]) is not int or source[key] < 1):
                raise ValidationError("来源行号必须为正整数。")
        if "endLine" in source and ("line" not in source or source["endLine"] < source["line"]):
            raise ValidationError("结束行不能早于起始行。")
        if "version" in source and (not isinstance(source["version"], str) or len(source["version"]) > 200):
            raise ValidationError("来源版本应为不超过 200 字的文本。")


class User(AbstractUser):
    email = models.EmailField("邮箱", unique=True)
    email_verified = models.BooleanField("邮箱已验证", default=False)


class Faction(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    name = models.CharField("名称", max_length=120)
    order = models.IntegerField("显示次序", default=999)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "阵营"
        verbose_name_plural = "阵营"

    def __str__(self):
        return self.name


class Person(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=100,
        default=person_id,
        validators=[RegexValidator(r"^[A-Za-z0-9_-]+$", "人物 ID 只能包含字母、数字、下划线和短横线。")],
    )
    name = models.CharField("姓名", max_length=120)
    aliases = models.JSONField("别名", default=list, blank=True, validators=[validate_aliases])
    faction = models.ForeignKey(Faction, verbose_name="当前阵营", on_delete=models.PROTECT)
    group_id = models.CharField("小队 ID", max_length=100, blank=True)
    group_name = models.CharField("小队名称", max_length=120, blank=True)
    is_operator = models.BooleanField("已实装干员", default=False, db_index=True)
    avatar = models.CharField("头像路径", max_length=250, blank=True)
    avatar_source = models.URLField("头像来源", max_length=1500, blank=True)
    avatar_is_generic = models.BooleanField("通用立绘", default=False)
    published = models.BooleanField("已公开", default=True, db_index=True)
    version = models.PositiveIntegerField("修订号", default=1, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]
        verbose_name = "人物"
        verbose_name_plural = "人物"

    def clean(self):
        if self.avatar and not re.fullmatch(r"/avatars/[A-Za-z0-9_-]+\.(webp|png|svg)", self.avatar):
            raise ValidationError({"avatar": "头像须为 /avatars/ 下的本地图片路径。"})

    def __str__(self):
        return self.name


class Identity(models.Model):
    external_id = models.CharField("游戏角色 ID", max_length=100, unique=True)
    person = models.ForeignKey(
        Person, on_delete=models.PROTECT, related_name="identities", verbose_name="统一人物"
    )
    label = models.CharField("形态名称", max_length=120, blank=True)
    published = models.BooleanField("已公开", default=True)

    class Meta:
        verbose_name = "身份映射"
        verbose_name_plural = "身份映射"

    def __str__(self):
        return self.external_id


class Relationship(models.Model):
    id = models.CharField(primary_key=True, max_length=220, default=relationship_id)
    person_a = models.ForeignKey(
        Person, on_delete=models.PROTECT, related_name="relationships_a", verbose_name="人物 A"
    )
    person_b = models.ForeignKey(
        Person, on_delete=models.PROTECT, related_name="relationships_b", verbose_name="人物 B"
    )
    kind = models.CharField(
        "判定", max_length=20, choices=[("mutual", "确认相识"), ("awareness", "单向知晓")]
    )
    awareness_from = models.ForeignKey(
        Person,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="awareness",
        verbose_name="知晓方",
    )
    note = models.TextField("判定说明", blank=True, max_length=12000)
    stable_keys = models.JSONField("原始稳定键", default=list, blank=True)
    published = models.BooleanField("已公开", default=True, db_index=True)
    version = models.PositiveIntegerField("修订号", default=1, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]
        verbose_name = "人物关系"
        verbose_name_plural = "人物关系"
        constraints = [
            models.UniqueConstraint(fields=["person_a", "person_b"], name="unique_person_pair"),
            models.CheckConstraint(
                condition=Q(person_a_id__lt=F("person_b_id")), name="ordered_distinct_pair"
            ),
            models.CheckConstraint(
                condition=(
                    Q(kind="mutual", awareness_from__isnull=True)
                    | (
                        Q(kind="awareness", awareness_from__isnull=False)
                        & (Q(awareness_from=F("person_a")) | Q(awareness_from=F("person_b")))
                    )
                ),
                name="valid_awareness_direction",
            ),
        ]

    def clean(self):
        if self.person_a_id and self.person_b_id and self.person_a_id > self.person_b_id:
            self.person_a_id, self.person_b_id = self.person_b_id, self.person_a_id
        if self.person_a_id == self.person_b_id:
            raise ValidationError("关系必须连接两位不同人物。")
        if self.kind == "mutual" and self.awareness_from_id:
            raise ValidationError({"awareness_from": "确认相识不填写知晓方。"})
        if self.kind == "awareness" and self.awareness_from_id not in (self.person_a_id, self.person_b_id):
            raise ValidationError({"awareness_from": "请选择关系中的一位人物作为知晓方。"})

    def __str__(self):
        return f"{self.person_a} / {self.person_b}"


class Evidence(models.Model):
    relationship = models.ForeignKey(
        Relationship, on_delete=models.PROTECT, related_name="evidence", verbose_name="关系"
    )
    quote = models.TextField("关键原文", max_length=100000)
    sources = models.JSONField("来源", default=list, blank=True, validators=[validate_sources])
    published = models.BooleanField("已公开", default=True)
    import_key = models.CharField(max_length=250, blank=True, editable=False, unique=True, null=True)
    source_id = models.CharField("Git 证据 ID", max_length=250, blank=True, editable=False, unique=True, null=True)

    class Meta:
        verbose_name = "证据"
        verbose_name_plural = "证据"

    def __str__(self):
        return f"{self.relationship_id}: {self.quote[:40]}"


class Targeted(models.Model):
    person = models.ForeignKey(Person, null=True, blank=True, on_delete=models.PROTECT, verbose_name="人物")
    relationship = models.ForeignKey(
        Relationship, null=True, blank=True, on_delete=models.PROTECT, verbose_name="关系"
    )

    class Meta:
        abstract = True
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(person__isnull=False, relationship__isnull=True)
                    | Q(person__isnull=True, relationship__isnull=False)
                ),
                name="%(class)s_exactly_one_target",
            )
        ]

    @property
    def target(self):
        return self.person or self.relationship

    def clean(self):
        if bool(self.person_id) == bool(self.relationship_id):
            raise ValidationError("必须且只能选择人物或关系中的一个目标。")


class Favorite(Targeted):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(Targeted.Meta):
        constraints = Targeted.Meta.constraints + [
            models.UniqueConstraint(fields=["user", "person"], name="unique_person_favorite"),
            models.UniqueConstraint(fields=["user", "relationship"], name="unique_relationship_favorite"),
        ]
        ordering = ["-created_at"]


class Comment(Targeted):
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="作者")
    body = models.TextField("正文", max_length=3000)
    status = models.CharField(
        "状态",
        max_length=16,
        default="visible",
        choices=[("visible", "公开"), ("hidden", "已隐藏"), ("deleted", "作者删除")],
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(Targeted.Meta):
        ordering = ["-created_at", "-pk"]
        verbose_name = "评论"
        verbose_name_plural = "评论"

    def __str__(self):
        return self.body[:60]


class Report(models.Model):
    comment = models.ForeignKey(Comment, on_delete=models.PROTECT, verbose_name="评论")
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="举报人")
    reason = models.CharField("原因", max_length=500)
    resolved = models.BooleanField("已处理", default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["comment", "reporter"], name="unique_comment_report")]
        verbose_name = "评论举报"
        verbose_name_plural = "评论举报"


class Submission(Targeted):
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="submissions", verbose_name="提交人"
    )
    body = models.TextField("补充说明", max_length=6000)
    evidence_text = models.TextField("补充原文与来源", max_length=12000, blank=True)
    proposed_changes = models.JSONField("审核后拟应用的修改", default=dict, blank=True)
    base_version = models.PositiveIntegerField("提交时修订号")
    status = models.CharField(
        "状态",
        max_length=16,
        default="pending",
        choices=[("pending", "待审核"), ("approved", "已采纳"), ("rejected", "未采纳")],
        db_index=True,
    )
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="reviews",
        verbose_name="审核人",
    )
    review_note = models.TextField("审核意见", max_length=3000, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(Targeted.Meta):
        ordering = ["-created_at"]
        verbose_name = "资料补充"
        verbose_name_plural = "资料补充"

    def __str__(self):
        return f"{self.get_status_display()} · {self.body[:45]}"


class Revision(models.Model):
    target_type = models.CharField("对象类型", max_length=40)
    target_id = models.CharField("对象 ID", max_length=250)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, verbose_name="操作人"
    )
    before = models.JSONField("修改前", default=dict)
    after = models.JSONField("修改后", default=dict)
    reason = models.CharField("来源", max_length=300)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "修改记录"
        verbose_name_plural = "修改记录"


class ImportBatch(models.Model):
    digest = models.CharField("文件摘要", max_length=64, unique=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    summary = models.JSONField("导入统计", default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "导入批次"
        verbose_name_plural = "导入批次"


# 显式导入以便 Django 发现拆分的私有反馈模型。
from .candidate_models import Candidate, CandidateEdit  # noqa: F401
from .editorial_models import ChangeSet, ChangeSetEvent  # noqa: F401
from .feedback_models import Feedback, FeedbackGuard, FeedbackReceipt, FeedbackReview  # noqa: F401
from .ops_models import AdminLoginGuard  # noqa: F401
from .release_models import DataRelease, ReleaseState  # noqa: F401
