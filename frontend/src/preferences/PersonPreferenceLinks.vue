<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { request } from './api';
import { skinDirectoryForms } from './skin-directory';
import type { Catalog } from './types';
const props = defineProps<{ personId: string }>();
const catalog = ref<Catalog | null>(null);
const forms = computed(() => skinDirectoryForms(catalog.value?.forms || []).filter(x => x.person_id === props.personId));
watch(() => props.personId, async () => {
  if (catalog.value) return;
  try { catalog.value = (await request<{ catalog: Catalog | null }>('catalog/')).catalog; } catch { /* 档案主体无需等待喜好服务。 */ }
}, { immediate: true });
</script>
<template>
  <section v-if="forms.length" class="person-preference-links"><h3>人物与皮肤喜好</h3><a class="archive-text-button" :href="`/preferences/?tab=characters&person=${encodeURIComponent(personId)}`">查看人物形态偏好</a><ul><li v-for="form in forms" :key="form.id"><a class="archive-text-button" :href="`/preferences/?tab=skins&form=${encodeURIComponent(form.id)}`">{{ form.name }} · 查看外观</a></li></ul></section>
</template>
