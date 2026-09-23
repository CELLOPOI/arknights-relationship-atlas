"""只读业务记录及具备授权、CSRF、审计的专用管理操作。"""
from typing import ClassVar

from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse

from .preference_editorial import (
    preview_catalog,
    publish_catalog,
    review_catalog,
    review_risk,
    revise_snapshots,
)
from .preference_models import (
    PreferenceCatalog,
    PreferenceControl,
    PreferenceEvent,
    PreferenceParticipant,
    PreferenceSnapshot,
)
from .preference_services import PreferenceError, audit, control


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_readonly_fields(self, request, obj=None):
        return [f.name for f in self.model._meta.fields]


@admin.register(PreferenceCatalog)
class CatalogAdmin(ReadOnlyAdmin):
    list_display: ClassVar = ["version", "status", "created_by", "reviewed_by", "published_at"]
    change_form_template = "admin/atlas/preference_catalog.html"

    def get_urls(self):
        return [path("<path:object_id>/workflow/", self.admin_site.admin_view(self.workflow),
                     name="atlas_preferencecatalog_workflow")] + super().get_urls()

    def workflow(self, request, object_id):
        result = None
        if request.method == "POST":
            try:
                action = request.POST.get("action")
                if action in ("approve", "reject"):
                    review_catalog(object_id, request.user, request.POST.get("reason", ""), action == "approve")
                elif action == "preview":
                    result = preview_catalog(object_id, request.user)
                elif action == "publish":
                    publish_catalog(object_id, request.POST.get("token", ""), request.user)
                else:
                    raise PreferenceError("invalid_action", "未知操作。")
                if result is None:
                    self.message_user(request, "操作已完成。", messages.SUCCESS)
            except PreferenceError as exc:
                self.message_user(request, exc.detail, messages.ERROR)
        context = {**self.admin_site.each_context(request), "opts": self.model._meta, "object_id": object_id,
                   "title": "审核与发布喜好名录", "preview": result}
        return TemplateResponse(request, "admin/atlas/preference_workflow.html", context)


@admin.register(PreferenceParticipant)
class ParticipantAdmin(ReadOnlyAdmin):
    list_display: ClassVar = ["id", "risk_status", "support_version", "created_at"]
    list_filter: ClassVar = ["risk_status"]
    exclude: ClassVar = ["credential_hash"]
    change_form_template = "admin/atlas/preference_participant.html"

    def get_readonly_fields(self, request, obj=None):
        return [f for f in super().get_readonly_fields(request, obj) if f != "credential_hash"]

    def get_urls(self):
        return [path("<path:object_id>/review/", self.admin_site.admin_view(self.review),
                     name="atlas_preferenceparticipant_review")] + super().get_urls()

    def review(self, request, object_id):
        if request.method == "POST":
            try:
                reason = request.POST.get("reason", "")
                review_risk(object_id, request.POST.get("status"), request.user, reason)
                revise_snapshots(request.user, reason)
                self.message_user(request, "复核已保存，保留范围内的统计已生成修订版。", messages.SUCCESS)
            except PreferenceError as exc:
                self.message_user(request, exc.detail, messages.ERROR)
        return HttpResponseRedirect(reverse("admin:atlas_preferenceparticipant_change", args=[object_id]))


@admin.register(PreferenceControl)
class ControlAdmin(admin.ModelAdmin):
    readonly_fields: ClassVar = ["id", "catalog", "revision", "last_aggregation_at", "aggregation_error", "retained_since"]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        from django.db import transaction
        from django.utils import timezone

        from .preference_services import invalidate_tasks
        with transaction.atomic():
            current = control(lock=True)
            before = {name: getattr(current, name) for name in form.changed_data}
            obj.revision = current.revision + 1
            super().save_model(request, obj, form, change)
            if obj.catalog_id:
                invalidate_tasks(obj, timezone.now())
            audit(None, "controls", before, {name: getattr(obj, name) for name in form.changed_data}, actor=request.user)


@admin.register(PreferenceEvent)
class EventAdmin(ReadOnlyAdmin):
    list_display: ClassVar = ["kind", "object_id", "actor", "created_at"]
    list_filter: ClassVar = ["kind"]


@admin.register(PreferenceSnapshot)
class SnapshotAdmin(ReadOnlyAdmin):
    list_display: ClassVar = ["scope", "kind", "object_id", "window", "cutoff", "revision", "reason"]
    list_filter: ClassVar = ["scope", "kind", "window"]
