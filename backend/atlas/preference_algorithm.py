"""窗口内证据权重与综合指数。纯计算便于独立模拟，不改写原始票据。"""
import math
from collections import Counter, defaultdict


def weight_comparisons(rows, total_cap=50.0, person_cap=1.0):
    """同一身份/无序对只取最新明确判断；两个上限在整个窗口计算。"""
    if total_cap <= 0 or person_cap <= 0:
        raise ValueError("Contribution caps must be positive")
    latest = {}
    for index, row in enumerate(rows):
        if row.get("outcome", "choose") != "choose" or row["winner_id"] not in (row["left_id"], row["right_id"]):
            continue
        if row["left_id"] == row["right_id"]:
            continue
        key = (str(row["participant_id"]), *sorted((row["left_id"], row["right_id"])))
        order = (str(row.get("accepted_at", "")), str(row.get("id", index)).zfill(12))
        if key not in latest or order > latest[key][0]:
            latest[key] = (order, row)
    counts, degrees = Counter(), Counter()
    for (uid, left, right) in latest:
        counts[uid] += 1
        degrees[uid, left] += 1
        degrees[uid, right] += 1
    return [dict(row, weight=min(1.0, total_cap / counts[uid], person_cap / degrees[uid, left],
                                  person_cap / degrees[uid, right]))
            for (uid, left, right), (_, row) in sorted(latest.items())]


def effective_size(weights):
    """Kish 量只描述证据集中程度，不能当作独立真人或置信度保证。"""
    weights = list(weights)
    squares = sum(w * w for w in weights)
    return sum(weights) ** 2 / squares if squares else 0.0


def cluster_sample(rows, rng):
    groups = defaultdict(list)
    for row in rows:
        groups[str(row["participant_id"])].append(row)
    keys = sorted(groups)
    # 每次抽中是一份独立副本，保留预先计算的权重；此后不得再次按身份去重/封顶。
    return [row for _ in keys for row in groups[rng.choice(keys)]] if keys else []


def tied_percentiles(values):
    """中秩百分位：100 * (严格小于数 + (同值数 - 1)/2) / (N - 1)。"""
    if len(values) < 2:
        return {}
    counts = Counter(values.values())
    below, result = 0, {}
    for value, count in sorted(counts.items()):
        result[value] = 100 * (below + (count - 1) / 2) / (len(values) - 1)
        below += count
    return {pid: result[value] for pid, value in values.items()}


def composite_index(random_rows, support_rows, random_weight=.7, minimum_pool=3,
                    support_participants=0, minimum_support_participants=30):
    if not 0 <= random_weight <= 1:
        raise ValueError("Composite weight must be between zero and one")
    supports = {row["id"]: row["count"] for row in support_rows}
    reference = {row["id"]: row for row in random_rows if row["status"] == "ready"
                 and row.get("score") is not None and math.isfinite(row["score"]) and row["id"] in supports}
    valid = len(reference) >= minimum_pool and support_participants >= minimum_support_participants
    rp = tied_percentiles({pid: row["score"] for pid, row in reference.items()}) if valid else {}
    sp = tied_percentiles({pid: supports[pid] for pid in reference}) if valid else {}
    rows = []
    for original in random_rows:
        pid = original["id"]
        score = random_weight * rp[pid] + (1 - random_weight) * sp[pid] if pid in rp else None
        variants = {str(w): round(w * rp[pid] + (1 - w) * sp[pid], 6) for w in (.6, .7, .8)} if score is not None else {}
        rows.append({"id": pid, "score": round(score, 6) if score is not None else None, "rank": None,
                     "random_score": original.get("score"), "support_count": supports.get(pid),
                     "random_percentile": rp.get(pid), "support_percentile": sp.get(pid),
                     "comparisons": original.get("comparisons", 0),
                     "weighted_evidence": original.get("weighted_evidence", 0),
                     "participants": original.get("participants", 0),
                     "effective_participants": original.get("effective_participants", 0),
                     "status": "ready" if score is not None else original["status"] if pid not in reference else
                     "support_insufficient" if support_participants < minimum_support_participants else "reference_insufficient",
                     "weight_sensitivity": variants})
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0), r["id"]))
    previous, rank = None, None
    for position, row in enumerate(rows, 1):
        if row["score"] is None:
            continue
        if previous != row["score"]:
            rank = position
        row["rank"], previous = rank, row["score"]
    for row in rows:
        ranks = [1 + sum(other["weight_sensitivity"][str(w)] > row["weight_sensitivity"][str(w)]
                         for other in rows if other["score"] is not None) for w in (.6, .7, .8)] if row["score"] is not None else []
        row["sensitivity_rank_range"] = [min(ranks), max(ranks)] if ranks else None
        row["weight_unstable"] = bool(ranks and max(ranks) - min(ranks) >= max(3, math.ceil(len(reference) * .1)))
    return {"rows": rows, "reference_pool": sorted(reference), "status": "ready" if valid else "accumulating",
            "formula": f"C = {random_weight:.2f} × P_E(R84) + {1 - random_weight:.2f} × P_E(S_current)",
            "weights": {"random": random_weight, "support": 1 - random_weight},
            "normalization": "midrank_percentile_v1", "minimum_reference_size": minimum_pool,
            "minimum_support_participants": minimum_support_participants,
            "interpretation": "近期随机好感 + 当前支持；产品权重定义，不是统一84天民意或公平性保证。"}
