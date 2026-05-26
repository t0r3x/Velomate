<template>
  <div class="bg-glow-1"></div>
  <div class="bg-glow-2"></div>
  <ToastContainer />
  <ConfirmDialog />
  <router-view />
</template>

<script setup lang="ts">
import ToastContainer from '@/components/ui/ToastContainer.vue'
import ConfirmDialog  from '@/components/ui/ConfirmDialog.vue'
</script>
