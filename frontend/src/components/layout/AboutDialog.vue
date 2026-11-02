<template>
  <!-- The same big dialog as Training Profile (tp-* in style.css / premium.css): same width,
       header, section labels, insets and footer. It used to be a 360px confirm-style box, which
       looked like a different app next to Training Profile. Settings here save on change. -->
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="open" class="tp-backdrop tp-modal-mode" @mousedown.self="emit('close')">
        <div class="tp-panel glass-panel" role="dialog" aria-modal="true" aria-labelledby="prefs-title">

          <div class="tp-header">
            <div class="tp-title" id="prefs-title">
              <i class="fa-solid fa-wrench tp-title-icon"></i>
              <span>Preferences</span>
            </div>
            <button class="panel-close-btn" aria-label="Close" @click="emit('close')">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div class="tp-body">
            <div class="tp-section-label">Appearance</div>
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

            <div class="tp-section-label tp-section-divider">AI coach</div>
            <label class="checkbox-label prefs-check" for="pref-instant-scoring">
              <input
                type="checkbox"
                id="pref-instant-scoring"
                :checked="settingsStore.instantScoreOnNewActivity"
                @change="onInstantScoring"
              >
              <span>Re-plan automatically when a ride syncs</span>
            </label>
            <p class="prefs-note">
              Regenerates your plan as soon as a new ride arrives, so its execution score shows up right away.
              Turning this off saves AI calls; the score then appears at the next scheduled refresh.
              Anything you enter yourself, like a check-in or a ride rating, always takes effect immediately.
            </p>

            <template v-if="updatesSupported">
              <div class="tp-section-label tp-section-divider">Updates</div>
              <div class="prefs-row">
                <span class="prefs-text">Velomate checks for updates every few hours.</span>
                <button class="btn btn-secondary btn-sm prefs-action" :disabled="checking" @click="onCheckUpdates">
                  {{ checking ? 'Checking…' : 'Check for updates' }}
                </button>
              </div>
              <p v-if="updateMessage" class="prefs-note">{{ updateMessage }}</p>
            </template>

            <div class="tp-section-label tp-section-divider">About</div>
            <div class="about-row">
              <img :src="active ? mbcImg : veloIcon" alt="" class="about-dialog-logo" />
              <div>
                <p class="confirm-message">
                  Velomate v{{ appVersion }}, the adaptive AI cycling coach for Garmin Connect.
                </p>
                <p class="confirm-message about-credit">
                  <button type="button" class="shablagoo-label" @click="unlockMintberry">Mintberry Crunch Labs</button>
                </p>
              </div>
            </div>
          </div>

          <div class="tp-footer">
            <button class="btn btn-primary" @click="emit('close')">Done</button>
          </div>
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

/**
 * Saves on change, like the theme — this dialog has no Save button. The checkbox reflects
 * the store, which only moves once the write succeeded, so a failure snaps it back.
 */
async function onInstantScoring(e: Event) {
  const input = e.target as HTMLInputElement
  if (!(await settingsStore.saveInstantScoreOnNewActivity(input.checked))) {
    input.checked = settingsStore.instantScoreOnNewActivity
    show('error', 'Could not save setting', 'Automatic re-planning was not changed.')
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
/* Preferences is short, so the shared big panel is capped lower than Training Profile's 760px
   height cap; width and everything else are identical. */
.tp-panel { max-height: min(92dvh, 720px); }

.prefs-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.prefs-label {
  min-width: 4.5rem;
  font-size: 0.86rem;
  font-weight: 500;
  color: var(--text-primary);
}

.prefs-text { font-size: 0.86rem; color: var(--text-secondary); }

.prefs-select {
  flex: 0 1 260px;
  padding: 0.5rem 0.75rem;
  font-size: 0.86rem;
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

/* It is a <button> now, so the UA colour has to be reset too: without this it falls back
   to buttontext and is invisible on every dark theme. */
.shablagoo-label {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.prefs-action { margin-left: auto; }

.prefs-note {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.5;
}

.prefs-check { font-size: 0.86rem; }

.about-row { display: flex; align-items: center; gap: 1.25rem; }

.about-dialog-logo {
  height: 56px;
  width: auto;
  object-fit: contain;
}

.confirm-message {
  font-size: 0.86rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.about-credit { margin-top: 0.25rem; color: var(--text-muted); }
</style>
