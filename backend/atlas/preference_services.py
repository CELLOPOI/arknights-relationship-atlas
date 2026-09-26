"""匿名喜好事务：参与者行锁串行化额度、任务消费和当前登记。"""
import copy
import hashlib
import json
import secrets
from collections import Counter
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .preference_coverage import STRATEGY as COVERAGE_STRATEGY
from .preference_coverage import coverage_targets
from .preference_models import (
    PreferenceChoice,
    PreferenceControl,
    PreferenceEvent,
    PreferenceOperation,
    PreferenceParticipant,
    PreferenceRiskSignal,
    PreferenceTask,
)
from .preference_subjects import subjects


class PreferenceError(Exception):
    def __init__(self, code, detail, status=400, **extra):
        super().__init__(detail)
        self.code, self.detail, self.status, self.extra = code, detail, status, extra


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def iso(value):
    return value.isoformat() if value else None


def control(lock=False):
    query = PreferenceControl.objects.select_for_update() if lock else PreferenceControl.objects
    return query.get_or_create(pk=1)[0]


def catalog_payload(current=None):
    current = current if current is not None else control()
    if not current.catalog_id:
        return None
    payload = copy.deepcopy(current.catalog.payload)
    payload["subjects"] = list(subjects(payload).values())
    for person in payload["persons"]:
        if not person.get("form_catalog_version"):
            _, _, person["form_catalog_version"] = choice_context(payload, "form", person["id"])
    return payload


def require_catalog(current):
    if not current.catalog_id:
        raise PreferenceError("catalog_unavailable", "候选名录尚未发布。", 503)
    return current.catalog.payload


def check_write(current, section):
    if not settings.PREFERENCES_ENABLED or not current.reads_enabled or not current.writes_enabled or not getattr(current, f"{section}_enabled"):
        raise PreferenceError("writes_paused", "此项登记暂时暂停，请稍后再试。", 503)


def eligible_people(catalog):
    return {p["id"]: p for p in catalog["persons"] if p.get("eligible", True)}


def week_start(now):
    local = now.astimezone(ZoneInfo("Asia/Shanghai"))
    return (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def quota(participant, now=None):
    now = now or timezone.now()
    start = week_start(now)
    issued = list(PreferenceTask.objects.filter(participant=participant, issued_at__gt=now - timedelta(days=settings.PREFERENCE_ROLLING_DAYS))
                  .exclude(status="void").values_list("issued_at", flat=True))
    weekly = sum(t >= start for t in issued)
    rolling = len(issued)
    return {"weekly_limit": settings.PREFERENCE_WEEKLY_LIMIT, "weekly_used": weekly,
            "rolling_limit": settings.PREFERENCE_ROLLING_LIMIT, "rolling_used": rolling,
            "weekly_resets_at": iso(start + timedelta(days=7)),
            "rolling_recovers_at": iso(min(issued) + timedelta(days=settings.PREFERENCE_ROLLING_DAYS)) if issued else None,
            "remaining": max(0, min(settings.PREFERENCE_WEEKLY_LIMIT - weekly,
                                     settings.PREFERENCE_ROLLING_LIMIT - rolling)),
            "person_limit": settings.PREFERENCE_PERSON_LIMIT, "rolling_days": settings.PREFERENCE_ROLLING_DAYS}


def task_data(task):
    if not task:
        return None
    people = {p["id"]: p for p in task.catalog.payload["persons"]}
    candidates = subjects(task.catalog.payload)
    return {"id": str(task.pk), "left": candidates.get(task.left_subject_id, people[task.left_id]),
            "right": candidates.get(task.right_subject_id, people[task.right_id]),
            "left_subject_id": task.left_subject_id, "right_subject_id": task.right_subject_id,
            "left_id": task.left_id, "right_id": task.right_id, "catalog_version": task.catalog_id,
            "issued_at": iso(task.issued_at), "expires_at": iso(task.expires_at), "status": task.status,
            "outcome": task.outcome or None, "winner_id": task.winner_id or None,
            "accepted_at": iso(task.accepted_at), "risk_status": task.risk_status}


def support_data(participant):
    current = control()
    candidates = subjects(current.catalog.payload) if current.catalog_id else {}
    def owners(ids):
        return {candidates[sid]["person_id"] for sid in ids if sid in candidates}
    return {"support_ids": sorted(set(participant.support_ids) | owners(participant.subject_support_ids)),
            "favorite_ids": sorted(set(participant.favorite_ids) | owners(participant.subject_favorite_ids)),
            "legacy_support_ids": participant.support_ids, "legacy_favorite_ids": participant.favorite_ids,
            "subject_support_ids": participant.subject_support_ids, "subject_favorite_ids": participant.subject_favorite_ids,
            "version": participant.support_version, "modified_at": iso(participant.support_modified_at),
            "next_change_at": iso(participant.support_modified_at + timedelta(hours=settings.PREFERENCE_COOLDOWN_HOURS))
            if participant.support_modified_at else None, "risk_status": participant.risk_status,
            "support_limit": settings.PREFERENCE_SUPPORT_LIMIT, "favorite_limit": settings.PREFERENCE_FAVORITE_LIMIT}


def choice_context(catalog, kind, object_id):
    if kind not in ("form", "skin"):
        raise PreferenceError("invalid_kind", "未知的偏好类型。")
    rows = catalog["persons"] if kind == "form" else catalog["forms"]
    obj = next((r for r in rows if r["id"] == object_id), None)
    if obj is None:
        raise PreferenceError("object_unavailable", "该人物或形态不在当前名录中。", 404)
    options = [r for r in (catalog["forms"] if kind == "form" else catalog["appearances"])
               if r["person_id" if kind == "form" else "form_id"] == object_id and r.get("eligible", True)]
    fallback = "forms-" + digest(sorted(r["id"] for r in options))[:32] if kind == "form" else catalog["version"]
    version = obj.get("form_catalog_version" if kind == "form" else "catalog_version") or fallback
    return obj, {r["id"] for r in options}, version


def choice_data(choice, catalog=None):
    if choice is None:
        return {"version": 0, "action": "withdraw", "choice_id": None, "catalog_version": None,
                "confirmed": False, "next_change_at": None}
    confirmed, available = False, False
    if catalog:
        try:
            _, options, current_version = choice_context(catalog, choice.kind, choice.object_id)
            available = choice.action == "none" or choice.choice_id in options
            confirmed = available and choice.catalog_version == current_version and choice.action != "withdraw"
        except PreferenceError:
            pass
    return {"kind": choice.kind, "object_id": choice.object_id, "version": choice.version,
            "action": choice.action, "choice_id": choice.choice_id or None,
            "catalog_version": choice.catalog_version, "confirmed": confirmed, "available": available,
            "modified_at": iso(choice.modified_at), "next_change_at": iso(choice.modified_at + timedelta(
                hours=settings.PREFERENCE_COOLDOWN_HOURS)) if choice.modified_at else None}


def state(participant):
    now, current = timezone.now(), control()
    cat = current.catalog.payload if current.catalog_id else None
    pending = PreferenceTask.objects.filter(participant=participant, status="pending", expires_at__gt=now).first()
    return {"server_time": iso(now), "quota": quota(participant, now), "pending_task": task_data(pending),
            "supports": support_data(participant), "choices": [choice_data(c, cat) for c in PreferenceChoice.objects.filter(participant=participant)],
            "risk_status": participant.risk_status, "catalog_version": current.catalog_id,
            "writes_enabled": current.writes_enabled, "task_enabled": current.tasks_enabled,
            "cooldown_hours": settings.PREFERENCE_COOLDOWN_HOURS}


def operation(participant_id, key, scope, body, callback):
    if not isinstance(key, str) or not 8 <= len(key) <= 100:
        raise PreferenceError("operation_key_required", "请提供有效操作标识。")
    fingerprint = digest({"scope": scope, "body": body})
    with transaction.atomic():
        # 所有写服务遵守 control → participant 顺序，与发布/重算一致。
        current = control(lock=True)
        participant = PreferenceParticipant.objects.select_for_update().get(pk=participant_id)
        old = PreferenceOperation.objects.filter(participant=participant, key=key).first()
        if old:
            if old.digest != fingerprint:
                raise PreferenceError("operation_conflict", "同一操作标识不能用于不同内容。", 409)
            return old.response
        response = callback(participant, current)
        PreferenceOperation.objects.create(participant=participant, key=key, digest=fingerprint, response=response)
        return response


def audit(participant, kind, before, after, object_id="", reason="", actor=None):
    PreferenceEvent.objects.create(participant=participant, kind=kind, before=before, after=after,
                                   object_id=object_id, reason=reason, actor=actor)


def invalidate_tasks(current, now):
    cat = require_catalog(current)
    valid = eligible_people(cat)
    paused = set(current.paused_objects)
    for task in PreferenceTask.objects.select_for_update().filter(status="pending"):
        if task.catalog_id != current.catalog_id or task.left_id not in valid or task.right_id not in valid or {task.left_id, task.right_id} & paused or not task_subjects_available(task, cat, paused):
            task.status, task.void_reason = "void", "candidate_or_resource_unavailable"
            task.save(update_fields=["status", "void_reason"])
            audit(task.participant, "task_void", {"status": "pending"}, {"status": "void"}, str(task.pk), task.void_reason)


def task_subjects_available(task, catalog, paused):
    candidates = subjects(catalog)
    return all(not sid or (sid in candidates and candidates[sid]["person_id"] == pid
                          and sid not in paused and candidates[sid].get("form_id") not in paused)
               for sid, pid in ((task.left_subject_id, task.left_id), (task.right_subject_id, task.right_id)))


def issue_task(participant, current):
    check_write(current, "tasks")
    cat, now = require_catalog(current), timezone.now()
    pending = PreferenceTask.objects.filter(participant=participant, status="pending").first()
    if pending:
        valid = eligible_people(cat)
        if pending.catalog_id != current.catalog_id or pending.left_id not in valid or pending.right_id not in valid or {pending.left_id, pending.right_id} & set(current.paused_objects) or not task_subjects_available(pending, cat, current.paused_objects):
            pending.status, pending.void_reason = "void", "candidate_or_resource_unavailable"
            pending.save(update_fields=["status", "void_reason"])
            audit(participant, "task_void", {}, {"reason": pending.void_reason}, str(pending.pk))
        elif pending.expires_at <= now:
            pending.status = "expired"
            pending.save(update_fields=["status"])
        else:
            return {"task": task_data(pending), "quota": quota(participant, now)}
    remaining = quota(participant, now)
    if not remaining["remaining"]:
        raise PreferenceError("quota_exhausted", "本期正式比较已用完，可以继续个人练习。", 409, quota=remaining)
    recent = list(PreferenceTask.objects.filter(participant=participant, issued_at__gt=now - timedelta(days=settings.PREFERENCE_ROLLING_DAYS))
                  .exclude(status="void").values("left_id", "right_id", "pair_key"))
    counts = Counter(pid for row in recent for pid in (row["left_id"], row["right_id"]))
    pairs = set(PreferenceTask.objects.filter(participant=participant,
                issued_at__gt=now - timedelta(days=settings.PREFERENCE_PAIR_REPEAT_DAYS))
                .exclude(status="void").values_list("pair_key", flat=True))
    candidates = {sid: row for sid, row in subjects(cat).items()
                  if sid not in current.paused_objects and row.get("form_id") not in current.paused_objects}
    by_person = {pid: [sid for sid, row in candidates.items() if row["person_id"] == pid] for pid in eligible_people(cat)}
    people = [pid for pid in eligible_people(cat) if by_person[pid] and counts[pid] < settings.PREFERENCE_PERSON_LIMIT and pid not in current.paused_objects]
    rng = secrets.SystemRandom()
    rng.shuffle(people)
    strategy = "uniform-v1"
    targets, coverage_details = [(pid, None) for pid in people], {}
    if rng.random() < settings.PREFERENCE_COVERAGE_FRACTION:
        strategy = COVERAGE_STRATEGY
        targets, coverage_details = coverage_targets(current, participant, candidates, people, now, rng)
    selected = None
    for left, target_subject in targets:
        opponents = [right for right in people if right != left and "|".join(sorted((left, right))) not in pairs]
        rng.shuffle(opponents)
        for right in opponents:
            left_subjects = [target_subject] if target_subject else by_person[left]
            available = [(a, b) for a in left_subjects for b in by_person[right] if "|".join(sorted((a, b))) not in pairs]
            if available:
                selected = list(rng.choice(available))
                break
        if selected:
            break
    if selected is None:
        raise PreferenceError("no_eligible_pair", "暂时没有符合规则的新题，可以稍后再来。", 409, quota=remaining)
    rng.shuffle(selected)
    task = PreferenceTask.objects.create(participant=participant, catalog=current.catalog,
        left_id=candidates[selected[0]]["person_id"], right_id=candidates[selected[1]]["person_id"],
        left_subject_id=selected[0], right_subject_id=selected[1], pair_key="|".join(sorted(selected)), strategy=strategy, issued_at=now,
        expires_at=now + timedelta(hours=settings.PREFERENCE_TASK_HOURS), risk_status=participant.risk_status)
    if strategy == COVERAGE_STRATEGY:
        audit(participant, "coverage_task_issued", {}, {"strategy": strategy, **coverage_details[target_subject]}, str(task.pk))
    return {"task": task_data(task), "quota": quota(participant, now)}


def answer_task(participant, current, task_id, body):
    check_write(current, "tasks")
    task = PreferenceTask.objects.filter(pk=task_id, participant=participant).first()
    if not task:
        raise PreferenceError("task_not_found", "题目不存在。", 404)
    outcome = body.get("outcome")
    winner = body.get("winner_id") or ""
    if outcome not in ("choose", "skip", "unfamiliar", "unfamiliar_left", "unfamiliar_right", "unfamiliar_both", "tie") or (outcome == "choose" and winner not in (task.left_id, task.right_id)) or (outcome != "choose" and winner):
        raise PreferenceError("invalid_answer", "请选择其中一位或跳过。")
    if task.status == "answered":
        if task.outcome == outcome and task.winner_id == winner:
            return {"task": task_data(task), "quota": quota(participant)}
        raise PreferenceError("task_already_answered", "这道题已处理，请刷新记录。", 409)
    if task.status != "pending" or task.expires_at <= timezone.now():
        raise PreferenceError("task_expired", "这道题已过期或作废，请获取新题。", 409)
    eligible = eligible_people(require_catalog(current))
    if task.catalog_id != current.catalog_id or task.left_id not in eligible or task.right_id not in eligible or {task.left_id, task.right_id} & set(current.paused_objects) or not task_subjects_available(task, require_catalog(current), current.paused_objects):
        raise PreferenceError("candidate_unavailable", "候选或资源暂不可用，请重新获取题目。", 409)
    recent_answers = list(PreferenceTask.objects.filter(participant=participant, status="answered",
        accepted_at__gt=timezone.now() - timedelta(minutes=5)).values_list("issued_at", "accepted_at"))
    rapid = sum((accepted - issued).total_seconds() < 1 for issued, accepted in recent_answers)
    if (participant.risk_status == "accepted" and rapid >= 8 and
            PreferenceRiskSignal.objects.filter(participant=participant, signal="identity_creation_burst").exists()):
        participant.risk_status = "pending"
        participant.save(update_fields=["risk_status"])
        PreferenceTask.objects.filter(participant=participant).update(risk_status="pending")
        current.revision += 1
        current.save(update_fields=["revision"])
        audit(participant, "risk_hold", {"risk_status": "accepted"}, {"risk_status": "pending"},
              reason="new_identity_burst_and_repeated_subsecond_answers")
    task.status, task.outcome, task.winner_id = "answered", outcome, winner
    task.accepted_at, task.risk_status = timezone.now(), participant.risk_status
    task.save(update_fields=["status", "outcome", "winner_id", "accepted_at", "risk_status"])
    return {"task": task_data(task), "quota": quota(participant)}


def expect_version(actual, body, latest):
    if type(body.get("version")) is not int or body["version"] != actual:
        raise PreferenceError("version_conflict", "状态已在其他页面更新，请核对最新内容。", 409, latest=latest)


def cooldown(modified, now):
    until = modified + timedelta(hours=settings.PREFERENCE_COOLDOWN_HOURS) if modified else now
    if until > now:
        raise PreferenceError("cooldown", "修改仍在冷却中。", 409, next_change_at=iso(until))


def update_supports(participant, current, body):
    check_write(current, "supports")
    cat, now = require_catalog(current), timezone.now()
    modern = any(key in body for key in ("subject_support_ids", "subject_favorite_ids", "legacy_support_ids", "legacy_favorite_ids"))
    if modern and ("support_ids" in body or "favorite_ids" in body):
        raise PreferenceError("invalid_supports", "请使用一份完整的形态支持名单。")
    if not modern and (participant.subject_support_ids or participant.subject_favorite_ids):
        raise PreferenceError("client_outdated", "支持名单已包含独立形态，请刷新页面后修改。", 409)
    supports = body.get("legacy_support_ids" if modern else "support_ids")
    favorites = body.get("legacy_favorite_ids" if modern else "favorite_ids")
    selected = body.get("subject_support_ids") if modern else []
    selected_favorites = body.get("subject_favorite_ids") if modern else []
    lists = (supports, favorites, selected, selected_favorites)
    if any(not isinstance(items, list) or any(not isinstance(p, str) for p in items)
           or len(set(items)) != len(items) for items in lists):
        raise PreferenceError("invalid_supports", "支持名单格式无效。")
    candidates = subjects(cat)
    if not set(supports) <= set(eligible_people(cat)) or not set(selected) <= candidates.keys():
        raise PreferenceError("candidate_unavailable", "名单中包含未开放的人物。")
    if not set(favorites) <= set(supports) or not set(selected_favorites) <= set(selected):
        raise PreferenceError("invalid_supports", "本命必须在支持名单中。")
    if modern and (not set(supports) <= set(participant.support_ids) or not set(favorites) <= set(participant.favorite_ids)):
        raise PreferenceError("invalid_supports", "旧人物登记只能保留或撤回；新增支持请选择具体形态。")
    selected_owners = {candidates[sid]["person_id"] for sid in selected}
    favorite_owners = [candidates[sid]["person_id"] for sid in selected_favorites]
    if (len(set(supports) | selected_owners) > settings.PREFERENCE_SUPPORT_LIMIT
            or len(set(favorites) | set(favorite_owners)) > settings.PREFERENCE_FAVORITE_LIMIT
            or len(favorite_owners) != len(set(favorite_owners))):
        raise PreferenceError("invalid_supports", "支持或本命超过人物名额，或同一人物标记了多个形态本命。")
    before = support_data(participant)
    expect_version(participant.support_version, body, before)
    if all(set(value) == set(getattr(participant, key)) for key, value in (
        ("support_ids", supports), ("favorite_ids", favorites),
        ("subject_support_ids", selected), ("subject_favorite_ids", selected_favorites))):
        return before
    cooldown(participant.support_modified_at, now)
    participant.support_ids, participant.favorite_ids = sorted(supports), sorted(favorites)
    participant.subject_support_ids, participant.subject_favorite_ids = sorted(selected), sorted(selected_favorites)
    participant.support_version += 1
    participant.support_modified_at = now
    participant.save(update_fields=["support_ids", "favorite_ids", "subject_support_ids", "subject_favorite_ids",
                                    "support_version", "support_modified_at"])
    after = support_data(participant)
    audit(participant, "support", before, after)
    return after


def update_choice(participant, current, kind, object_id, body, confirm=False):
    check_write(current, "choices")
    cat, now = require_catalog(current), timezone.now()
    obj, options, current_version = choice_context(cat, kind, object_id)
    choice = PreferenceChoice.objects.filter(participant=participant, kind=kind, object_id=object_id).first()
    before = choice_data(choice, cat)
    expect_version(choice.version if choice else 0, body, before)
    if body.get("catalog_version") != current_version:
        raise PreferenceError("catalog_conflict", "候选名录已更新，请重新核对。", 409, catalog_version=current_version)
    action = choice.action if confirm and choice else body.get("action")
    chosen = choice.choice_id if confirm and choice else (body.get("choice_id") or "")
    if not isinstance(action, str) or not isinstance(chosen, str) or action not in ("choose", "none", "withdraw") or (action == "choose" and chosen not in options) or (action != "choose" and chosen):
        raise PreferenceError("invalid_choice", "选项不属于当前候选名录。")
    if confirm and (not choice or choice.action == "withdraw"):
        raise PreferenceError("nothing_to_confirm", "没有可确认的原选择。", 409)
    if action != "withdraw" and (not obj.get("eligible", True) or not obj.get("complete", True) or len(options) < 2 or object_id in current.paused_objects):
        raise PreferenceError("choices_unavailable", "该对象的完整候选或图片尚不可用，暂不能登记。", 409)
    if choice and choice.action == action and choice.choice_id == chosen and choice.catalog_version == current_version:
        return before
    same_choice = choice and choice.action == action and choice.choice_id == chosen and action != "withdraw"
    correction = choice and choice.action == "choose" and choice.choice_id not in options
    if not same_choice and action != "withdraw" and not correction:
        cooldown(choice.modified_at if choice else None, now)
    if choice is None:
        choice = PreferenceChoice(participant=participant, kind=kind, object_id=object_id)
    choice.action, choice.choice_id, choice.catalog_version = action, chosen, current_version
    choice.version += 1
    if not same_choice:
        choice.modified_at = now
    choice.save()
    after = choice_data(choice, cat)
    audit(participant, "choice_correction" if correction else "choice", before, after, f"{kind}:{object_id}",
          "withdrawn_candidate" if correction else "")
    return after
