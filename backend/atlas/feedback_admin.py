from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.urls import reverse
from django.utils.html import format_html_join

from .feedback_models import Feedback, FeedbackReview
from .feedback_services import review_feedback


class FeedbackForm(forms.ModelForm):
    version_token = forms.IntegerField(widget=forms.HiddenInput)

    class Meta:
        model = Feedback
        fields = ("status", "review_note", "issue_url")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["version_token"].initial = self.instance.version

    def clean(self):
        values = super().clean()
        if self.instance.pk:
            # Django admin changeform 已开启事务，锁保持到校验及保存结束。
            current = Feedback.objects.select_for_update().get(pk=self.instance.pk)
            if values.get("version_token") != current.version:
                raise ValidationError("这条反馈已被其他维护者处理，请重新打开核对后再保存。")
        return values


class FeedbackReviewInline(admin.TabularInline):
    model = FeedbackReview
    fields = ("actor", "before", "after", "created_at")
    readonly_fields = fields
    extra = 0
    can_delete = False

    def has_view_permission(self, request, obj=None):
        return request.user.has_perm("atlas.view_feedback") or request.user.has_perm("atlas.change_feedback")

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    change_form_template = "admin/atlas/feedback_change.html"
    form = FeedbackForm
    list_display = ("id", "type", "status", "created_at", "processed_by")
    list_filter = ("status", "type")
    search_fields = ("description",)
    readonly_fields = (
        "type", "description", "person", "relationship", "source_url", "contact",
        "created_at", "processed_by", "processed_at", "version", "related_revisions",
    )
    inlines = (FeedbackReviewInline,)
    actions = None

    def get_fields(self, request, obj=None):
        fields = ["type", "description", "person", "relationship", "source_url"]
        if request.user.has_perm("atlas.view_feedback_contact"):
            fields.append("contact")
        fields.extend(["created_at", "status", "review_note", "issue_url", "related_revisions",
                       "processed_by", "processed_at", "version"])
        if self.has_change_permission(request, obj):
            fields.append("version_token")
        return fields

    @admin.display(description="关联资料修订")
    def related_revisions(self, obj):
        return format_html_join(" · ", '<a href="{}">修订 {}（{}）</a>', (
            (reverse("admin:atlas_changeset_change", args=[item.pk]), item.pk, item.get_status_display())
            for item in obj.change_sets.all()
        )) or "暂无关联修订"

    def change_view(self, request, object_id, form_url="", extra_context=None):
        return super().change_view(request, object_id, form_url, {
            **(extra_context or {}), "can_create_revision": request.user.has_perm("atlas.add_changeset")
            and request.user.has_perm("atlas.change_feedback") and request.user.has_perm("atlas.view_feedback"),
        })

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        saved = review_feedback(
            obj.pk, actor=request.user, expected_version=form.cleaned_data["version_token"],
            status=obj.status, review_note=obj.review_note, issue_url=obj.issue_url,
        )
        obj.version, obj.processed_by, obj.processed_at = saved.version, saved.processed_by, saved.processed_at
