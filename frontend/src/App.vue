<template>
  <TitleBar />
  <div class="app-shell">
    <UpdateBanner />
    <router-view />
  </div>
  <ToastContainer />
  <ConfirmDialog />
  <PauseDialog />
  <MoveDayDialog />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import ConfirmDialog  from '@/components/ui/ConfirmDialog.vue'
import PauseDialog    from '@/components/ui/PauseDialog.vue'
import MoveDayDialog  from '@/components/ui/MoveDayDialog.vue'
import TitleBar       from '@/components/layout/TitleBar.vue'
import UpdateBanner   from '@/components/layout/UpdateBanner.vue'
import { isElectron } from '@/utils/electron'

onMounted(() => {
  if (isElectron()) document.body.classList.add('is-electron')
})
</script>
