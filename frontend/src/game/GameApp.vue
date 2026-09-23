<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { bindSectionScroll } from '../section-scroll';
import { navigateSection, sectionTransitioning } from '../section-navigation';
import FeedbackPanel from '../components/FeedbackPanel.vue';
import SiteNotice from '../components/SiteNotice.vue';
import SiteNoticeButton from '../components/SiteNoticeButton.vue';
import SourceList from '../components/SourceList.vue';
import type { FeedbackTarget } from '../types';
import { api } from '../api';
import type { Relation } from '../types';
import GameIcon from './GameIcon.vue';
import PersonAvatar from './PersonAvatar.vue';
import CharacterIllustration from './CharacterIllustration.vue';
import CompletionPlay from './CompletionPlay.vue';
import RecognitionPlay from './RecognitionPlay.vue';
import NameEntry from './NameEntry.vue';
import SolutionList from './SolutionList.vue';
import { presentPerson, restoreAppearances, type AppearanceChoices } from './appearances';
import { findSolutions } from './solutions';
import { COMPLETION_GAPS, completionPath, completionWon, type CompletionRound } from './completion';
import { RECOGNITION_SIZE, RECOGNITION_CONNECTED_COUNT, type RecognitionRound } from './recognition';
import { LEGACY_STORAGE_KEY, MODES, STORAGE_KEY, createSession, modeRules, readGameSave, type GameMode, type GameSession } from './modes';
import {
  MAX_STEPS, DEFAULT_BANS, DIFFICULTIES, advance, buildNetwork, dataFingerprint, defaultRules,
  newRound, nextHint, readRules,
  type GameData, type GamePerson, type Network, type Round, type Rules,
} from './network';
import './game.css';

const feedbackOpen = ref(false);
const feedbackTarget = ref<FeedbackTarget | null>(null);
function openFeedback(target: FeedbackTarget | null = null) { feedbackTarget.value = target; feedbackOpen.value = true; }

const data = shallowRef<GameData | null>(null);
const network = shallowRef<Network | null>(null);
const round = shallowRef<Round | null>(null);
const completion = shallowRef<CompletionRound | null>(null);
const recognition = shallowRef<RecognitionRound | null>(null);
const mode = ref<GameMode>('completion');
let sessions: Partial<Record<GameMode, GameSession>> = {};
const entryFeedback = ref('');
const entryRevision = ref(0);
const appearances = shallowRef<AppearanceChoices>({});
const rules = ref<Rules>(defaultRules());
const draft = ref<Rules>(defaultRules());
const loading = ref(true);
const busy = ref(false);
const loadError = ref('');
const rulesError = ref('');
const message = ref('');
const query = ref('');
const banQuery = ref('');
const solutionVisible = ref(false);
const settings = ref<HTMLDialogElement>();
const menu = ref<HTMLDialogElement>();
const evidenceDialog = ref<HTMLDialogElement>();
const candidateHeading = ref<HTMLHeadingElement>();
const outcomeHeading = ref<HTMLHeadingElement>();
const evidence = shallowRef<Relation | null>(null);
const evidenceLoading = ref(false);
const evidenceError = ref('');
const evidenceId = ref('');
let evidenceRequest = 0;
let fingerprint = '';
let disposed = false;

const people = computed(() => new Map(data.value?.nodes.map(person => [person.id, presentPerson(person, appearances.value[person.id])]) || []));
const displayNetwork = computed(() => network.value ? { ...network.value, people: new Map([...network.value.people.keys()].map(id => [id, people.value.get(id)!])) } : null);
const sortedPeople = computed(() => [...people.value.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
const puzzle = computed(() => completion.value?.puzzle || round.value?.puzzle);
const recognitionPair = computed(() => recognition.value?.questions[recognition.value.index]);
const current = computed(() => recognitionPair.value ? people.value.get(recognitionPair.value.leftId)! : completion.value
  ? people.value.get(completion.value.puzzle.shortestPath[completion.value.activeGap - 1])!
  : round.value ? people.value.get(round.value.path[round.value.path.length - 1])! : null);
const start = computed(() => recognitionPair.value ? people.value.get(recognitionPair.value.leftId)! : puzzle.value ? people.value.get(puzzle.value.startId)! : null);
const target = computed(() => recognitionPair.value ? people.value.get(recognitionPair.value.rightId)! : puzzle.value ? people.value.get(puzzle.value.targetId)! : null);
const steps = computed(() => Math.max(0, (round.value?.path.length || 1) - 1));
const won = computed(() => !!round.value && current.value?.id === round.value.puzzle.targetId);
const finished = computed(() => won.value || steps.value === MAX_STEPS || !!round.value?.revealed);
const outcome = computed(() => won.value ? '已连接' : round.value?.revealed ? '本局已结束' : '已用完六步');
const canonicalPeople = computed(() => new Map(data.value?.nodes.map(person => [person.id, person]) || []));
const activeBans = computed(() => rules.value.bannedIds.map(id => canonicalPeople.value.get(id)).filter((person): person is GamePerson => !!person));
const draftBans = computed(() => draft.value.bannedIds.map(id => canonicalPeople.value.get(id)).filter((person): person is GamePerson => !!person));
const adjacent = computed(() => {
  if (!network.value || !current.value || !round.value) return [];
  const visited = new Set(round.value.path);
  return [...network.value.neighbors.get(current.value.id)!.keys()].filter(id => !visited.has(id))
    .map(id => people.value.get(id)!)
    .sort((a, b) => a.factionName.localeCompare(b.factionName, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
});
function matches(person: GamePerson, text: string) {
  const term = text.trim().toLocaleLowerCase();
  return [person.name, ...person.aliases, person.factionName].some(name => name.toLocaleLowerCase().includes(term));
}
const candidates = computed(() => adjacent.value.filter(person => matches(person, query.value)));
const banMatches = computed(() => [...canonicalPeople.value.values()].filter(person => matches(person, banQuery.value)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
const routeKey = computed(() => round.value?.path.join('>') || '');
const hintedId = computed(() => round.value?.hintedPaths.includes(routeKey.value) && network.value ? nextHint(network.value, round.value) : null);
const routeEdges = computed(() => {
  const path = completion.value ? completionPath(completion.value) : round.value?.path || [];
  return path.slice(1).flatMap((id, index) => {
    const from = path[index];
    const edge = id && from ? network.value?.neighbors.get(from)?.get(id) : null;
    return edge ? [{ id: edge, from: people.value.get(from!)!, to: people.value.get(id!)! }] : [];
  });
});
const solutions = computed(() => round.value && network.value ? findSolutions(network.value, round.value.puzzle.startId, round.value.puzzle.targetId) : { paths: [], limited: false });

function remember() { sessions[mode.value] = { rules: rules.value, round: round.value, completion: completion.value, recognition: recognition.value, appearances: appearances.value }; }

function noPuzzleMessage() {
  return mode.value === 'recognition'
    ? `当前人物池不足以抽出 ${RECOGNITION_CONNECTED_COUNT} 对直接认识、${RECOGNITION_SIZE - RECOGNITION_CONNECTED_COUNT} 对可通过一人连接的题目，请减少禁用人物或扩大人物范围。`
    : '当前规则下没有符合难度的题目，请减少禁用人物或调整难度。';
}

function applySession(session: GameSession) {
  rules.value = session.rules;
  network.value = buildNetwork(data.value!, session.rules);
  round.value = session.round; completion.value = session.completion;
  recognition.value = session.recognition || null;
  appearances.value = session.appearances || {};
  query.value = ''; solutionVisible.value = false; entryFeedback.value = ''; message.value = '';
  entryRevision.value++;
}

function save() {
  if (!data.value) return;
  remember();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ fingerprint, mode: mode.value, sessions })); }
  catch { message.value = '浏览器未能保存进度，刷新后将重新开始。'; }
}

async function load() {
  loading.value = true; loadError.value = '';
  try {
    const result = await api<GameData>('graph/?scope=all');
    if (disposed) return;
    if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.edges) || !result.nodes.length) {
      throw new Error('当前没有可用的关系资料，请稍后重试。');
    }
    data.value = result;
    fingerprint = dataFingerprint(result);
    const readStored = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
    const saved = readGameSave(readStored(STORAGE_KEY), readStored(LEGACY_STORAGE_KEY), result);
    sessions = saved.sessions; mode.value = saved.mode;
    const cached = sessions[mode.value];
    const nextRules = cached?.rules || modeRules(mode.value);
    const nextNetwork = buildNetwork(result, nextRules);
    const restored = !!(cached?.round || cached?.completion || cached?.recognition);
    const session = restored ? cached! : createSession(nextNetwork, nextRules, mode.value);
    applySession(session || { rules: nextRules, round: null, completion: null });
    if (restored) message.value = '已恢复上次进度。';
    else if (!session) message.value = noPuzzleMessage();
    save();
  } catch (error) { loadError.value = error instanceof Error ? error.message : '读取关系资料失败，请重试。'; }
  finally { loading.value = false; }
}

async function startPuzzle(nextRules = rules.value, fromSettings = false) {
  if (!data.value || busy.value) return;
  busy.value = true; rulesError.value = ''; message.value = '';
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const normalized = readRules(nextRules, data.value);
    const nextNetwork = buildNetwork(data.value, normalized);
    const session = createSession(nextNetwork, normalized, mode.value, { rules: rules.value, round: round.value, completion: completion.value, recognition: recognition.value });
    if (!session) {
      const error = noPuzzleMessage();
      if (fromSettings) rulesError.value = error; else message.value = error;
      return;
    }
    applySession(session);
    if (fromSettings) settings.value?.close();
    save();
    await nextTick(); focusChoices();
  } finally { busy.value = false; }
}

function focusChoices() {
  const element = mode.value === 'recognition' ? document.getElementById('recognition-heading') || document.getElementById('recognition-question')
    : mode.value === 'completion' ? document.getElementById('completion-heading') : candidateHeading.value;
  element?.focus({ preventScroll: true });
}

async function switchMode(nextMode: GameMode) {
  if (!data.value || busy.value || nextMode === mode.value) return;
  busy.value = true; remember();
  await nextTick();
  try {
    const cached = sessions[nextMode];
    const nextRules = cached?.rules || modeRules(nextMode);
    const session = cached?.round || cached?.completion || cached?.recognition ? cached : createSession(buildNetwork(data.value, nextRules), nextRules, nextMode);
    mode.value = nextMode;
    applySession(session || { rules: nextRules, round: null, completion: null });
    if (!session) message.value = noPuzzleMessage();
    save();
  } finally { busy.value = false; }
}

async function updateCompletion(next: CompletionRound) {
  completion.value = next; save();
  if (completionWon(next) || next.revealed) {
    await nextTick(); document.getElementById('completion-result-title')?.focus({ preventScroll: true });
  }
}

async function updateRecognition(next: RecognitionRound) {
  recognition.value = next; message.value = ''; save();
  await nextTick(); focusChoices();
}

function chooseName(id: string, appearanceId?: string) {
  if (!network.value || !round.value || busy.value || finished.value) return;
  const person = people.value.get(id);
  if (!person) return;
  if (rules.value.bannedIds.includes(id)) entryFeedback.value = `${person.name}在本局禁用名单中，请换一位人物。`;
  else if (!network.value.people.has(id)) entryFeedback.value = `${person.name}不在本局人物范围内，请换一位人物。`;
  else if (round.value.path.includes(id)) entryFeedback.value = `路线中已经经过${person.name}，不能重复使用。`;
  else if (!network.value.neighbors.get(current.value!.id)?.has(id)) entryFeedback.value = `${current.value!.name}与${person.name}暂无已收录连线，请换一位人物。未消耗步数。`;
  else {
    if (appearanceId && id !== round.value.puzzle.targetId) appearances.value = { ...appearances.value, ...restoreAppearances({ [id]: appearanceId }, data.value!) };
    entryFeedback.value = ''; choose(id);
  }
}

async function choose(id: string) {
  if (!round.value || !network.value || busy.value) return;
  const next = advance(network.value, round.value, id);
  if (!next) return;
  round.value = next; query.value = ''; message.value = '';
  save();
  await nextTick();
  (finished.value ? outcomeHeading.value : mode.value === 'input' ? document.getElementById('game-name-input') : candidateHeading.value)?.focus({ preventScroll: true });
}

function undo() {
  if (!round.value || steps.value === 0 || won.value || round.value.revealed || busy.value) return;
  round.value = { ...round.value, path: round.value.path.slice(0, -1) };
  query.value = ''; message.value = ''; entryFeedback.value = ''; solutionVisible.value = false; save();
}

function hint() {
  if (!round.value || !network.value || finished.value || busy.value) return;
  const id = nextHint(network.value, round.value);
  if (!id) { message.value = '这条路线无法在剩余步数内抵达，请撤回一步再试。'; return; }
  if (!round.value.hintedPaths.includes(routeKey.value)) {
    round.value = { ...round.value, hintedPaths: [...round.value.hintedPaths, routeKey.value] };
  }
  query.value = '';
  message.value = `可以尝试连接${people.value.get(id)!.name}。`;
  save();
  nextTick(() => document.querySelector<HTMLElement>('[data-hinted="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
}

function reveal() {
  if (!round.value) return;
  if (!won.value) round.value = { ...round.value, revealed: true };
  solutionVisible.value = true; message.value = ''; save();
}

function retry() {
  if (!round.value) return;
  round.value = newRound(round.value.puzzle);
  entryRevision.value++;
  solutionVisible.value = false; query.value = ''; message.value = ''; entryFeedback.value = ''; save();
}

function openSettings() {
  draft.value = { ...rules.value, bannedIds: [...rules.value.bannedIds] };
  banQuery.value = ''; rulesError.value = ''; settings.value?.showModal();
}

function toggleBan(id: string) {
  draft.value.bannedIds = draft.value.bannedIds.includes(id)
    ? draft.value.bannedIds.filter(value => value !== id) : [...draft.value.bannedIds, id];
  rulesError.value = '';
}

async function showEvidence(id: string) {
  evidenceId.value = id;
  const request = ++evidenceRequest;
  evidence.value = null; evidenceError.value = ''; evidenceLoading.value = true;
  if (!evidenceDialog.value?.open) evidenceDialog.value?.showModal();
  try {
    const result = await api<Relation>(`relationships/${encodeURIComponent(id)}/`);
    if (request === evidenceRequest && evidenceDialog.value?.open) evidence.value = result;
  } catch (error) {
    if (request === evidenceRequest) evidenceError.value = error instanceof Error ? error.message : '读取原文失败，请重试。';
  } finally { if (request === evidenceRequest) evidenceLoading.value = false; }
}

function closeEvidence() { evidenceRequest++; evidenceDialog.value?.close(); }

let releaseScroll: (() => void) | undefined;
onMounted(() => {
  document.title = '人物连线 · 泰拉群像'; load();
  releaseScroll = bindSectionScroll(document.getElementById('game-workspace')!, {
    blocked: sectionTransitioning,
    step: direction => {
      navigateSection(direction > 0 ? '/preferences/' : history.state?.sectionReturn || '/?scope=all#factions', direction);
      return true;
    },
  });
});
onBeforeUnmount(() => { disposed = true; evidenceRequest++; releaseScroll?.(); });
</script>

<template>
  <div class="game-app">
    <a class="skip-link" href="#game-workspace">跳到人物连线</a>
    <header class="site-header game-header">
      <a class="site-brand" href="/#home"><span>泰拉群像</span><small>ARKNIGHTS</small></a>
      <nav class="site-nav" aria-label="主导航">
        <a href="/#home"><span>INDEX</span><small>首页</small></a>
        <a href="/?scope=all#factions"><span>RELATIONS</span><small>人物关系</small></a>
        <a href="/game/" aria-current="page"><span>GAME</span><small>游戏</small></a>
        <a href="/preferences/"><span>PREFERENCES</span><small>喜好</small></a>
        <SiteNoticeButton><span>NOTICE</span><small>站点说明</small></SiteNoticeButton>
      </nav>
      <div class="visitor-links"><a href="https://github.com/CELLOPOI/arknights-relationship-atlas/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a><button class="account-entry" @click="openFeedback()">反馈问题</button></div>
      <button class="site-menu-toggle" aria-label="打开导航" aria-haspopup="dialog" @click="menu?.showModal()"><span></span><span></span><span></span></button>
    </header>

    <main id="game-workspace" class="game-workspace" tabindex="-1">
      <div class="game-title-row">
        <div><h1>人物连线</h1><p>{{ MODES[mode].description }}</p></div>
        <button class="game-button game-rules-button" :disabled="loading || !!loadError || busy" @click="openSettings"><GameIcon name="settings" />规则与禁用<span v-if="data" class="game-count">{{ rules.bannedIds.length }}</span></button>
      </div>

      <nav class="game-mode-tabs" aria-label="游戏模式">
        <button v-for="(item, key) in MODES" :key="key" :aria-pressed="mode === key" :data-mode="key" :disabled="loading || !!loadError || busy" @click="switchMode(key)">{{ item.label }}</button>
        <span>切换模式保留各自进度</span>
      </nav>

      <section v-if="loading || loadError" class="game-load-state" :aria-busy="loading">
        <p v-if="loading" role="status">正在读取关系资料…</p>
        <template v-else><p role="alert">{{ loadError }}</p><button class="game-button primary" @click="load"><GameIcon name="refresh" />重新读取</button></template>
      </section>
      <section v-else-if="!round && !completion && !recognition" class="game-load-state">
        <p role="status">{{ message }}</p><button class="game-button primary" @click="openSettings">调整规则</button>
      </section>

      <div v-else class="game-layout">
        <div class="game-stage">
          <CharacterIllustration :key="`current-${current!.id}`" :person="current!" side="current" :label="mode === 'recognition' ? '人物 A' : undefined" />
          <CharacterIllustration :key="`target-${target!.id}`" :person="target!" side="target" :label="mode === 'recognition' ? '人物 B' : undefined" />
          <div class="game-play" :aria-busy="busy" :data-start-id="start!.id" :data-target-id="target!.id">
            <div class="game-endpoints" :aria-label="mode === 'recognition' ? '本题两位人物' : '本局起点与终点'"><span>{{ mode === 'recognition' ? '人物 A' : '起点' }}<strong>{{ start!.name }}</strong></span><span v-if="mode === 'recognition'" aria-hidden="true">与</span><GameIcon v-else name="arrow" /><span>{{ mode === 'recognition' ? '人物 B' : '终点' }}<strong>{{ target!.name }}</strong></span></div>
            <p v-if="(completion || recognition) && message" class="game-notice" role="status">{{ message }}</p>
            <RecognitionPlay v-if="recognition && displayNetwork" :round="recognition" :network="displayNetwork" :busy="busy" @update="updateRecognition" @next="startPuzzle()" @evidence="showEvidence" />
            <CompletionPlay v-else-if="completion && displayNetwork" :round="completion" :network="displayNetwork" :busy="busy" @update="updateCompletion" @next="startPuzzle()" @evidence="showEvidence" />
            <template v-else-if="round">
            <section class="game-route-section" aria-label="当前路线">
              <div class="game-route-heading"><h2>你的路线</h2><p><strong>{{ steps }}</strong><span>/ {{ MAX_STEPS }} 步</span></p></div>
              <ol class="game-route" aria-label="已走路线和剩余步数">
                <li v-for="slot in MAX_STEPS + 1" :key="slot" class="game-step" :class="{ filled: round.path[slot - 1], current: slot === round.path.length, connected: slot < round.path.length }" :data-person="round.path[slot - 1]">
                  <div class="game-step-avatar"><PersonAvatar v-if="round.path[slot - 1]" :person="people.get(round.path[slot - 1])!" eager /><span v-else>{{ slot - 1 }}</span></div>
                  <span class="game-step-name" :title="round.path[slot - 1] ? people.get(round.path[slot - 1])!.name : undefined">{{ round.path[slot - 1] ? people.get(round.path[slot - 1])!.name : `第 ${slot - 1} 步` }}</span>
                </li>
              </ol>
            </section>

            <div class="game-action-row">
              <button class="game-text-button" :disabled="steps === 0 || won || round.revealed || busy" @click="undo"><GameIcon name="back" />撤回一步</button>
              <button class="game-text-button" :disabled="finished || busy" @click="hint"><GameIcon name="hint" />提示下一人<span v-if="round.hintedPaths.length">{{ round.hintedPaths.length }}</span></button>
              <button class="game-text-button game-another" :disabled="busy" @click="startPuzzle()"><GameIcon name="refresh" />{{ busy ? '正在出题…' : '换一道题' }}</button>
              <span class="game-action-note">撤回不占步数，探索次数会保留。</span>
            </div>
            <p v-if="message" class="game-notice" role="status">{{ message }}</p>

            <section v-if="!finished" class="game-choices" aria-labelledby="game-next-heading">
              <div class="game-choices-heading"><div><h2 id="game-next-heading" ref="candidateHeading" tabindex="-1">从<span>{{ current!.name }}</span>继续</h2><p v-if="mode === 'explore'">选择下一位人物 · {{ adjacent.length }} 人可连接</p><p v-else>输入名字，确认人物后检查这一步连线。</p></div><span class="game-remaining">剩余 {{ MAX_STEPS - steps }} 步</span></div>
              <NameEntry v-if="mode === 'input'" :key="entryRevision" :people="sortedPeople" :current-id="current!.id" :busy="busy" :feedback="entryFeedback" @choose="chooseName" @clear="entryFeedback = ''" />
              <template v-else>
              <label class="game-search"><GameIcon name="search" /><input v-model="query" aria-label="搜索可连接人物" placeholder="搜索名字、别名或阵营" autocomplete="off" /><button v-if="query" class="game-clear" aria-label="清除人物搜索" @click="query = ''"><GameIcon name="close" /></button></label>
              <div :key="current!.id" class="game-candidates">
                <button v-for="person in candidates" :key="person.id" class="game-candidate" :class="{ hinted: person.id === hintedId }" :data-next-id="person.id" :data-hinted="person.id === hintedId" :aria-label="`连接${person.name}`" :disabled="busy" @click="choose(person.id)">
                  <PersonAvatar :person="person" /><span class="game-candidate-copy"><strong>{{ person.name }}</strong><small>{{ person.id === hintedId ? '提示人物' : person.factionName }}</small></span><GameIcon name="arrow" />
                </button>
                <p v-if="!candidates.length" class="game-empty">{{ adjacent.length ? '没有匹配的人物，试试其他名字或清除搜索。' : '当前人物没有未经过的可用连线，请撤回一步。' }}</p>
              </div>
              </template>
              <div class="game-play-footer"><span>同一条路线不能重复经过人物。</span><button class="game-text-button" @click="reveal">结束本局并看答案</button></div>
            </section>
            <section v-else class="game-result" :data-result="won ? 'won' : round.revealed ? 'revealed' : 'lost'" aria-labelledby="game-result-title">
              <h2 id="game-result-title" ref="outcomeHeading" tabindex="-1">{{ outcome }}</h2>
              <p v-if="won" class="game-result-score">本次 <strong>{{ steps }}</strong> 步<span>最短 {{ round.puzzle.shortestPath.length - 1 }} 步</span></p>
              <p v-else>{{ round.revealed ? '下方可查看符合本局规则的参考路线。' : '还没有抵达终点，可以撤回调整路线，或查看答案。' }}</p>
              <p class="game-result-meta">探索选择 {{ round.moves }} 次 · 提示 {{ round.hintedPaths.length }} 次</p>
              <div class="game-result-actions"><button class="game-button primary" :disabled="busy" @click="startPuzzle()">{{ busy ? '正在出题…' : '下一题' }}<GameIcon name="arrow" /></button><button class="game-button" :disabled="busy" @click="retry">重试本题</button><button v-if="!solutionVisible && !round.revealed" class="game-text-button" @click="reveal">查看最短路线</button></div>
              <SolutionList v-if="(solutionVisible || round.revealed) && displayNetwork" :network="displayNetwork" :primary="round.puzzle.shortestPath" :solutions="solutions" label="最短路线" @evidence="showEvidence" />
            </section>
            </template>
          </div>
        </div>

        <aside class="game-sidebar" :aria-label="mode === 'recognition' ? '本轮规则' : '本局规则和沿途关系'">
          <section><div class="game-sidebar-heading"><h2>{{ mode === 'recognition' ? '本轮规则' : '本局规则' }}</h2><button class="game-text-button" :disabled="busy" @click="openSettings">修改</button></div><dl class="game-rule-list"><div><dt>游戏模式</dt><dd>{{ MODES[mode].label }}</dd></div><div><dt>人物范围</dt><dd>{{ rules.scope === 'all' ? '干员与 NPC' : '仅干员' }}</dd></div><div v-if="mode === 'recognition'"><dt>题目配比</dt><dd>每轮 {{ RECOGNITION_SIZE }} 题 · 认识与不认识各 {{ RECOGNITION_CONNECTED_COUNT }} 题</dd></div><div v-else><dt>题目难度</dt><dd>{{ DIFFICULTIES[rules.difficulty].label }}{{ mode === 'completion' ? ` · ${COMPLETION_GAPS[rules.difficulty]} 处空位` : '' }}</dd></div><div><dt>{{ mode === 'recognition' ? '判断规则' : '连线规则' }}</dt><dd>{{ mode === 'recognition' ? '有直接连线算认识，没有算不认识' : '有连线即可双向通行' }}</dd></div></dl>
            <h3 class="game-ban-heading">禁用人物 <span>{{ activeBans.length }}</span></h3><ul class="game-active-bans"><li v-for="person in activeBans" :key="person.id"><PersonAvatar :person="person" /><span>{{ person.name }}</span></li></ul><p v-if="!activeBans.length" class="game-sidebar-note">本局没有禁用人物。</p><p v-else class="game-sidebar-note">{{ mode === 'recognition' ? '禁用人物及其异格不会进入抽题池。' : '禁用人物不会出现在起点、终点或中转。' }}</p>
          </section>
          <section v-if="mode !== 'recognition'" class="game-trail"><h2>沿途关系</h2><p v-if="!routeEdges.length" class="game-sidebar-note">开始连线后，可以在这里查看关系原文。</p><button v-for="edge in routeEdges" :key="edge.id" class="game-trail-edge" @click="showEvidence(edge.id)"><span>{{ edge.from.name }}<GameIcon name="arrow" />{{ edge.to.name }}</span><small>查看依据</small></button></section>
        </aside>
      </div>
      <footer class="game-page-footer"><a href="/?scope=all#factions">返回人物关系档案<GameIcon name="arrow" /></a><a href="/sources/">来源与版权 · 非官方</a></footer>
    </main>

    <FeedbackPanel :open="feedbackOpen" :target="feedbackTarget" @close="feedbackOpen = false" />
    <dialog ref="settings" class="archive-dialog game-settings" aria-labelledby="game-settings-title" @cancel="busy && $event.preventDefault()">
      <form class="game-dialog-surface" @submit.prevent="startPuzzle(draft, true)">
        <header class="game-dialog-header"><h2 id="game-settings-title">规则与禁用</h2><button type="button" class="archive-close" aria-label="关闭规则设置" :disabled="busy" @click="settings?.close()"><GameIcon name="close" /></button></header>
        <div class="game-dialog-body">
          <label class="game-field" for="game-scope">人物范围<select id="game-scope" v-model="draft.scope" :disabled="busy"><option value="operators">仅干员</option><option value="all">干员与 NPC</option></select></label>
          <p v-if="mode === 'recognition'" class="game-setting-note game-recognition-rules">每轮抽 {{ RECOGNITION_SIZE }} 对人物，直接认识与不认识各 {{ RECOGNITION_CONNECTED_COUNT }} 对，顺序随机。不认识的题都能通过一人接通，需要从候选中选出中间人；两步都答对才计为答对一题。同一轮不重复人物对。</p>
          <fieldset v-else class="game-difficulty"><legend>题目难度</legend><label v-for="(level, key) in DIFFICULTIES" :key="key" :class="{ selected: draft.difficulty === key }"><input v-model="draft.difficulty" type="radio" name="difficulty" :value="key" :disabled="busy" /><strong>{{ level.label }}</strong><span>{{ mode === 'completion' ? `${COMPLETION_GAPS[key]} 处空位 · ${COMPLETION_GAPS[key] * 2} 步` : `最短 ${level.min}${level.min !== level.max ? `–${level.max}` : ''} 步` }}</span></label></fieldset>
          <div class="game-ban-title"><h3>禁用人物 <span>{{ draftBans.length }}</span></h3><button type="button" class="game-text-button" :disabled="busy" @click="draft.bannedIds = [...DEFAULT_BANS]; rulesError = ''">恢复三巨头</button><button type="button" class="game-text-button" :disabled="busy || !draftBans.length" @click="draft.bannedIds = []; rulesError = ''">清空</button></div>
          <p class="game-setting-note">默认禁用博士、阿米娅、凯尔希。禁用包含本体与所有异格{{ mode === 'recognition' ? '，被禁用人物不会进入抽题池。' : '，对起点、终点和中转都生效。' }}</p>
          <div class="game-ban-chips"><button v-for="person in draftBans" :key="person.id" type="button" class="game-ban-chip" :aria-label="`取消禁用${person.name}`" :disabled="busy" @click="toggleBan(person.id)"><span>{{ person.name }}</span><GameIcon name="close" /></button><p v-if="!draftBans.length" class="game-setting-note">未禁用任何人物。</p></div>
          <label class="game-search"><GameIcon name="search" /><input v-model="banQuery" aria-label="搜索要禁用的人物" placeholder="搜索名字、真名或异格" :disabled="busy" autocomplete="off" /></label>
          <div class="game-ban-results"><button v-for="person in banMatches.slice(0, 24)" :key="person.id" type="button" :aria-pressed="draft.bannedIds.includes(person.id)" :aria-label="`${draft.bannedIds.includes(person.id) ? '取消禁用' : '禁用'}${person.name}`" :disabled="busy" @click="toggleBan(person.id)"><PersonAvatar :person="person" /><span>{{ person.name }}<small>{{ person.factionName }}</small></span><span class="game-ban-state">{{ draft.bannedIds.includes(person.id) ? '已禁用' : '禁用' }}</span></button><p v-if="!banMatches.length" class="game-empty">没有匹配的人物，试试其他名字。</p></div>
          <p v-if="banMatches.length > 24" class="game-setting-note">显示前 24 位，输入名字可继续查找。</p>
          <p v-if="rulesError" class="game-error" role="alert">{{ rulesError }}</p>
        </div>
        <footer class="game-dialog-footer"><span>{{ mode === 'recognition' ? '应用后开始新一轮。' : '应用后会开始新题。' }}</span><button type="submit" class="game-button primary" :disabled="busy">{{ busy ? '正在检查题目…' : mode === 'recognition' ? '应用并开始新一轮' : '应用并开始新题' }}<GameIcon name="arrow" /></button></footer>
      </form>
    </dialog>

    <dialog ref="evidenceDialog" class="archive-dialog game-evidence" aria-labelledby="game-evidence-title" @close="evidenceRequest++">
      <div class="game-dialog-surface"><header class="game-dialog-header"><h2 id="game-evidence-title">{{ evidence?.title || '关系依据' }}</h2><button class="archive-close" aria-label="关闭关系依据" @click="closeEvidence"><GameIcon name="close" /></button></header><div class="game-dialog-body record-evidence"><p v-if="evidenceLoading" role="status">正在读取原文…</p><template v-else-if="evidenceError"><p class="game-error" role="alert">{{ evidenceError }}</p><button class="game-button" @click="showEvidence(evidenceId)">重新读取</button></template><template v-else-if="evidence"><button class="archive-button secondary" @click="openFeedback({ targetType: 'relationship', targetId: evidence.id, title: evidence.title })">反馈这份资料</button><p>{{ evidence.note || '以下为档案收录的关系依据。' }}</p><article v-for="item in evidence.evidence" :key="item.id"><h3>关键原文</h3><blockquote>{{ item.quote }}</blockquote><SourceList :sources="item.sources" /></article></template></div></div>
    </dialog>

    <dialog ref="menu" class="site-menu" aria-label="网站导航"><button aria-label="关闭导航" @click="menu?.close()"><GameIcon name="close" /></button><a href="/#home">INDEX <span>首页</span></a><a href="/?scope=all#factions">RELATIONS <span>人物关系</span></a><a href="/game/" aria-current="page">GAME <span>游戏</span></a><a href="/preferences/">PREFERENCES <span>喜好</span></a><SiteNoticeButton>NOTICE <span>站点说明</span></SiteNoticeButton></dialog>
    <SiteNotice />
  </div>
</template>
