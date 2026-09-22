import json
from urllib.parse import urlencode

from django import forms
from django.conf import settings
from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.shortcuts import render
from django.urls import path, reverse

from .importing import import_bundle
from .models import (
    Comment,
    Evidence,
    Faction,
    Identity,
    ImportBatch,
    Person,
    Relationship,
    Report,
    Revision,
    Submission,
    User,
)
from .services import record_revision, review_submission, snapshot

admin.site.site_header = "干员关系档案 · 资料管理"
admin.site.site_title = "档案管理"
admin.site.index_title = "资料修订、审核与发布"


@admin.register(User)
class AtlasUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (("邮箱验证", {"fields": ("email_verified",)}),)
    add_fieldsets = UserAdmin.add_fieldsets + (("联系方式", {"fields": ("email",)}),)


class NoDeleteAdmin(admin.ModelAdmin):
    def has_delete_permission(self, request, obj=None):
        return False


class VersionedForm(forms.ModelForm):
    version_token = forms.IntegerField(widget=forms.HiddenInput, required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["version_token"].initial = self.instance.version

    def clean(self):
        cleaned = super().clean()
        if self.instance.pk and not self.instance._state.adding:
            current = type(self.instance).objects.select_for_update().get(pk=self.instance.pk)
            if cleaned.get("version_token") != current.version:
                raise ValidationError("这份资料已被其他操作更新，请重新打开核对后再保存。")
        return cleaned


class AuditedAdmin(NoDeleteAdmin):
    def save_model(self, request, obj, form, change):
        before = snapshot(type(obj).objects.get(pk=obj.pk)) if change else {}
        if hasattr(obj, "version") and change:
            obj.version += 1
        super().save_model(request, obj, form, change)
        record_revision(obj, request.user, before, "admin")


class FormalDataAdmin(AuditedAdmin):
    change_form_template = "admin/atlas/formal_change_form.html"

    def render_change_form(self, request, context, add=False, change=False, form_url="", obj=None):
        if obj and request.user.has_perm("atlas.add_candidate"):
            from .source_data import evidence_id

            section = {"person": "people", "faction": "factions", "identity": "identities",
                       "relationship": "relationships", "evidence": "evidence"}[obj._meta.model_name]
            key = evidence_id(obj) if section == "evidence" else obj.external_id if section == "identities" else obj.pk
            context["candidate_add_url"] = reverse("admin:atlas_candidate_add") + "?" + urlencode({
                "section": section, "record_id": key,
            })
        return super().render_change_form(request, context, add, change, form_url, obj)

    def has_add_permission(self, request):
        return not settings.FORMAL_DATA_MANAGED and super().has_add_permission(request)

    def has_change_permission(self, request, obj=None):
        return not settings.FORMAL_DATA_MANAGED and super().has_change_permission(request, obj)

    def save_model(self, request, obj, form, change):
        if settings.FORMAL_DATA_MANAGED:
            raise PermissionDenied("正式资料仅通过版本化发布写入。")
        super().save_model(request, obj, form, change)


@admin.register(Faction)
class FactionAdmin(FormalDataAdmin):
    list_display = ["name", "id", "order"]
    search_fields = ["name", "id"]

    def get_readonly_fields(self, request, obj=None):
        return ["id"] if obj else []


class ImportForm(forms.Form):
    graph = forms.FileField(label="graph.json")
    evidence = forms.FileField(label="evidence.json")
    update_existing = forms.BooleanField(label="允许更新已有资料（建议先预览并核对）", required=False)

    def clean(self):
        cleaned = super().clean()
        for key in ("graph", "evidence"):
            file = cleaned.get(key)
            if file:
                if file.size > 12 * 1024 * 1024:
                    raise ValidationError("每个文件不能超过 12 MiB。")
                try:
                    cleaned[key + "_data"] = json.load(file)
                except (ValueError, UnicodeError) as exc:
                    raise ValidationError("请上传有效的 UTF-8 JSON 文件。") from exc
        return cleaned


@admin.register(Person)
class PersonAdmin(FormalDataAdmin):
    form = VersionedForm
    list_display = ["name", "id", "is_operator", "faction", "published", "version"]
    list_filter = ["is_operator", "published", "faction"]
    search_fields = ["name", "id", "aliases"]
    autocomplete_fields = ["faction"]
    change_list_template = "admin/atlas/person/change_list.html"

    def get_readonly_fields(self, request, obj=None):
        return ["id", "version", "updated_at"] if obj else ["version", "updated_at"]

    def get_urls(self):
        return [
            path("import/", self.admin_site.admin_view(self.import_view), name="atlas_import")
        ] + super().get_urls()

    def import_view(self, request):
        if settings.FORMAL_DATA_MANAGED:
            raise PermissionDenied("正式资料仅通过版本化发布写入。")

        required = [
            "atlas.add_person",
            "atlas.change_person",
            "atlas.add_relationship",
            "atlas.change_relationship",
            "atlas.add_evidence",
            "atlas.change_evidence",
            "atlas.add_faction",
            "atlas.change_faction",
        ]
        if not request.user.has_perms(required):
            raise PermissionDenied
        form = ImportForm(request.POST or None, request.FILES or None)
        result = None
        if request.method == "POST" and form.is_valid():
            try:
                result = import_bundle(
                    form.cleaned_data["graph_data"],
                    form.cleaned_data["evidence_data"],
                    actor=request.user,
                    dry_run=request.POST.get("operation") != "apply",
                    update_existing=form.cleaned_data["update_existing"],
                )
            except (ValidationError, ValueError, TypeError) as exc:
                form.add_error(None, str(exc))
        return render(
            request,
            "admin/atlas/import.html",
            {
                **self.admin_site.each_context(request),
                "title": "批量导入人物与关系",
                "form": form,
                "result": result,
            },
        )


@admin.register(Identity)
class IdentityAdmin(FormalDataAdmin):
    list_display = ["external_id", "person", "label"]
    search_fields = ["external_id", "person__name", "label"]
    autocomplete_fields = ["person"]


class EvidenceInline(admin.StackedInline):
    model = Evidence
    extra = 0
    can_delete = False
    fields = ["quote", "sources"]

    def has_add_permission(self, request, obj=None):
        return not settings.FORMAL_DATA_MANAGED and super().has_add_permission(request, obj)

    def has_change_permission(self, request, obj=None):
        return not settings.FORMAL_DATA_MANAGED and super().has_change_permission(request, obj)


@admin.register(Relationship)
class RelationshipAdmin(FormalDataAdmin):
    form = VersionedForm
    list_display = ["person_a", "person_b", "kind", "awareness_from", "published", "version"]
    list_filter = ["kind", "published"]
    search_fields = ["id", "person_a__name", "person_b__name"]
    autocomplete_fields = ["person_a", "person_b", "awareness_from"]
    inlines = [EvidenceInline]

    def get_readonly_fields(self, request, obj=None):
        return (
            ["id", "person_a", "person_b", "stable_keys", "version", "updated_at"]
            if obj
            else ["version", "updated_at"]
        )

    def save_formset(self, request, form, formset, change):
        for obj in formset.save(commit=False):
            before = snapshot(Evidence.objects.get(pk=obj.pk)) if obj.pk else {}
            obj.save()
            record_revision(obj, request.user, before, "admin:evidence")
        formset.save_m2m()


@admin.register(Evidence)
class EvidenceAdmin(FormalDataAdmin):
    list_display = ["id", "relationship"]
    search_fields = ["quote", "relationship__person_a__name", "relationship__person_b__name"]
    autocomplete_fields = ["relationship"]

    def get_readonly_fields(self, request, obj=None):
        return ["relationship"] if obj else []

    @transaction.atomic
    def save_model(self, request, obj, form, change):
        target = Relationship.objects.select_for_update().get(pk=obj.relationship_id)
        before = snapshot(target)
        target.version += 1
        target.save()
        record_revision(target, request.user, before, "admin:evidence")
        super().save_model(request, obj, form, change)


@admin.register(Submission)
class SubmissionAdmin(NoDeleteAdmin):
    def has_change_permission(self, request, obj=None):
        return not settings.FORMAL_DATA_MANAGED and super().has_change_permission(request, obj)

    def get_actions(self, request):
        return {} if settings.FORMAL_DATA_MANAGED else super().get_actions(request)

    def save_model(self, request, obj, form, change):
        if settings.FORMAL_DATA_MANAGED:
            raise PermissionDenied("旧投稿审核已停止，请整理为资料候选。")
        super().save_model(request, obj, form, change)

    list_display = ["id", "author", "person", "relationship", "status", "created_at"]
    list_filter = ["status"]
    search_fields = ["body", "author__username", "person__name", "relationship__id"]
    actions = ["approve", "reject"]
    readonly_fields = [
        "author",
        "person",
        "relationship",
        "body",
        "evidence_text",
        "base_version",
        "status",
        "reviewer",
        "reviewed_at",
        "created_at",
    ]

    def has_add_permission(self, request):
        return False

    def get_readonly_fields(self, request, obj=None):
        return self.readonly_fields + (
            ["proposed_changes", "review_note"] if obj and obj.status != "pending" else []
        )

    @admin.action(description="采纳所选补充并应用候选修改")
    def approve(self, request, queryset):
        for item in queryset:
            try:
                review_submission(item.pk, request.user, True)
                self.message_user(request, f"已采纳补充 {item.pk}。")
            except ValidationError as exc:
                self.message_user(request, f"补充 {item.pk}：{'；'.join(exc.messages)}", messages.ERROR)

    @admin.action(description="不采纳所选补充")
    def reject(self, request, queryset):
        for item in queryset:
            try:
                review_submission(item.pk, request.user, False)
                self.message_user(request, f"已处理补充 {item.pk}。")
            except ValidationError as exc:
                self.message_user(request, "；".join(exc.messages), messages.ERROR)


@admin.register(Comment)
class CommentAdmin(AuditedAdmin):
    list_display = ["id", "author", "person", "relationship", "status", "created_at"]
    list_filter = ["status"]
    search_fields = ["body", "author__username"]
    readonly_fields = ["author", "person", "relationship", "body", "created_at"]

    def has_add_permission(self, request):
        return False


@admin.register(Report)
class ReportAdmin(NoDeleteAdmin):
    list_display = ["id", "comment", "reporter", "resolved", "created_at"]
    list_filter = ["resolved"]
    readonly_fields = ["comment", "reporter", "reason", "created_at"]
    actions = ["hide_comments"]

    def has_add_permission(self, request):
        return False

    @admin.action(description="隐藏被举报评论并标记已处理", permissions=["change"])
    def hide_comments(self, request, queryset):
        if not request.user.has_perm("atlas.change_comment"):
            self.message_user(request, "需要评论修改权限。", messages.ERROR)
            return
        with transaction.atomic():
            for report in queryset.select_related("comment"):
                comment = Comment.objects.select_for_update().get(pk=report.comment_id)
                before = snapshot(comment)
                if comment.status == "visible":
                    comment.status = "hidden"
                    comment.save(update_fields=["status"])
                    record_revision(comment, request.user, before, f"report:{report.pk}")
                report.resolved = True
                report.save(update_fields=["resolved"])


class ReadOnlyAdmin(NoDeleteAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Revision)
class RevisionAdmin(ReadOnlyAdmin):
    list_display = ["target_type", "target_id", "actor", "reason", "created_at"]
    search_fields = ["target_id", "reason"]
    list_filter = ["target_type"]


@admin.register(ImportBatch)
class ImportBatchAdmin(ReadOnlyAdmin):
    list_display = ["digest", "actor", "created_at"]


# 注册独立的私有反馈队列。
from . import (
    candidate_admin,  # noqa: F401
    editorial_admin,  # noqa: F401
    feedback_admin,  # noqa: F401
)
