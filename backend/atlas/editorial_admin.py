from django import forms
from django.contrib import admin
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.paginator import Paginator
from django.http import Http404, HttpResponse, HttpResponseNotAllowed
from django.shortcuts import get_object_or_404, redirect
from django.template.response import TemplateResponse
from django.urls import path

from .candidate_admin import choices_for
from .candidate_models import SECTIONS, Candidate
from .editorial_display import error_message, field_value, record_name
from .editorial_models import ChangeSet
from .editorial_services import (
    add_record,
    batch_data,
    create_change_set,
    current_asset_version,
    edit_change_set,
    export_release,
    preview_publication,
    publish_change_set,
    rebase_change_set,
    remove_record,
    transition,
)
from .feedback_models import Feedback
from .release_models import DataRelease, ReleaseState
from .releasing import narrative_changes
from .source_data import FIELDS, MODELS, compare_data


class ChangeSetForm(forms.Form):
    version_token = forms.IntegerField(widget=forms.HiddenInput, required=False)
    title = forms.CharField(label="修订标题", max_length=180)
    description = forms.CharField(label="修改说明与依据", max_length=6000, required=False,
                                  widget=forms.Textarea(attrs={"rows": 4}),
                                  help_text="说明修改原因和可定位的原文出处；提交审核前必须填写。")
    feedback_id = forms.IntegerField(widget=forms.HiddenInput, required=False, min_value=1)
    rollback_target_id = forms.CharField(widget=forms.HiddenInput, required=False, max_length=100)


class AddRecordForm(forms.Form):
    version_token = forms.IntegerField(widget=forms.HiddenInput)
    section = forms.ChoiceField(choices=SECTIONS, widget=forms.HiddenInput)
    record_id = forms.ChoiceField(label="已有资料", required=False)
    new_id = forms.CharField(label="新增稳定 ID", max_length=250, required=False,
                             help_text="修改已有资料时留空。新增人物、阵营、关系或证据可自动生成；身份映射须填写实际游戏角色 ID。")

    def __init__(self, *args, section, batch, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["record_id"].choices = [("", "新增一条资料"), *choices_for(section, batch.base_release.formal_snapshot)]
        self.initial.update(version_token=batch.version, section=section)

    def clean(self):
        values = super().clean()
        if values.get("record_id") and values.get("new_id"):
            raise ValidationError("请选择已有资料，或填写新增稳定 ID，不能同时填写。")
        return values


def differences(before, after, page=1):
    # 全量初始发布包含上万条记录，只格式化本页，避免生成巨大的后台页面。
    rows = Paginator(compare_data(before, after), 25).get_page(page)
    for change in rows:
        old, new = change["before"] or {}, change["after"] or {}
        section = change["section"]
        change["label"] = dict(SECTIONS).get(section, section)
        change["name"] = record_name(section, new or old, after)
        fields = []
        for key in FIELDS[section]:
            if old.get(key) == new.get(key):
                continue
            label = {"id": "稳定 ID", "external_id": "游戏角色 ID", "sources": "来源"}.get(key)
            if not label:
                field = MODELS[section]._meta.get_field(key.removesuffix("_id") if key.endswith("_id")
                                                       and key not in ("group_id",) else key)
                label = str(field.verbose_name)
            fields.append({"label": label, "before": field_value(section, key, old.get(key), before),
                           "after": field_value(section, key, new.get(key), after)})
        change["fields"] = fields
    return rows


@admin.register(ChangeSet)
class ChangeSetAdmin(admin.ModelAdmin):
    list_display = ("id", "title", "status", "base_release", "updated_by", "updated_at")
    list_filter = ("status",)
    search_fields = ("title", "description")
    actions = None

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        return [path("<int:object_id>/record/", self.admin_site.admin_view(self.record_view),
                     name="atlas_changeset_record")] + super().get_urls()

    def context(self, request, **kwargs):
        return {**self.admin_site.each_context(request), "opts": self.model._meta, **kwargs}

    def add_view(self, request, form_url="", extra_context=None):
        if not self.has_add_permission(request):
            raise PermissionDenied
        state = ReleaseState.objects.select_related("current").get(pk=1)
        initial = {"feedback_id": request.GET.get("feedback", ""),
                   "rollback_target_id": request.GET.get("rollback", "")}
        if initial["rollback_target_id"]:
            initial["title"] = f"回退至 {initial['rollback_target_id']}"
        form = ChangeSetForm(request.POST if request.method == "POST" else None, initial=initial)
        if request.method == "POST" and form.is_valid():
            try:
                values = form.cleaned_data
                batch = create_change_set(actor=request.user, title=values["title"],
                    description=values["description"], feedback_id=values["feedback_id"],
                    rollback_target_id=values["rollback_target_id"] or None)
                return redirect("admin:atlas_changeset_change", batch.pk)
            except (ValidationError, DataRelease.DoesNotExist, Feedback.DoesNotExist) as exc:
                form.add_error(None, error_message(exc) if isinstance(exc, ValidationError) else "关联反馈或回退版本不存在。")
        return TemplateResponse(request, "admin/atlas/editorial/add.html", self.context(
            request, title="新建资料修订", form=form, baseline_missing=not state.current_id))

    def record_view(self, request, object_id):
        if not self.has_view_permission(request) or not self.has_change_permission(request):
            raise PermissionDenied
        batch = get_object_or_404(ChangeSet.objects.select_related("base_release"), pk=object_id)
        section = request.POST.get("section") if request.method == "POST" else request.GET.get("section", "people")
        if section not in dict(SECTIONS):
            section = "people"
        form = AddRecordForm(request.POST if request.method == "POST" else None, section=section, batch=batch)
        if request.method == "POST" and form.is_valid():
            try:
                values = form.cleaned_data
                item = add_record(batch.pk, actor=request.user, expected_version=values["version_token"],
                                  section=values["section"], record_id=values["record_id"], new_id=values["new_id"])
                return redirect("admin:atlas_candidate_change", item.pk)
            except ValidationError as exc:
                form.add_error(None, error_message(exc))
        return TemplateResponse(request, "admin/atlas/editorial/record.html", self.context(
            request, title="添加修订条目", original=batch, section=section, sections=SECTIONS, form=form))

    def change_view(self, request, object_id, form_url="", extra_context=None):
        if not self.has_view_permission(request):
            raise PermissionDenied
        try:
            object_id = forms.IntegerField(min_value=1, max_value=9223372036854775807).clean(object_id)
        except ValidationError as exc:
            raise Http404 from exc
        batch = get_object_or_404(ChangeSet.objects.select_related(
            "base_release", "rollback_target", "published_release", "reviewed_by"), pk=object_id)
        form = ChangeSetForm(initial={"title": batch.title, "description": batch.description, "version_token": batch.version})
        error, preview, note = "", None, request.POST.get("note", "")
        if request.method == "POST":
            action = request.POST.get("action", "")
            try:
                version = forms.IntegerField(min_value=1).clean(request.POST.get("version_token"))
                kwargs = {"actor": request.user, "expected_version": version}
                if action == "save":
                    form = ChangeSetForm(request.POST)
                    if form.is_valid():
                        edit_change_set(batch.pk, title=form.cleaned_data["title"],
                                        description=form.cleaned_data["description"], **kwargs)
                    else:
                        raise ValidationError("请检查修订标题和说明。")
                elif action == "preview":
                    preview = preview_publication(batch.pk, **kwargs)
                elif action == "publish":
                    published = publish_change_set(batch.pk, preview_token=request.POST.get("preview_token"), **kwargs)
                    self.message_user(request, f"资料已发布：{published.pk}。")
                    return redirect("admin:atlas_datarelease_change", published.pk)
                elif action == "rebase":
                    rebase_change_set(batch.pk, **kwargs)
                elif action == "remove":
                    candidate_id = forms.IntegerField(min_value=1).clean(request.POST.get("candidate_id"))
                    remove_record(batch.pk, candidate_id=candidate_id, **kwargs)
                else:
                    transition(batch.pk, action=action, note=note, **kwargs)
                if action != "preview":
                    self.message_user(request, "修订已更新。")
                    return redirect("admin:atlas_changeset_change", batch.pk)
            except ValidationError as exc:
                error = error_message(exc)
            except Candidate.DoesNotExist:
                error = "该条资料已不在本次修订中，请刷新页面。"
        data = batch_data(batch, validate=False)
        changes = differences(batch.base_release.formal_snapshot, data, request.GET.get("page"))
        narratives = narrative_changes(ReleaseState(current=batch.base_release), data)
        relations = {item["id"] for item in changes if item["section"] == "relationships"}
        relations |= {item["after"]["relationship_id"] for item in changes if item["section"] == "evidence" and item["after"]}
        evidence = [item for item in data["evidence"] if item["relationship_id"] in relations]
        records = list(batch.records.filter(included=True))
        for item in records:
            item.display_name = record_name(item.section, item.proposed, data) or item.record_id
        current_id = ReleaseState.objects.values_list("current_id", flat=True).get(pk=1)
        try:
            asset_version = current_asset_version()
        except ValidationError:
            asset_version = "素材清单不可用"
        return TemplateResponse(request, "admin/atlas/editorial/change.html", self.context(
            request, title=batch.title, original=batch, form=form, changes=changes, narratives=narratives,
            records=records, events=batch.events.select_related("actor"),
            evidence=evidence, error=error, preview=preview, note=note, current_id=current_id, asset_version=asset_version,
            stale=current_id != batch.base_release_id, can_edit=self.has_change_permission(request),
            can_review=request.user.has_perm("atlas.review_changeset"),
            can_publish=request.user.has_perm("atlas.publish_changeset"),
            can_feedback=request.user.has_perm("atlas.view_feedback")))


@admin.register(DataRelease)
class PublicationAdmin(admin.ModelAdmin):
    list_display = ("id", "origin", "previous", "actor", "created_at")
    list_filter = ("origin",)
    actions = None

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        return [path("<path:object_id>/export/", self.admin_site.admin_view(self.export_view),
                     name="atlas_datarelease_export")] + super().get_urls()

    def change_view(self, request, object_id, form_url="", extra_context=None):
        if not self.has_view_permission(request):
            raise PermissionDenied
        if request.method != "GET":
            return HttpResponseNotAllowed(["GET"])
        release = get_object_or_404(DataRelease.objects.select_related("previous"), pk=object_id)
        before = release.previous.formal_snapshot if release.previous_id else {
            "schema_version": 1, **{key: [] for key in FIELDS}, "conditional": [], "provenance": {}}
        return TemplateResponse(request, "admin/atlas/editorial/release.html", {
            **self.admin_site.each_context(request), "opts": self.model._meta, "title": f"资料发布 · {release.pk}",
            "original": release, "changes": differences(before, release.formal_snapshot, request.GET.get("page")),
            "can_rollback": request.user.has_perm("atlas.add_changeset")
                and ReleaseState.objects.get(pk=1).current_id != release.pk,
            "change_set": ChangeSet.objects.filter(published_release=release).first(),
        })

    def export_view(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        if not self.has_view_permission(request):
            raise PermissionDenied
        release = get_object_or_404(DataRelease, pk=object_id)
        response = HttpResponse(export_release(release), content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="atlas-data-{release.pk}.zip"'
        response["Cache-Control"] = "no-store"
        return response
