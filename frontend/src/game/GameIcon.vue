<script setup lang="ts">
defineProps<{ name: 'arrow' | 'back' | 'close' | 'search' | 'settings' | 'hint' | 'refresh' }>();
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-if="name === 'arrow'" d="M5 12h14m-6-6 6 6-6 6" />
    <path v-else-if="name === 'back'" d="M19 12H5m6-6-6 6 6 6" />
    <path v-else-if="name === 'close'" d="m6 6 12 12M6 18 18 6" />
    <g v-else-if="name === 'search'"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></g>
    <g v-else-if="name === 'settings'"><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6m8 0v6m-7 0v6" /></g>
    <g v-else-if="name === 'hint'"><path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z" /></g>
    <path v-else d="M4 10a8 8 0 1 1 1 7M4 4v6h6" />
  </svg>
</template>
