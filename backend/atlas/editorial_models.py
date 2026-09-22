"""后台修订保存草稿与审核状态；只有发布服务可以写正式资料。"""

from django.conf import settings
from django.db import models


class ChangeSet(models.Model):
    STATUSES = (("draft", "草稿"), ("submitted", "待审核"), ("approved", "已通过"),
                ("published", "已发布"), ("cancelled", "已取消"))
    title = models.CharField("修订标题", max_length=180)
    description = models.TextField("修改说明与依据", max_length=6000, blank=True)
    status = models.CharField("状态", max_length=20, choices=STATUSES, default="draft", db_index=True)
    version = models.PositiveIntegerField("修订版本", default=1)
    base_release = models.ForeignKey("atlas.DataRelease", on_delete=models.PROTECT, related_name="+",
                                     verbose_name="基线发布")
    rollback_target = models.ForeignKey("atlas.DataRelease", null=True, blank=True, on_delete=models.PROTECT,
                                        related_name="+", verbose_name="回退目标")
    published_release = models.OneToOneField("atlas.DataRelease", null=True, blank=True,
                                             on_delete=models.PROTECT, related_name="change_set",
                                             verbose_name="发布版本")
    feedback = models.ForeignKey("atlas.Feedback", null=True, blank=True, on_delete=models.SET_NULL,
                                  related_name="change_sets", verbose_name="关联反馈")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                   related_name="+", verbose_name="创建人")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                   related_name="+", verbose_name="最后操作人")
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                    related_name="+", verbose_name="审核人")
    review_note = models.TextField("审核意见", max_length=6000, blank=True)
    review_digest = models.CharField(max_length=64, blank=True)
    asset_version = models.CharField(max_length=100, blank=True)
    reviewed_at = models.DateTimeField("审核时间", null=True, blank=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        ordering = ("-updated_at", "-pk")
        default_permissions = ("add", "change", "view")
        permissions = (("review_changeset", "Can review editorial changes"),
                       ("publish_changeset", "Can publish editorial changes"))
        verbose_name = "资料修订"
        verbose_name_plural = "资料修订"

    def __str__(self):
        return self.title


class ChangeSetEvent(models.Model):
    change_set = models.ForeignKey(ChangeSet, on_delete=models.PROTECT, related_name="events")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=30)
    version = models.PositiveIntegerField()
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    def get_action_display(self):
        return {"created": "创建修订", "edited": "修改说明", "record_added": "添加条目",
                "record_saved": "保存条目", "record_removed": "移出条目", "record_restored": "恢复条目",
                "rebased": "更新基线", "submit": "提交审核", "approve": "审核通过",
                "return": "退回草稿", "withdraw": "撤回草稿", "cancel": "取消修订",
                "published": "发布资料"}.get(self.action, self.action)

    class Meta:
        ordering = ("created_at", "pk")
        default_permissions = ()
