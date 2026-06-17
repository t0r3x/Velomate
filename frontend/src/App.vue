<template>
  <div class="bg-glow-1"></div>
  <div class="bg-glow-2"></div>
  <ToastContainer />
  <ConfirmDialog />
  <PauseDialog />
  <MoveDayDialog />
  <router-view />
</template>

<script setup lang="ts">
import ToastContainer from '@/components/ui/ToastContainer.vue'
import ConfirmDialog  from '@/components/ui/ConfirmDialog.vue'
import PauseDialog    from '@/components/ui/PauseDialog.vue'
import MoveDayDialog  from '@/components/ui/MoveDayDialog.vue'
</script>
