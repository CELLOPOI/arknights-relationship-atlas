<script setup lang="ts">
import { assetUrl } from '../asset-url';
import { computed, nextTick, onBeforeUnmount, ref, toRefs, watch } from 'vue';
import { preferenceDraft } from './session';
import { skinDirectoryForms } from './skin-directory';
import ChoiceEditor from './ChoiceEditor.vue';
import PreferenceImage from './PreferenceImage.vue';
import type { Catalog, Form, State } from './types';
const props = defineProps<{ active: boolean; catalog: Catalog; state: State; formId: string }>();
const emit = defineEmits<{ refresh: []; open: [id: string]; close: [] }>();
const { query, profession } = toRefs(preferenceDraft('skin-filters', { query: '', profession: '' }));
const professionOpen = ref(false);
const detail = ref<HTMLDialogElement>(), filter = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>();
let cardFocus: HTMLElement | null = null;
const directoryElement = ref<HTMLElement>();
const revealedForms = ref(new Set<string>());
const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();
let touchFrame = 0;
let touchPoint = { x: 0, y: 0 };
const people = computed(() => new Map(props.catalog.persons.map(x => [x.id, x])));
const appearances = computed(() => new Map(props.catalog.appearances.map(x => [x.id, x])));
const choices = computed(() => new Map(props.state.choices.filter(x => x.kind === 'skin').map(x => [x.object_id, x])));
const directory = computed(() => skinDirectoryForms(props.catalog.forms));
const forms = computed(() => directory.value.filter(x => {
  const person = people.value.get(x.person_id);
  return (!profession.value || x.profession === profession.value) && [x.name, person?.name || '', ...(person?.aliases || [])].join(' ').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase());
}).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
const groups = computed(() => props.catalog.professions.map(x => ({ ...x, forms: forms.value.filter(f => f.profession === x.id) })).filter(x => x.forms.length));
const selected = computed(() => props.catalog.forms.find(x => x.id === props.formId));
const coverage = computed(() => directory.value.filter(x => x.complete && x.eligible).length);
function cardArt(form: Form) {
  const choice = choices.value.get(form.id);
  const picked = choice?.action === 'choose' && choice.choice_id ? appearances.value.get(choice.choice_id) : null;
  return picked?.eligible ? picked : appearances.value.get(form.default_appearance_id || '');
}
async function openFilter() { professionOpen.value = true; await nextTick(); filter.value?.showModal(); }
function closeFilter() { professionOpen.value = false; filter.value?.close(); trigger.value?.focus(); }
function setProfession(value: string) { profession.value = value; closeFilter(); }
function clearReveals() {
  cancelAnimationFrame(touchFrame); touchFrame = 0;
  for (const timer of revealTimers.values()) clearTimeout(timer);
  revealTimers.clear(); revealedForms.value.clear();
}
function revealAtTouch(event: TouchEvent) {
  if (event.touches.length !== 1) { clearReveals(); return; }
  const touch = event.touches[0]!;
  touchPoint = { x: touch.clientX, y: touch.clientY };
  if (touchFrame) return;
  touchFrame = requestAnimationFrame(() => {
    touchFrame = 0;
    // 滚动开始后 pointer 事件会取消，touchmove 的 target 也不会跟随手指；按当前位置找卡片。
    const card = document.elementFromPoint(touchPoint.x, touchPoint.y)?.closest<HTMLElement>('.skin-card');
    const id = card?.dataset.formId;
    if (!id || !directoryElement.value?.contains(card)) return;
    revealedForms.value.add(id);
    clearTimeout(revealTimers.get(id));
    // 快速划过也留足时间完成渐变，不阻止原生滚动或延迟点按打开详情。
    revealTimers.set(id, setTimeout(() => { revealedForms.value.delete(id); revealTimers.delete(id); }, 700));
  });
}
function openForm(id: string, event: MouseEvent) { closeFilter(); cardFocus = event.currentTarget as HTMLElement; emit('open', id); }
watch(() => [props.active, props.formId, query.value, profession.value, professionOpen.value], clearReveals, { flush: 'sync' });
watch(() => [props.formId, props.active], async () => {
  await nextTick();
  if (!props.active) { filter.value?.close(); detail.value?.close(); return; }
  if (props.formId) { filter.value?.close(); if (!detail.value?.open) detail.value?.showModal(); }
  else { detail.value?.close(); cardFocus?.focus({ preventScroll: true }); }
}, { immediate: true });
onBeforeUnmount(() => { clearReveals(); filter.value?.close(); detail.value?.close(); });
</script>
<template>
  <section ref="directoryElement" class="skins-view" @touchstart.passive="revealAtTouch" @touchmove.passive="revealAtTouch" @touchcancel="clearReveals">
    <header class="preference-title"><h1>皮肤喜好</h1><p>已开放 {{ coverage }} 个完整形态目录 · 只评价立绘</p></header>
    <div class="skins-tools"><label class="pref-search"><span>搜索干员</span><input v-model="query" type="search" placeholder="姓名、异格或别名" autocomplete="off"></label><button ref="trigger" class="profession-trigger" aria-haspopup="dialog" :aria-expanded="professionOpen" @click="openFilter"><span>职业</span><strong>{{ catalog.professions.find(x => x.id === profession)?.name || '全部' }}</strong><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 8 8-8 8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></button></div>
    <div v-if="!forms.length" class="preference-empty"><p>当前搜索与职业条件没有匹配的干员。</p><button class="pref-secondary" @click="profession = ''; query = ''">清除筛选</button></div>
    <section v-for="group in groups" :key="group.id" class="skin-profession-group"><h2>{{ group.name }}<span>{{ group.forms.length }}</span></h2><div class="skin-grid"><button v-for="form in group.forms" :key="form.id" class="skin-card" :class="{ 'is-revealing': revealedForms.has(form.id) }" :data-form-id="form.id" :data-appearance-id="cardArt(form)?.id" :aria-label="`${form.name}，${choices.get(form.id)?.action === 'choose' ? '已登记个人外观' : '查看外观'}`" @click="openForm(form.id, $event)"><PreferenceImage :src="cardArt(form)?.portrait_url || cardArt(form)?.thumbnail_url || ''" :alt="''" lazy passive /><span class="skin-card-name">{{ form.name }}</span></button></div></section>
    <dialog ref="filter" class="profession-panel" aria-label="选择职业" @cancel.prevent="closeFilter" @click="event => event.target === filter && closeFilter()"><div><header><h2>职业</h2><button class="pref-text" @click="closeFilter">关闭</button></header><button :aria-pressed="!profession" @click="setProfession('')">全部</button><button v-for="item in catalog.professions" :key="item.id" :aria-pressed="profession === item.id" @click="setProfession(item.id)"><img :src="assetUrl(item.icon_url)" alt="">{{ item.name }}</button></div></dialog>
    <dialog ref="detail" class="preference-detail" aria-labelledby="skin-detail-title" @cancel.prevent="emit('close')"><header class="preference-detail-header"><button class="pref-secondary" @click="emit('close')">返回目录</button><h2 id="skin-detail-title">{{ selected?.name || '形态不可用' }}</h2></header><div class="preference-detail-body"><KeepAlive><ChoiceEditor v-if="selected" :key="selected.id" kind="skin" :object-id="selected.id" :catalog="catalog" :state="state" @refresh="emit('refresh')" /></KeepAlive><p v-if="!selected" class="preference-empty">该形态不存在或已撤下，请返回目录选择。</p></div></dialog>
  </section>
</template>
