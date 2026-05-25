<template>
  <div id="toast-container">
    <AppToast v-for="t in toasts" :key="t.id" :toast="t" />
  </div>
</template>

<script setup lang="ts">
import { useToast } from '@/composables/useToast'
import AppToast from './AppToast.vue'

const { toasts } = useToast()
</script>
