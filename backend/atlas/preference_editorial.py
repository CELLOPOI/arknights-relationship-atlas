"""名录审核/预览/原子发布与风险复核；每次修改保留审计依据。"""
import hashlib
import json
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from .models import Person
from .preference_models import (
    PreferenceCatalog,
    PreferenceEvent,
    PreferenceOperation,
    PreferenceParticipant,
    PreferenceRate,
    PreferenceRiskSignal,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_services import PreferenceError, audit, choice_context, control, digest, invalidate_tasks


def permission(actor, name):
    if not actor or not actor.is_active or not actor.is_staff or not actor.has_perm(f"atlas.{name}"):
        raise PreferenceError("permission_denied", "没有执行此操作的权限。", 403)


def validate_catalog(payload, check_assets=True):
    if not isinstance(payload, dict) or any(not payload.get(k) for k in ("version", "asset_version", "source_version")):
        raise PreferenceError("invalid_catalog", "名录缺少版本及来源。")
    maps = {}
    for name in ("persons", "forms", "appearances", "professions"):
        rows = payload.get(name)
        if not isinstance(rows, list) or any(not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"] for r in rows):
            raise PreferenceError("invalid_catalog", f"名录 {name} 格式无效。")
        maps[name] = {r["id"]: r for r in rows}
        if len(maps[name]) != len(rows):
            raise PreferenceError("duplicate_id", "名录包含重复稳定 ID。")
    ids = set(maps["persons"])
    if set(Person.objects.filter(pk__in=ids, published=True).values_list("pk", flat=True)) != ids:
        raise PreferenceError("unpublished_person", "名录只能引用正式已公开人物。")
    for person in maps["persons"].values():
        actual = {f["id"] for f in maps["forms"].values() if f.get("person_id") == person["id"]}
        if set(person.get("form_ids", [])) != actual:
            raise PreferenceError("invalid_mapping", "人物形态映射不完整。")
    for form in maps["forms"].values():
        if form.get("person_id") not in ids or form.get("profession") not in maps["professions"]:
            raise PreferenceError("invalid_mapping", "形态人物或职业映射无效。")
        actual = {a["id"] for a in maps["appearances"].values() if a.get("form_id") == form["id"]}
        if set(form.get("appearance_ids", [])) != actual:
            raise PreferenceError("invalid_mapping", "外观候选映射不完整。")
        if form.get("complete") and (not form.get("catalog_version") or form.get("default_appearance_id") not in actual):
            raise PreferenceError("incomplete_catalog", "完整形态缺少基础图或候选版本。")
    for appearance in maps["appearances"].values():
        if appearance.get("form_id") not in maps["forms"] or not appearance.get("image_url") or not appearance.get("thumbnail_url"):
            raise PreferenceError("invalid_mapping", "外观缺少归属或图片。")
    if not check_assets:
        return payload
    root = Path(settings.PREFERENCE_ASSET_ROOT).resolve()
    try:
        manifest = json.loads(Path(settings.PREFERENCE_MANIFEST_PATH).read_text())
        old_manifest = json.loads(Path(settings.ASSET_MANIFEST_PATH).read_text())
    except (OSError, ValueError) as exc:
        raise PreferenceError("assets_unavailable", "素材清单不可用。") from exc
    if manifest["version"] != payload["asset_version"]:
        raise PreferenceError("asset_version_conflict", "素材版本与候选名录不符。")
    files = {row["path"]: row for row in manifest["files"]}
    old_paths = {"/" + row["path"] for row in old_manifest["files"]}
    paths = set()
    for rows in maps.values():
        for row in rows.values():
            paths.update(row[key] for key in ("representative_url", "image_url", "thumbnail_url", "portrait_url", "icon_url") if row.get(key))
    for url in paths:
        if not url.startswith("/") or url.startswith("//") or urlsplit(url).netloc or urlsplit(url).fragment:
            raise PreferenceError("invalid_asset_url", "素材必须使用本站固定路径。")
        url = urlsplit(url).path
        if not url.startswith("/assets/preferences/"):
            if url not in old_paths:
                raise PreferenceError("asset_missing", "引用的固定素材不在清单内。")
            continue
        relative = url.removeprefix("/assets/preferences/")
        asset = (root / relative).resolve()
        if not asset.is_relative_to(root) or relative not in files:
            raise PreferenceError("asset_missing", "喜好素材不在固定清单内。")
        try:
            content = asset.read_bytes()
        except OSError as exc:
            raise PreferenceError("asset_missing", "喜好素材尚未部署完整。") from exc
        row = files[relative]
        if hashlib.sha256(content).hexdigest() != row["sha256"] or len(content) != row["bytes"]:
            raise PreferenceError("asset_corrupt", "喜好素材校验失败。")
    return payload


def create_catalog(payload, actor, note):
    permission(actor, "add_preferencecatalog")
    validate_catalog(payload)
    if not note.strip():
        raise PreferenceError("reason_required", "请填写名录来源与修改说明。")
    with transaction.atomic():
        current = control(lock=True)
        if PreferenceCatalog.objects.filter(pk=payload["version"]).exists():
            raise PreferenceError("version_exists", "此名录版本已存在，不能覆盖。", 409)
        catalog = PreferenceCatalog.objects.create(version=payload["version"], payload=payload, digest=digest(payload),
            base_version=current.catalog_id or "", created_by=actor, note=note)
        audit(None, "catalog_draft", {}, {"version": catalog.pk, "digest": catalog.digest}, reason=note, actor=actor)
        return catalog


def review_catalog(version, actor, note, approve=True):
    permission(actor, "review_preference_catalog")
    if not note.strip():
        raise PreferenceError("reason_required", "请填写审核理由。")
    with transaction.atomic():
        control(lock=True)
        catalog = PreferenceCatalog.objects.select_for_update().get(pk=version)
        if catalog.status not in ("draft", "approved"):
            raise PreferenceError("catalog_state", "已发布名录不可修改。", 409)
        validate_catalog(catalog.payload)
        catalog.status, catalog.reviewed_by = "approved" if approve else "draft", actor
        catalog.save(update_fields=["status", "reviewed_by"])
        audit(None, "catalog_review", {}, {"version": version, "approved": approve}, object_id=version, reason=note, actor=actor)
        return catalog


def preview_catalog(version, actor):
    permission(actor, "publish_preference_catalog")
    with transaction.atomic():
        current = control(lock=True)
        catalog = PreferenceCatalog.objects.select_for_update().get(pk=version)
        if catalog.status != "approved" or catalog.base_version != (current.catalog_id or ""):
            raise PreferenceError("catalog_state", "请先审核，并核对当前发布基线。", 409)
        validate_catalog(catalog.payload)
        old = current.catalog.payload if current.catalog_id else {}
        changes = {}
        for key in ("persons", "forms", "appearances"):
            before = {r["id"]: r for r in old.get(key, [])}
            after = {r["id"]: r for r in catalog.payload[key]}
            changes[key] = {"added": sorted(after.keys() - before.keys()), "removed": sorted(before.keys() - after.keys()),
                            "changed": sorted(k for k in before.keys() & after.keys() if before[k] != after[k])}
        value = {"version": version, "digest": digest(catalog.payload), "base_version": current.catalog_id,
                 "actor": actor.pk, "revision": current.revision, "reviewer": catalog.reviewed_by_id,
                 "review_event": PreferenceEvent.objects.filter(kind="catalog_review", object_id=version).order_by("-pk").values_list("pk", flat=True).first()}
        return {"changes": changes, "token": signing.dumps(value, salt="preference-preview"),
                "version": version, "expires_in": 3600}


def publish_catalog(version, token, actor):
    permission(actor, "publish_preference_catalog")
    try:
        value = signing.loads(token, salt="preference-preview", max_age=3600)
    except signing.BadSignature as exc:
        raise PreferenceError("preview_expired", "预览已失效，请重新预览。", 409) from exc
    with transaction.atomic():
        current = control(lock=True)
        catalog = PreferenceCatalog.objects.select_for_update().get(pk=version)
        expected = {"version": version, "digest": digest(catalog.payload), "base_version": current.catalog_id,
                    "actor": actor.pk, "revision": current.revision, "reviewer": catalog.reviewed_by_id,
                 "review_event": PreferenceEvent.objects.filter(kind="catalog_review", object_id=version).order_by("-pk").values_list("pk", flat=True).first()}
        if value != expected or catalog.status != "approved" or catalog.base_version != (current.catalog_id or ""):
            raise PreferenceError("preview_conflict", "发布内容或基线已变化，请重新预览。", 409)
        validate_catalog(catalog.payload)
        # 撤下再加入仍须遵守历史归属，不能复用旧稳定 ID。
        historical_owners = {"forms": {}, "appearances": {}}
        historical_sets = {}
        for published in PreferenceCatalog.objects.filter(status="published").only("payload"):
            for name, child, owner, kind in (("persons", "forms", "person_id", "form"),
                                                   ("forms", "appearances", "form_id", "skin")):
                for row in published.payload[name]:
                    key = (name, row["id"], choice_context(published.payload, kind, row["id"])[2])
                    historical_sets[key] = {item["id"] for item in published.payload[child]
                                            if item[owner] == row["id"] and item.get("eligible", True)}
            for name, owner in (("forms", "person_id"), ("appearances", "form_id")):
                historical_owners[name].update({row["id"]: row[owner] for row in published.payload[name]})
        for name, owner in (("forms", "person_id"), ("appearances", "form_id")):
            for row in catalog.payload[name]:
                previous_owner = historical_owners[name].get(row["id"])
                if previous_owner is not None and previous_owner != row[owner]:
                    raise PreferenceError("stable_id_reassigned", "历史稳定 ID 不得改绑其他人物或形态。", 409)
        for name, child, owner, kind in (("persons", "forms", "person_id", "form"),
                                               ("forms", "appearances", "form_id", "skin")):
            for row in catalog.payload[name]:
                key = (name, row["id"], choice_context(catalog.payload, kind, row["id"])[2])
                options = {item["id"] for item in catalog.payload[child]
                           if item[owner] == row["id"] and item.get("eligible", True)}
                if key in historical_sets and historical_sets[key] != options:
                    raise PreferenceError("candidate_version_reused", "同一确认版本不能代表不同候选集合。", 409)
        if current.catalog_id:
            old = current.catalog.payload
            for name, owner in (("forms", "person_id"), ("appearances", "form_id")):
                previous = {r["id"]: r for r in old[name]}
                for row in catalog.payload[name]:
                    if row["id"] in previous and previous[row["id"]][owner] != row[owner]:
                        raise PreferenceError("stable_id_reassigned", "稳定 ID 不得改绑其他人物或形态。", 409)
            # 候选集合变化必须变更独立确认版本；文字或压缩变更不强制撤回确认。
            for name, child, owner, kind in (("persons", "forms", "person_id", "form"),
                                                   ("forms", "appearances", "form_id", "skin")):
                previous = {r["id"]: r for r in old[name]}
                for row in catalog.payload[name]:
                    if row["id"] not in previous:
                        continue
                    before = {r["id"] for r in old[child] if r[owner] == row["id"] and r.get("eligible", True)}
                    after = {r["id"] for r in catalog.payload[child] if r[owner] == row["id"] and r.get("eligible", True)}
                    if before != after and choice_context(old, kind, row["id"])[2] == choice_context(catalog.payload, kind, row["id"])[2]:
                        raise PreferenceError("candidate_version_unchanged", "候选集合变化必须更新确认版本。", 409)
        now = timezone.now()
        catalog.status, catalog.published_at = "published", now
        catalog.save(update_fields=["status", "published_at"])
        current.catalog = catalog
        current.revision += 1
        current.save(update_fields=["catalog", "revision"])
        invalidate_tasks(current, now)
        audit(None, "catalog_publish", {"version": catalog.base_version}, {"version": version}, reason=catalog.note, actor=actor)
        return catalog


def review_risk(participant_id, status, actor, reason):
    permission(actor, "review_preference_risk")
    if status not in ("accepted", "pending", "excluded") or not reason.strip():
        raise PreferenceError("invalid_review", "复核需要有效状态与理由。")
    with transaction.atomic():
        current = control(lock=True)
        participant = PreferenceParticipant.objects.select_for_update().get(pk=participant_id)
        before = participant.risk_status
        participant.risk_status = status
        participant.save(update_fields=["risk_status"])
        PreferenceTask.objects.filter(participant=participant).update(risk_status=status)
        current.revision += 1
        current.save(update_fields=["revision"])
        audit(participant, "risk_review", {"status": before}, {"status": status, "revision": current.revision}, reason=reason, actor=actor)
    return current.revision


def delete_batches(query, batch_size=500):
    deleted = 0
    while ids := list(query.order_by("pk").values_list("pk", flat=True)[:batch_size]):
        # 删除时重新检查条件，避免删掉选取 ID 后被并发请求续期的限流行。
        count, _ = query.filter(pk__in=ids).delete()
        deleted += count
    return deleted


def purge(now=None):
    now = now or timezone.now()
    detail_cutoff = now - timedelta(days=settings.PREFERENCE_DETAIL_RETENTION_DAYS)
    # 先提交保留边界，使正在计算的旧快照拒绝发布；耗时清理不占用控制锁。
    # 中断只会保守地缩短可重算范围，下次可继续清理，不会误称明细仍完整。
    with transaction.atomic(durable=True):
        current = control(lock=True)
        current.retained_since = max(filter(None, [current.retained_since, detail_cutoff]))
        current.save(update_fields=["retained_since"])
    risk = delete_batches(PreferenceRiskSignal.objects.filter(
        created_at__lt=now - timedelta(days=settings.PREFERENCE_RISK_RETENTION_DAYS)))
    rates = delete_batches(PreferenceRate.objects.filter(expires_at__lt=now))
    operations = delete_batches(PreferenceOperation.objects.filter(created_at__lt=detail_cutoff))
    expired = PreferenceTask.objects.filter(status="pending", expires_at__lte=now)
    while ids := list(expired.order_by("pk").values_list("pk", flat=True)[:500]):
        expired.filter(pk__in=ids).update(status="expired")
    tasks = delete_batches(PreferenceTask.objects.filter(issued_at__lt=detail_cutoff).filter(
        Q(accepted_at__isnull=True) | Q(accepted_at__lt=detail_cutoff)).exclude(status="pending"))
    state_kinds = ["support", "choice", "choice_correction"]
    later = PreferenceEvent.objects.filter(
        participant_id=OuterRef("participant_id"), object_id=OuterRef("object_id"),
        kind__in=state_kinds, created_at__lte=detail_cutoff,
    ).filter(Q(created_at__gt=OuterRef("created_at")) |
             Q(created_at=OuterRef("created_at"), pk__gt=OuterRef("pk")))
    # 支持与同一对象的选择/纠正均保留截止点前最后一条，含相同时间戳的顺序。
    events = delete_batches(PreferenceEvent.objects.filter(
        created_at__lt=detail_cutoff, kind__in=state_kinds).filter(Exists(later)))
    events += delete_batches(PreferenceEvent.objects.filter(created_at__lt=detail_cutoff, kind="task_void"))
    return {"risk_signals": risk, "rates": rates, "operations": operations, "tasks": tasks, "events": events}


def revise_snapshots(actor, reason):
    permission(actor, "review_preference_risk")
    if not reason.strip():
        raise PreferenceError("reason_required", "请填写重算理由。")
    from .preference_statistics import aggregate
    current = control()
    earliest = timezone.now() - timedelta(days=settings.PREFERENCE_DETAIL_RETENTION_DAYS - 84)
    cutoffs = PreferenceSnapshot.objects.filter(kind="random", window=84, cutoff__gte=earliest).values_list("cutoff", "catalog_version").distinct()
    done = set()
    for cutoff, version in cutoffs:
        if (cutoff, version) in done or current.retained_since and cutoff - timedelta(days=84) < current.retained_since:
            continue
        aggregate(cutoff, reason=reason, catalog_version=version)
        done.add((cutoff, version))
    return len(done)
