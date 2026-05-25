<template>
  <span class="status-dot" :class="state"></span>
</template>

<script setup lang="ts">
defineProps<{ state: 'pulsing' | 'connected' | 'disconnected' }>()
</script>
