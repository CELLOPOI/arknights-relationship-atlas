"""按形态补覆盖；复用已发布统计，不在持有写锁时重新拟合或物化全部票据。"""
from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.db.models import Count, Q

from .preference_models import PreferenceSnapshot, PreferenceTask

STRATEGY = "coverage-form-v2"


def sample_need(row):
    """估计派题优先级，单位为补充判断；不是承诺新增这些题就能达标。"""
    thresholds = {
        "comparisons": settings.PREFERENCE_MIN_COMPARISONS,
        "weighted_evidence": settings.PREFERENCE_MIN_WEIGHTED_EVIDENCE,
        "participants": settings.PREFERENCE_MIN_PARTICIPANTS,
        "effective_participants": settings.PREFERENCE_MIN_EFFECTIVE_PARTICIPANTS,
        "opponents": settings.PREFERENCE_MIN_OPPONENTS,
    }
    gaps = {key: max(0., threshold - row.get(key, 0)) for key, threshold in thresholds.items()}
    gaps["weighted_evidence"] /= min(1., settings.PREFERENCE_WEIGHT_PERSON_CAP)
    reason = max(gaps, key=gaps.get)
    if gaps[reason]:
        return gaps[reason], reason
    interval = row.get("interval")
    if interval and all(value is not None for value in interval):
        width = interval[1] - interval[0]
        if width > settings.PREFERENCE_MAX_INTERVAL_WIDTH:
            # 区间随样本量的平方根缩小只作调度近似，不改变正式区间或入榜条件。
            return row.get("comparisons", 0) * ((width / settings.PREFERENCE_MAX_INTERVAL_WIDTH) ** 2 - 1), "interval"
    return 0., "subject_exposure"


def coverage_targets(current, participant, candidates, people, now, rng):
    # 统计模块依赖写服务；仅在运行时取版本，避免模块初始化循环。
    from .preference_statistics import algorithm_version

    delay = timedelta(minutes=settings.PREFERENCE_AGGREGATION_INTERVAL_MINUTES * 2)
    snapshot = PreferenceSnapshot.objects.filter(
        scope="form", kind="random", object_id="", window=settings.PREFERENCE_ROLLING_DAYS,
        catalog_version=current.catalog_id, asset_version=current.catalog.payload["asset_version"],
        algorithm_version=algorithm_version(), revision=current.revision,
        cutoff__gt=now - delay, cutoff__lte=now, generated_at__lte=now,
    ).first()
    rows = {row["id"]: row for row in snapshot.payload.get("rows", [])} if snapshot else {}
    exposure, reserved = Counter(), Counter()
    issued = PreferenceTask.objects.filter(
        issued_at__gt=now - timedelta(days=settings.PREFERENCE_ROLLING_DAYS), issued_at__lte=now,
    ).exclude(status="void")
    for side in ("left", "right"):
        counts = {"displays": Count("pk")}
        if snapshot:
            # 新发、新受理及尚未过期待答临时占用补题预算，下一份快照重新校准。
            unaccounted = (Q(issued_at__gt=snapshot.cutoff) | Q(accepted_at__gt=snapshot.cutoff)
                           | Q(status="pending", expires_at__gt=now))
            counts["reserved"] = Count("pk", filter=unaccounted)
        for group in issued.values(f"{side}_subject_id", f"{side}_id").annotate(**counts):
            sid = group[f"{side}_subject_id"]
            if sid in candidates and candidates[sid]["person_id"] == group[f"{side}_id"]:
                exposure[sid] += group["displays"]
                reserved[sid] += group.get("reserved", 0)
    seen = set()
    judgments = PreferenceTask.objects.filter(
        participant=participant, participant__risk_status="accepted", risk_status="accepted",
        status="answered", outcome="choose", accepted_at__lte=now,
        accepted_at__gt=now - timedelta(days=settings.PREFERENCE_PAIR_REPEAT_DAYS),
    )
    for left, right in judgments.values_list("left_subject_id", "right_subject_id"):
        seen.update((left, right))
    available = set(people)
    targets = [sid for sid, row in candidates.items() if row["person_id"] in available]
    rng.shuffle(targets)
    details, priorities = {}, {}
    for sid in targets:
        row = rows.get(sid)
        # 名录刚更新或统计延迟时只按真实形态曝光补题，不使用旧版本缺口。
        need, reason = sample_need(row) if row is not None else (0., "subject_exposure")
        remaining = max(0., need - reserved[sid])
        tier = 2 if remaining == 0 else 1 if reason == "interval" else 0
        priorities[sid] = (tier, sid in seen, -remaining, exposure[sid])
        details[sid] = {
            "target_subject_id": sid, "reason": reason,
            "snapshot_id": snapshot.pk if row is not None else None,
            "snapshot_cutoff": snapshot.cutoff.isoformat() if row is not None else None,
            "sample_need": round(need, 6), "reserved_displays": reserved[sid],
            "remaining_need": round(remaining, 6), "issued_displays": exposure[sid],
            "previously_judged": sid in seen,
            "sample_before": {key: row[key] for key in (
                "comparisons", "weighted_evidence", "participants", "effective_participants", "opponents", "interval",
            ) if key in row} if row is not None else {},
        }
    targets.sort(key=priorities.__getitem__)
    return [(candidates[sid]["person_id"], sid) for sid in targets], details
