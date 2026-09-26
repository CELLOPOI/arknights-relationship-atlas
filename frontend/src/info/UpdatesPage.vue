<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError } from '../api';
import FeedbackPanel from '../components/FeedbackPanel.vue';
import SiteNotice from '../components/SiteNotice.vue';
import SiteNoticeButton from '../components/SiteNoticeButton.vue';

type Category = 'all' | 'story' | 'feature';
type Update = { id: number; category: Exclude<Category, 'all'>; title: string; summary: string; changes: string[];
  status: 'draft' | 'published'; publishedAt: string | null };
type UpdatePage = { results: Update[]; count: number; next: number | null };
const categories: { value: Category; label: string }[] = [{ value: 'all', label: '全部更新' }, { value: 'story', label: '剧情修订' }, { value: 'feature', label: '功能更新' }];
const category = ref<Category>('all');
const items = ref<Update[]>([]);
const next = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const preview = ref('');
const feedbackOpen = ref(false);
const menu = ref<HTMLDialogElement>();
const scroll = ref<HTMLElement>();
let request = 0;
let failedPage = 1;
const date = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value)).replaceAll('/', '.') : '待发布';

async function load(page = 1) {
  const sequence = ++request;
  busy.value = true; error.value = ''; failedPage = page;
  if (page === 1) { items.value = []; next.value = null; }
  try {
    if (preview.value) {
      const item = await api<Update>(`updates/${encodeURIComponent(preview.value)}/preview/`);
      if (sequence !== request) return;
      items.value = [item];
    } else {
      const result = await api<UpdatePage>(`updates/?category=${category.value}&page=${page}`);
      if (sequence !== request) return;
      items.value = page === 1 ? result.results : [...items.value, ...result.results];
      next.value = result.next;
    }
  } catch (reason) {
    if (sequence !== request) return;
    error.value = preview.value && reason instanceof ApiError && reason.status === 403
      ? '请先登录有查看权限的后台账号，再打开草稿预览。' : (reason as Error).message;
  } finally { if (sequence === request) busy.value = false; }
}
function filter(value: Category) {
  if (value === category.value) return;
  category.value = value;
  const url = new URL(location.href);
  if (value === 'all') url.searchParams.delete('category'); else url.searchParams.set('category', value);
  history.pushState(history.state, '', url);
  void load();
}
function readLocation() {
  const query = new URL(location.href).searchParams;
  const value = query.get('category');
  category.value = value === 'story' || value === 'feature' ? value : 'all';
  preview.value = query.get('preview') || '';
  if (scroll.value) scroll.value.scrollTop = 0;
  void load();
}
onMounted(() => {
  document.title = '更新说明 · 方舟关系与喜好';
  readLocation();
  window.addEventListener('popstate', readLocation);
});
onBeforeUnmount(() => { request++; menu.value?.close(); window.removeEventListener('popstate', readLocation); });
</script>

<template>
  <div class="updates-page">
    <a class="skip-link" href="#updates-content">跳到更新说明</a>
    <header class="site-header">
      <a class="site-brand" href="/#home"><span>方舟关系与喜好</span><small>ARKNIGHTS</small></a>
      <nav class="site-nav" aria-label="主导航">
        <a href="/#home"><span>INDEX</span><small>首页</small></a>
        <a href="/?scope=all#factions"><span>RELATIONS</span><small>人物关系</small></a>
        <a href="/game/"><span>GAME</span><small>游戏</small></a>
        <a href="/preferences/"><span>PREFERENCES</span><small>喜好</small></a>
        <a href="/updates/" aria-current="page"><span>UPDATES</span><small>更新</small></a>
        <SiteNoticeButton><span>NOTICE</span><small>站点说明</small></SiteNoticeButton>
      </nav>
      <button class="updates-menu-button" aria-label="打开导航" aria-haspopup="dialog" @click="menu?.showModal()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
    </header>
    <main id="updates-content" ref="scroll" class="updates-scroll" tabindex="-1">
      <div class="updates-layout">
        <header class="updates-heading">
          <div><h1>更新说明</h1><p>人物关系的补录与勘误，以及网站功能的变化。</p></div>
          <button class="updates-feedback" aria-haspopup="dialog" @click="feedbackOpen = true">反馈问题 <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></button>
        </header>
        <div v-if="preview" class="updates-preview" role="status"><span>后台预览 · {{ items[0]?.status === 'published' ? '已发布' : '待发布' }}</span><a :href="`/admin/atlas/siteupdate/${encodeURIComponent(preview)}/change/`">返回后台编辑</a></div>
        <div v-else class="updates-filters" role="group" aria-label="更新分类">
          <button v-for="option in categories" :key="option.value" :aria-pressed="category === option.value" @click="filter(option.value)">{{ option.label }}</button>
        </div>
        <section class="updates-feed" aria-label="更新记录" :aria-busy="busy">
          <div v-if="busy && !items.length" class="updates-loading" role="status"><p>正在加载更新…</p><div aria-hidden="true"><span /><span /><span /></div></div>
          <article v-for="item in items" :id="`update-${item.id}`" :key="item.id" class="update-entry">
            <div class="update-meta"><time v-if="item.publishedAt" :datetime="item.publishedAt">{{ date(item.publishedAt) }}</time><span v-else class="update-pending">待发布</span><span class="update-category">{{ item.category === 'story' ? '剧情修订' : '功能更新' }}</span></div>
            <div class="update-copy">
              <h2>{{ item.title }}</h2>
              <p class="update-summary">{{ item.summary }}</p>
              <ul class="update-changes"><li v-for="(change, index) in item.changes" :key="index">{{ change }}</li></ul>
            </div>
          </article>
          <div v-if="error" class="updates-state" role="alert"><p>{{ error }}</p><button class="archive-button secondary" :disabled="busy" @click="load(failedPage)">重新加载</button></div>
          <div v-else-if="!busy && !items.length" class="updates-state"><h2>暂无{{ category === 'story' ? '剧情修订' : category === 'feature' ? '功能更新' : '更新记录' }}</h2><p>发布后的说明会按时间列在这里。</p><button v-if="category !== 'all'" class="archive-button secondary" @click="filter('all')">查看全部更新</button></div>
          <div v-if="next && !error" class="updates-more"><button class="archive-button secondary" :disabled="busy" @click="load(next)">{{ busy ? '正在加载…' : '查看更早的更新' }}</button></div>
        </section>
        <footer class="updates-footer"><a href="/sources/">来源与版权</a></footer>
      </div>
    </main>
    <dialog ref="menu" class="site-menu" aria-label="网站导航">
      <button aria-label="关闭导航" @click="menu?.close()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      <a href="/#home">INDEX <span>首页</span></a><a href="/?scope=all#factions">RELATIONS <span>人物关系</span></a><a href="/game/">GAME <span>游戏</span></a><a href="/preferences/">PREFERENCES <span>喜好</span></a><a href="/updates/" aria-current="page" @click="menu?.close()">UPDATES <span>更新</span></a><SiteNoticeButton>NOTICE <span>站点说明</span></SiteNoticeButton>
    </dialog>
    <FeedbackPanel :open="feedbackOpen" @close="feedbackOpen = false" />
    <SiteNotice />
  </div>
</template>

<style>
.updates-page { height: 100dvh; display: flex; flex-direction: column; background: var(--bg-canvas); color: var(--text-primary); }
.updates-page .site-header { flex: none; }
.updates-page svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.updates-page :focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 4px; }
.updates-page ::selection { background: var(--accent-cyan); color: var(--bg-canvas); }
.updates-page a { text-underline-offset: 4px; }
.updates-scroll { flex: 1; min-height: 0; overflow-y: auto; outline: none; scrollbar-gutter: stable; scrollbar-color: var(--border-medium) var(--bg-canvas); }
.updates-layout { max-width: 1120px; padding: 64px 40px 28px; margin-inline: auto; }
.updates-heading { display: flex; align-items: center; justify-content: space-between; gap: 32px; padding-bottom: 44px; }
.updates-heading h1 { margin: 0; font-size: 42px; line-height: 1.3; font-weight: 700; }
.updates-heading p { margin: 16px 0 0; color: var(--text-muted); font-size: 15px; line-height: 1.8; }
.updates-feedback { display: inline-flex; flex: none; align-items: center; gap: 28px; padding: 0 0 0 18px; min-height: 44px; border: 0; background: none; color: var(--accent-cyan); font: inherit; font-size: 14px; cursor: pointer; }
.updates-feedback:hover { color: var(--accent-cyan-hover); }
.updates-filters { display: flex; gap: 32px; border-bottom: 1px solid var(--border-medium); }
.updates-filters button { padding: 14px 0; min-height: 48px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; }
.updates-filters button:hover { color: var(--text-primary); }
.updates-filters button[aria-pressed="true"] { color: var(--accent-cyan); border-bottom-color: var(--accent-cyan); }
.updates-preview { display: flex; justify-content: space-between; gap: 16px; padding: 16px 0; border-block: 1px solid var(--border-medium); color: var(--accent-amber); font-size: 14px; line-height: 1.6; }
.updates-preview a { color: var(--text-secondary); }
.update-entry { display: grid; grid-template-columns: 176px minmax(0, 1fr); gap: 32px; padding: 40px 0 44px; border-bottom: 1px solid var(--border-subtle); }
.update-meta { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; padding-top: 3px; }
.update-meta time { color: var(--text-primary); font: 400 26px/1.3 AtlasNarrow, sans-serif; font-variant-numeric: tabular-nums; }
.update-pending { font-size: 22px; color: var(--accent-amber); }
.update-category { font-size: 12px; line-height: 1.5; color: var(--text-muted); }
.update-copy { max-width: 72ch; min-width: 0; overflow-wrap: anywhere; }
.update-copy h2 { margin: 0; font-size: 24px; line-height: 1.5; text-wrap: balance; }
.update-summary { margin: 16px 0 20px; color: var(--text-secondary); font-size: 15px; line-height: 1.9; white-space: pre-wrap; }
.update-changes { padding-left: 20px; margin: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.9; }
.update-changes li { padding-left: 4px; white-space: pre-wrap; }
.update-changes li + li { margin-top: 12px; }
.update-changes li::marker { color: var(--text-muted); }
.updates-state, .updates-loading { padding: 52px 0; }
.updates-state h2 { margin: 0 0 12px; font-size: 20px; }
.updates-state p, .updates-loading p { margin: 0 0 24px; color: var(--text-muted); font-size: 15px; line-height: 1.8; }
.updates-state[role="alert"] p { color: var(--feedback-error); }
.updates-loading span { display: block; height: 12px; width: 70%; margin-top: 16px; background: var(--bg-surface-elevated); }
.updates-loading span:first-child { width: 40%; height: 22px; margin-bottom: 28px; }
.updates-loading span:last-child { width: 55%; }
.updates-more { padding: 28px 0; text-align: center; }
.updates-footer { display: flex; align-items: center; justify-content: flex-end; padding-top: 28px; font-size: 12px; line-height: 1.9; color: var(--text-muted); }
.updates-footer a { display: inline-flex; align-items: center; flex: none; min-height: 44px; color: var(--text-secondary); }
.updates-footer a:hover { color: var(--accent-cyan); }
.updates-menu-button { display: none; align-items: center; justify-content: center; width: 44px; height: 44px; border: 0; color: var(--text-primary); background: none; cursor: pointer; }
@media (max-width: 1100px) { .updates-menu-button { display: inline-flex; margin-left: auto; } }
@media (max-width: 760px) {
  .updates-layout { padding: 32px 20px max(24px, env(safe-area-inset-bottom)); }
  .updates-heading { align-items: flex-start; gap: 16px; padding-bottom: 28px; }
  .updates-heading h1 { font-size: 30px; }
  .updates-heading p { max-width: 22em; font-size: 14px; margin-top: 14px; }
  .updates-feedback { font-size: 13px; padding: 0; gap: 8px; }
  .updates-feedback svg { width: 18px; height: 18px; }
  .updates-filters { gap: 28px; }
  .update-entry { grid-template-columns: 1fr; gap: 20px; padding: 28px 0 32px; }
  .update-meta { flex-direction: row; align-items: center; gap: 16px; padding: 0; }
  .update-meta time { font-size: 22px; }
  .update-pending { font-size: 18px; }
  .update-copy h2 { font-size: 21px; }
  .update-summary { margin-top: 12px; font-size: 14px; }
  .updates-footer { flex-direction: column; align-items: flex-start; gap: 8px; }
  .updates-preview { flex-wrap: wrap; }
}
</style>
