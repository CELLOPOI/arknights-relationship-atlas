<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ src: string; alt: string; lazy?: boolean; passive?: boolean }>();
const emit = defineEmits<{ ready: []; failed: [] }>();
const failed = ref(false), attempt = ref(0), loaded = ref(false);
watch(() => props.src, () => { failed.value = false; loaded.value = false; });
function retry() { failed.value = false; loaded.value = false; attempt.value++; }
</script>
<template>
  <div class="preference-image" :data-image-state="failed ? 'failed' : loaded ? 'ready' : 'loading'">
    <img v-if="!failed" :key="`${src}:${attempt}`" :src="src" :alt="alt" :loading="lazy ? 'lazy' : 'eager'" decoding="async" draggable="false" @load="loaded = true; emit('ready')" @error="failed = true; emit('failed')">
    <div v-else class="preference-image-error"><span>图片暂不可用</span><button v-if="!passive" type="button" @click.stop="retry">重试图片</button></div>
  </div>
</template>
