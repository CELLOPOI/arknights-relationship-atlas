<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { siteNotice } from '../content/site-notice';
import { acknowledgeSiteNotice, hasAcknowledgedSiteNotice, openSiteNotice, siteNoticeOpen } from '../site-notice';

const dialog = ref<HTMLDialogElement>();
const body = ref<HTMLElement>();
const content = ref<HTMLElement>();
const readToEnd = ref(false);
let observer: ResizeObserver | undefined;
let layoutReady = false;
let opening = 0;

function checkReadPosition() {
  const element = body.value;
  if (!dialog.value?.open || !element || !layoutReady) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 2) readToEnd.value = true;
}

watch(siteNoticeOpen, async open => {
  const sequence = ++opening;
  observer?.disconnect();
  layoutReady = false;
  await nextTick();
  if (sequence !== opening || !dialog.value || !body.value || !content.value) return;
  if (!open) { dialog.value.close(); return; }
  // 已确认后主动重看不再要求滚到底；首次阅读只在正文末尾出现后解锁。
  readToEnd.value = hasAcknowledgedSiteNotice();
  dialog.value.showModal();
  body.value.scrollTop = 0;
  body.value.focus({ preventScroll: true });
  observer = new ResizeObserver(checkReadPosition);
  observer.observe(body.value);
  observer.observe(content.value);
  await document.fonts.ready;
  if (sequence !== opening) return;
  layoutReady = true;
  checkReadPosition();
}, { immediate: true });

function acknowledge() {
  if (readToEnd.value) acknowledgeSiteNotice();
}

onMounted(() => { if (!hasAcknowledgedSiteNotice()) openSiteNotice(); });
onBeforeUnmount(() => { opening++; observer?.disconnect(); dialog.value?.close(); });
</script>

<template>
  <dialog ref="dialog" id="site-notice-dialog" class="archive-dialog site-notice-dialog" aria-labelledby="site-notice-heading" @cancel.prevent @keydown.stop>
    <div class="archive-dialog-surface">
      <header class="archive-dialog-header"><h2 id="site-notice-heading">{{ siteNotice.title }}</h2></header>
      <div ref="body" class="archive-dialog-body site-notice-body" tabindex="0" role="region" aria-label="站点说明正文" @scroll.passive="checkReadPosition">
        <div ref="content">
          <p v-for="(paragraph, index) in siteNotice.paragraphs" :key="index">{{ paragraph }}</p>
          <p><a class="site-notice-project" :href="siteNotice.project.url" target="_blank" rel="noopener noreferrer">{{ siteNotice.project.label }}</a></p>
        </div>
      </div>
      <footer class="site-notice-footer">
        <p id="site-notice-status" role="status">{{ readToEnd ? '确认后不再自动弹出' : '请阅读至末尾' }}</p>
        <button type="button" class="archive-button site-notice-confirm" :disabled="!readToEnd" aria-describedby="site-notice-status" @click="acknowledge">我已知晓</button>
      </footer>
    </div>
  </dialog>
</template>

<style>
.site-notice-dialog { width: 560px; max-height: 80dvh; margin: auto; overflow: hidden; outline: none; }
.site-notice-dialog .archive-dialog-surface { height: auto; min-height: 0; }
.site-notice-body { min-height: 0; font-size: 16px; line-height: 1.85; color: var(--text-secondary); touch-action: pan-y; scrollbar-gutter: stable; }
.site-notice-body:focus-visible { outline-offset: -4px; }
.site-notice-body p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.site-notice-body p + p { margin-top: 20px; }
.site-notice-project { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent-cyan); text-underline-offset: 4px; overflow-wrap: anywhere; }
.site-notice-project:hover { color: var(--accent-cyan-hover); }
.site-notice-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex: none; border-top: 1px solid var(--archive-rule); padding: 18px 28px; }
.site-notice-footer p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-muted); }
.site-notice-confirm { flex: none; background: var(--accent-cyan); border-color: var(--accent-cyan); }
.site-notice-confirm:hover { background: var(--accent-cyan-hover); border-color: var(--accent-cyan-hover); }
.site-notice-dialog .site-notice-confirm:disabled { background: var(--bg-surface); border-color: var(--archive-rule); color: var(--text-muted); opacity: 1; }
@media (max-width: 760px) {
  .site-notice-dialog { max-height: calc(100dvh - 32px); }
  .site-notice-footer { padding: 16px 20px max(16px, env(safe-area-inset-bottom)); gap: 12px; }
}
@media (max-width: 380px) {
  .site-notice-footer { flex-direction: column; align-items: stretch; }
}
</style>
