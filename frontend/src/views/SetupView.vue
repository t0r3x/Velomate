<template>
  <div id="view-setup">
    <div class="setup-card glass-panel">
      <div class="setup-logo">
        <i class="fa-solid fa-route logo-icon"></i>
        <h1>UN<span>BOUND</span></h1>
      </div>
      <p class="setup-tagline">AI-powered training for cyclists.</p>

      <ul class="setup-steps">
        <li :class="{ 'step-done': authStore.isLoggedIn }">
          <i class="fa-solid fa-link"></i>
          <div>
            <strong>Connect Garmin</strong>
            <span>Sync your activities and training history</span>
          </div>
          <span class="setup-step-status">{{ authStore.isLoggedIn ? '✓ Connected' : '–' }}</span>
        </li>
        <li :class="{ 'step-done': settingsStore.geminiConfigured }">
          <i class="fa-solid fa-brain"></i>
          <div>
            <strong>Add AI API key</strong>
            <span>Required for AI adaptive training plans</span>
          </div>
          <span class="setup-step-status">{{ settingsStore.geminiConfigured ? '✓ Configured' : '–' }}</span>
        </li>
      </ul>

      <button class="btn btn-primary btn-glow setup-configure-btn" @click="panelOpen = true">
        <span>Configure</span>
        <i class="fa-solid fa-sliders"></i>
      </button>
    </div>
  </div>

  <SettingsPanel v-model:open="panelOpen" @edit-profile="() => {}" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore }     from '@/stores/auth.store'
import { useSettingsStore } from '@/stores/settings.store'
import SettingsPanel from '@/components/layout/SettingsPanel.vue'

const authStore     = useAuthStore()
const settingsStore = useSettingsStore()
const panelOpen     = ref(false)
</script>
