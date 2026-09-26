from django.core.exceptions import ValidationError
from django.db import models


class SiteUpdate(models.Model):
    class Category(models.TextChoices):
        STORY = "story", "剧情修订"
        FEATURE = "feature", "功能更新"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        PUBLISHED = "published", "已发布"

    key = models.SlugField("稳定标识", max_length=100, unique=True,
                          help_text="使用英文、数字和短横线，保存后不再改动。")
    category = models.CharField("分类", max_length=16, choices=Category.choices)
    title = models.CharField("标题", max_length=140)
    summary = models.CharField("摘要", max_length=300)
    changes = models.TextField("更新内容", max_length=16000, help_text="每行一项变化，使用纯文本。")
    # 保留旧列以兼容已部署数据库和历史记录；后台及公开页面不再使用独立致谢字段。
    acknowledgements = models.TextField("感谢反馈", max_length=1000, blank=True,
                                       help_text="仅填写可公开的感谢文案；具名致谢前确认对方同意，不粘贴联系方式。")
    data_release = models.ForeignKey("DataRelease", on_delete=models.PROTECT, null=True, blank=True,
                                     verbose_name="关联资料版本", help_text="剧情修订发布前必须关联实际发布的资料版本。")
    status = models.CharField("状态", max_length=16, choices=Status.choices, default=Status.DRAFT)
    published_at = models.DateTimeField("发布时间", null=True, blank=True)
    updated_at = models.DateTimeField("修改时间", auto_now=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ("-published_at", "-pk",)
        verbose_name = "更新说明"
        verbose_name_plural = "更新说明"
        permissions = (("publish_siteupdate", "可以发布或撤回更新说明"),)

    def __str__(self):
        return self.title

    def clean(self):
        super().clean()
        if not self.title.strip() or not self.summary.strip():
            raise ValidationError("标题和摘要不能只包含空白。")
        lines = [line.strip() for line in self.changes.splitlines() if line.strip()]
        if not lines or len(lines) > 40 or any(len(line) > 2000 for line in lines):
            raise ValidationError({"changes": "请填写 1–40 项变化，每项不超过 2,000 字。"})
        if self.status == self.Status.PUBLISHED:
            if not self.published_at:
                raise ValidationError("请通过发布操作填写发布时间。")
            if self.category == self.Category.STORY and not self.data_release_id:
                raise ValidationError({"data_release": "剧情修订须关联实际发布的资料版本，确认修订已生效。"})
