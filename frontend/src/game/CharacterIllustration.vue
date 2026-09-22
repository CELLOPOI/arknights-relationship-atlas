<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { GamePerson } from './network';
import { loadIllustrations, type CharacterArt, type Illustration } from './illustrations';
import PersonAvatar from './PersonAvatar.vue';

const props = defineProps<{ person: GamePerson; side: 'current' | 'target'; label?: string }>();
const roleLabel = computed(() => props.label || (props.side === 'current' ? '当前人物' : '终点'));
const art = shallowRef<CharacterArt | null>(null);
const phase = ref<'base' | 'elite2'>('base');
const foreground = computed(() => phase.value === 'elite2' ? art.value?.elite2 : art.value?.base);
const backdrop = computed(() => phase.value === 'elite2'
  ? art.value?.basePortrait
  : art.value?.elite2Portrait);
const canSwap = computed(() => props.person.isOperator !== false && !!art.value?.elite2 && !!art.value?.basePortrait && !!art.value?.elite2Portrait && loaded.value && !failed.value);
const nextPhase = computed(() => phase.value === 'base' ? '精二' : '精一');
const swapping = ref<'loading' | 'moving' | null>(null);
const swapError = ref(false);
const loaded = ref(false);
const failed = ref(false);
const backgroundFailed = ref(false);
const attempt = ref(0);
let request = 0;

async function load() {
  const active = ++request;
  art.value = null; loaded.value = false; failed.value = false; backgroundFailed.value = false;
  phase.value = 'base'; swapping.value = null; swapError.value = false;
  attempt.value++;
  try {
    const index = await loadIllustrations();
    if (active !== request) return;
    art.value = index.people[props.person.appearanceId || props.person.id] || null;
    failed.value = !art.value?.base;
  } catch { if (active === request) failed.value = true; }
}

function preload(image: Illustration) {
  return new Promise<void>((resolve, reject) => {
    const element = new Image();
    const timeout = window.setTimeout(() => finish(new Error('Illustration load timed out')), 15000);
    function finish(error?: unknown) {
      window.clearTimeout(timeout);
      element.onload = null; element.onerror = null;
      if (error) reject(error); else resolve();
    }
    element.onload = () => { element.decode().then(() => finish(), finish); };
    element.onerror = () => finish(new Error('Illustration unavailable'));
    element.src = image.src;
  });
}

async function swap() {
  if (!canSwap.value || swapping.value || !art.value?.elite2 || !art.value.basePortrait || !art.value.elite2Portrait) return;
  const active = request;
  const next = phase.value === 'base' ? 'elite2' : 'base';
  const front = next === 'elite2' ? art.value.elite2 : art.value.base;
  const back = next === 'elite2' ? art.value.basePortrait : art.value.elite2Portrait;
  swapping.value = 'loading'; swapError.value = false;
  try {
    // 两层解码完成后一起交换，慢网或失败时保留原画面，避免空白和先后闪现。
    await Promise.all([preload(front), preload(back)]);
    if (active !== request) return;
    backgroundFailed.value = false;
    swapping.value = 'moving'; phase.value = next;
  } catch {
    if (active !== request) return;
    swapping.value = null; swapError.value = true;
  }
}

watch(() => props.person.appearanceId || props.person.id, load, { immediate: true });
onBeforeUnmount(() => { request++; });
</script>

<template>
  <figure class="game-portrait" :class="`game-portrait-${side}`" :data-person-id="person.id" :data-appearance-id="person.appearanceId || person.id" :data-person-kind="person.isOperator === false ? 'npc' : 'operator'" :data-art-state="failed ? 'error' : loaded ? 'ready' : 'loading'" :data-art-phase="phase" :data-swapping="swapping || undefined" :aria-label="`${roleLabel}：${person.name}`" :style="art ? { '--portrait-native-height': `${art.base.height}px` } : undefined">
    <div class="game-portrait-stage" :aria-busy="(!loaded && !failed) || !!swapping">
      <Transition name="game-art-back">
        <div v-if="backdrop && person.isOperator !== false && !backgroundFailed" :key="`${person.id}-back-${phase}-${attempt}`" class="game-portrait-backdrop" aria-hidden="true">
          <img class="game-portrait-back" :src="backdrop.src" :width="backdrop.width" :height="backdrop.height" alt="" decoding="async" draggable="false" @error="backgroundFailed = true" />
        </div>
      </Transition>
      <Transition name="game-art-front" @after-enter="swapping === 'moving' && (swapping = null)">
        <div v-if="foreground && !failed" :key="`${person.id}-front-${phase}-${attempt}`" class="game-portrait-foreground" :data-phase="phase">
          <img class="game-portrait-front" :class="{ loaded }" :src="foreground.src" :width="foreground.width" :height="foreground.height" :alt="`${person.name}${canSwap ? (phase === 'base' ? '精一' : '精二') : ''}立绘`" decoding="async" fetchpriority="high" draggable="false" @load="loaded = true" @error="failed = true" />
        </div>
      </Transition>
      <button v-if="canSwap" type="button" class="game-portrait-switch" :aria-label="`${person.name}：${swapError ? '重试' : '切换至'}${nextPhase}立绘`" :aria-disabled="!!swapping" :title="swapError ? '立绘加载失败，点击重试' : `点击背景，切换至${nextPhase}立绘`" @click="swap">
        <span class="game-portrait-switch-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 8h15l-4-4M20 16H5l4 4" /></svg>
          {{ swapping === 'loading' ? '加载中…' : `${swapError ? '重试' : '切换'}${nextPhase}` }}
        </span>
      </button>
      <div v-if="!loaded || failed" class="game-portrait-fallback">
        <PersonAvatar :person="person" eager />
        <template v-if="failed"><span>立绘暂不可用</span><button class="game-text-button" @click="load">重试立绘</button></template>
        <span v-else>正在加载立绘…</span>
      </div>
      <span class="game-portrait-status" role="status">{{ swapError ? `${nextPhase}立绘加载失败，点击背景重试。` : swapping === 'loading' ? `正在加载${nextPhase}立绘。` : canSwap ? `当前显示${phase === 'base' ? '精一' : '精二'}立绘。` : '' }}</span>
    </div>
    <figcaption class="game-portrait-caption">
      <div class="game-portrait-name"><h2>{{ person.name }}</h2><span>{{ roleLabel }}</span></div>
      <p>{{ person.factionName }}<span v-if="person.canonicalName && person.canonicalName !== person.name"> · {{ person.canonicalName }}的异格</span><span v-if="art?.generic"> · 剧情通用立绘</span></p>
    </figcaption>
  </figure>
</template>
