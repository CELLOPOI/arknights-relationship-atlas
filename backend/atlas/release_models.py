from django.conf import settings
from django.db import models


class DataRelease(models.Model):
    origin = models.CharField("发布来源", max_length=20, default="git",
                              choices=(("git", "初始资料包"), ("editorial", "后台修订"), ("rollback", "后台回退")))
    id = models.CharField("发布版本", primary_key=True, max_length=100)
    package_digest = models.CharField("发布包摘要", max_length=64)
    manifest = models.JSONField("发布清单")
    formal_snapshot = models.JSONField("正式资料基线")
    narratives = models.JSONField("条件叙事与来源记录")
    changes = models.JSONField("发布差异")
    previous = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField("应用时间", auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
        default_permissions = ("view",)
        verbose_name = "资料发布"
        verbose_name_plural = "资料发布"


class ReleaseState(models.Model):
    authority = models.CharField(max_length=20, default="git", choices=(("git", "初始资料包"), ("database", "后台管理")))
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    current = models.ForeignKey(DataRelease, null=True, blank=True, on_delete=models.PROTECT)

    class Meta:
        default_permissions = ()
        constraints = (models.CheckConstraint(condition=models.Q(id=1), name="single_release_state"),)
