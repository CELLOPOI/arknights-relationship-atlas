<script setup lang="ts">
import type { Source } from '../types';
import { sourceTitle, sourceLines, sourceReference } from '../source-display';

defineProps<{ sources: Source[] }>();
</script>

<template>
  <section v-if="sources.length" class="evidence-sources" aria-label="来源出处">
    <h4>来源出处（{{ sources.length }}）</h4>
    <ul class="evidence-source-list">
      <li v-for="(source, index) in sources" :key="index" class="evidence-source-item">
        <span class="evidence-source-title">{{ sourceTitle(source) }}</span>
        <a v-if="sourceReference(source)" class="evidence-source-link" :href="sourceReference(source)" target="_blank" rel="noopener noreferrer">{{ source.referenceLabel || 'PRTS 对照' }}</a>
        <details class="evidence-source-record">
          <summary>原始记录</summary>
          <div>
            <code>{{ source.source }}</code>
            <span v-if="sourceLines(source)">{{ sourceLines(source) }}</span>
            <span v-if="source.version">版本：{{ source.version }}</span>
          </div>
        </details>
      </li>
    </ul>
  </section>
</template>
