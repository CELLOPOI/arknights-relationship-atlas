"""可重放离线校准；只生成内存中的合成判断，不写入参与记录或公共榜。"""
import json
import math
import random
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.test.utils import override_settings

from atlas.preference_algorithm import (
    cluster_sample,
    composite_index,
    effective_size,
    tied_percentiles,
    weight_comparisons,
)
from atlas.preference_statistics import analyze_random, fit_bt, parameters, quantile


def rank_error(ids, scores, truth):
    pairs = [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]
    return sum((scores[a] - scores[b]) * (truth[a] - truth[b]) > 0 for a, b in pairs) / len(pairs)


def bounded(rows, k=50, limit=1):
    weighted = weight_comparisons(rows, k, limit)
    total, person = Counter(), Counter()
    for row in weighted:
        total[row['participant_id']] += row['weight']
        for pid in (row['left_id'], row['right_id']):
            person[row['participant_id'], pid] += row['weight']
    assert max(total.values(), default=0) <= k + 1e-8
    assert max(person.values(), default=0) <= limit + 1e-8
    return weighted, {'raw': len(rows), 'deduplicated': len(weighted), 'evidence': round(sum(total.values()), 4),
                      'max_identity_weight': round(max(total.values(), default=0), 6),
                      'max_identity_person_weight': round(max(person.values(), default=0), 6)}


class Command(BaseCommand):
    help = 'Calibrate weighted BT and composite sensitivity with reproducible synthetic data, without DB writes.'

    def add_arguments(self, parser):
        parser.add_argument('--seed', type=int, default=20260923)
        parser.add_argument('--participants', type=int, default=600)
        parser.add_argument('--bootstrap', type=int, default=100)
        parser.add_argument('--output')

    def handle(self, *args, **options):
        if not 100 <= options['participants'] <= 10000 or not 20 <= options['bootstrap'] <= 1000:
            raise CommandError('Use 100–10000 participants and 20–1000 bootstrap samples.')
        rng = random.Random(options['seed'])
        ids = [f'synthetic-{i:02}' for i in range(32)]
        strengths = {pid: (i - 15.5) / 10 for i, pid in enumerate(ids)}
        cutoff = datetime(2026, 9, 23, 12, tzinfo=UTC)
        truth = {a: 100 * sum(1 / (1 + math.exp(strengths[b] - strengths[a])) for b in ids) / len(ids) for a in ids}
        rows = []

        def row(uid, left, right, winner=None, days=0, outcome='choose'):
            if winner is None:
                winner = left if rng.random() < 1 / (1 + math.exp(strengths[right] - strengths[left])) else right
            return {'id': len(rows) + rng.randrange(10000000), 'participant_id': str(uid), 'left_id': left,
                    'right_id': right, 'winner_id': winner, 'outcome': outcome,
                    'strategy': 'uniform-v1', 'accepted_at': cutoff - timedelta(days=days)}

        for uid in range(options['participants']):
            for _ in range(20):
                left, right = rng.sample(ids, 2)
                rows.append(row(uid, left, right, days=rng.randrange(84)))
        weighted, bounds = bounded(rows)
        scores, converged = fit_bt(ids, weighted)
        intervals = defaultdict(list)
        for _ in range(options['bootstrap']):
            values, ok = fit_bt(ids, cluster_sample(weighted, rng))
            converged &= ok
            for pid, score in values.items():
                intervals[pid].append(score)
        recovery = {'pair_order_recovery': rank_error(ids, scores, truth),
                    'mean_absolute_score_error': sum(abs(scores[p] - truth[p]) for p in ids) / len(ids),
                    'single_simulation_interval_coverage': sum(quantile(intervals[p], .025) <= truth[p] <= quantile(intervals[p], .975) for p in ids) / len(ids),
                    'converged': converged, **bounds}
        scenarios = {}
        target = ids[0]
        high = [row('one-high', a, b, winner=target if target in (a, b) else None, days=i % 84)
                for i in range(480) for a, b in [rng.sample(ids, 2)]]
        few = [row(f'few-{i}', target, ids[i % 31 + 1], target) for i in range(10)]
        newcomers = [row(f'new-{i}', target, ids[i % 31 + 1], target) for i in range(120)]
        repeated = [row('one-repeat', target, ids[i % 31 + 1], target, days=i % 84) for i in range(1440)]
        skipped = [row(f'skip-{i}', target, ids[i % 31 + 1], outcome='unfamiliar_both') for i in range(5000)]
        for name, extra in [('high_activity', high), ('ten_single_answers', few), ('120_new_identities', newcomers),
                            ('long_repetition_across_weeks', repeated), ('5000_skips', skipped)]:
            weights, check = bounded(rows + extra)
            estimates, ok = fit_bt(ids, weights)
            raw_estimates, _ = fit_bt(ids, [r for r in rows + extra if r['outcome'] == 'choose'])
            scenarios[name] = {**check, 'target_weighted_shift': estimates[target] - scores[target],
                               'target_unweighted_score': raw_estimates[target], 'converged': ok}
        one, _ = bounded([row('single', ids[0], ids[1], ids[0])])
        assert one[0]['weight'] == 1
        swapped = [{**r, 'left_id': r['right_id'], 'right_id': r['left_id']} for r in rows]
        reversed_scores, _ = fit_bt(ids, weight_comparisons(swapped))
        assert max(abs(scores[p] - reversed_scores[p]) for p in ids) < 1e-8
        calibration = []
        for k, limit in [(25, .5), (50, 1), (100, 2), (25, 1), (100, 1)]:
            weights, check = bounded(rows, k, limit)
            for prior in [.1, .5, 1.0]:
                estimates, ok = fit_bt(ids, weights, prior=prior)
                calibration.append({'K': k, 'L': limit, 'prior': prior, 'converged': ok,
                    'MAE': sum(abs(estimates[p] - truth[p]) for p in ids) / len(ids),
                    'order_recovery': rank_error(ids, estimates, truth), 'weighted_evidence': check['evidence']})
        catalog = {'version': 'synthetic-only', 'persons': [{'id': p, 'eligible': True} for p in ids + ['cold-new']]}
        with override_settings(PREFERENCE_BOOTSTRAP_SAMPLES=options['bootstrap']):
            windows = {str(days): analyze_random(catalog, cutoff, days, rows + repeated) for days in (28, 84)}
        window_report = {k: {field: v.get(field) for field in ['sample_size', 'raw_sample_size', 'weighted_evidence', 'participant_count', 'connected', 'reference_version']} | {
            'ready': sum(x['status'] == 'ready' for x in v['rows']),
            'cold_new': next(x for x in v['rows'] if x['id'] == 'cold-new')} for k, v in windows.items()}
        random_rows = [{'id': p, 'status': 'ready', 'score': scores[p]} for p in ids]
        # 偏斜支持人数用于暴露 min-max 被极大值牵动和百分位丢失量级差异的取舍。
        supports = [{'id': p, 'count': int(8 * (1.24 ** ((len(ids) - i) % len(ids))))} for i, p in enumerate(ids)]
        comp = composite_index(random_rows, supports, support_participants=600)
        normalizations = {}
        rr, ss = {x['id']: x['score'] for x in random_rows}, {x['id']: x['count'] for x in supports}
        for method in ['tied_percentile', 'minmax', 'log_support_minmax']:
            values = []
            for source, logarithm in [(rr, False), (ss, method == 'log_support_minmax')]:
                src = {p: math.log1p(v) if logarithm else v for p, v in source.items()}
                lo, hi = min(src.values()), max(src.values())
                values.append(tied_percentiles(src) if method == 'tied_percentile' else {p: 100 * (v - lo) / (hi - lo) for p, v in src.items()})
            for ratio in [.6, .7, .8]:
                result = {p: ratio * values[0][p] + (1 - ratio) * values[1][p] for p in ids}
                ordered = sorted(ids, key=lambda p: (-result[p], p))
                normalizations[f'{method}/{ratio}'] = {'top5': ordered[:5], 'ranks': {p: ordered.index(p) + 1 for p in ids}}
        reference = normalizations['tied_percentile/0.7']['ranks']
        for result in normalizations.values():
            result['maximum_rank_change_from_default'] = max(abs(reference[p] - result['ranks'][p]) for p in ids)
        wide_ids = [f'wide-{i}' for i in range(581)]
        wide_rows = [{'participant_id': 'one-broad', 'left_id': a, 'right_id': b, 'winner_id': a, 'outcome': 'choose',
                          'accepted_at': cutoff - timedelta(days=i % 84)}
                     for i in range(1440) for a, b in [rng.sample(wide_ids, 2)]]
        wide_caps = {str(k): bounded(wide_rows, k, 1)[1] for k in (25, 50, 100)}
        report = {'synthetic_only': True, 'writes_database': False, 'seed': options['seed'], 'parameters': parameters(),
                  'participants': options['participants'], 'bootstrap': options['bootstrap'], 'recovery': recovery,
                  'scenarios': scenarios, 'K_L_prior_calibration': calibration, 'wide_pool_581_global_cap': wide_caps, 'windows_and_cold_start': window_report,
                  'normalization_and_weight_sensitivity': normalizations,
                  'unstable_composite_rows': sum(x.get('weight_unstable', False) for x in comp['rows']),
                  'single_answer_weight': one[0]['weight'], 'left_right_max_difference': max(abs(scores[p] - reversed_scores[p]) for p in ids),
                  'cluster_ess_example': effective_size([1, 1, 1, .1]),
                  'decision': 'K=50/L=1/prior=0.5 保留为产品规则；原始30条、20加权证据、30标识、30聚类ESS、15对手及区间/敏感性门槛同时满足才排名。70/30及并列百分位是可解释的定义，不是最公平的证明。',
                  'limits': ['对输入贡献封顶不等于对分数影响封顶。', '集中创建匿名身份仍然可以改变结果；匿名标识不是真人身份。', '单次模拟的区间覆盖率不是经验证的总体95%覆盖保证。', '场景含历史重复记录；不表示当前派题允许突破展示或参与额度。']}
        content = json.dumps(report, ensure_ascii=False, indent=2)
        if options['output']:
            from pathlib import Path
            Path(options['output']).write_text(content + '\n')
        self.stdout.write(content)
        if not converged or recovery['pair_order_recovery'] < .9:
            raise CommandError('Synthetic model recovery did not meet the calibration check.')
