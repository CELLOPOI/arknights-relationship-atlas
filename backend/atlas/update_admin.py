from django.contrib import admin, messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils.html import format_html

from .admin import NoDeleteAdmin, VersionedForm
from .update_models import SiteUpdate
from .update_services import set_update_publication


class UpdateForm(VersionedForm):
    class Meta:
        model = SiteUpdate
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        if self.instance.pk and not self.instance._state.adding:
            current = SiteUpdate.objects.get(pk=self.instance.pk)
            if current.status == SiteUpdate.Status.PUBLISHED:
                raise ValidationError("已发布的说明须先撤回，再编辑并重新发布。")
            if cleaned.get("key", current.key) != current.key:
                raise ValidationError("更新说明的稳定标识不能修改。")
        return cleaned


@admin.register(SiteUpdate)
class SiteUpdateAdmin(NoDeleteAdmin):
    form = UpdateForm
    list_display = ("title", "category", "status", "published_at", "preview_link",)
    list_filter = ("status", "category",)
    search_fields = ("title", "summary", "key",)
    actions = ("publish_selected", "withdraw_selected",)
    readonly_fields = ("status", "published_at", "updated_at", "preview_link",)
    exclude = ("version",)
    raw_id_fields = ("data_release",)

    @admin.display(description="页面预览")
    def preview_link(self, obj):
        if not obj.pk:
            return "保存草稿后可预览。"
        return format_html('<a href="/updates/?preview={}" target="_blank" rel="noopener">预览更新说明</a>', obj.pk)

    def get_readonly_fields(self, request, obj=None):
        fields = list(self.readonly_fields)
        if obj:
            fields.append("key")
        if obj and obj.status == SiteUpdate.Status.PUBLISHED:
            fields.extend(["category", "title", "summary", "changes", "acknowledgements", "data_release"])
        return fields

    def save_model(self, request, obj, form, change):
        if change:
            obj.version += 1
        super().save_model(request, obj, form, change)

    def has_publish_permission(self, request):
        return request.user.has_perm("atlas.publish_siteupdate")

    def change_publication(self, request, queryset, published):
        try:
            with transaction.atomic():
                for update in queryset:
                    changed = set_update_publication(update.pk, actor=request.user, published=published)
                    self.log_change(request, changed, "发布更新说明" if published else "撤回更新说明")
        except ValidationError as exc:
            self.message_user(request, "；".join(exc.messages), messages.ERROR)
            return
        self.message_user(request, "更新说明已发布。" if published else "更新说明已撤回，可继续编辑。", messages.SUCCESS)

    @admin.action(description="发布所选更新说明", permissions=["publish"])
    def publish_selected(self, request, queryset):
        self.change_publication(request, queryset, True)

    @admin.action(description="撤回所选更新说明", permissions=["publish"])
    def withdraw_selected(self, request, queryset):
        self.change_publication(request, queryset, False)
