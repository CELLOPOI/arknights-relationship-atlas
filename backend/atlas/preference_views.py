"""喜好独立 API；公开汇总与匿名私有状态使用不同缓存策略。"""
import secrets
from datetime import timedelta
from functools import wraps
from io import BytesIO

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponseBase, JsonResponse
from django.urls import path
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .feedback_views import identity_key
from .preference_models import (
    PreferenceCatalog,
    PreferenceChoice,
    PreferenceParticipant,
    PreferenceRate,
    PreferenceRiskSignal,
    PreferenceSnapshot,
    PreferenceTask,
)
from .preference_services import (
    PreferenceError,
    answer_task,
    catalog_payload,
    choice_context,
    choice_data,
    control,
    digest,
    iso,
    issue_task,
    operation,
    state,
    support_data,
    task_data,
    update_choice,
    update_supports,
)
from .preference_statistics import algorithm_version, series_key, snapshot_data
from .preference_subjects import project_comparisons, subjects
from .public_cache import encode_json, public_json


def credential_hash(value):
    return salted_hmac("preference-credential", value, algorithm="sha256").hexdigest()


def participant_for(request):
    credential = request.COOKIES.get(settings.PREFERENCE_COOKIE_NAME, "")
    return PreferenceParticipant.objects.filter(credential_hash=credential_hash(credential)).first() if credential else None


def rate(request, scope, participant=None):
    now = timezone.now()
    # 来源只限制短时请求峰值，不作为身份或投票资格；不记录原始 IP。
    source = identity_key(request)
    limits = {"identity": (30, 600), "tasks": (60, 600), "answer": (120, 1200),
              "supports": (30, 300), "choice": (60, 600), "read": (600, 3000)}
    personal_limit, source_limit = limits[scope]
    subjects = [(f"source:{source}", source_limit)]
    if participant:
        subjects.append((f"participant:{participant.pk}", personal_limit))
    with transaction.atomic():
        for subject, limit in subjects:
            key = digest(f"{scope}:{subject}")
            guard, _ = PreferenceRate.objects.select_for_update().get_or_create(key=key, defaults={
                "window_started": now, "expires_at": now + timedelta(minutes=2)})
            if guard.window_started + timedelta(minutes=1) <= now:
                guard.count, guard.window_started = 0, now
            if guard.count >= limit:
                raise PreferenceError("rate_limited", "请求过于频繁，请稍后重试。", 429,
                                      retry_after=max(1, int((guard.window_started + timedelta(minutes=1) - now).total_seconds())))
            guard.count += 1
            guard.expires_at = now + timedelta(minutes=2)
            guard.save()
    return source


def endpoint(methods, private=False, scope="read", public=False):
    def decorate(func):
        @wraps(func)
        @require_http_methods(methods)
        @csrf_protect
        def wrapped(request, **kwargs):
            try:
                current = control()
                if not settings.PREFERENCES_ENABLED or not current.reads_enabled:
                    raise PreferenceError("preferences_paused", "喜好功能暂时暂停。", 503)
                request.preference_control = current
                participant = None if public else participant_for(request)
                if private and participant is None:
                    raise PreferenceError("identity_required", "请先初始化参与状态。", 401)
                request.preference_participant = participant
                rate(request, scope if request.method != "GET" else "read", participant)
                if request.method not in ("GET", "HEAD"):
                    if request.content_type != "application/json":
                        raise PreferenceError("json_required", "请求必须为 JSON。", 415)
                    body = request.read(32769)
                    if len(body) > 32768:
                        raise PreferenceError("body_too_large", "请求内容过大。", 413)
                    request._body, request._stream = body, BytesIO(body)
                    import json
                    try:
                        request.preference_body = json.loads(body)
                    except (ValueError, UnicodeDecodeError) as exc:
                        raise PreferenceError("invalid_json", "JSON 格式无效。") from exc
                    if not isinstance(request.preference_body, dict):
                        raise PreferenceError("invalid_body", "请求必须为字段对象。")
                value = func(request, **kwargs)
                response = value if isinstance(value, HttpResponseBase) else JsonResponse(value)
            except PreferenceError as exc:
                response = JsonResponse({"code": exc.code, "detail": exc.detail, **exc.extra}, status=exc.status)
                if exc.status == 429:
                    response["Retry-After"] = str(exc.extra["retry_after"])
            response.setdefault("Cache-Control", "private, no-store")
            if not public:
                response["Vary"] = "Cookie"
            return response
        return wrapped
    return decorate


def fields(body, allowed):
    if set(body) - set(allowed):
        raise PreferenceError("unknown_fields", "请求包含未声明字段。")


@ensure_csrf_cookie
@endpoint(["GET"])
def catalog(request):
    return {**runtime_payload(request.preference_control), "catalog": catalog_payload(request.preference_control)}


def runtime_payload(current):
    return {"catalog_version": current.catalog_id, "server_time": iso(timezone.now()), "config": {
        "weekly_limit": settings.PREFERENCE_WEEKLY_LIMIT, "rolling_limit": settings.PREFERENCE_ROLLING_LIMIT,
        "person_limit": settings.PREFERENCE_PERSON_LIMIT, "support_limit": settings.PREFERENCE_SUPPORT_LIMIT, "favorite_limit": settings.PREFERENCE_FAVORITE_LIMIT,
        "rolling_days": settings.PREFERENCE_ROLLING_DAYS, "coverage_fraction": settings.PREFERENCE_COVERAGE_FRACTION,
        "proximity_fraction": settings.PREFERENCE_PROXIMITY_FRACTION,
        "proximity_max_score_gap": settings.PREFERENCE_PROXIMITY_MAX_SCORE_GAP,
        "rest_interval": settings.PREFERENCE_REST_INTERVAL, "pair_repeat_days": settings.PREFERENCE_PAIR_REPEAT_DAYS,
        "cooldown_hours": settings.PREFERENCE_COOLDOWN_HOURS, "task_hours": settings.PREFERENCE_TASK_HOURS,
        "phase": "trial", "writes_enabled": current.writes_enabled, "tasks_enabled": current.tasks_enabled,
        "supports_enabled": current.supports_enabled, "choices_enabled": current.choices_enabled}}


@ensure_csrf_cookie
@endpoint(["GET"])
def runtime(request):
    return runtime_payload(request.preference_control)


@endpoint(["GET"], public=True)
def directory(request):
    current = request.preference_control
    if not current.catalog_id:
        raise PreferenceError("catalog_unavailable", "候选名录尚未发布。", 503)
    if request.GET.get("version") != current.catalog_id:
        raise PreferenceError("catalog_conflict", "候选名录已更新，请重新读取。", 409)
    revision = PreferenceCatalog.objects.values("version", "digest").get(pk=current.catalog_id)
    key = "preference-directory-v1-" + digest(revision)
    return public_json(request, key, lambda: encode_json({"catalog": catalog_payload(current)}))


def participant_state(participant):
    value = state(participant)
    value["choice_order_seed"] = salted_hmac("preference-order", str(participant.pk), algorithm="sha256").hexdigest()
    return value


@endpoint(["POST"], scope="identity")
def identity(request):
    fields(request.preference_body, [])
    participant = request.preference_participant
    credential = None
    if participant is None:
        credential = secrets.token_urlsafe(48)
        with transaction.atomic():
            current = control(lock=True)
            if not current.writes_enabled:
                raise PreferenceError("writes_paused", "参与登记暂时暂停。", 503)
            source = identity_key(request)
            recent = PreferenceRiskSignal.objects.filter(source_hash=source, signal="new_identity",
                created_at__gt=timezone.now() - timedelta(minutes=1)).count()
            # 仅短时大量新身份暂缓；共享来源与共同喜好本身不导致排除。
            participant = PreferenceParticipant.objects.create(credential_hash=credential_hash(credential),
                                                               risk_status="accepted")
            PreferenceRiskSignal.objects.create(participant=participant, source_hash=source, signal="new_identity")
            if recent >= 20:
                PreferenceRiskSignal.objects.create(participant=participant, source_hash=source, signal="identity_creation_burst")
    response = JsonResponse(participant_state(participant))
    if credential:
        response.set_cookie(settings.PREFERENCE_COOKIE_NAME, credential, max_age=60 * 60 * 24 * 365,
                            secure=settings.PREFERENCE_COOKIE_SECURE, httponly=True, samesite="Lax", path="/api/preferences/")
    return response


@endpoint(["GET"], private=True)
def me(request):
    return participant_state(request.preference_participant)


@endpoint(["POST"], private=True, scope="tasks")
def tasks(request):
    body = request.preference_body
    fields(body, ["operation_key"])
    return operation(request.preference_participant.pk, body.get("operation_key"), "tasks", body, issue_task)


@endpoint(["POST"], private=True, scope="answer")
def answer(request, task_id):
    body = request.preference_body
    fields(body, ["operation_key", "outcome", "winner_id"])
    return operation(request.preference_participant.pk, body.get("operation_key"), f"answer:{task_id}", body,
                     lambda p, c: answer_task(p, c, task_id, body))


@endpoint(["GET", "PUT"], private=True, scope="supports")
def supports(request):
    if request.method == "GET":
        return support_data(request.preference_participant)
    body = request.preference_body
    fields(body, ["operation_key", "version", "support_ids", "favorite_ids", "subject_support_ids",
                  "subject_favorite_ids", "legacy_support_ids", "legacy_favorite_ids"])
    return operation(request.preference_participant.pk, body.get("operation_key"), "supports", body,
                     lambda p, c: update_supports(p, c, body))


@endpoint(["GET", "PUT", "POST"], private=True, scope="choice")
def choices(request, kind, object_id, confirm=False):
    if confirm and request.method != "POST" or not confirm and request.method == "POST":
        raise PreferenceError("method_not_allowed", "请求方法无效。", 405)
    if request.method == "GET":
        current_catalog = catalog_payload()
        if current_catalog is None:
            raise PreferenceError("catalog_unavailable", "候选名录尚未发布。", 503)
        choice_context(current_catalog, kind, object_id)
        return choice_data(PreferenceChoice.objects.filter(participant=request.preference_participant,
                                                           kind=kind, object_id=object_id).first(), catalog_payload())
    body = request.preference_body
    fields(body, ["operation_key", "version", "catalog_version"] if confirm else
           ["operation_key", "version", "catalog_version", "action", "choice_id"])
    return operation(request.preference_participant.pk, body.get("operation_key"), f"choice:{kind}:{object_id}:{confirm}", body,
                     lambda p, c: update_choice(p, c, kind, object_id, body, confirm))


def result_query(request):
    kind = request.GET.get("kind", "random")
    window = request.GET.get("window", "84" if kind in ("random", "composite") else "0")
    object_id = request.GET.get("object_id", "")
    windows = ("28", "84") if kind == "random" else ("84",) if kind == "composite" else ("0",)
    if kind not in ("random", "support", "form", "skin", "composite") or window not in windows:
        raise PreferenceError("invalid_result", "统计类型或窗口无效。")
    if (kind in ("form", "skin")) != bool(object_id):
        raise PreferenceError("invalid_object", "请选择对应人物或形态。")
    scope = request.GET.get("scope", "person")
    if scope not in ("person", "form") or (kind in ("form", "skin") and scope != "person"):
        raise PreferenceError("invalid_scope", "统计对象口径无效。")
    return kind, int(window), object_id, scope


@endpoint(["GET"])
def rankings(request):
    kind, window, object_id, scope = result_query(request)
    query = PreferenceSnapshot.objects.filter(scope=scope, kind=kind, window=window, object_id=object_id)
    if request.GET.get("snapshot_id"):
        if not request.GET["snapshot_id"].isdigit():
            raise PreferenceError("invalid_snapshot", "快照标识无效。")
        query = query.filter(pk=int(request.GET["snapshot_id"]))
    current_catalog = control().catalog_id
    snapshot = query.first() if request.GET.get("snapshot_id") else (query.filter(catalog_version=current_catalog,
                algorithm_version=algorithm_version()).first() or query.filter(catalog_version=current_catalog).first() or query.first())
    delay = timedelta(minutes=settings.PREFERENCE_AGGREGATION_INTERVAL_MINUTES * 2)
    current = control()
    stale = snapshot and (snapshot.generated_at < timezone.now() - delay or snapshot.revision < current.revision
                          or snapshot.catalog_version != current.catalog_id or snapshot.algorithm_version != algorithm_version())
    status = "no_data" if snapshot is None else "delayed" if stale else "current"
    return {"scope": scope, "kind": kind, "window": window, "object_id": object_id, "snapshot": snapshot_data(snapshot), "status": status}


@endpoint(["GET"])
def trends(request):
    kind, window, object_id, scope = result_query(request)
    raw = PreferenceSnapshot.objects.filter(scope=scope, kind=kind, window=window, object_id=object_id).order_by("-cutoff", "-revision")
    # 先只读日期与口径字段，避免为筛选每日节点反序列化整个历史的榜单明细。
    metadata = raw.filter(cutoff__gte=timezone.now() - timedelta(days=180)).values_list(
        "pk", "cutoff", "scope", "catalog_version", "algorithm_version", "asset_version",
        "payload__reference_version", "revision")
    seen, selected_ids = set(), []
    for pk, cutoff, *series in metadata.iterator(chunk_size=512):
        key = (cutoff.date(), *series)
        if key not in seen:
            selected_ids.append(pk)
            seen.add(key)
        if len(selected_ids) == 180:
            break
    selected = raw.in_bulk(selected_ids)
    snapshots = [selected[pk] for pk in selected_ids if pk in selected]
    changes = {"7": None, "28": None}
    if kind in ("support", "composite") and snapshots:
        latest = next((s for s in snapshots if s.catalog_version == control().catalog_id
                       and s.algorithm_version == algorithm_version()), snapshots[0])
        for days in (7, 28):
            target = latest.cutoff - timedelta(days=days)
            baseline = raw.filter(cutoff__lte=target, cutoff__gt=target - timedelta(days=1),
                                  catalog_version=latest.catalog_version, algorithm_version=latest.algorithm_version,
                                  asset_version=latest.asset_version, revision=latest.revision).first()
            if baseline and series_key(baseline) == series_key(latest):
                metric = "score" if kind == "composite" else "count"
                before = {r["id"]: r.get(metric) for r in baseline.payload["rows"]}
                changes[str(days)] = {"baseline_at": iso(baseline.cutoff), "rows": [
                    {"id": r["id"], "delta": r[metric] - before[r["id"]]} for r in latest.payload["rows"]
                    if r.get(metric) is not None and before.get(r["id"]) is not None]}
    return {"snapshots": [snapshot_data(s) for s in reversed(snapshots)], "changes": changes}


@endpoint(["GET"])
def pairs(request):
    left, right, window = request.GET.get("left_id"), request.GET.get("right_id"), request.GET.get("window", "84")
    if not left or not right or left == right or window not in ("28", "84"):
        raise PreferenceError("invalid_pair", "请提供两位不同人物和有效窗口。")
    now = timezone.now()
    scope = request.GET.get("scope", "person")
    if scope not in ("person", "form"):
        raise PreferenceError("invalid_scope", "统计对象口径无效。")
    candidates = subjects(catalog_payload() or {"persons": [], "forms": [], "appearances": []})
    left_key, right_key = ("left_subject_id", "right_subject_id") if scope == "form" else ("left_id", "right_id")
    query = Q(**{left_key: left, right_key: right}) | Q(**{left_key: right, right_key: left})
    raw = PreferenceTask.objects.filter(query, outcome="choose", status="answered",
        accepted_at__gt=now - timedelta(days=int(window)), accepted_at__lte=now,
        risk_status="accepted", participant__risk_status="accepted").values(
            "left_id", "right_id", "left_subject_id", "right_subject_id", "winner_id")
    rows = list(project_comparisons(raw, scope, candidates))
    return {"scope": scope, "left_id": left, "right_id": right,
            "left_wins": sum(row["winner_id"] == left for row in rows),
            "right_wins": sum(row["winner_id"] == right for row in rows), "sample_size": len(rows), "window": int(window),
            "window_start": iso(now - timedelta(days=int(window))), "window_end": iso(now),
            "status": "observed" if rows else "no_data"}


@endpoint(["GET"], private=True)
def records(request):
    rows = PreferenceTask.objects.filter(participant=request.preference_participant, status="answered").order_by("-accepted_at", "-pk")
    if request.GET.get("cursor"):
        try:
            cursor = parse_datetime(request.GET["cursor"])
        except ValueError:
            cursor = None
        if cursor is None or timezone.is_naive(cursor):
            raise PreferenceError("invalid_cursor", "记录分页标识无效。")
        rows = rows.filter(accepted_at__lt=cursor)
    values = list(rows[:51])
    return {"records": [task_data(t) for t in values[:50]],
            "next_cursor": iso(values[49].accepted_at) if len(values) > 50 else None}


urlpatterns = [
    path("runtime/", runtime), path("directory/", directory),
    path("catalog/", catalog), path("identity/", identity), path("state/", me), path("tasks/", tasks),
    path("tasks/<uuid:task_id>/answer/", answer), path("supports/", supports),
    path("choices/<str:kind>/<str:object_id>/", choices),
    path("choices/<str:kind>/<str:object_id>/confirm/", choices, {"confirm": True}),
    path("rankings/", rankings), path("trends/", trends), path("pairs/", pairs), path("records/", records),
]
