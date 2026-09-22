<script setup lang="ts">
import type { GamePerson } from './network';
defineProps<{ person: GamePerson; eager?: boolean }>();
function fallback(event: Event) {
  const image = event.target as HTMLImageElement;
  if (!image.src.endsWith('/avatars/unknown.svg')) image.src = '/avatars/unknown.svg';
}
</script>

<template>
  <img :src="person.avatar || `/avatars/${person.id}.webp`" alt="" :loading="eager ? 'eager' : 'lazy'" decoding="async" width="80" height="80" @error="fallback" />
</template>
