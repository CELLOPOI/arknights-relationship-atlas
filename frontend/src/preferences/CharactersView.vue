<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue';
import { mutate, pendingMutation, PreferenceError, request, timeText } from './api';
import { comparisonImage, type ComparisonImage } from './comparison-image';
import { preferenceDraft } from './session';
import ChoiceEditor from './ChoiceEditor.vue';
import PreferenceImage from './PreferenceImage.vue';
import ResultsView from './ResultsView.vue';
import PersonalRanking from './PersonalRanking.vue';
import { choosePracticePair, PRACTICE_RECORD_LIMIT, PRACTICE_STORAGE_KEY, practiceScopes, readPracticeRecords, type PracticeScope } from './personal-ranking';
import type { Catalog, Quota, RecordItem, State, Supports, Task, Subject } from './types';
const props = defineProps<{ active: boolean; catalog: Catalog; state: State; personId?: string }>();
const emit = defineEmits<{ refresh: []; skin: [id: string] }>();
const draft = preferenceDraft(`characters-v3:${props.state.choice_order_seed}`, {
  section: 'random', busy: false, query: '', scope: 'all', supportDraft: [] as string[], favoriteDraft: [] as string[],
  supportVersion: 0, dirty: false, practice: false, practiceScope: 'operator' as PracticeScope, practiceTask: null as Task | null, pause: false, answered: 0,
  awaitingAnswer: null as { task: Task; outcome: string; winnerId?: string } | null,
});
const { section, busy, query, scope, supportDraft, favoriteDraft, supportVersion, dirty, practice, practiceScope, practiceTask, pause, awaitingAnswer } = toRefs(draft);
if (practiceScope.value !== 'all' && practiceScope.value !== 'operator') practiceScope.value = 'operator';
const error = ref(''), message = ref(''), task = ref<Task | null>(props.state.pending_task);
const previousTask = ref<Task | null>(null), taskLoading = ref(false);
const invalidTaskId = ref('');
const imagePreloads = new Set<() => void>();
const supportPending = ref(!!pendingMutation('supports'));
const restInterval = computed(() => Math.max(1, Number(props.state.config?.rest_interval || 50)));
const imagesReady = ref(new Set<string>());
const records = ref<RecordItem[]>([]), recordsLoading = ref(false), cursor = ref<string | null>(null);
const localRecords = ref<RecordItem[]>([]);
const practiceStorageError = ref('');
const profileId = ref(''), profile = ref<HTMLDialogElement>(), zoom = ref<HTMLDialogElement>(), zoomId = ref('');
let disposed = false;
const people = computed(() => new Map(props.catalog.persons.map(x => [x.id, x])));
const pool = computed(() => props.catalog.persons.filter(x => x.eligible));
const subjects = computed<Subject[]>(() => props.catalog.subjects || pool.value.map(p => ({ ...p, person_id: p.id, form_id: null })));
const entities = computed(() => new Map<string, Subject>([
  ...props.catalog.persons.map(p => [p.id, { ...p, person_id: p.id, form_id: null }] as [string, Subject]),
  ...subjects.value.map(p => [p.id, p] as [string, Subject]),
]));
const ownerId = (id: string) => entities.value.get(id)?.person_id || id;
const supportCount = computed(() => new Set(supportDraft.value.map(ownerId)).size);
const favoriteCount = computed(() => new Set(favoriteDraft.value.map(ownerId)).size);
const pair = computed(() => practice.value ? practiceTask.value : awaitingAnswer.value?.task || task.value || previousTask.value);
const waitingForNext = computed(() => !practice.value && !!previousTask.value);
const randomStatus = computed(() => taskLoading.value ? previousTask.value ? '正在准备下一题…' : '正在读取题目…'
  : busy.value && awaitingAnswer.value ? '正在记录你的选择…'
  : waitingForNext.value ? '上一题已记录，下一题未能载入。' : message.value);
const shown = computed(() => pair.value ? [
  { person: pair.value.left || people.value.get(pair.value.left_id), id: pair.value.left_id },
  { person: pair.value.right || people.value.get(pair.value.right_id), id: pair.value.right_id },
].flatMap(({ person, id }) => person ? [{ ...person, person_id: id }] : []) : []);
const zoomPerson = computed(() => shown.value.find(p => p.id === zoomId.value) || entities.value.get(zoomId.value));
const matches = computed(() => subjects.value.filter(x => (scope.value === 'all' || x.kind === scope.value) && [x.name, ...x.aliases].join(' ').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const draftPeople = computed(() => supportDraft.value.map(id => ({
  id, name: entities.value.get(id)?.name || '已撤下的登记', available: entities.value.has(id),
  legacy: !props.state.supports.subject_support_ids?.includes(id) && !subjects.value.some(s => s.id === id),
})));
const currentProfile = computed(() => people.value.get(profileId.value));
const supportConflict = computed(() => dirty.value && supportVersion.value !== props.state.supports.version);
const readyToAnswer = computed(() => shown.value.length === 2 && shown.value.every(x => imagesReady.value.has(x.id)));
const answerBlocked = computed(() => !pair.value || busy.value || waitingForNext.value || (!practice.value && !props.state.writes_enabled));
const answerDisabled = computed(() => answerBlocked.value || !!awaitingAnswer.value);
const chooseDisabled = computed(() => answerDisabled.value || !readyToAnswer.value);
function restoreDraft(value = props.state.supports) { supportDraft.value = props.catalog.subjects ? [...(value.subject_support_ids || []), ...(value.legacy_support_ids || [])] : [...value.support_ids]; favoriteDraft.value = props.catalog.subjects ? [...(value.subject_favorite_ids || []), ...(value.legacy_favorite_ids || [])] : [...value.favorite_ids]; supportVersion.value = value.version; dirty.value = false; }
watch(() => props.state, state => {
  // 提交后的状态查询可能先返回空待答题，不能覆盖正在切换的画面。
  if (!busy.value && !previousTask.value) task.value = state.pending_task?.id === invalidTaskId.value ? null : state.pending_task;
  if (!dirty.value) restoreDraft(state.supports);
}, { immediate: true });
watch(() => pair.value?.id, () => { imagesReady.value = new Set(); }, { flush: 'sync' });
watch(() => props.active, active => { if (!active) { profile.value?.close(); zoom.value?.close(); } });
watch(() => props.personId, id => { if (id) void openPerson(id); }, { immediate: true });
try { localRecords.value = readPracticeRecords(localStorage.getItem(PRACTICE_STORAGE_KEY)); }
catch { practiceStorageError.value = '无法读取本机练习记录，当前页面仍可练习并生成榜单。'; }
function useSection(value: string) { section.value = value; error.value = ''; if (value === 'records') void loadRecords(); }
function newPractice() {
  const next = choosePracticePair(props.catalog.persons, localRecords.value, practiceScope.value);
  if (!next) { practiceTask.value = null; return; }
  const [first, second] = next;
  const pickForm = (id: string) => { const forms = subjects.value.filter(s => s.person_id === id); return forms[Math.floor(Math.random() * forms.length)] || people.value.get(id)!; };
  practiceTask.value = { id: crypto.randomUUID(), left: pickForm(first.id), right: pickForm(second.id), left_id: first.id, right_id: second.id, catalog_version: props.catalog.version, expires_at: '', status: 'practice' };
}
function setPractice(value: boolean) { practice.value = value; error.value = ''; message.value = ''; if (value && !practiceTask.value) newPractice(); }
function startPractice() { if (busy.value || awaitingAnswer.value) return; useSection('random'); setPractice(true); }
watch(practiceScope, () => { practiceTask.value = null; if (practice.value) newPractice(); });
watch(pool, () => {
  const current = practiceTask.value;
  if (current && ![current.left_id, current.right_id].every(id => pool.value.some(p => p.id === id && (practiceScope.value === 'all' || p.kind === 'operator')))) practiceTask.value = null;
  if (practice.value && !practiceTask.value) newPractice();
}, { immediate: true });
function preloadImage(source: ComparisonImage) {
  return new Promise<void>(resolve => {
    const image = new Image();
    const finish = () => {
      clearTimeout(timeout); image.onload = image.onerror = null;
      imagePreloads.delete(finish); resolve();
    };
    // 预加载失败或过慢时交给卡片现有的占位和重试处理，避免一直锁住选择。
    const timeout = setTimeout(finish, 8000);
    imagePreloads.add(finish);
    image.onload = () => { void image.decode().catch(() => {}).then(finish); };
    image.onerror = finish;
    if (source.sizes) image.sizes = source.sizes;
    if (source.srcset) image.srcset = source.srcset;
    image.src = source.src;
  });
}
async function nextTask() {
  if (busy.value || awaitingAnswer.value || practice.value || !props.active || section.value !== 'random') return;
  pause.value = false; error.value = ''; busy.value = true; taskLoading.value = true;
  try {
    const result = await mutate<{ task: Task }>('task', 'tasks/', 'POST', {});
    if (disposed) return;
    const next = result.task;
    const sources = [next.left || people.value.get(next.left_id), next.right || people.value.get(next.right_id)]
      .flatMap(person => person?.representative_url ? [person.representative_url] : []);
    await Promise.all([...new Set(sources)].map(src => preloadImage(comparisonImage(src, props.catalog.appearances))));
    if (disposed) return;
    task.value = next; previousTask.value = null; invalidTaskId.value = ''; emit('refresh');
  }
  catch (reason) { error.value = (reason as Error).message; }
  finally { busy.value = false; taskLoading.value = false; }
}
async function answer(outcome: string, winnerId?: string) {
  const current = pair.value;
  if (!current || answerBlocked.value || (outcome === 'choose' && !awaitingAnswer.value && !readyToAnswer.value)) return;
  if (practice.value) {
    localRecords.value.unshift({ id: current.id, left: current.left, right: current.right, left_id: current.left_id, right_id: current.right_id, winner_id: winnerId || null, outcome, accepted_at: new Date().toISOString() });
    localRecords.value = localRecords.value.slice(0, PRACTICE_RECORD_LIMIT);
    try { localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(localRecords.value)); practiceStorageError.value = ''; }
    catch { practiceStorageError.value = '本机储存不可用，练习记录和榜单仅保留在当前页面。'; }
    newPractice(); return;
  }
  if (awaitingAnswer.value && (awaitingAnswer.value.outcome !== outcome || awaitingAnswer.value.winnerId !== winnerId)) return;
  awaitingAnswer.value = { task: current, outcome, winnerId };
  busy.value = true; error.value = '';
  try {
    const result = await mutate<{ task: Task & { risk_status?: string }; quota: Quota }>(`answer:${current.id}`, `tasks/${current.id}/answer/`, 'POST', { outcome, ...(winnerId ? { winner_id: winnerId } : {}) });
    draft.answered++; pause.value = draft.answered % restInterval.value === 0;
    const continueRandom = props.active && section.value === 'random' && !pause.value && result.quota.remaining > 0 && !disposed;
    previousTask.value = continueRandom ? current : null;
    awaitingAnswer.value = null; task.value = null;
    message.value = result.task.risk_status === 'pending' ? '已收到，待确认后计入公共结果。' : '已记录你的选择。';
    emit('refresh');
    // 请求可以在隐藏后完成，但下一道题只能在当前人物比较视图派发。
    if (continueRandom) { busy.value = false; await nextTask(); }
  } catch (reason) {
    error.value = (reason as Error).message;
    if (reason instanceof PreferenceError && reason.status !== 0 && reason.status < 500) awaitingAnswer.value = null;
    if (reason instanceof PreferenceError && ['task_expired', 'task_already_answered', 'candidate_unavailable', 'task_not_found'].includes(reason.code)) {
      invalidTaskId.value = current.id; task.value = null; previousTask.value = null;
      emit('refresh');
    }
  } finally { busy.value = false; }
}
function onComparisonKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    || !props.active || section.value !== 'random' || !pair.value || document.hidden
    || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (document.querySelector('dialog[open], [aria-modal="true"]')
    || target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, summary, [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="tablist"], .random-skip-reasons'))) return;
  // 比较时方向键不滚动页面；长按和加载期间的按键不留给下一题。
  event.preventDefault();
  if (event.repeat || answerDisabled.value) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (!chooseDisabled.value) void answer('choose', event.key === 'ArrowLeft' ? pair.value.left_id : pair.value.right_id);
  } else void answer(event.key === 'ArrowUp' ? 'tie' : 'skip');
}
function toggleSupport(id: string) {
  if (supportPending.value || busy.value) return;
  error.value = ''; dirty.value = true;
  if (supportDraft.value.includes(id)) { supportDraft.value = supportDraft.value.filter(x => x !== id); favoriteDraft.value = favoriteDraft.value.filter(x => x !== id); }
  else if (supportDraft.value.some(x => ownerId(x) === ownerId(id)) || supportCount.value < props.state.supports.support_limit) supportDraft.value.push(id);
  else error.value = `已支持 ${props.state.supports.support_limit} 位人物，移除一位后可添加。`;
}
function toggleFavorite(id: string) {
  if (supportPending.value || busy.value) return;
  dirty.value = true;
  if (favoriteDraft.value.includes(id)) favoriteDraft.value = favoriteDraft.value.filter(x => x !== id);
  else if (favoriteDraft.value.some(x => ownerId(x) === ownerId(id)) || favoriteCount.value < props.state.supports.favorite_limit) {
    favoriteDraft.value = favoriteDraft.value.filter(x => ownerId(x) !== ownerId(id));
    favoriteDraft.value.push(id);
  }
  else error.value = `最多标记 ${props.state.supports.favorite_limit} 位本命。`;
}
async function saveSupports() {
  if (busy.value || (supportConflict.value && !supportPending.value)) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const subjectIds = new Set([...subjects.value.map(p => p.id), ...(props.state.supports.subject_support_ids || [])]);
    const body = props.catalog.subjects ? {
      subject_support_ids: supportDraft.value.filter(id => subjectIds.has(id)),
      subject_favorite_ids: favoriteDraft.value.filter(id => subjectIds.has(id)),
      legacy_support_ids: supportDraft.value.filter(id => !subjectIds.has(id)),
      legacy_favorite_ids: favoriteDraft.value.filter(id => !subjectIds.has(id)),
    } : { support_ids: supportDraft.value, favorite_ids: favoriteDraft.value };
    const result = await mutate<Supports>('supports', 'supports/', 'PUT', { version: supportVersion.value, ...body });
    supportPending.value = false;
    restoreDraft(result); message.value = result.risk_status === 'pending' ? '名单已保存，待确认后计入公共结果。' : '支持名单已保存。'; emit('refresh');
  } catch (reason) { supportPending.value = !!pendingMutation('supports'); error.value = (reason as Error).message; if (reason instanceof PreferenceError && reason.code === 'version_conflict') emit('refresh'); }
  finally { busy.value = false; }
}
async function loadRecords(more = false) {
  recordsLoading.value = true;
  try { const result = await request<{ records: RecordItem[]; next_cursor: string | null }>(`records/${more && cursor.value ? `?cursor=${encodeURIComponent(cursor.value)}` : ''}`); records.value = more ? [...records.value, ...result.records] : result.records; cursor.value = result.next_cursor; }
  catch (reason) { error.value = (reason as Error).message; }
  finally { recordsLoading.value = false; }
}
async function openPerson(id: string) { profileId.value = ownerId(id); await nextTick(); if (props.active && !profile.value?.open) profile.value?.showModal(); }
async function showArt(id: string) { zoomId.value = id; await nextTick(); zoom.value?.showModal(); }
function clearPractice() {
  localRecords.value = []; practiceTask.value = null;
  try { localStorage.removeItem(PRACTICE_STORAGE_KEY); practiceStorageError.value = ''; }
  catch { practiceStorageError.value = '当前页面的记录和榜单已清空，但本机储存未能清除，刷新后旧记录可能恢复。'; }
  if (practice.value) newPractice();
}
if (section.value === 'records') void loadRecords();
onMounted(() => { window.addEventListener('keydown', onComparisonKeydown); });
onBeforeUnmount(() => { disposed = true; window.removeEventListener('keydown', onComparisonKeydown); imagePreloads.forEach(finish => finish()); profile.value?.close(); zoom.value?.close(); });
</script>
<template>
  <section class="characters-view">
    <header class="preference-title"><h1>人物喜好</h1><p>随机选择与长期支持分别统计，免登录即可参与。</p></header>
    <nav class="pref-tabs character-tabs" aria-label="人物喜好功能"><button v-for="item in [['random','随机选择'],['personal','我的喜好榜'],['support','厨力支持'],['results','榜单与趋势'],['records','我的记录']]" :key="item[0]" :aria-current="section === item[0] ? 'page' : undefined" @click="useSection(item[0]!)">{{ item[1] }}</button></nav>
    <p v-if="!state.writes_enabled" class="pref-message">喜好登记暂时暂停，可以继续浏览已保存的结果。</p><p v-if="state.risk_status === 'pending'" class="pref-message">你的登记已收到，待确认后计入公共结果。</p>
    <p v-if="error" class="pref-error" role="alert">{{ error }}</p><p v-if="message && section !== 'random'" class="pref-message" role="status">{{ message }}</p>
    <p v-if="practiceStorageError" class="pref-error" role="alert">{{ practiceStorageError }}</p>
    <PersonalRanking v-if="section === 'personal'" v-model:scope="practiceScope" :records="localRecords" :persons="catalog.persons" :disabled="busy || !!awaitingAnswer" @practice="startPractice" />
    <div v-show="section === 'random'" class="random-view">
      <div class="pref-row random-toolbar"><h2>这两位人物，你更喜欢谁？</h2><div class="pref-tabs" aria-label="参与模式"><button :aria-pressed="!practice" :disabled="busy || !!awaitingAnswer" @click="setPractice(false)">正式随机</button><button :aria-pressed="practice" :disabled="busy || !!awaitingAnswer" @click="setPractice(true)">个人练习</button></div></div>
      <template v-if="practice">
        <div class="pref-row personal-practice-tools"><div class="pref-tabs" aria-label="个人练习范围"><button v-for="item in practiceScopes" :key="item.value" :aria-pressed="practiceScope === item.value" @click="practiceScope = item.value">{{ item.label }}</button></div><button class="pref-text" @click="useSection('personal')">查看我的喜好榜</button></div>
        <p class="pref-muted">选择会自动更新本机喜好榜，优先补充缺少的比较，不占正式额度。</p>
      </template>
      <p v-else class="pref-muted">本周已派发 {{ state.quota.weekly_used }} / {{ state.quota.weekly_limit }} 道 · 近 28 天 {{ state.quota.rolling_used }} / {{ state.quota.rolling_limit }} 道 · 可以跳过，跳过占用已派发机会。</p>
      <div class="random-status" role="status" aria-live="polite"><span>{{ randomStatus }}</span><button v-if="waitingForNext && !busy" class="pref-text" :disabled="!state.writes_enabled" @click="nextTask">重试下一题</button></div>
      <p v-if="pair" class="pref-muted random-keyboard-hint">键盘方向键：<span>← 选左边，</span><span>→ 选右边，</span><span>↑ 难分高下，</span><span>↓ 跳过。</span><span v-if="!practice">正式选择提交后不能撤回。</span></p>
      <div v-if="pair" class="random-pair" :aria-busy="busy || waitingForNext"><article v-for="(person, index) in shown" :key="`${pair.id}:${person.id}`" class="random-person"><div class="random-illustration"><PreferenceImage v-bind="comparisonImage(person.representative_url, catalog.appearances)" :alt="`${person.name}固定代表立绘`" @ready="imagesReady.add(person.id)" @failed="imagesReady.delete(person.id)" /><button class="random-enlarge" :aria-label="`放大${person.name}立绘`" @click="showArt(person.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button></div><h3>{{ person.name }}</h3><button class="pref-primary" :disabled="chooseDisabled" :aria-keyshortcuts="index === 0 ? 'ArrowLeft' : 'ArrowRight'" @click="answer('choose', person.person_id)">更喜欢这位<kbd class="random-shortcut" aria-hidden="true">{{ index === 0 ? '←' : '→' }}</kbd></button></article></div>
      <div v-if="pair" class="random-skip"><button class="pref-secondary" :disabled="answerDisabled" aria-keyshortcuts="ArrowDown" @click="answer('skip')">暂不判断，跳过<kbd class="random-shortcut" aria-hidden="true">↓</kbd></button><details class="random-skip-reasons"><summary>不熟悉</summary><button class="pref-text" :disabled="answerDisabled" @click="answer('unfamiliar_left')">不认识左边</button><button class="pref-text" :disabled="answerDisabled" @click="answer('unfamiliar_right')">不认识右边</button><button class="pref-text" :disabled="answerDisabled" @click="answer('unfamiliar_both')">两边都不熟悉</button></details><button class="pref-text" :disabled="answerDisabled" aria-keyshortcuts="ArrowUp" @click="answer('tie')">难分高下<kbd class="random-shortcut" aria-hidden="true">↑</kbd></button></div>
      <p v-if="awaitingAnswer && !busy" class="pref-message">上次提交结果尚未确认，请重试同一操作。<button class="pref-secondary" @click="answer(awaitingAnswer.outcome, awaitingAnswer.winnerId)">重试原选择</button></p>
      <div v-if="!pair && practice" class="preference-empty"><h3>当前范围可比较的人物不足两位</h3><p>请切换人物范围，或等待目录更新。</p></div>
      <div v-else-if="!pair" class="preference-empty"><h3>{{ pause ? `已经完成 ${restInterval} 道，可以歇一会儿` : state.quota.remaining === 0 ? '本期正式比较已用完' : '从两个人物中选出更喜欢的一位' }}</h3><p>双方使用固定代表图；刷新会恢复同一道待答题。</p><div class="pref-actions"><button v-if="state.quota.remaining > 0" class="pref-primary" :disabled="busy || !state.writes_enabled" @click="nextTask">{{ busy ? '读取题目…' : pause ? '继续选择' : '开始随机选择' }}</button><button class="pref-secondary" @click="setPractice(true)">开始个人练习</button><button class="pref-text" @click="useSection('results')">查看大家的结果</button></div></div>
      <details v-if="!practice" class="pref-history"><summary>额度与参与规则</summary><p>本周最多 {{ state.quota.weekly_limit }} 道，连续 28 天最多 {{ state.quota.rolling_limit }} 道，人物展示与对位重复同时受限。服务器派发时预留次数；跳过、自然过期也会占用机会。</p><p>周额度恢复：{{ timeText(state.quota.weekly_resets_at) }}（北京时间）。<template v-if="state.quota.rolling_recovers_at">滚动额度最早恢复：{{ timeText(state.quota.rolling_recovers_at) }}。</template></p><p>匿名身份保存在这个浏览器中。清除 Cookie、换浏览器或换设备后，无法保证找回旧记录；匿名参与不能保证严格一人一票。</p></details>
    </div>
    <section v-show="section === 'support'" class="support-view">
      <div class="support-current"><p v-if="supportPending" class="pref-message">上次名单保存结果尚未确认，请先重试原操作。<button class="pref-secondary" :disabled="busy" @click="saveSupports">重试原名单</button></p><div class="pref-row"><h2>支持名单</h2><span>已暂选 {{ supportCount }} / {{ state.supports.support_limit }} 人物 · 本命 {{ favoriteCount }} / {{ state.supports.favorite_limit }}</span></div><p class="pref-muted">长期保留，整份名单每 {{ state.cooldown_hours }} 小时可修改一次。同一人物的本体与异格合占一个名额，本命不额外加票。</p><p v-if="state.supports.next_change_at" class="pref-muted">下次可修改：{{ timeText(state.supports.next_change_at) }}（北京时间）</p><div class="support-draft"><div v-for="person in draftPeople" :key="person.id" class="support-draft-person"><button class="pref-text" :disabled="!person.available" @click="openPerson(person.id)">{{ person.name }}<small v-if="catalog.subjects && person.available && person.legacy"> · 旧登记，未指定形态</small></button><button :disabled="!person.available" :aria-pressed="favoriteDraft.includes(person.id)" @click="toggleFavorite(person.id)">{{ favoriteDraft.includes(person.id) ? '本命' : '标为本命' }}</button><button :aria-label="`移除${person.name}`" @click="toggleSupport(person.id)">移除</button></div><p v-if="!supportDraft.length" class="pref-muted">名单为空。保存空名单将撤回全部支持与本命标记。</p></div><p v-if="supportConflict" class="pref-error" role="alert">另一页面已更新名单，当前草稿不会覆盖它。<button class="pref-text" @click="restoreDraft()">重新读取已保存名单</button></p><div class="pref-actions"><button class="pref-primary" :disabled="busy || supportPending || !dirty || supportConflict || !state.writes_enabled" @click="saveSupports">{{ busy ? '保存中…' : supportDraft.length ? '保存整份名单' : '确认撤回全部支持' }}</button><button class="pref-text" :disabled="busy || supportPending" @click="restoreDraft()">取消草稿</button><span v-if="dirty" class="pref-muted">有未保存的修改</span></div></div>
      <div class="pref-row"><label class="pref-search"><span>搜索人物</span><input v-model="query" type="search" placeholder="姓名、异格或别名"></label><label class="pref-filter">范围<select v-model="scope"><option value="all">全部人物</option><option value="operator">干员</option><option value="npc">精选 NPC</option></select></label></div>
      <div class="support-directory"><article v-for="person in matches" :key="person.id"><button class="support-name" @click="openPerson(person.id)">{{ person.name }}<small v-if="person.kind === 'npc'">NPC</small></button><button :aria-pressed="supportDraft.includes(person.id)" @click="toggleSupport(person.id)">{{ supportDraft.includes(person.id) ? '已加入' : '加入支持' }}</button></article></div><p v-if="!matches.length" class="preference-empty">没有找到匹配的人物。</p>
    </section>
    <ResultsView v-if="section === 'results'" :catalog="catalog" @person="openPerson" />
    <section v-if="section === 'records'" class="records-view"><h2>正式选择记录</h2><p class="pref-muted">这里显示实际受理的对局，不推算完整个人排名。</p><p v-if="recordsLoading" role="status">正在读取记录…</p><p v-if="!recordsLoading && !records.length" class="preference-empty">还没有正式选择记录。</p><ol class="preference-records"><li v-for="record in records" :key="record.id"><span>{{ record.left?.name || people.get(record.left_id)?.name }} / {{ record.right?.name || people.get(record.right_id)?.name }}</span><strong>{{ record.winner_id ? `选择 ${record.winner_id === record.left_id ? record.left?.name || people.get(record.left_id)?.name : record.right?.name || people.get(record.right_id)?.name}` : record.outcome === 'tie' ? '难分高下' : record.outcome?.startsWith('unfamiliar') ? '不熟悉' : '跳过' }}</strong><time>{{ timeText(record.accepted_at) }}</time><small v-if="record.risk_status && record.risk_status !== 'accepted'">{{ record.risk_status === 'pending' ? '待确认' : '未计入公共结果' }}</small></li></ol><button v-if="cursor" class="pref-secondary" :disabled="recordsLoading" @click="loadRecords(true)">更早记录</button><details class="pref-history"><summary>本机个人练习 · {{ localRecords.length }} 条</summary><button class="pref-text" @click="useSection('personal')">查看我的喜好榜</button><p>练习不进入公共榜。清除本地记录不会撤销服务器已接受的正式选择。</p><button class="pref-text" @click="clearPractice">清除本机练习记录</button><ol class="preference-records"><li v-for="record in localRecords" :key="record.id"><span>{{ record.left?.name || people.get(record.left_id)?.name }} / {{ record.right?.name || people.get(record.right_id)?.name }}</span><strong>{{ record.winner_id ? `选择 ${record.winner_id === record.left_id ? record.left?.name || people.get(record.left_id)?.name : record.right?.name || people.get(record.right_id)?.name}` : record.outcome === 'tie' ? '难分高下' : record.outcome?.startsWith('unfamiliar') ? '不熟悉' : '跳过' }}</strong><time>{{ timeText(record.accepted_at) }}</time></li></ol></details></section>
    <dialog ref="profile" class="preference-detail" aria-labelledby="preference-person-title"><header class="preference-detail-header"><button class="pref-secondary" @click="profile?.close()">返回人物</button><h2 id="preference-person-title">{{ currentProfile?.name || '人物不可用' }}</h2></header><div v-if="currentProfile" class="preference-detail-body"><p v-if="currentProfile.selection_reason || currentProfile.reason" class="pref-muted">{{ currentProfile.selection_reason || currentProfile.reason }}</p><a class="pref-text" :href="`/?scope=all&person=${encodeURIComponent(currentProfile.id)}#graph`">查看人物关系与资料</a><ChoiceEditor :key="currentProfile.id" kind="form" :object-id="currentProfile.id" :catalog="catalog" :state="state" @refresh="emit('refresh')" @skin="id => { profile?.close(); emit('skin', id); }" /></div></dialog>
    <dialog ref="zoom" class="preference-lightbox" aria-label="人物完整立绘"><header><h2>{{ zoomPerson?.name }}</h2><button class="pref-secondary" @click="zoom?.close()">关闭大图</button></header><PreferenceImage v-if="zoomPerson" :src="zoomPerson.representative_url" :alt="zoomPerson.name" /></dialog>
  </section>
</template>
