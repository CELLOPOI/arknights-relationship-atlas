<script setup lang="ts">
import { computed, ref, toRefs, watch } from 'vue';
import { request, timeText } from './api';
import { preferenceDraft } from './session';
import type { Catalog, Results, Snapshot } from './types';
const props = defineProps<{ catalog: Catalog; kind?: string; objectId?: string }>();
const emit = defineEmits<{ person: [id: string] }>();
const { selectedKind, selectedScope, windowDays, search, historyId } = toRefs(preferenceDraft(`results-v3:${props.kind || 'people'}:${props.objectId || ''}`, { selectedKind: 'composite', selectedScope: 'form', windowDays: 84, search: '', historyId: '' }));
const result = ref<Results | null>(null), history = ref<Snapshot[]>([]);
const changes = ref<Record<string, null | { baseline_at: string; rows: { id: string; delta: number }[] }>>({});
const loading = ref(false), error = ref('');
const left = ref(''), right = ref(''), pair = ref<{ left_wins: number; right_wins: number; sample_size: number; left_id: string; right_id: string } | null>(null);
let sequence = 0, pairSequence = 0;
const kind = computed(() => props.kind || selectedKind.value);
const resultScope = computed(() => props.kind || !props.catalog.subjects ? 'person' : selectedScope.value);
const pairPeople = computed(() => resultScope.value === 'form' ? props.catalog.subjects || [] : props.catalog.persons);
const resultPerson = (id: string) => props.catalog.subjects?.find(s => s.id === id)?.person_id || id;
const names = computed(() => new Map([...props.catalog.persons, ...props.catalog.forms, ...props.catalog.appearances, ...(props.catalog.subjects || [])].map(x => [x.id, x.name])));
const snapshot = computed(() => result.value?.snapshot);
const rows = computed(() => snapshot.value?.payload.rows.filter(x => (names.value.get(x.id) || x.id).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) || []);
const historical = computed(() => history.value.filter(s => s.payload.rows.some(x => x.id === historyId.value)));
const metric = (s: Snapshot) => { const row = s.payload.rows.find(x => x.id === historyId.value); return ['random', 'composite'].includes(kind.value) ? row?.score : row?.count; };
const series = (s: Snapshot) => [s.scope || 'person', s.catalog_version, s.algorithm_version, s.asset_version, s.payload.reference_version || '', s.revision].join(':');
const trendSegments = computed(() => {
  const items = historical.value;
  const values = items.map(metric).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const max = ['random', 'composite'].includes(kind.value) ? 100 : Math.max(1, ...values);
  const segments: { key: string; points: string }[] = [];
  let previous: Snapshot | undefined, points: string[] = [];
  const flush = () => { if (points.length > 1) segments.push({ key: `${segments.length}`, points: points.join(' ') }); points = []; };
  items.forEach((item, index) => {
    const value = metric(item);
    if (value == null || !Number.isFinite(value)) { flush(); previous = undefined; return; }
    if (previous && series(previous) !== series(item)) flush();
    points.push(`${20 + index / Math.max(1, items.length - 1) * 660},${160 - value / max * 140}`); previous = item;
  });
  flush(); return segments;
});
const number = (value?: number | null, digits = 1) => value == null ? '—' : value.toFixed(digits);
const change = (id: string, days: string) => { const value = changes.value[days]?.rows.find(x => x.id === id)?.delta; return value == null ? '暂无' : `${value > 0 ? '+' : ''}${number(value, kind.value === 'composite' ? 1 : 0)}`; };
function statusText(status?: string) {
  return ({ disconnected: '比较网络未连通', unstable: '结果不稳定', separated: '全胜或全败，继续积累', ready: '可供参考', support_insufficient: '当前支持样本不足', reference_insufficient: '合格参照不足' } as Record<string, string>)[status || ''] || '样本积累中';
}
async function load() {
  const id = ++sequence; pairSequence++; loading.value = true; error.value = ''; pair.value = null;
  result.value = null; history.value = []; changes.value = {};
  const query = new URLSearchParams({ scope: resultScope.value, kind: kind.value, window: String(kind.value === 'random' ? windowDays.value : kind.value === 'composite' ? 84 : 0), ...(props.objectId ? { object_id: props.objectId } : {}) });
  try {
    const [current, past] = await Promise.all([request<Results>(`rankings/?${query}`), request<{ snapshots: Snapshot[]; changes: typeof changes.value }>(`trends/?${query}`)]);
    if (id !== sequence) return;
    result.value = current; history.value = [...past.snapshots].sort((a, b) => a.cutoff.localeCompare(b.cutoff) || a.id - b.id); changes.value = past.changes;
    if (!historyId.value) historyId.value = current.snapshot?.payload.rows[0]?.id || '';
  } catch (reason) { if (id === sequence) error.value = (reason as Error).message; }
  finally { if (id === sequence) loading.value = false; }
}
async function loadPair() {
  if (!left.value || !right.value || left.value === right.value) { error.value = '请选择两个不同人物。'; return; }
  const id = ++pairSequence; error.value = '';
  try { const value = await request<NonNullable<typeof pair.value>>(`pairs/?${new URLSearchParams({ scope: resultScope.value, left_id: left.value, right_id: right.value, window: String(windowDays.value) })}`); if (id === pairSequence) pair.value = value; }
  catch (reason) { if (id === pairSequence) error.value = (reason as Error).message; }
}
watch(resultScope, () => { historyId.value = ''; left.value = ''; right.value = ''; });
watch([kind, resultScope, windowDays, () => props.objectId], load, { immediate: true });
</script>
<template>
  <section class="preference-results">
    <div v-if="!props.kind && catalog.subjects" class="pref-tabs" role="group" aria-label="人物合并方式">
      <button :aria-pressed="resultScope === 'form'" @click="selectedScope = 'form'">干员分开</button>
      <button :aria-pressed="resultScope === 'person'" @click="selectedScope = 'person'">人物合并</button>
    </div>
    <p v-if="!props.kind && catalog.subjects" class="pref-muted">{{ resultScope === 'person' ? '合并本体与异格的选择，同一参与者按人物去重。' : '本体与异格分别统计，只计实际出场形态的选择。' }}</p>
    <div class="pref-row">
      <div v-if="!props.kind" class="pref-tabs" aria-label="统计口径">
        <button v-for="item in [['composite','综合榜'],['random','随机好感'],['support','厨力支持']]" :key="item[0]" :aria-pressed="kind === item[0]" @click="selectedKind = item[0]!">{{ item[1] }}</button>
      </div>
      <div v-if="kind === 'random'" class="pref-tabs" aria-label="统计窗口"><button :aria-pressed="windowDays === 84" @click="windowDays = 84">近 84 天</button><button :aria-pressed="windowDays === 28" @click="windowDays = 28">近 28 天</button></div>
      <button class="pref-text" :disabled="loading" @click="load">刷新结果</button>
    </div>
    <p v-if="loading" role="status">正在读取统计…</p><p v-if="error" class="pref-error" role="alert">{{ error }}</p>
    <div v-if="!loading && !snapshot" class="preference-empty"><h3>样本积累中</h3><p>尚无已生成的统计快照。登记会保留，汇总后在这里显示真实结果。</p></div>
    <template v-if="snapshot && !loading">
      <h3 v-if="kind === 'composite'" class="composite-title">近期随机好感 + 当前支持</h3>
      <p class="pref-muted">截止 {{ timeText(snapshot.cutoff) }} · {{ snapshot.payload.participant_count }} 个{{ ['random','composite'].includes(kind) ? '随机参与' : '当前登记' }}标识<template v-if="kind === 'composite'"> · {{ snapshot.payload.support_participant_count }} 个当前支持标识</template><template v-if="['random','composite'].includes(kind)"> · 实际积累 {{ snapshot.payload.actual_days }} 天</template></p>
      <p v-if="result?.status === 'delayed'" class="pref-message">汇总延迟，以下是最近成功结果。</p>
      <p v-if="kind === 'composite'" class="pref-muted">近 84 天随机好感百分位 × {{ Math.round((snapshot.payload.parameters?.composite_random_weight ?? .7) * 100) }}% + 当前支持百分位 × {{ Math.round((1 - (snapshot.payload.parameters?.composite_random_weight ?? .7)) * 100) }}%。样本不足的人物保留分项，不补综合分；本命不额外加分。</p>
      <p v-else-if="kind === 'random'" class="pref-muted">{{ snapshot.payload.raw_sample_size ?? snapshot.payload.sample_size }} 次原始明确对位，去重后 {{ snapshot.payload.sample_size }} 次，{{ number(snapshot.payload.weighted_evidence) }} 份加权证据。区间按匿名标识成组重采样，不代表全体玩家民意误差。</p>
      <p v-else-if="kind === 'support'" class="pref-muted">当前有效登记，含长期未回访的名单。占比以至少支持一人的标识为分母，合计可超过 100%；本命单列。</p>
      <p v-else class="pref-muted">仅统计已确认当前完整名录的明确选择；没有明显偏好 {{ snapshot.payload.none_count || 0 }} 份，不纳入百分比分母。</p>
      <details v-if="['composite','random'].includes(kind)" class="pref-method">
        <summary>公式、样本条件与参照集合</summary>
        <p>每个窗口独立去重；每标识每无序{{ resultScope === 'form' ? '形态' : '人物' }}对取最新有效明确判断。每条权重 min(1, K/n, L/dᵢ, L/dⱼ)，K={{ snapshot.payload.parameters?.total_cap }}、L={{ snapshot.payload.parameters?.person_cap }}；周额度刷新不重置统计贡献。</p>
        <p>每人物至少 {{ snapshot.payload.parameters?.min_comparisons }} 次去重比较、{{ snapshot.payload.parameters?.min_evidence }} 份加权证据、{{ snapshot.payload.parameters?.min_participants }} 个标识、{{ snapshot.payload.parameters?.min_effective_participants }} 个有效标识量、{{ snapshot.payload.parameters?.min_opponents }} 个对手，并通过网络、收敛与区间检查。有效标识量描述证据集中度，不是独立真人数。</p>
        <p v-if="kind === 'composite'">同一合格集合内使用中秩百分位，同值同分。至少 {{ snapshot.payload.minimum_reference_size }} 位合格人物、{{ snapshot.payload.minimum_support_participants }} 个当前支持标识；零支持是实测零值。70/30 是本站的产品定义，权重敏感时显示 60/40、70/30、80/20 下的名次范围。</p>
        <p>参照集合 {{ snapshot.payload.reference_pool?.length || 0 }} 位 · 版本 {{ snapshot.payload.reference_version?.slice(0, 12) }}。搜索不改变参照集合；集合、参数、素材或修订变化时，趋势断开。</p>
        <p>{{ snapshot.payload.reference_pool?.map(id => names.get(id) || id).join('、') || '暂无可用参照集合。' }}</p>
        <p>随机窗口 {{ timeText(snapshot.payload.window_start) }} 至 {{ timeText(snapshot.payload.window_end) }}。<template v-if="kind === 'composite'">支持是同一截止点的当前登记，两项时间口径不同。</template></p>
      </details>
      <label class="pref-search"><span>查找结果</span><input v-model="search" type="search" placeholder="输入名称"></label>
      <div class="pref-table-scroll"><table class="pref-table"><thead><tr>
        <th>{{ kind === 'skin' ? '外观' : kind === 'form' || resultScope === 'form' ? '形态' : '人物' }}</th>
        <template v-if="kind === 'composite'"><th>状态 / 名次</th><th>综合指数</th><th>随机分 / 百分位</th><th>当前支持 / 百分位</th><th>加权证据 / 标识</th><th>7 / 28 天变化</th></template>
        <template v-else-if="kind === 'random'"><th>状态 / 名次</th><th>偏好分与区间</th><th>原始 / 去重对位</th><th>加权证据</th><th>标识 / 有效量 / 对手</th></template>
        <template v-else><th>选择数</th><th>占比</th><th v-if="kind === 'support'">本命</th><th v-if="kind === 'support'">7 / 28 天净变化</th></template>
      </tr></thead><tbody><tr v-for="row in rows" :key="row.id">
        <th><button v-if="['random','support','composite'].includes(kind)" class="pref-text" @click="emit('person', resultPerson(row.id))">{{ names.get(row.id) || row.id }}</button><template v-else>{{ names.get(row.id) || row.id }}</template></th>
        <template v-if="kind === 'composite'"><td>{{ row.rank ? `第 ${row.rank} 位` : statusText(row.status) }}</td><td>{{ number(row.score) }}<small v-if="row.weight_unstable" class="pref-sensitivity">权重敏感：第 {{ row.sensitivity_rank_range?.join('–') }} 位</small></td><td>{{ number(row.random_score) }} / {{ number(row.random_percentile) }}</td><td>{{ row.support_count ?? '—' }} / {{ number(row.support_percentile) }}</td><td>{{ number(row.weighted_evidence) }} / {{ row.participants }}</td><td>{{ change(row.id, '7') }} / {{ change(row.id, '28') }}</td></template>
        <template v-else-if="kind === 'random'"><td>{{ row.rank ? `第 ${row.rank} 位` : statusText(row.status) }}</td><td>{{ number(row.score) }}<span v-if="row.interval?.[0] != null && row.interval?.[1] != null">（{{ number(row.interval[0]) }}–{{ number(row.interval[1]) }}）</span></td><td>{{ row.raw_comparisons ?? row.comparisons }} / {{ row.comparisons }}</td><td>{{ number(row.weighted_evidence) }}</td><td>{{ row.participants }} / {{ number(row.effective_participants) }} / {{ row.opponents }}</td></template>
        <template v-else><td>{{ row.count || 0 }}</td><td>{{ row.share == null ? '—' : `${(row.share * 100).toFixed(1)}%` }}</td><td v-if="kind === 'support'">{{ row.favorite_count || 0 }}</td><td v-if="kind === 'support'">{{ change(row.id, '7') }} / {{ change(row.id, '28') }}</td></template>
      </tr></tbody></table></div>
      <p class="pref-muted">更新时间 {{ timeText(snapshot.generated_at) }} · 名录 {{ snapshot.catalog_version }} · 算法 {{ snapshot.algorithm_version }} · 修订 {{ snapshot.revision }}<template v-if="snapshot.reason"> · {{ snapshot.reason }}</template></p>
    </template>
    <details class="pref-history"><summary>历史趋势与版本节点</summary>
      <p v-if="history.length < 2" class="pref-muted">暂无足够历史快照，积累后可以查看趋势。</p>
      <template v-else><label class="pref-search"><span>查看对象</span><select v-model="historyId"><option v-for="row in snapshot?.payload.rows || []" :key="row.id" :value="row.id">{{ names.get(row.id) || row.id }}</option></select></label>
        <svg v-if="trendSegments.length" class="pref-trend" viewBox="0 0 700 180" role="img" :aria-label="`${names.get(historyId)}的同口径历史，版本变化处断开，详见下表`"><path d="M20 10V160H680" fill="none" stroke="currentColor" opacity=".35"/><polyline v-for="segment in trendSegments" :key="segment.key" :points="segment.points" fill="none" stroke="var(--accent-cyan)" stroke-width="2" /></svg>
        <p>只连接同口径的连续节点；缺失数据与版本变化处断开。窗口内旧判断退出也会改变结果。</p>
        <div class="pref-table-scroll"><table class="pref-table"><thead><tr><th>截止</th><th>实际值</th><th>版本节点 / 原因</th></tr></thead><tbody><tr v-for="item in historical" :key="item.id"><td>{{ timeText(item.cutoff) }}</td><td>{{ metric(item) ?? '样本不足' }}</td><td>{{ item.catalog_version }} / {{ item.algorithm_version }} / 参照 {{ item.payload.reference_version?.slice(0,8) || '固定名录' }} / 修订 {{ item.revision }} · {{ item.reason || '常规汇总' }}</td></tr></tbody></table></div>
      </template>
    </details>
    <details v-if="kind === 'random'" class="pref-history"><summary>查看两个具体人物的原始对位</summary><div class="pref-actions"><label>人物一<select v-model="left"><option value="">请选择</option><option v-for="person in pairPeople" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><label>人物二<select v-model="right"><option value="">请选择</option><option v-for="person in pairPeople" :key="person.id" :value="person.id">{{ person.name }}</option></select></label><button class="pref-secondary" @click="loadPair">查询对位</button></div><p v-if="pair">{{ pair.sample_size ? `${names.get(pair.left_id)} ${pair.left_wins} 次，${names.get(pair.right_id)} ${pair.right_wins} 次；共 ${pair.sample_size} 次原始有效明确判断，未应用整窗去重和统计权重。` : '这两位人物暂无正式随机对位数据。' }}</p></details>
  </section>
</template>
