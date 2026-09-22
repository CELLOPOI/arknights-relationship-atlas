"""单条资料草稿及其历史；关联修订统一审核发布。"""

from django.conf import settings
from django.db import models

SECTIONS = (
    ("people", "人物"), ("factions", "阵营"), ("identities", "身份映射"),
    ("relationships", "关系"), ("evidence", "独立证据"),
)


class Candidate(models.Model):
    change_set = models.ForeignKey("atlas.ChangeSet", null=True, blank=True, on_delete=models.PROTECT,
                                   related_name="records", verbose_name="所属修订")
    included = models.BooleanField("纳入修订", default=True)
    section = models.CharField("资料类型", max_length=20, choices=SECTIONS)
    record_id = models.CharField("稳定 ID", max_length=250)
    base_release = models.ForeignKey("atlas.DataRelease", on_delete=models.PROTECT, verbose_name="基线发布")
    base_digest = models.CharField("基线摘要", max_length=64)
    before = models.JSONField("修改前", null=True)
    proposed = models.JSONField("候选内容")
    private_note = models.TextField("私有编辑备注", blank=True, max_length=6000)
    version = models.PositiveIntegerField("候选版本", default=1)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                   related_name="created_candidates", verbose_name="创建人")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                   related_name="updated_candidates", verbose_name="最后编辑人")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("编辑时间", auto_now=True)

    class Meta:
        ordering = ("-updated_at", "-pk")
        default_permissions = ("add", "change", "view")
        verbose_name = "资料候选"
        verbose_name_plural = "资料候选"
        constraints = (models.UniqueConstraint(fields=("change_set", "section", "record_id"),
                                               name="unique_changeset_record"),)

    def __str__(self):
        return f"{self.get_section_display()} · {self.record_id}"


class CandidateEdit(models.Model):
    candidate = models.ForeignKey(Candidate, on_delete=models.CASCADE, related_name="edits")
    version = models.PositiveIntegerField()
    proposed = models.JSONField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("version",)
        default_permissions = ()
        constraints = (models.UniqueConstraint(fields=("candidate", "version"), name="candidate_edit_version"),)
