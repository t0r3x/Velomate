<template>
  <Transition name="update-banner-fade">
    <div v-if="status && !dismissed" class="update-banner" :class="status.state">
      <i class="fa-solid" :class="status.state === 'ready' ? 'fa-circle-check' : 'fa-spinner fa-spin'"></i>

      <span v-if="status.state === 'downloading'">
        Downloading update v{{ status.version }}…
      </span>
      <span v-else>
        Update v{{ status.version }} is ready to install.
      </span>

      <button v-if="status.state === 'ready'" class="btn btn-primary btn-sm update-banner-action" @click="restartAndInstall">
        Restart &amp; Install
      </button>

      <button class="update-banner-dismiss" aria-label="Dismiss" @click="dismiss">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useUpdater } from '@/composables/useUpdater'

const { status, dismissed, dismiss, restartAndInstall } = useUpdater()
</script>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-shrink: 0;
  padding: 0.6rem 1.15rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid var(--panel-border);
}

.update-banner.ready {
  background: rgba(var(--primary-rgb), 0.12);
  border-bottom-color: rgba(var(--primary-rgb), 0.3);
}

.update-banner.ready i.fa-circle-check {
  color: var(--z2-color);
}

.update-banner.downloading i.fa-spinner {
  color: var(--text-muted);
}

.update-banner-action {
  margin-left: 0.5rem;
}

.update-banner-dismiss {
  margin-left: auto;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.8rem;
  border-radius: 6px;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.update-banner-dismiss:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.update-banner-fade-enter-active,
.update-banner-fade-leave-active {
  transition: opacity 0.2s ease;
}
.update-banner-fade-enter-from,
.update-banner-fade-leave-to {
  opacity: 0;
}
</style>
