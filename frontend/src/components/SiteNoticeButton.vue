<script setup lang="ts">
import { openSiteNotice } from '../site-notice';

function open(event: MouseEvent) {
  // 从手机导航打开时先收起菜单，关闭说明后焦点返回菜单按钮。
  (event.currentTarget as HTMLElement).closest('dialog')?.close();
  openSiteNotice();
}
</script>

<template>
  <button type="button" class="site-notice-entry" aria-haspopup="dialog" aria-controls="site-notice-dialog" @click="open"><slot>站点说明</slot></button>
</template>

<style>
.site-notice-entry { border: 0; background: none; color: var(--text-secondary); font: inherit; padding: 0; min-height: 44px; cursor: pointer; text-align: left; }
.site-notice-entry:hover { color: var(--accent-cyan); }
.site-notice-entry:focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 4px; }
</style>
