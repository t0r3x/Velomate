<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="visible" class="confirm-overlay" @mousedown.self="_cancel">
        <div class="confirm-dialog glass-panel" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid fa-circle-pause" style="color: #f59e0b;"></i>
            <span>Pause training?</span>
          </div>
          <p class="confirm-message">
            AI will stop suggesting workouts and auto-skips won't accumulate while paused.
            Resume when you're ready — the plan will restart conservatively.
          </p>
          <div class="pause-reason-wrap">
            <input
              v-model="reason"
              class="pause-reason-input"
              type="text"
              placeholder="Reason (optional) — e.g. injury, travel, illness…"
              maxlength="120"
              @keydown.enter="submit"
              @keydown.esc="_cancel"
            />
          </div>
          <div class="confirm-actions">
            <button class="btn btn-secondary btn-sm" @click="_cancel">Cancel</button>
            <button class="btn btn-sm btn-pause-confirm" @click="submit">
              Pause training
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { usePauseDialog } from '@/composables/usePauseDialog'

const { visible, _accept, _cancel } = usePauseDialog()
const reason = ref('')

// Reset input each time the dialog opens
watch(visible, v => { if (v) reason.value = '' })

function submit() {
  _accept(reason.value.trim())
}
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
  max-width: 400px;
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

.confirm-message {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.pause-reason-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.pause-reason-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.pause-reason-input::placeholder { color: var(--text-muted); }
.pause-reason-input:focus { border-color: #f59e0b; }

.confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn-pause-confirm {
  background: #b45309;
  color: #fff;
  border-color: transparent;
}
.btn-pause-confirm:hover:not(:disabled) {
  background: #92400e;
}

/* Transition (reuse confirm-fade keyframes defined globally) */
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
