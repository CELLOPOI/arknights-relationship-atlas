import copy

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import Http404, HttpResponse, HttpResponseNotAllowed
from django.shortcuts import get_object_or_404, redirect
from django.template.response import TemplateResponse
from django.urls import path

from .candidate_models import SECTIONS, Candidate
from .candidate_services import create_candidate, export_candidate, save_candidate
from .editorial_display import field_value
from .editorial_services import adopt_candidate, batch_data, save_record
from .release_models import ReleaseState
from .source_data import FIELDS, KEYS, MODELS

LABELS = {"aliases": "别名（每行一个）", "stable_keys": "原始稳定键（每行一个）"}


def choices_for(section, data):
    people = {r["id"]: r["name"] for r in data["people"]}
    result = []
    for row in data[section]:
        key = row[KEYS[section]]
        label = row.get("name", row.get("label", ""))
        if section == "relationships":
            label = f"{people.get(row['person_a_id'], '待选人物')} / {people.get(row['person_b_id'], '待选人物')}"
        elif section == "evidence":
            label = row["quote"][:65]
        result.append((key, f"{label} · {key}"))
    return result


class StartForm(forms.Form):
    section = forms.ChoiceField(label="资料类型", choices=SECTIONS, widget=forms.HiddenInput)
    record_id = forms.ChoiceField(label="现有资料", required=False)
    relationship_id = forms.ChoiceField(label="新增独立证据所属关系", required=False)
    base_release = forms.CharField(widget=forms.HiddenInput)
    base_digest = forms.CharField(widget=forms.HiddenInput)

    def __init__(self, *args, section, release, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["record_id"].choices = [("", "请选择；新增独立证据时留空"), *choices_for(section, release.formal_snapshot)]
        self.fields["relationship_id"].choices = [("", "不新增证据"), *choices_for("relationships", release.formal_snapshot)]
        if section != "evidence":
            self.fields["record_id"].required = True
            self.fields.pop("relationship_id")


class SourceForm(forms.Form):
    kind = forms.ChoiceField(label="来源类型", choices=(("", "请选择类型"), ("story", "剧情"), ("profile", "档案"), ("manual", "人工说明")))
    source = forms.CharField(label="出处/来源路径", max_length=1500, strip=False)
    line = forms.IntegerField(label="起始行", min_value=1, required=False)
    endLine = forms.IntegerField(label="结束行", min_value=1, required=False)
    version = forms.CharField(label="来源版本", max_length=200, required=False, strip=False)

    def clean(self):
        values = super().clean()
        if values.get("endLine") and (not values.get("line") or values["endLine"] < values["line"]):
            raise ValidationError("结束行须有对应起始行，且不能早于起始行。")
        return values


SourceFormSet = forms.formset_factory(SourceForm, extra=1, can_delete=True, max_num=100, validate_max=True)


class RecordForm(forms.Form):
    version_token = forms.IntegerField(widget=forms.HiddenInput)
    change_set_version = forms.IntegerField(widget=forms.HiddenInput, required=False)
    private_note = forms.CharField(label="私有编辑备注（不导出）", max_length=6000, required=False, widget=forms.Textarea)

    def __init__(self, *args, candidate, **kwargs):
        super().__init__(*args, **kwargs)
        self.candidate = candidate
        row = candidate.proposed
        baseline = batch_data(candidate.change_set, validate=False) if candidate.change_set_id else candidate.base_release.formal_snapshot
        initial = {"version_token": candidate.version, "private_note": candidate.private_note}
        if candidate.change_set_id:
            initial["change_set_version"] = candidate.change_set.version
        for key in FIELDS[candidate.section]:
            if key == "sources":
                continue
            name = "record_" + key
            if key == KEYS[candidate.section]:
                field = forms.CharField(label="稳定 ID", disabled=True)
            elif key in LABELS:
                field = forms.CharField(label=LABELS[key], required=False, widget=forms.Textarea, strip=False)
            else:
                model_field = MODELS[candidate.section]._meta.get_field(
                    key.removesuffix("_id") if key.endswith("_id") and key not in ("group_id", "external_id") else key
                )
                if model_field.is_relation:
                    section = "factions" if key == "faction_id" else "relationships" if key == "relationship_id" else "people"
                    field = forms.ChoiceField(label=model_field.verbose_name,
                                              choices=[("", "未指定"), *choices_for(section, baseline)],
                                              required=not model_field.null)
                else:
                    field = model_field.formfield()
                    if isinstance(field, forms.CharField):
                        field.strip = False
                if candidate.before and ((candidate.section == "relationships" and key in ("person_a_id", "person_b_id")) or (
                    candidate.section == "evidence" and key == "relationship_id"
                )):
                    field.disabled = True
            self.fields[name] = field
            initial[name] = "\n".join(row[key]) if key in LABELS else row[key]
        self.initial.update(initial)
        self.order_fields(["version_token", *("record_" + k for k in FIELDS[candidate.section] if k != "sources"), "private_note"])

    def proposal(self, source_forms=None):
        result = copy.deepcopy(self.candidate.proposed)
        for key in FIELDS[self.candidate.section]:
            if key == "sources":
                result[key] = []
                for form in source_forms:
                    values = form.cleaned_data
                    if not values or values.get("DELETE"):
                        continue
                    source = {"kind": values["kind"], "source": values["source"]}
                    for name in ("line", "endLine", "version"):
                        if values.get(name) is not None and (values[name] != "" or name in form.initial):
                            source[name] = values[name]
                    result[key].append(source)
            elif key in LABELS:
                result[key] = [line for line in self.cleaned_data["record_" + key].splitlines() if line]
            else:
                result[key] = self.cleaned_data["record_" + key]
                if isinstance(self.fields["record_" + key].widget, forms.Textarea):
                    # 浏览器提交 textarea 时会转为 CRLF；未编辑内容保留原始表示。
                    normalized = result[key].replace("\r\n", "\n").replace("\r", "\n")
                    result[key] = normalized
                    for original in (self.candidate.proposed.get(key), (self.candidate.before or {}).get(key)):
                        if isinstance(original, str) and original.replace("\r\n", "\n").replace("\r", "\n") == normalized:
                            result[key] = original
                            break
                if key == "awareness_from_id" and not result[key]:
                    result[key] = None
        return result


@admin.register(Candidate)
class CandidateAdmin(admin.ModelAdmin):
    list_display = ("id", "section", "record_id", "base_release", "version", "updated_by", "updated_at")
    list_filter = ("section", "base_release")
    search_fields = ("record_id",)
    actions = None

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        return [path("<int:object_id>/export/", self.admin_site.admin_view(self.export_view),
                     name="atlas_candidate_export"),
                path("<int:object_id>/adopt/", self.admin_site.admin_view(self.adopt_view),
                     name="atlas_candidate_adopt")] + super().get_urls()

    def context(self, request, **kwargs):
        return {**self.admin_site.each_context(request), "opts": self.model._meta, **kwargs}

    def add_view(self, request, form_url="", extra_context=None):
        if not self.has_add_permission(request):
            raise PermissionDenied
        state = ReleaseState.objects.get(pk=1)
        if not state.current_id:
            return TemplateResponse(request, "admin/atlas/candidate/add.html", self.context(
                request, title="创建资料候选", baseline_missing=True,
            ))
        section = request.POST.get("section", request.GET.get("section", "people"))
        if section not in FIELDS:
            section = "people"
        initial = {"section": section, "base_release": state.current_id,
                   "base_digest": state.current.manifest["data_digest"], "record_id": request.GET.get("record_id", "")}
        form = StartForm(request.POST if request.method == "POST" else None, section=section,
                         release=state.current, initial=initial)
        if request.method == "POST" and form.is_valid():
            values = form.cleaned_data
            try:
                item = create_candidate(actor=request.user, section=values["section"], record_id=values["record_id"],
                                        relationship_id=values.get("relationship_id", ""),
                                        expected_release=values["base_release"], expected_digest=values["base_digest"])
                self.message_user(request, "候选已创建，请填写修改内容并保存；正式资料尚未改变。")
                return redirect("admin:atlas_candidate_change", item.pk)
            except ValidationError as exc:
                form.add_error(None, "；".join(exc.messages))
        return TemplateResponse(request, "admin/atlas/candidate/add.html", self.context(
            request, title="创建资料候选", form=form, sections=SECTIONS, section=section, release=state.current,
        ))

    def get_candidate(self, object_id):
        try:
            key = forms.IntegerField(min_value=1, max_value=9223372036854775807).clean(object_id)
        except ValidationError as exc:
            raise Http404 from exc
        return get_object_or_404(Candidate.objects.select_related("base_release", "change_set__base_release"), pk=key)

    def change_view(self, request, object_id, form_url="", extra_context=None):
        if not self.has_view_permission(request):
            raise PermissionDenied
        item = self.get_candidate(object_id)
        can_change = self.has_change_permission(request, item)
        if item.change_set_id:
            if not request.user.has_perm("atlas.view_changeset"):
                raise PermissionDenied
            can_change = can_change and request.user.has_perm("atlas.change_changeset") and item.included and item.change_set.status == "draft"
        if not self.has_view_permission(request, item) or (request.method == "POST" and not can_change):
            raise PermissionDenied
        form = RecordForm(request.POST if request.method == "POST" else None, candidate=item)
        sources = None
        if item.section == "evidence":
            sources = SourceFormSet(request.POST if request.method == "POST" else None,
                                    initial=item.proposed["sources"], prefix="sources")
        if request.method == "POST" and form.is_valid() and (sources is None or sources.is_valid()):
            try:
                kwargs = {"actor": request.user, "expected_version": form.cleaned_data["version_token"],
                          "proposed": form.proposal(sources), "private_note": form.cleaned_data["private_note"]}
                if item.change_set_id:
                    save_record(item.pk, expected_change_set_version=form.cleaned_data["change_set_version"], **kwargs)
                else:
                    save_candidate(item.pk, **kwargs)
                self.message_user(request, "草稿已保存；正式资料将在修订审核发布后更新。")
                return redirect("admin:atlas_candidate_change", item.pk)
            except ValidationError as exc:
                form.add_error(None, "；".join(exc.messages))
        if not can_change:
            for field in form.fields.values():
                field.disabled = True
            for source_form in sources or ():
                for field in source_form.fields.values():
                    field.disabled = True
        before = item.before or {}
        display_data = batch_data(item.change_set, validate=False) if item.change_set_id else item.base_release.formal_snapshot
        changes = [{"field": key, "label": form.fields["record_" + key].label if key != "sources" else "来源",
                    "before": field_value(item.section, key, before.get(key), item.base_release.formal_snapshot),
                    "after": field_value(item.section, key, item.proposed[key], display_data)}
                   for key in item.proposed if before.get(key) != item.proposed[key]]
        return TemplateResponse(request, "admin/atlas/candidate/change.html", self.context(
            request, title=str(item), original=item, form=form, sources=sources, changes=changes, can_change=can_change,
            can_export=request.user.has_perm("atlas.view_candidate"),
            can_adopt=not item.change_set_id and request.user.has_perm("atlas.add_changeset")
                      and request.user.has_perm("atlas.change_candidate"),
        ))

    def adopt_view(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        self.get_candidate(object_id)
        try:
            version = forms.IntegerField(min_value=1).clean(request.POST.get("version_token"))
            batch = adopt_candidate(object_id, actor=request.user, expected_version=version)
            return redirect("admin:atlas_changeset_change", batch.pk)
        except ValidationError as exc:
            self.message_user(request, "；".join(exc.messages), messages.ERROR)
            return redirect("admin:atlas_candidate_change", object_id)

    def export_view(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        if not request.user.has_perm("atlas.view_candidate"):
            raise PermissionDenied
        self.get_candidate(object_id)
        try:
            version = forms.IntegerField(min_value=1).clean(request.POST.get("version_token"))
            archive = export_candidate(object_id, actor=request.user, expected_version=version)
        except ValidationError as exc:
            self.message_user(request, "；".join(exc.messages), messages.ERROR)
            return redirect("admin:atlas_candidate_change", object_id)
        response = HttpResponse(archive, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="candidate-{object_id}-v{version}.zip"'
        response["Cache-Control"] = "no-store"
        return response
