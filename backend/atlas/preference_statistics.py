"""可回放的真实汇总；Bradley–Terry 收缩与按参与标识聚类重采样。"""
import math
import random
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import timedelta

import numpy as np
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .preference_algorithm import composite_index, effective_size, weight_comparisons
from .preference_models import PreferenceEvent, PreferenceParticipant, PreferenceSnapshot, PreferenceTask
from .preference_services import (
    PreferenceError,
    choice_context,
    control,
    digest,
    eligible_people,
    iso,
    require_catalog,
)
from .preference_solver import PreparedBT
from .preference_subjects import project_comparisons, subjects

ALGORITHM = "bt-dual-scope-v4"


def parameters():
    return {"total_cap": settings.PREFERENCE_WEIGHT_TOTAL_CAP, "person_cap": settings.PREFERENCE_WEIGHT_PERSON_CAP,
            "prior": settings.PREFERENCE_BT_PRIOR, "min_comparisons": settings.PREFERENCE_MIN_COMPARISONS,
            "min_evidence": settings.PREFERENCE_MIN_WEIGHTED_EVIDENCE,
            "min_participants": settings.PREFERENCE_MIN_PARTICIPANTS,
            "min_effective_participants": settings.PREFERENCE_MIN_EFFECTIVE_PARTICIPANTS,
            "min_opponents": settings.PREFERENCE_MIN_OPPONENTS,
            "max_interval_width": settings.PREFERENCE_MAX_INTERVAL_WIDTH,
            "max_sensitivity_shift": settings.PREFERENCE_MAX_SENSITIVITY_SHIFT,
            "bootstrap_samples": settings.PREFERENCE_BOOTSTRAP_SAMPLES,
            "solver_max_iterations": settings.PREFERENCE_BT_MAX_ITERATIONS,
            "solver_tolerance": settings.PREFERENCE_BT_TOLERANCE,
            "solver_gradient_tolerance": settings.PREFERENCE_BT_GRADIENT_TOLERANCE,
            "composite_random_weight": settings.PREFERENCE_COMPOSITE_RANDOM_WEIGHT,
            "composite_min_pool": settings.PREFERENCE_COMPOSITE_MIN_POOL,
            "composite_min_support_participants": settings.PREFERENCE_COMPOSITE_MIN_SUPPORT_PARTICIPANTS,
            "registration_min_participants": settings.PREFERENCE_REGISTRATION_MIN_PARTICIPANTS}


def algorithm_version():
    return f"{ALGORITHM}-{digest(parameters())[:12]}"


def series_key(snapshot):
    return (snapshot.scope, snapshot.catalog_version, snapshot.algorithm_version, snapshot.asset_version,
            snapshot.payload.get("reference_version"), snapshot.revision)


def solver_parameters():
    return {"prior": settings.PREFERENCE_BT_PRIOR,
            "max_iterations": settings.PREFERENCE_BT_MAX_ITERATIONS,
            "tolerance": settings.PREFERENCE_BT_TOLERANCE,
            "gradient_tolerance": settings.PREFERENCE_BT_GRADIENT_TOLERANCE}


def fit_bt(ids, rows, max_iterations=None, tolerance=None, prior=None):
    """保留既有模拟/调用入口；完整汇总另保存求解诊断。"""
    options = solver_parameters()
    options.update({key: value for key, value in
                    (("max_iterations", max_iterations), ("tolerance", tolerance), ("prior", prior))
                    if value is not None})
    result = PreparedBT(ids, rows).fit(**options)
    return result.scores, result.converged


def bootstrap_scores(model, model_ids, rows, fitted, *, enabled):
    """按标识复制已加权证据，不重封顶；失败时整组区间暂不发布。"""
    requested = settings.PREFERENCE_BOOTSTRAP_SAMPLES
    diagnostics = {"requested": requested, "successful": 0, "failed": 0, "extended": 0,
                   "max_iterations": 0, "max_gradient_residual": 0.0}
    if not enabled or not rows:
        diagnostics["skipped"] = "no_comparisons" if not rows else "model_unavailable"
        return [], diagnostics
    if requested < 1:
        diagnostics["skipped"] = "no_resamples"
        return [], diagnostics
    # 截止点、窗口标签、原票顺序及左右摆放不改变同一有效输入的区间。
    # 种子包含匿名分组，仅在内存使用，不作为公开诊断输出。
    evidence = [(str(row["participant_id"]), *sorted((row["left_id"], row["right_id"])),
                 row["winner_id"], row["weight"]) for row in rows]
    rng = random.Random(digest({"model": ALGORITHM, "ids": model_ids, "evidence": evidence,
                               "prior": settings.PREFERENCE_BT_PRIOR}))
    groups = {uid: index for index, uid in enumerate(sorted({row[0] for row in evidence}))}
    row_groups = np.array([groups[row[0]] for row in evidence], dtype=np.intp)
    samples = []
    for _ in range(requested):
        counts = np.bincount([rng.randrange(len(groups)) for _ in groups], minlength=len(groups))
        result = model.fit(**solver_parameters(), initial=fitted.abilities, multipliers=counts[row_groups])
        diagnostics["successful" if result.converged else "failed"] += 1
        diagnostics["extended"] += result.iterations > 500
        diagnostics["max_iterations"] = max(diagnostics["max_iterations"], result.iterations)
        diagnostics["max_gradient_residual"] = max(diagnostics["max_gradient_residual"], result.gradient_residual)
        if result.converged:
            samples.append([result.scores[pid] for pid in model_ids])
    # 不删除失败重采样后悄悄以剩余样本构造区间，以免引入条件选择偏差。
    return samples if not diagnostics["failed"] else [], diagnostics


def attach_rank_intervals(results, model_ids, samples):
    """条件于本次固定合格集合；同分使用与点估计一致的竞争名次。"""
    reference = sorted(row["id"] for row in results if row["status"] == "ready")
    if not reference or not samples:
        return reference
    positions = {pid: index for index, pid in enumerate(model_ids)}
    values = np.round(np.asarray(samples)[:, [positions[pid] for pid in reference]], 6)
    ranks = np.array([np.searchsorted(np.sort(-sample), -sample, side="left") + 1 for sample in values])
    low, high = np.quantile(ranks, [.025, .975], axis=0)
    bounds = {pid: [math.floor(low[i]), math.ceil(high[i])] for i, pid in enumerate(reference)}
    for row in results:
        row["rank_interval"] = bounds.get(row["id"])
    return reference


def quantile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    position = (len(values) - 1) * fraction
    low = int(position)
    high = min(len(values) - 1, low + 1)
    return values[low] + (values[high] - values[low]) * (position - low)


def analyze_random(catalog, cutoff, window, all_rows):
    ids = sorted(eligible_people(catalog))
    start = cutoff - timedelta(days=window)
    id_set = set(ids)
    all_rows = [r for r in all_rows if r["left_id"] in id_set and r["right_id"] in id_set
                and start < r["accepted_at"] <= cutoff]
    raw = [r for r in all_rows if r["outcome"] == "choose"]
    rows = weight_comparisons(raw, settings.PREFERENCE_WEIGHT_TOTAL_CAP, settings.PREFERENCE_WEIGHT_PERSON_CAP)
    participants, opponents = defaultdict(set), defaultdict(set)
    compared, raw_compared, evidence, unfamiliar, displays = (Counter() for _ in range(5))
    clusters, group_weights = defaultdict(list), defaultdict(Counter)
    for row in all_rows:
        for pid in (row["left_id"], row["right_id"]):
            displays[pid] += 1
            raw_compared[pid] += row["outcome"] == "choose"
            unfamiliar[pid] += (row["outcome"] in ("unfamiliar", "unfamiliar_both")
                                or row["outcome"] == "unfamiliar_left" and pid == row["left_id"]
                                or row["outcome"] == "unfamiliar_right" and pid == row["right_id"])
    for row in rows:
        uid = str(row["participant_id"])
        clusters[uid].append(row)
        for pid, other in ((row["left_id"], row["right_id"]), (row["right_id"], row["left_id"])):
            compared[pid] += 1
            evidence[pid] += row["weight"]
            group_weights[pid][uid] += row["weight"]
            participants[pid].add(uid)
            opponents[pid].add(other)
    components, unseen = [], {pid for pid in ids if compared[pid]}
    while unseen:
        component, frontier = set(), [min(unseen)]
        while frontier:
            pid = frontier.pop()
            if pid in component:
                continue
            component.add(pid)
            frontier.extend(opponents[pid] - component)
        unseen -= component
        components.append(component)
    # 未出现的新人物不拖垮已有比较网络；不同连通分量不可通过先验硬接为全榜。
    connected = len(components) == 1
    model_ids = sorted(union) if (union := set().union(*components)) else []
    model = PreparedBT(model_ids, rows)
    fitted = model.fit(**solver_parameters())
    score, converged = fitted.scores, fitted.converged
    samples, bootstrap_diagnostics = bootstrap_scores(model, model_ids, rows, fitted,
                                                     enabled=connected and converged)
    bootstrap_converged = not rows or (bootstrap_diagnostics["requested"] > 0
                                      and bootstrap_diagnostics["successful"] == bootstrap_diagnostics["requested"]
                                      and bootstrap_diagnostics["failed"] == 0)
    sensitivity = []
    unweighted = uniform = None
    uniform_ids = set()
    if connected and converged:
        for scale in (.5, 2):
            alternative = weight_comparisons(raw, settings.PREFERENCE_WEIGHT_TOTAL_CAP * scale,
                                             settings.PREFERENCE_WEIGHT_PERSON_CAP * scale)
            sensitivity.append(PreparedBT(model_ids, alternative).fit(**solver_parameters(), initial=fitted.abilities))
        unweighted = PreparedBT(model_ids, [dict(r, weight=1) for r in rows]).fit(
            **solver_parameters(), initial=fitted.abilities)
        # 策略对照沿用原窗口权重，避免筛选后重新分配个人预算。
        uniform_rows = [row for row in rows if row["strategy"] == "uniform-v1"]
        if uniform_rows:
            uniform_ids = {pid for row in uniform_rows for pid in (row["left_id"], row["right_id"])}
            uniform = PreparedBT(model_ids, uniform_rows).fit(**solver_parameters(), initial=fitted.abilities)
    sensitivity_converged = not rows or (len(sensitivity) == 2 and all(result.converged for result in sensitivity))
    complete = converged and bootstrap_converged and sensitivity_converged
    bounds = np.quantile(np.asarray(samples), [.025, .975], axis=0) if samples and complete else None
    intervals = {pid: [float(bounds[0, i]), float(bounds[1, i])] for i, pid in enumerate(model_ids)} if bounds is not None else {}
    wins = Counter(row["winner_id"] for row in rows)
    results = []
    for pid in ids:
        interval = intervals.get(pid, [None, None])
        ess = effective_size(group_weights[pid].values())
        enough = (compared[pid] >= settings.PREFERENCE_MIN_COMPARISONS
                  and evidence[pid] >= settings.PREFERENCE_MIN_WEIGHTED_EVIDENCE
                  and len(participants[pid]) >= settings.PREFERENCE_MIN_PARTICIPANTS
                  and ess >= settings.PREFERENCE_MIN_EFFECTIVE_PARTICIPANTS
                  and len(opponents[pid]) >= settings.PREFERENCE_MIN_OPPONENTS)
        shift = max(abs(alternative.scores[pid] - score[pid]) for alternative in sensitivity) if pid in score and sensitivity and sensitivity_converged else None
        uncertain = interval[0] is not None and interval[1] - interval[0] > settings.PREFERENCE_MAX_INTERVAL_WIDTH
        sensitive = shift is not None and shift > settings.PREFERENCE_MAX_SENSITIVITY_SHIFT
        separated = compared[pid] > 0 and wins[pid] in (0, compared[pid])
        status = ("insufficient" if not enough else "disconnected" if not connected else
                  "solver_failed" if not complete else "separated" if separated else
                  "uncertain" if uncertain else "sensitive" if sensitive else "ready")
        # 不连通模型的跨分量分数没有可比较含义，保留样本事实而不公开伪精确数值。
        results.append({"id": pid, "score": round(score[pid], 6) if pid in score and connected and converged else None,
                        "interval": [round(x, 3) if x is not None and connected else None for x in interval],
                        "rank": None, "rank_interval": None,
                        "comparisons": compared[pid], "raw_comparisons": raw_compared[pid],
                        "weighted_evidence": round(evidence[pid], 6), "effective_participants": round(ess, 3),
                        "participants": len(participants[pid]), "opponents": len(opponents[pid]), "status": status,
                        "unfamiliar_count": unfamiliar[pid], "completed_displays": displays[pid],
                        "unfamiliar_share": unfamiliar[pid] / displays[pid] if displays[pid] else None,
                        "contribution_sensitivity": round(shift, 3) if shift is not None else None,
                        "unweighted_sensitivity": round(unweighted.scores[pid] - score[pid], 3) if pid in score and unweighted and unweighted.converged else None,
                        "strategy_sensitivity": round(uniform.scores[pid] - score[pid], 3) if pid in uniform_ids and uniform and uniform.converged else None})
    results.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0), r["id"]))
    rank, previous, tied_rank = 0, None, None
    for row in results:
        if row["status"] == "ready":
            rank += 1
            if row["score"] != previous:
                tied_rank = rank
            row["rank"], previous = tied_rank, row["score"]
    rank_reference = attach_rank_intervals(results, model_ids, samples if complete else [])
    first = min((r["accepted_at"] for r in all_rows), default=None)
    total_weights = [sum(row["weight"] for row in values) for values in clusters.values()]
    return {"rows": results, "sample_size": len(rows), "raw_sample_size": len(raw),
            "weighted_evidence": round(sum(evidence.values()) / 2, 6),
            "effective_participants": round(effective_size(total_weights), 3),
            "participant_count": len(clusters), "window_start": iso(start), "window_end": iso(cutoff), "observed_start": iso(first),
            "actual_days": min(window, max(1, math.ceil((cutoff - first).total_seconds() / 86400))) if first else 0,
            "status": "solver_failed" if connected and rows and not complete else "ready" if rank else "accumulating",
            "converged": converged,
            "bootstrap_converged": bootstrap_converged, "bootstrap_samples": settings.PREFERENCE_BOOTSTRAP_SAMPLES,
            "component_count": len(components), "connected": connected,
            "left_win_share": sum(row["winner_id"] == row["left_id"] for row in rows) / len(rows) if rows else None,
            "uncertainty_method": "participant_cluster_percentile_95", "reference_pool": model_ids,
            "rank_reference_pool": rank_reference,
            "rank_uncertainty_method": "participant_cluster_percentile_95_fixed_eligible_pool",
            "diagnostics": {"fit": fitted.diagnostics(), "bootstrap": bootstrap_diagnostics,
                            "sensitivity": {"converged": sensitivity_converged,
                                            "fits": [result.diagnostics() for result in sensitivity]},
                            "unweighted": unweighted.diagnostics() if unweighted else None,
                            "uniform": uniform.diagnostics() if uniform else None},
            "reference_version": digest(model_ids), "parameters": parameters(),
            "interpretation": "本站自愿参与样本。权重限制证据量，不保证真人等权或最终分数影响上限。"}


def comparison_rows(cutoff, window):
    return list(PreferenceTask.objects.filter(status="answered", accepted_at__gt=cutoff - timedelta(days=window),
        accepted_at__lte=cutoff, risk_status="accepted", participant__risk_status="accepted").values(
            "id", "left_id", "right_id", "left_subject_id", "right_subject_id", "winner_id",
            "participant_id", "outcome", "strategy", "accepted_at"))


def random_result(catalog, cutoff, window, scope="person", *, rows=None):
    rows = comparison_rows(cutoff, window) if rows is None else rows
    candidates = subjects(catalog)
    projected = list(project_comparisons(rows, scope, candidates))
    target = {**catalog, "persons": list(candidates.values())} if scope == "form" else catalog
    return {**analyze_random(target, cutoff, window, projected), "scope": scope}


def random_window_results(catalog, cutoff, scope, *, rows):
    """仅本轮同口径复用完整输入一致的窗口，不缓存跨轮状态。"""
    long = random_result(catalog, cutoff, 84, scope, rows=rows)
    short_start = cutoff - timedelta(days=28)
    # 包含跳过和不熟悉记录；恰在28天边界的记录仅属于84天窗口。
    # 判定使用本轮取出的全部原始行，宁可少复用，也不因投影/去重遗漏展示事实。
    if all(row["accepted_at"] > short_start for row in rows):
        short = deepcopy(long)
        short["window_start"] = iso(short_start)
        short["actual_days"] = min(28, long["actual_days"])
    else:
        short = random_result(catalog, cutoff, 28, scope, rows=rows)
    return {84: long, 28: short}


def current_states(cutoff):
    valid = set(PreferenceParticipant.objects.filter(risk_status="accepted", created_at__lte=cutoff).values_list("pk", flat=True))
    supports, choices = {}, {}
    for event in PreferenceEvent.objects.filter(participant_id__in=valid, created_at__lte=cutoff,
                                               kind__in=["support", "choice", "choice_correction"]).order_by("created_at", "pk"):
        if event.kind == "support":
            supports[event.participant_id] = event.after
        else:
            choices[(event.participant_id, event.object_id)] = event.after
    return supports, choices


def registration_results(catalog, cutoff, scope="person", *, states=None):
    supports, choices = current_states(cutoff) if states is None else states
    eligible = subjects(catalog) if scope == "form" else eligible_people(catalog)
    counts, favorites = Counter(), Counter()
    denominator = 0
    for value in supports.values():
        ids = set(value.get("subject_support_ids" if scope == "form" else "support_ids", [])) & eligible.keys()
        denominator += bool(ids)
        counts.update(ids)
        favorites.update(set(value.get("subject_favorite_ids" if scope == "form" else "favorite_ids", [])) & ids)
    yield "support", "", {"rows": [{"id": pid, "count": counts[pid], "favorite_count": favorites[pid],
                                      "share": counts[pid] / denominator if denominator else None} for pid in eligible],
                           "sample_size": sum(counts.values()), "participant_count": denominator,
                           "window_start": None, "window_end": iso(cutoff), "status": "current"}
    if scope == "form":
        return
    for kind, objects in (("form", catalog["persons"]), ("skin", catalog["forms"])):
        for obj in objects:
            _, options, version = choice_context(catalog, kind, obj["id"])
            counts, none_count, stale_count = Counter(), 0, 0
            for (_, target), value in choices.items():
                if not obj.get("eligible", True) or target != f"{kind}:{obj['id']}" or value["action"] == "withdraw":
                    continue
                if value["catalog_version"] != version:
                    stale_count += 1
                elif value["action"] == "none":
                    none_count += 1
                elif value["choice_id"] in options:
                    counts[value["choice_id"]] += 1
            total = sum(counts.values())
            yield kind, obj["id"], {"rows": [{"id": pid, "count": counts[pid], "share": counts[pid] / total if total else None}
                                             for pid in sorted(options)], "sample_size": total, "participant_count": total,
                                     "none_count": none_count, "unconfirmed_count": stale_count,
                                     "choice_catalog_version": version, "window_start": None, "window_end": iso(cutoff),
                                     "status": "ready" if total >= settings.PREFERENCE_REGISTRATION_MIN_PARTICIPANTS and len(options) > 1 else "insufficient"}


def snapshot_data(snapshot):
    if not snapshot:
        return None
    return {"id": snapshot.pk, "scope": snapshot.scope, "kind": snapshot.kind, "object_id": snapshot.object_id, "window": snapshot.window,
            "cutoff": iso(snapshot.cutoff), "generated_at": iso(snapshot.generated_at),
            "catalog_version": snapshot.catalog_version, "algorithm_version": snapshot.algorithm_version,
            "asset_version": snapshot.asset_version, "revision": snapshot.revision,
            "reason": snapshot.reason, "supersedes": snapshot.supersedes_id, "payload": snapshot.payload}


def aggregate(cutoff=None, reason="", catalog_version=None, force_revision=False):
    cutoff = cutoff or timezone.now().replace(second=0, microsecond=0)
    if force_revision and not reason.strip():
        raise PreferenceError("reason_required", "显式重算修订需要填写原因。")
    # 只在取数和发布时持有控制锁；拟合与重采样不能阻塞派题、投票或新身份。
    # durable 防止调用者的外层事务让取数阶段的锁延续到整个计算结束。
    with transaction.atomic(durable=True):
        current = control(lock=True)
        source_version = (current.catalog_id, current.revision, current.retained_since)
        catalog = require_catalog(current)
        if catalog_version:
            from .preference_models import PreferenceCatalog
            catalog = PreferenceCatalog.objects.get(pk=catalog_version, status="published").payload
        if cutoff > timezone.now():
            raise PreferenceError("future_cutoff", "统计截止点不能在未来。")
        if current.retained_since and cutoff - timedelta(days=84) < current.retained_since:
            raise PreferenceError("outside_retention", "所需明细已超出保留范围，不能声称完整重算。", 409)
        # 两种口径、两个窗口复用同一份已提交输入，离开事务后不再查询业务明细。
        rows = comparison_rows(cutoff, 84)
        states = current_states(cutoff)

    values = []
    for scope in ("person", "form"):
        scoped = [("random", "", window, payload)
                  for window, payload in random_window_results(catalog, cutoff, scope, rows=rows).items()]
        scoped += [(kind, object_id, 0, payload) for kind, object_id, payload in registration_results(catalog, cutoff, scope, states=states)]
        random_payload = scoped[0][3]
        support_payload = next(payload for kind, _, _, payload in scoped if kind == "support")
        composite = composite_index(random_payload["rows"], support_payload["rows"],
                                    settings.PREFERENCE_COMPOSITE_RANDOM_WEIGHT, settings.PREFERENCE_COMPOSITE_MIN_POOL,
                                    support_payload["participant_count"], settings.PREFERENCE_COMPOSITE_MIN_SUPPORT_PARTICIPANTS)
        composite.update({key: random_payload[key] for key in ("window_start", "window_end", "observed_start",
                          "actual_days", "sample_size", "raw_sample_size", "weighted_evidence", "participant_count")})
        composite.update(support_participant_count=support_payload["participant_count"],
                         parameters=parameters(), reference_version=digest(composite["reference_pool"]))
        scoped.append(("composite", "", 84, composite))
        values.extend((scope, *row) for row in scoped)
    version = algorithm_version()

    with transaction.atomic(durable=True):
        current = control(lock=True)
        if (current.catalog_id, current.revision, current.retained_since) != source_version:
            raise PreferenceError("aggregation_conflict", "统计期间名录、复核状态或保留范围发生变化，请重新运行统计。", 409)
        # 显式修订与整批快照一起提交；计算失败或版本冲突不能消耗修订号。
        if force_revision:
            current.revision += 1
            current.save(update_fields=["revision"])
        snapshots = []
        for scope, kind, object_id, window, payload in values:
            payload["scope"] = scope
            payload.setdefault("parameters", parameters())
            previous = PreferenceSnapshot.objects.filter(scope=scope, kind=kind, object_id=object_id, window=window, cutoff=cutoff,
                                                          catalog_version=catalog["version"], algorithm_version=version).first()
            if previous and previous.revision == current.revision:
                snapshots.append(previous)
                continue
            snapshots.append(PreferenceSnapshot.objects.create(scope=scope, kind=kind, object_id=object_id, window=window,
                cutoff=cutoff, catalog_version=catalog["version"], algorithm_version=version,
                asset_version=catalog["asset_version"], revision=current.revision, payload=payload,
                supersedes=previous, reason=reason))
        current.last_aggregation_at, current.aggregation_error = timezone.now(), ""
        current.save(update_fields=["last_aggregation_at", "aggregation_error"])
        return snapshots
