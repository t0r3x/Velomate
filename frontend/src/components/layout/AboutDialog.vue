<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="open" class="confirm-overlay" @mousedown.self="emit('close')">
        <div class="confirm-dialog about-dialog glass-panel" role="dialog" aria-modal="true">

          <div class="confirm-header">
            <i class="fa-solid fa-wrench" style="color: var(--primary-color);"></i>
            <span>Preferences</span>
            <button class="panel-close-btn about-dialog-close" @click="emit('close')" aria-label="Close">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="prefs-row">
            <label class="prefs-label" for="theme-select">Theme</label>
            <select
              id="theme-select"
              class="prefs-select"
              :value="settingsStore.theme"
              @change="onTheme"
            >
              <option v-for="t in availableThemes" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </div>

          <div v-if="updatesSupported" class="prefs-row">
            <span class="prefs-label">Updates</span>
            <button class="btn btn-secondary btn-sm prefs-action" :disabled="checking" @click="onCheckUpdates">
              {{ checking ? 'Checking…' : 'Check for updates' }}
            </button>
          </div>
          <p v-if="updatesSupported && updateMessage" class="prefs-note">{{ updateMessage }}</p>

          <div class="prefs-divider"></div>

          <img :src="active ? mbcImg : veloIcon" alt="" class="about-dialog-logo" />
          <p class="confirm-message">
            Velomate v{{ appVersion }} — the adaptive AI cycling coach for Garmin Connect.
          </p>
          <p class="confirm-message about-credit">
            <button type="button" class="shablagoo-label" @click="unlockMintberry">Mintberry Crunch Labs</button>
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings.store'
import { useUpdater } from '@/composables/useUpdater'
import { useToast } from '@/composables/useToast'
import type { UiTheme } from '@/types'

const settingsStore = useSettingsStore()
const { show } = useToast()
import veloIcon from '@/assets/velomate_icon.png'
import mbcImg   from '@/assets/mbc.png'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const appVersion = __APP_VERSION__

/** The logo turns into the Mintberry mark while that theme is on. */
const active = computed(() => settingsStore.theme === 'mintberry')

const ALL_THEMES: { id: UiTheme; label: string }[] = [
  // Default first.
  { id: 'slate',     label: 'Cool slate' },
  { id: 'midnight',  label: 'Midnight black' },
  { id: 'light',     label: 'Light' },
  { id: 'mintberry', label: 'Mintberry Crunch' },
]

/**
 * Mintberry stays out of the list until it has been discovered — that is the whole point
 * of an easter egg. Once unlocked it behaves like any other theme, so switching away and
 * back does not mean hunting for it again.
 */
const availableThemes = computed(() =>
  ALL_THEMES.filter(t => t.id !== 'mintberry' || settingsStore.mintberryUnlocked || active.value)
)

async function unlockMintberry() {
  if (!(await settingsStore.saveTheme('mintberry'))) {
    show('error', 'Could not save theme', 'Your theme choice was not stored.')
  }
}


const { checking, updatesSupported, checkNow } = useUpdater()
const updateMessage = ref<string | null>(null)

/**
 * Reports the outcome in words, including "you are up to date" — a check that finds
 * nothing fires no event, so without this the button would appear to do nothing.
 */
async function onCheckUpdates() {
  updateMessage.value = null
  const result = await checkNow()

  if (!result.supported) {
    // Unreachable in practice — the row is hidden when updates are unsupported — but a
    // wrong "you are up to date" would be worse than a redundant branch.
    updateMessage.value = 'Automatic updates are not available in this build.'
  } else if (result.error) {
    updateMessage.value = `Could not check for updates: ${result.error}`
  } else if (result.available) {
    updateMessage.value = `Version ${result.version} is available and is downloading now.`
  } else {
    updateMessage.value = `You are on the latest version (${result.current ?? appVersion}).`
  }
}

/** The theme applies instantly and rolls back by itself if the write fails. */
async function onTheme(e: Event) {
  const next = (e.target as HTMLSelectElement).value as UiTheme
  if (!(await settingsStore.saveTheme(next))) {
    show('error', 'Could not save theme', 'Your theme choice was not stored.')
  }
}
</script>

<style scoped>
.prefs-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.25rem 0 0.75rem;
}

.prefs-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.prefs-select {
  flex: 1;
  padding: 0.4rem 0.55rem;
  font-size: 0.82rem;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
}

.prefs-select:focus {
  outline: none;
  border-color: rgba(var(--primary-rgb), 0.7);
}

/* It is a <button> now, so the UA colour has to be reset too — without this it falls back
   to buttontext and is invisible on every dark theme. */
.shablagoo-label {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.prefs-action {
  margin-left: auto;
}

.prefs-note {
  margin: -0.35rem 0 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.45;
}

.prefs-divider {
  height: 1px;
  background: var(--hairline);
  margin: 0 0 0.75rem;
}

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

.about-dialog-logo {
  height: 64px;
  width: auto;
  align-self: center;
  margin: 1.5rem;
  object-fit: contain;
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
