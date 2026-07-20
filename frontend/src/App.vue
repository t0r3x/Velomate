<template>
  <TitleBar />
  <ToastContainer />
  <ConfirmDialog />
  <PauseDialog />
  <MoveDayDialog />
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import ConfirmDialog  from '@/components/ui/ConfirmDialog.vue'
import PauseDialog    from '@/components/ui/PauseDialog.vue'
import MoveDayDialog  from '@/components/ui/MoveDayDialog.vue'
import TitleBar       from '@/components/layout/TitleBar.vue'
import { isElectron } from '@/utils/electron'

onMounted(() => {
  if (isElectron()) document.body.classList.add('is-electron')
})
</script>
