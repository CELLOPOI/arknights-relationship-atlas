<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import SiteNotice from '../components/SiteNotice.vue';
import SiteNoticeButton from '../components/SiteNoticeButton.vue';
import FeedbackPanel from '../components/FeedbackPanel.vue';
import GameIcon from '../game/GameIcon.vue';
import CharactersView from './CharactersView.vue';
import SkinsView from './SkinsView.vue';
import ResultsView from './ResultsView.vue';
import { request } from './api';
import { preferenceDraft } from './session';
import { bindSectionScroll } from '../section-scroll';
import { navigateSection, sectionTransitioning } from '../section-navigation';
import type { Catalog, Config, State } from './types';
import './preferences.css';

const catalog = shallowRef<Catalog | null>(null), state = shallowRef<State | null>(null);
const config = ref<Config>({});
const loading = ref(true), error = ref(''), feedback = ref(false);
const tab = ref<'characters' | 'skins'>('characters'), formId = ref(''), personId = ref('');
const menu = ref<HTMLDialogElement>(), viewport = ref<HTMLElement>();
const scrolls = preferenceDraft('scrolls', { characters: 0, skins: 0 });
let releaseScroll: (() => void) | undefined;
let disposed = false, stateRequest = 0;
const ready = computed(() => !!catalog.value && !!state.value);
// 无匿名身份时仅向目录组件提供明确禁写的展示上下文；它不代表已查询到的个人登记。
const publicState = computed<State>(() => ({
  server_time: '', catalog_version: catalog.value?.version || '', risk_status: 'unavailable',
  writes_enabled: false, choice_order_seed: 'public-directory', cooldown_hours: Number(config.value.cooldown_hours || 24),
  quota: { weekly_used: 0, weekly_limit: 0, rolling_used: 0, rolling_limit: 0, remaining: 0, weekly_resets_at: '', rolling_recovers_at: null },
  pending_task: null, choices: [], supports: { support_ids: [], favorite_ids: [], version: 0, next_change_at: null,
    support_limit: Number(config.value.support_limit || 15), favorite_limit: Number(config.value.favorite_limit || 3) },
}));

async function refresh() {
  const id = ++stateRequest;
  try {
    const fresh = await request<State>('state/');
    const updated = fresh.catalog_version !== catalog.value?.version
      ? await request<{ catalog: Catalog | null; config: Config }>('catalog/') : null;
    if (!disposed && id === stateRequest) {
      if (updated?.catalog) { catalog.value = updated.catalog; config.value = updated.config; }
      state.value = { ...fresh, config: config.value }; error.value = '';
    }
  } catch (reason) {
    if (!disposed && id === stateRequest) error.value = `个人状态暂未刷新：${(reason as Error).message}`;
  }
}
async function load() {
  loading.value = true; error.value = '';
  try {
    const result = await request<{ catalog: Catalog | null; config: Config }>('catalog/');
    if (disposed) return;
    if (!result.catalog) throw new Error('喜好目录尚未发布，请稍后重试。');
    catalog.value = result.catalog;
    config.value = result.config;
    const identity = await request<State>('identity/', 'POST', {});
    if (!disposed) { state.value = { ...identity, config: result.config }; await nextTick(); if (viewport.value) viewport.value.scrollTop = scrolls[tab.value]; }
  } catch (reason) { if (!disposed) error.value = (reason as Error).message; }
  finally { if (!disposed) loading.value = false; }
}
async function syncRoute() {
  if (viewport.value) scrolls[tab.value] = viewport.value.scrollTop;
  const params = new URLSearchParams(location.search);
  tab.value = params.get('tab') === 'skins' ? 'skins' : 'characters';
  formId.value = tab.value === 'skins' ? params.get('form') || '' : '';
  personId.value = tab.value === 'characters' ? params.get('person') || '' : '';
  await nextTick();
  if (viewport.value) viewport.value.scrollTop = scrolls[tab.value];
}
function route(next: 'characters' | 'skins', form = '') {
  const url = new URL(location.href);
  url.searchParams.set('tab', next);
  url.searchParams.delete('person');
  if (form && next === 'skins') url.searchParams.set('form', form); else url.searchParams.delete('form');
  if (url.href === location.href) return;
  history.pushState({ ...history.state }, '', url);
  void syncRoute();
  // 切换只查询已保存状态；派发只发生于人物视图的明确操作。
  if (state.value) void refresh();
}
onMounted(() => {
  document.title = '喜好 · 泰拉群像';
  void syncRoute(); void load();
  window.addEventListener('popstate', syncRoute);
  document.addEventListener('atlas:preferences-changed', refresh);
  releaseScroll = bindSectionScroll(viewport.value!, {
    blocked: sectionTransitioning,
    step: direction => {
      if (direction > 0) return false;
      navigateSection('/game/', -1); return true;
    },
  });
});
onBeforeUnmount(() => { if (viewport.value) scrolls[tab.value] = viewport.value.scrollTop; disposed = true; stateRequest++; releaseScroll?.(); window.removeEventListener('popstate', syncRoute); document.removeEventListener('atlas:preferences-changed', refresh); });
</script>
<template>
  <div class="preferences-app">
    <a class="skip-link" href="#preferences-workspace">跳到喜好内容</a>
    <header class="site-header preferences-header">
      <a class="site-brand" href="/#home"><span>泰拉群像</span><small>ARKNIGHTS</small></a>
      <nav class="site-nav" aria-label="主导航">
        <a href="/#home"><span>INDEX</span><small>首页</small></a>
        <a href="/?scope=all#factions"><span>RELATIONS</span><small>人物关系</small></a>
        <a href="/game/"><span>GAME</span><small>游戏</small></a>
        <a href="/preferences/" aria-current="page"><span>PREFERENCES</span><small>喜好</small></a>
        <SiteNoticeButton><span>NOTICE</span><small>站点说明</small></SiteNoticeButton>
      </nav>
      <div class="visitor-links"><a href="https://github.com/CELLOPOI/arknights-relationship-atlas/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a><button class="account-entry" @click="feedback = true">反馈问题</button></div>
      <button class="site-menu-toggle" aria-label="打开导航" aria-haspopup="dialog" @click="menu?.showModal()"><span></span><span></span><span></span></button>
    </header>
    <div class="preferences-layout">
      <nav class="preferences-switch" aria-label="喜好视图">
        <button :aria-current="tab === 'characters' ? 'page' : undefined" @click="route('characters')"><span>人物</span></button>
        <button :aria-current="tab === 'skins' ? 'page' : undefined" @click="route('skins')"><span>皮肤</span></button>
        <a href="/sources/" class="preferences-source">来源</a>
      </nav>
      <main id="preferences-workspace" ref="viewport" class="preferences-workspace" tabindex="-1" :aria-busy="loading">
        <div v-if="loading && !ready" class="preference-empty" role="status">正在读取喜好目录与个人状态…</div>
        <div v-else-if="error && !catalog" class="preference-empty"><p role="alert">{{ error }}</p><button class="pref-primary" @click="load">重新读取</button></div>
        <template v-if="catalog && state">
          <p v-if="error" class="pref-error" role="alert">{{ error }} <button class="pref-text" @click="refresh">重试刷新</button></p>
          <CharactersView v-show="tab === 'characters'" :active="tab === 'characters'" :catalog="catalog" :state="state" :person-id="personId" @refresh="refresh" @skin="id => route('skins', id)" />
          <SkinsView v-show="tab === 'skins'" :active="tab === 'skins'" :catalog="catalog" :state="state" :form-id="formId" @refresh="refresh" @open="id => route('skins', id)" @close="route('skins')" />
        </template>
        <template v-else-if="catalog && !loading">
          <p class="pref-message" role="status">个人登记暂时不可用，当前仅浏览公开目录与结果；卡面显示默认外观。{{ error }} <button class="pref-text" @click="load">重新连接</button></p>
          <section v-show="tab === 'characters'"><header class="preference-title"><h1>人物喜好</h1><p>公开结果 · 只读浏览</p></header><ResultsView :catalog="catalog" /></section>
          <SkinsView v-show="tab === 'skins'" :active="tab === 'skins'" :catalog="catalog" :state="publicState" :form-id="formId" @open="id => route('skins', id)" @close="route('skins')" />
        </template>
        <footer class="preferences-footer"><span>本站参与者的喜好记录</span><button @click="feedback = true">反馈问题</button><a href="/sources/">来源与版权</a></footer>
      </main>
    </div>
    <dialog ref="menu" class="site-menu" aria-label="网站导航"><button aria-label="关闭导航" @click="menu?.close()"><GameIcon name="close" /></button><a href="/#home">INDEX <span>首页</span></a><a href="/?scope=all#factions">RELATIONS <span>人物关系</span></a><a href="/game/">GAME <span>游戏</span></a><a href="/preferences/" aria-current="page">PREFERENCES <span>喜好</span></a><SiteNoticeButton>NOTICE <span>站点说明</span></SiteNoticeButton><a href="/sources/">SOURCES <span>来源与版权</span></a></dialog>
    <SiteNotice /><FeedbackPanel :open="feedback" :target="null" @close="feedback = false" />
  </div>
</template>
