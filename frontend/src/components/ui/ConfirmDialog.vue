<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="visible" class="confirm-overlay" @mousedown.self="_cancel">
        <div class="confirm-dialog glass-panel" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid" :class="options.danger ? 'fa-triangle-exclamation' : 'fa-circle-question'"></i>
            <span>{{ options.title }}</span>
          </div>
          <p class="confirm-message">{{ options.message }}</p>
          <div class="confirm-actions">
            <button class="btn btn-secondary btn-sm" @click="_cancel">
              {{ options.cancelLabel ?? 'Cancel' }}
            </button>
            <button
              class="btn btn-sm"
              :class="options.danger ? 'btn-danger' : 'btn-primary'"
              @click="_accept"
            >
              {{ options.confirmLabel ?? 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useConfirm } from '@/composables/useConfirm'

const { visible, options, _accept, _cancel } = useConfirm()
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

.confirm-dialog {
  width: 100%;
  max-width: 380px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-header .fa-triangle-exclamation { color: #f87171; }
.confirm-header .fa-circle-question      { color: rgba(var(--primary-rgb), 1); }

.confirm-message {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn-danger {
  background: #dc2626;
  color: #fff;
  border-color: transparent;
}
.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

/* Transition */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .confirm-dialog,
.confirm-fade-leave-active .confirm-dialog {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.confirm-fade-enter-from .confirm-dialog,
.confirm-fade-leave-to .confirm-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
