<template>
  <div class="bg-glow-1"></div>
  <div class="bg-glow-2"></div>
  <ToastContainer />
  <router-view />
</template>

<script setup lang="ts">
import ToastContainer from '@/components/ui/ToastContainer.vue'
</script>
