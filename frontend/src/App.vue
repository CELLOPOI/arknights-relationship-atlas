<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AtlasShell from './components/AtlasShell.vue';
import AccountPanel from './components/AccountPanel.vue';
import FeedbackPanel from './components/FeedbackPanel.vue';
import RecordPanel from './components/RecordPanel.vue';
import SiteNotice from './components/SiteNotice.vue';
import { refreshSession, user, communityEnabled } from './session';
import type { Target, FeedbackTarget } from './types';

const feedbackOpen = ref(false);
const feedbackTarget = ref<FeedbackTarget | null>(null);
function openFeedback(next: FeedbackTarget | null = null) { feedbackTarget.value = next; feedbackOpen.value = true; }
const ready = ref(false);
const accountOpen = ref(false);
const target = ref<Target | null>(null);
const focus = ref<string | null>(null);
const scope = ref(new URLSearchParams(location.search).get('scope') === 'all' ? 'all' : 'operators');
const npcCount = ref<number | null>(null);
const authAction = ref('login');
const token = ref('');
const uid = ref('');

function openAccount() { if (!communityEnabled.value) return; authAction.value = 'login'; accountOpen.value = true; }
function onView(event: Event) { focus.value = (event as CustomEvent).detail.focus; }
function onData(event: Event) { npcCount.value = (event as CustomEvent).detail.npcCount; }
function onClick(event: MouseEvent) {
  const element = (event.target as Element)?.closest<HTMLElement>('[data-community]');
  if (element?.dataset.target) openRecord({ targetType: element.dataset.community as Target['targetType'], targetId: element.dataset.target });
}
function openRecord(next: Target) { window.relationshipAtlas?.closePanel(); target.value = next; accountOpen.value = false; }
function navigate(id: string, isOperator: boolean) {
  target.value = null; accountOpen.value = false;
  if (!isOperator && scope.value !== 'all') {
    const url = new URL(location.href); url.searchParams.set('scope', 'all'); url.searchParams.set('person', id); url.hash = 'graph'; location.assign(url); return;
  }
  window.relationshipAtlas?.navigate(id);
}
function changeScope(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const url = new URL(location.href);
  if (value === 'all') url.searchParams.set('scope', 'all'); else url.searchParams.delete('scope');
  location.assign(url);
}

onMounted(async () => {
  document.addEventListener('atlas:view', onView);
  document.addEventListener('atlas:data', onData);
  document.addEventListener('click', onClick);
  await refreshSession();
  const params = new URLSearchParams(location.search);
  if (communityEnabled.value && ['verify', 'reset'].includes(params.get('action') || '')) {
    authAction.value = params.get('action')!; token.value = params.get('token') || ''; uid.value = params.get('uid') || '';
    const url = new URL(location.href); ['action', 'token', 'uid'].forEach(key => url.searchParams.delete(key)); history.replaceState(history.state, '', url);
    accountOpen.value = true;
  }
});
onBeforeUnmount(() => { document.removeEventListener('atlas:view', onView); document.removeEventListener('atlas:data', onData); document.removeEventListener('click', onClick); });
</script>

<template>
  <AtlasShell @ready="ready = true" />
  <template v-if="ready">
    <Teleport to="#account-control"><div class="visitor-links"><a href="https://github.com/CELLOPOI/arknights-relationship-atlas/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a><button class="account-entry" @click="openFeedback()">反馈问题</button></div><button v-if="communityEnabled" class="account-entry" aria-haspopup="dialog" @click="openAccount"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><span>{{ user ? '我的档案' : '登录 / 注册' }}</span></button></Teleport>
    <Teleport to="#person-actions"><button v-if="focus" class="archive-text-button person-record-button" @click="openRecord({ targetType: 'person', targetId: focus })">人物档案<svg aria-hidden="true"><use href="#i-arrow-up-right" /></svg></button></Teleport>
    <Teleport to="#scope-control"><div class="scope-control"><label for="archive-scope">资料范围</label><select id="archive-scope" :value="scope" @change="changeScope"><option value="operators">干员版</option><option value="all">干员与 NPC</option></select></div><p v-if="scope === 'all' && npcCount !== null" class="scope-note">{{ npcCount > 0 ? `已收录 ${npcCount} 名 NPC` : '当前资料尚未收录 NPC，将随核查逐步补充。' }}</p></Teleport>
  </template>
  <FeedbackPanel :open="feedbackOpen" :target="feedbackTarget" @close="feedbackOpen = false" />
  <AccountPanel v-if="communityEnabled" :open="accountOpen" :initial-action="authAction" :token="token" :uid="uid" @close="accountOpen = false" @navigate="openRecord" />
  <RecordPanel :target="target" @close="target = null" @login="openAccount" @navigate="navigate" @feedback="openFeedback" />
  <SiteNotice />
</template>
