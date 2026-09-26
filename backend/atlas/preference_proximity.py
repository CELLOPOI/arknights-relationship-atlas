"""为全榜近分对象补直接对位；规则与解释边界见 PREFERENCES_STATISTICS.md。"""
import math
from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.db.models import Count, Q

from .preference_coverage import recent_form_snapshot
from .preference_models import PreferenceTask

STRATEGY = "proximity-form-v1"


def ranked(row):
    score, interval = row.get("score"), row.get("rank_interval")
    return (row.get("status") == "ready" and isinstance(score, (int, float)) and math.isfinite(score)
            and isinstance(interval, list) and len(interval) == 2
            and all(isinstance(value, (int, float)) and math.isfinite(value) for value in interval)
            and 1 <= interval[0] <= interval[1])


def proximity_pair(current, participant, candidates, people, pairs, now, rng):
    snapshot = recent_form_snapshot(current, now)
    if snapshot is None:
        return None, {"reason": "snapshot_unavailable"}
    available = set(people)
    rows = {row["id"]: row for row in snapshot.payload.get("rows", [])
            if row["id"] in candidates and candidates[row["id"]]["person_id"] in available and ranked(row)}
    if len(rows) < 2:
        return None, {"reason": "no_eligible_neighbor"}
    max_gap = settings.PREFERENCE_PROXIMITY_MAX_SCORE_GAP
    start = now - timedelta(days=settings.PREFERENCE_ROLLING_DAYS)
    exposure = Counter()
    issued = PreferenceTask.objects.filter(
        strategy=STRATEGY, issued_at__gt=start, issued_at__lte=now,
    ).exclude(status="void")
    # 待答、跳过和过期都占调度机会；只作轮转依据，不写进有效票数。
    for side in ("left", "right"):
        for group in issued.values(f"{side}_subject_id", f"{side}_id").annotate(displays=Count("pk")):
            sid = group[f"{side}_subject_id"]
            if sid in rows and candidates[sid]["person_id"] == group[f"{side}_id"]:
                exposure[sid] += group["displays"]
    seen = set()
    judgments = PreferenceTask.objects.filter(
        participant=participant, participant__risk_status="accepted", risk_status="accepted",
        status="answered", outcome="choose", accepted_at__lte=now,
        accepted_at__gt=now - timedelta(days=settings.PREFERENCE_PAIR_REPEAT_DAYS),
    )
    for left, right in judgments.values_list("left_subject_id", "right_subject_id"):
        seen.update((left, right))
    targets = list(rows)
    rng.shuffle(targets)
    targets.sort(key=lambda sid: (sid in seen, exposure[sid]))
    ordered = sorted(rows, key=lambda sid: rows[sid]["score"])
    scores = [rows[sid]["score"] for sid in ordered]
    # 按轮转优先级找第一个有合法近邻的目标，不预先枚举全榜的所有组合。
    for target in targets:
        score, interval = rows[target]["score"], rows[target]["rank_interval"]
        owner = candidates[target]["person_id"]
        opponents = []
        for sid in ordered[bisect_left(scores, score - max_gap):bisect_right(scores, score + max_gap)]:
            other = candidates[sid]["person_id"]
            bounds = rows[sid]["rank_interval"]
            if (owner != other and "|".join(sorted((owner, other))) not in pairs
                    and "|".join(sorted((target, sid))) not in pairs
                    and max(interval[0], bounds[0]) <= min(interval[1], bounds[1])):
                opponents.append(sid)
        if opponents:
            break
    else:
        return None, {"reason": "no_eligible_neighbor"}
    pair_keys = {sid: "|".join(sorted((target, sid))) for sid in opponents}
    # 只聚合已选目标的合法对位，避免在写锁内物化全榜历史或重新拟合。
    history = PreferenceTask.objects.filter(issued_at__lte=now, pair_key__in=pair_keys.values()).filter(
        Q(issued_at__gt=start) | Q(accepted_at__gt=start, accepted_at__lte=now),
    ).exclude(status="void")
    valid = Q(status="answered", outcome="choose", risk_status="accepted", participant__risk_status="accepted",
              accepted_at__gt=start, accepted_at__lte=now)
    counts = {group["pair_key"]: group for group in history.values("pair_key").annotate(
        participants=Count("participant_id", distinct=True, filter=valid),
        pending=Count("pk", filter=Q(status="pending", expires_at__gt=now)),
        displays=Count("pk", filter=Q(issued_at__gt=start)),
    )}
    evidence = {sid: counts.get(key, {"participants": 0, "pending": 0, "displays": 0})
                for sid, key in pair_keys.items()}
    rng.shuffle(opponents)
    opponent = min(opponents, key=lambda sid: (
        sid in seen, evidence[sid]["participants"] + evidence[sid]["pending"],
        exposure[sid], evidence[sid]["displays"], abs(rows[sid]["score"] - rows[target]["score"]),
    ))
    return [target, opponent], {
        "reason": "overlapping_rank_intervals", "target_subject_id": target, "opponent_subject_id": opponent,
        "snapshot_id": snapshot.pk, "snapshot_cutoff": snapshot.cutoff.isoformat(),
        "score_gap": round(abs(rows[target]["score"] - rows[opponent]["score"]), 6), "max_score_gap": max_gap,
        "direct_participants": evidence[opponent]["participants"], "pending_pair_tasks": evidence[opponent]["pending"],
        "pair_displays": evidence[opponent]["displays"],
        "subjects": {sid: {"score": rows[sid]["score"], "rank_interval": rows[sid]["rank_interval"],
                           "proximity_displays": exposure[sid], "previously_judged": sid in seen}
                     for sid in (target, opponent)},
    }
