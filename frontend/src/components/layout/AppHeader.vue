<template>
  <!-- The app's header: who it is, what state it is in, and the two settings doors. It replaced
       a small status pill that said "Connected" and little else. Each status item is a button
       to the screen that can fix it, and its hover tooltip says why it looks the way it does. -->
  <Teleport to="#titlebar-menu-slot" :disabled="!isElectronMode">
  <header class="app-header" :class="[isElectronMode ? 'app-header--titlebar' : 'glass-panel', { 'kbd-nav': keyboardNav }]">
    <div v-if="!isElectronMode" class="ah-brand">
      <img :src="veloIcon" alt="" class="ah-brand-icon" />
      <span class="ah-brand-name">Velomate</span>
    </div>

    <div class="ah-status">
      <button
        v-for="item in items" :key="item.key"
        type="button"
        class="ah-item"
        :class="{ 'is-warn': item.warn }"
        :aria-label="`${item.label}: ${item.value}${item.warn ? ' (needs attention)' : ''}`"
        @click="item.action()"
        @mouseenter="showTip(item.key, $event)"
        @mouseleave="tipKey = null"
        @focus="keyboardNav && showTip(item.key, $event)"
        @blur="tipKey = null"
      >
        <span class="ah-item-label">{{ item.label }}</span>
        <span class="ah-item-value">
          <StatusDot v-if="item.key === 'garmin'" :state="dotState" />
          <i v-else-if="item.icon" class="fa-solid ah-item-icon" :class="item.icon"></i>
          {{ item.value }}
          <i v-if="item.busy" class="fa-solid fa-spinner fa-spin ah-item-busy" aria-hidden="true"></i>
          <i v-if="item.warn" class="fa-solid fa-triangle-exclamation ah-item-warn" aria-hidden="true"></i>
        </span>
      </button>
    </div>

    <div class="ah-actions">
      <!-- Same glyphs as the dialogs they open (Training Profile: user-gear, Preferences: wrench). -->
      <button type="button" class="ah-action" aria-label="Training profile" @click="emit('open-profile')">
        <i class="fa-solid fa-user-gear"></i>
      </button>
      <button type="button" class="ah-action" aria-label="Preferences" @click="emit('open-preferences')">
        <i class="fa-solid fa-wrench"></i>
      </button>
    </div>

    <!-- The app's data tooltip (premium.css), teleported so the header never clips it. -->
    <Teleport to="body">
      <div v-if="tip" class="trend-tooltip ride-tooltip ah-tooltip" :style="{ left: `${tipPos.left}px`, top: `${tipPos.top}px` }">
        <div class="tt-date">{{ tip.title }}</div>
        <template v-for="(line, i) in tip.lines" :key="i">
          <div class="tt-row" :class="{ 'is-warn-row': line.warn }">
            <i class="fa-solid tt-icon" :class="line.warn ? 'fa-triangle-exclamation ah-tt-warn' : 'fa-circle-info ah-tt-info'"></i>
            <span>{{ line.text }}</span>
          </div>
          <!-- The rides behind a warning, so the athlete can find them in the list. -->
          <ul v-if="line.rides?.length" class="ah-tt-rides">
            <li v-for="r in line.rides" :key="r">{{ r }}</li>
          </ul>
        </template>
        <div class="tt-foot">{{ tip.hint }}</div>
      </div>
    </Teleport>
  </header>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuthStore }           from '@/stores/auth.store'
import { useProfileStore }        from '@/stores/profile.store'
import { useActivitiesStore }     from '@/stores/activities.store'
import { useSettingsStore }       from '@/stores/settings.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useFreeTrainingStore }   from '@/stores/freeTraining.store'
import { useTimeAgo }             from '@/composables/useTimeAgo'
import StatusDot   from '@/components/ui/StatusDot.vue'
import { isElectron } from '@/utils/electron'
import type { Activity } from '@/types'
import { HR_PEAK_MARGIN, averagedAboveLthr, peakAboveMax, recentRides, rideSummary } from '@/utils/hrCalibration'
import veloIcon from '@/assets/velomate_icon.png'

// The dialogs these open live in DashboardView, which keeps at most one open at a time.
const emit = defineEmits<{ 'open-settings': []; 'open-profile': []; 'open-preferences': [] }>()

// In Electron the header lives inside the title bar (which carries the icon and name), so it
// skips its own brand; in the browser it is a card above the dashboard.
const isElectronMode = isElectron()

/**
 * In Electron something outside the app focuses the first header button about 350ms after the
 * window opens (no Velomate code calls focus() at startup; the old menu bar got the same focus
 * but had no visible focus style). That left a focus ring and an open tooltip on "Garmin" at
 * every launch. Both now wait until the athlete actually navigates with Tab.
 */
const keyboardNav = ref(false)
const onKey = (e: KeyboardEvent) => { if (e.key === 'Tab') keyboardNav.value = true }
const onPointer = () => { keyboardNav.value = false }
/**
 * On a phone the three items share one row, and "Synced just now" made Garmin the widest of them:
 * there the value is just the age ("3h ago"). The label and the green dot already say Garmin is
 * connected, and the tooltip still says when it last synced.
 */
const COMPACT_QUERY = '(max-width: 480px)'
const compactMq = window.matchMedia(COMPACT_QUERY)
const compact = ref(compactMq.matches)
const onCompact = (e: MediaQueryListEvent) => { compact.value = e.matches }
const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onPointer)
  compactMq.addEventListener('change', onCompact)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onPointer)
  compactMq.removeEventListener('change', onCompact)
})

const authStore     = useAuthStore()
const profileStore  = useProfileStore()
const activities    = useActivitiesStore()
const settingsStore = useSettingsStore()
const recStore      = useRecommendationStore()
const freeStore     = useFreeTrainingStore()
const { timeAgo }   = useTimeAgo()

/** Garmin data older than this reads as stale: the plan is then built on rides that may be missing. */
const STALE_SYNC_HOURS = 48

const MODEL_LABELS: Record<string, string> = {
  'gemini-3.8-flash': 'Accurate',
  'gemini-3.5-flash-lite': 'Super fast',
}
const modelLabel = (id: string | null | undefined) => (id ? MODEL_LABELS[id] ?? id : '')

// ── Garmin ───────────────────────────────────────────────────────────────────
const dotState = computed<'pulsing' | 'connected' | 'disconnected'>(() => {
  if (!authStore.loaded) return 'pulsing'
  return authStore.isLoggedIn ? 'connected' : 'disconnected'
})
const syncedAt = computed(() => activities.analysis?.updatedAt ?? null)
const syncStale = computed(() =>
  !!syncedAt.value && Date.now() - new Date(syncedAt.value).getTime() > STALE_SYNC_HOURS * 3_600_000
)

// ── AI ───────────────────────────────────────────────────────────────────────
const activeStore = computed(() => (settingsStore.freeTrainingMode ? freeStore : recStore))
const aiBusy = computed(() => activeStore.value.refreshStep !== null || activeStore.value.isRegenerating)
/** Set by the backend to the model that actually answered; differs after an automatic fallback. */
const fellBack = computed(() =>
  !!settingsStore.geminiLastModel && settingsStore.geminiLastModel !== settingsStore.geminiModel
)
// The last-used model only changes when a generation finishes, so read it again then.
watch(aiBusy, (busy, was) => { if (was && !busy) settingsStore.reload() })

const paused = computed(() => activeStore.value.state === 'paused')

// ── Heart rate profile ───────────────────────────────────────────────────────
/** How many rides a warning names before it says "and N more". */
const HR_RIDES_LISTED = 3
const listRides = (rides: Activity[], hr: 'avg' | 'max') => [
  ...rides.slice(0, HR_RIDES_LISTED).map(a => rideSummary(a, hr)),
  ...(rides.length > HR_RIDES_LISTED ? [`and ${rides.length - HR_RIDES_LISTED} more`] : []),
]

interface TipLine { text: string; warn: boolean; rides?: string[] }

const hrWarnings = computed<TipLine[]>(() => {
  const p = profileStore.profile
  const out: TipLine[] = []
  if (!p?.maxHr || !p?.lthr) return out
  const rides = recentRides(activities.activities)
  const peak = activities.analysis?.maxRecordedHr ?? 0
  if (peak > p.maxHr + HR_PEAK_MARGIN) {
    out.push({
      text: `Your peak recorded heart rate (${peak} bpm) is above your Max HR (${p.maxHr} bpm). Unless that was a sensor spike, your zones sit too low.`,
      warn: true,
      rides: listRides(rides.filter(a => peakAboveMax(a, p.maxHr)), 'max'),
    })
  }
  const above = rides.filter(a => averagedAboveLthr(a, p.lthr))
  if (above.length > 0) {
    out.push({
      text: `${above.length} ride${above.length === 1 ? '' : 's'} of an hour or more averaged above your LTHR (${p.lthr} bpm). LTHR is about the highest heart rate you can hold for an hour, so it is probably set too low.`,
      warn: true,
      rides: listRides(above, 'avg'),
    })
  }
  return out
})

// ── Items ────────────────────────────────────────────────────────────────────
interface Item {
  key: 'garmin' | 'ai' | 'hr' | 'training'
  label: string
  value: string
  icon?: string
  warn: boolean
  busy?: boolean
  action: () => void
}
const items = computed<Item[]>(() => {
  const list: Item[] = [
    {
      key: 'garmin',
      label: 'Garmin',
      value: !authStore.loaded ? 'Checking…'
        : !authStore.isLoggedIn ? 'Not connected'
        : syncedAt.value ? (compact.value ? capitalize(timeAgo(syncedAt.value)) : `Synced ${timeAgo(syncedAt.value)}`)
        : 'Connected',
      warn: authStore.loaded && (!authStore.isLoggedIn || syncStale.value),
      action: () => emit('open-settings'),
    },
    {
      key: 'ai',
      label: 'AI coach',
      value: aiBusy.value ? 'Updating…' : modelLabel(settingsStore.geminiModel),
      icon: 'fa-wand-magic-sparkles',
      warn: !settingsStore.geminiConfigured,
      busy: aiBusy.value,
      action: () => emit('open-settings'),
    },
    {
      key: 'hr',
      label: 'Heart rate',
      value: profileStore.hrLabel || 'Not set',
      icon: 'fa-heart-pulse',
      warn: hrWarnings.value.length > 0,
      action: () => emit('open-profile'),
    },
  ]
  if (paused.value) {
    list.push({ key: 'training', label: 'Training', value: 'Paused', icon: 'fa-pause', warn: true, action: () => emit('open-profile') })
  }
  return list
})

// ── Tooltip ──────────────────────────────────────────────────────────────────
const tipKey = ref<Item['key'] | null>(null)
const tipPos = ref({ left: 0, top: 0 })
function showTip(key: Item['key'], e: Event) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  tipPos.value = { left: Math.min(r.left, window.innerWidth - 320), top: r.bottom + 8 }
  tipKey.value = key
}

const tip = computed(() => {
  switch (tipKey.value) {
    case 'garmin':
      if (!authStore.isLoggedIn) return { title: 'Garmin', lines: [{ text: 'Not connected, so no new rides come in and the coach plans on old data.', warn: true }], hint: 'Click to connect.' }
      return {
        title: 'Garmin',
        lines: [
          { text: syncedAt.value ? `Rides last synced ${new Date(syncedAt.value).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : 'Connected.', warn: false },
          ...(syncStale.value ? [{ text: `That is more than ${STALE_SYNC_HOURS / 24} days ago: recent rides may be missing from your plan and the trend.`, warn: true }] : []),
        ],
        hint: 'Click for connection settings.',
      }
    case 'ai':
      return {
        title: 'AI coach',
        lines: [
          { text: settingsStore.geminiConfigured ? `Model: ${modelLabel(settingsStore.geminiModel)} (${settingsStore.geminiModel}).` : 'No API key yet, so there is no coach.', warn: !settingsStore.geminiConfigured },
          ...(aiBusy.value ? [{ text: 'Working on your plan right now.', warn: false }] : []),
          ...(fellBack.value ? [{ text: `Your last plan came from ${modelLabel(settingsStore.geminiLastModel)}: ${modelLabel(settingsStore.geminiModel)} was busy, out of quota or too slow, so the automatic fallback took over.`, warn: false }] : []),
        ],
        hint: 'Click for AI settings.',
      }
    case 'hr': {
      const p = profileStore.profile
      return {
        title: 'Heart rate profile',
        lines: [
          { text: p ? `Max HR ${p.maxHr} bpm · LTHR ${p.lthr} bpm. Your zones are set from these.` : 'Not set yet.', warn: false },
          ...hrWarnings.value,
        ],
        hint: 'Click to review your training profile.',
      }
    }
    case 'training':
      return { title: 'Training', lines: [{ text: 'Training is paused: the coach makes no new plans until you resume.', warn: true }], hint: 'Resume from the training card.' }
    default:
      return null
  }
})
</script>

<style scoped>
/* A card like the ones below it (same surface, edge and width), compact in height. */
.app-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  /* The cards' column, not the window: .app-container pads 1.5rem each side (0.85rem on phones),
     so a 100%-wide header ran to the window edge in Electron's 1400px window while the cards sat
     24px in. A wider browser window hid it behind the max-width. */
  width: calc(100% - 3rem);
  max-width: calc(1600px - 3rem);
  margin: 1.5rem auto 0;
  /* Same horizontal inset as the cards' content (1.75rem), so the wordmark lines up with it. */
  padding: 0.95rem 1.25rem 0.95rem 1.75rem;
}

.ah-brand { display: flex; align-items: center; gap: 0.6rem; padding-right: 1.5rem; border-right: 1px solid var(--hairline); }
.ah-brand-icon { width: 26px; height: 26px; border-radius: var(--radius-xs); }
.ah-brand-name {
  font-family: var(--font-numeric);
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

/* Status items read like the Trend card's header stats: eyebrow label over a value. */
.ah-status { display: flex; align-items: stretch; flex: 1; min-width: 0; gap: 0.6rem; flex-wrap: wrap; }
.ah-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  padding: 0.35rem 0.85rem;
  font: inherit;
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
/* The divider sits in the gap, not on the item's edge: every item then gets the same fully
   rounded hover, with air between it and the line (an edge divider squared off one side). */
.ah-item + .ah-item::before {
  content: '';
  position: absolute;
  left: calc(-0.3rem - 0.5px);
  top: 22%;
  bottom: 22%;
  width: 1px;
  background: var(--hairline);
  pointer-events: none;
}
.ah-item:hover { background: var(--raise); }
.ah-item:focus-visible { outline: none; }
.kbd-nav .ah-item:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
.ah-item-label {
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ah-item-value {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
}
.ah-item-icon { font-size: 0.8rem; color: var(--text-muted); }
.ah-item-icon.fa-heart-pulse { color: var(--z5-color); }
.ah-item-busy { font-size: 0.75rem; color: var(--text-muted); }
/* Attention: an icon plus the amber of the pause state, never colour alone. */
.ah-item-warn { font-size: 0.75rem; color: #f59e0b; }
.ah-item.is-warn .ah-item-value { color: var(--text-primary); }

.ah-actions { display: flex; gap: 0.4rem; margin-left: auto; }
.ah-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  font-size: 0.9rem;
  color: var(--text-muted);
  background: none;
  border: 1px solid var(--hairline);
  border-radius: 50%;
  cursor: pointer;
}
.ah-action:hover { color: var(--text-primary); background: var(--raise); }
.ah-action:focus-visible { outline: none; }
.kbd-nav .ah-action:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

/* In the Electron title bar: no card, full height, buttons clickable, empty space draggable. */
.app-header--titlebar {
  flex: 1;
  width: auto;
  max-width: none;
  height: 100%;
  margin: 0;
  padding: 0 0.75rem 0 0.6rem;
  gap: 1rem;
  background: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
}
.app-header--titlebar .ah-status { align-items: center; flex-wrap: nowrap; }
.app-header--titlebar .ah-item { padding: 0.3rem 0.8rem; }
.app-header--titlebar .ah-item,
.app-header--titlebar .ah-action { -webkit-app-region: no-drag; }
.app-header--titlebar .ah-action { width: 2.1rem; height: 2.1rem; }

/* Below ~820px brand, items and actions no longer fit one row, and the last item wrapped on its
   own. The items get their own row instead, and that row never wraps: three items always fit it. */
@media (max-width: 820px) {
  .app-header { flex-wrap: wrap; row-gap: 0.6rem; }
  .ah-brand { border-right: none; padding-right: 0; }
  /* flex-basis, not width: the base rule's flex: 1 sets a 0 basis that would win over width.
     The negative margin lines the first item's text up with the wordmark above it. */
  .ah-status { order: 3; flex-basis: 100%; flex-wrap: nowrap; margin-left: -0.85rem; }
}

@media (max-width: 640px) {
  .app-header { width: calc(100% - 1.7rem); margin-top: 1rem; padding: 0.75rem 1rem; gap: 0.75rem; }
  .ah-status { gap: 0.4rem; margin-left: -0.5rem; }
  .ah-item { padding: 0.3rem 0.5rem; }
  .ah-item + .ah-item::before { left: calc(-0.2rem - 0.5px); }
}
</style>

<style>
.ah-tooltip { max-width: 320px; }
.ah-tooltip .tt-row { align-items: flex-start; }
.ah-tooltip .tt-row .tt-icon { margin-top: 0.3em; }
.ah-tooltip .tt-row span:last-child { line-height: 1.45; padding: 0.1rem 0; }
.ah-tooltip .ah-tt-warn { color: #f59e0b; }
.ah-tooltip .ah-tt-info { color: var(--text-muted); }
/* Indented under the warning text, past its icon. */
.ah-tooltip .ah-tt-rides {
  margin: 0.1rem 0 0.3rem;
  padding-left: calc(10px + 0.45rem);
  list-style: none;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
</style>
