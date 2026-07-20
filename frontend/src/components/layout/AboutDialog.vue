<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="open" class="confirm-overlay" @mousedown.self="emit('close')">
        <div class="confirm-dialog about-dialog glass-panel" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid fa-circle-info" style="color: var(--primary-color);"></i>
            <span>About Velomate</span>
            <button class="panel-close-btn about-dialog-close" @click="emit('close')" aria-label="Close">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <p class="confirm-message">
            Velomate v1.0 — the adaptive AI cycling coach for Garmin Connect.
          </p>
          <p class="confirm-message about-credit">
            <input type="checkbox" id="shablagoo-toggle" class="sr-only" v-model="active">
            <label for="shablagoo-toggle" class="shablagoo-label">Mintberry Crunch Labs</label>
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useShablagoo } from '@/composables/useShablagoo'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { active } = useShablagoo()
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  padding: 1rem;
}

.about-dialog {
  width: 100%;
  max-width: 360px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.about-dialog-close {
  margin-left: auto;
}

.confirm-message {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.about-credit {
  color: var(--text-muted);
}

/* Transition (reuses the same confirm-fade convention as the other dialogs) */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .about-dialog,
.confirm-fade-leave-active .about-dialog {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.confirm-fade-enter-from .about-dialog,
.confirm-fade-leave-to .about-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
