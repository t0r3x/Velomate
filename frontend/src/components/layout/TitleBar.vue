<template>
  <div v-if="showTitleBar" class="app-titlebar" :class="{ 'is-mac': isMac }">
    <div class="titlebar-drag">
      <img :src="veloIcon" alt="" class="titlebar-icon" />
      <span class="titlebar-title">Velomate</span>
    </div>

    <div id="titlebar-menu-slot" class="titlebar-menu-slot"></div>

    <div class="titlebar-spacer"></div>

    <div v-if="!isMac" class="titlebar-controls">
      <button class="tb-btn" @click="api?.minimize()" aria-label="Minimize">
        <i class="fa-solid fa-minus"></i>
      </button>
      <button class="tb-btn" @click="api?.toggleMaximize()" aria-label="Maximize">
        <i :class="maximized ? 'fa-solid fa-window-restore' : 'fa-regular fa-square'"></i>
      </button>
      <button class="tb-btn tb-close" @click="api?.close()" aria-label="Close">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { isElectron, isMacElectron, electronAPI } from '@/utils/electron'
import veloIcon from '@/assets/velomate_icon.png'

const showTitleBar = isElectron()
const isMac = isMacElectron()
const api = electronAPI()
const maximized = ref(false)

onMounted(() => {
  api?.onMaximizedChange((value) => { maximized.value = value })
})
</script>

<style scoped>
.app-titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  display: flex;
  align-items: stretch;
  background: rgba(8, 11, 20, 0.92);
  border-bottom: 1px solid var(--panel-border);
  z-index: 10000;
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar-drag {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 14px;
  padding-right: 10px;
  flex-shrink: 0;
}

.app-titlebar.is-mac .titlebar-drag {
  padding-left: 78px; /* clear the native traffic-light buttons */
}

.titlebar-icon {
  height: 15px;
  width: 15px;
  object-fit: contain;
  flex-shrink: 0;
}

.titlebar-title {
  font-family: var(--font-main);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  white-space: nowrap;
}

/* Real content (MenuBar, teleported here in Electron) renders inline in the
   same row as the title — this is the non-draggable pocket it lands in. */
.titlebar-menu-slot {
  display: flex;
  -webkit-app-region: no-drag;
}

/* Everything between the menu items and the window controls stays draggable. */
.titlebar-spacer {
  flex: 1;
  min-width: 0;
  -webkit-app-region: drag;
}

.titlebar-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

.tb-btn {
  width: 46px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 0.72rem;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tb-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.tb-btn.tb-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
