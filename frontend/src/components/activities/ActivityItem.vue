<template>
  <!-- The whole ride is the target for rating it, not just the pencil: the hover outline
       already promised that clicking it does something. Inert while the editor is open. -->
  <li
    class="activity-item"
    :class="{ 'is-clickable': !editing }"
    :tabindex="editing ? undefined : 0"
    @click="onItemClick"
    @keydown.enter.self="onItemClick"
  >
    <div class="activity-details-main">
      <span class="activity-title">{{ activity.name || 'Cycling Activity' }}</span>
      <span class="activity-meta">{{ meta }}</span>

      <!-- Hovering the rating row shows the same tooltip as the Trend chart for that day. -->
      <div
        v-if="hasFeedback || editing"
        class="act-feedback"
        @mouseenter="showTip($event, 'rating')"
        @mouseleave="hideTip"
      >
        <span v-if="rpe !== null" class="act-rpe-badge" :class="rpeClass">RPE {{ rpe }}</span>
        <span v-if="feeling !== null" class="act-feeling-badge" :class="feelingEntry.cls" v-html="feelingHtml"></span>
        <!-- Score and pencil wrap as one unit, so the pencil never ends up alone on a line. -->
        <span class="act-feedback-tail">
          <span v-if="planEntry?.executionScore != null" class="act-score-badge" :class="scoreClass">
            <i class="fa-solid fa-brain"></i>
            {{ planEntry.executionScore }}
            <span class="act-score-type">{{ scoreTypeLabel }}</span>
          </span>
          <button v-if="!editing" class="act-rate-btn" :title="rateTitle" @click="openEditor">
            <i class="fa-solid fa-pen"></i>
          </button>
        </span>
      </div>

      <!-- No rating yet: the most important signal in the app shouldn't need the watch. -->
      <button v-else class="act-rate-btn act-rate-btn--empty" @click="openEditor">
        <i class="fa-regular fa-face-smile"></i>
        <span>Rate this ride</span>
      </button>

    </div>

    <!-- Hovering the numbers shows the ride's details: speed, max HR, time per zone, and whether
         it is one of the rides the header's heart rate warning is about. -->
    <div class="activity-stats-summary" @mouseenter="showTip($event, 'stats')" @mouseleave="hideTip">
      <div class="act-stat act-stat--dist">
        <span class="act-stat-val">{{ activity.distanceKm }} km</span>
        <span class="act-stat-label">Dist</span>
      </div>
      <div class="act-stat act-stat--time">
        <span class="act-stat-val">{{ activity.durationMinutes }} min</span>
        <span class="act-stat-label">Time</span>
      </div>
      <div v-if="activity.averageHr > 0" class="act-stat act-stat--hr">
        <span class="act-stat-val">
          {{ activity.averageHr }} bpm
          <i v-if="hrFlags.length" class="fa-solid fa-triangle-exclamation act-stat-flag" aria-label="Heart rate above your profile"></i>
        </span>
        <span class="act-stat-label">Avg HR</span>
      </div>
    </div>

    <!-- A direct child of the item, not of the left column, so it wraps onto its own line
         and spans the full width rather than being squeezed beside the stats. -->
    <div v-if="editing" class="act-rate-editor">
      <div class="act-rate-row">
        <span class="act-rate-label">Effort</span>
        <div
          class="act-rate-slider"
          :class="{ 'is-unset': draftRpe === null }"
          :title="draftRpe !== null ? `${draftRpe} · ${RPE_HINTS[draftRpe]}` : 'Not rated'"
        >
          <input
            v-model.number="rpeSlider"
            class="act-rate-range"
            type="range"
            min="1"
            max="10"
            step="1"
            aria-label="Perceived effort, 1 to 10"
          />
          <div class="act-rate-ticks" aria-hidden="true">
            <span
              v-for="n in 10"
              :key="`tick-${n}`"
              class="act-rate-tick"
              :class="{ 'is-current': draftRpe === n }"
            >{{ n }}</span>
          </div>
        </div>
      </div>

      <div class="act-rate-row">
        <span class="act-rate-label">Feeling</span>
        <div class="act-rate-scale">
          <button
            v-for="n in 5"
            :key="`feel-${n}`"
            class="act-rate-chip act-rate-chip--face"
            :class="{ 'is-selected': draftFeeling === n }"
            :title="FEELING_MAP[n].label"
            @click="draftFeeling = draftFeeling === n ? null : n"
          ><i class="fa-regular" :class="FEELING_MAP[n].icon"></i></button>
        </div>
      </div>

      <div class="act-rate-actions">
        <button class="btn btn-secondary btn-sm" :disabled="saving" @click="editing = false">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="saving || !hasDraft" @click="save">
          <span>{{ saving ? 'Saving…' : 'Save' }}</span>
          <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
        </button>
      </div>
    </div>
    <Teleport to="body">
      <div v-if="tip && !editing" ref="tipEl" class="trend-tooltip ride-tooltip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }">
        <div class="tt-date">{{ tipDate }}</div>
        <template v-if="tip.kind === 'stats'">
          <div class="tt-row">
            <i class="fa-solid fa-route tt-icon tt-icon--muted"></i>
            <strong>{{ activity.distanceKm }} km</strong>
            <span>{{ speed ? `${speed} km/h average` : 'Distance' }}</span>
          </div>
          <div class="tt-row">
            <i class="fa-regular fa-clock tt-icon tt-icon--muted"></i>
            <strong>{{ duration }}</strong>
            <span>Load {{ load }}</span>
          </div>
          <div v-if="activity.averageHr > 0" class="tt-row">
            <i class="fa-solid fa-heart-pulse tt-icon tt-icon--hr"></i>
            <strong>{{ activity.averageHr }} bpm</strong>
            <span>average{{ activity.maxHr > 0 ? ` · max ${activity.maxHr}` : '' }}{{ avgZone ? ` · Z${avgZone}` : '' }}</span>
          </div>
          <div v-if="activity.averagePower > 0" class="tt-row">
            <i class="fa-solid fa-bolt tt-icon tt-icon--muted"></i>
            <strong>{{ activity.averagePower }} W</strong>
            <span>average{{ activity.maxPower > 0 ? ` · max ${activity.maxPower}` : '' }}</span>
          </div>

          <template v-if="zoneMins.some(m => m > 0)">
            <div class="tt-date tt-section">Time in zone</div>
            <div class="tt-zones">
              <template v-for="(m, z) in zoneMins" :key="'z' + z">
                <span v-if="m > 0" class="tt-zone">
                  <span class="tt-key" :style="{ background: `var(--z${z + 1}-color)` }"></span>Z{{ z + 1 }}
                  <strong>{{ m }}m</strong>
                </span>
              </template>
            </div>
          </template>

          <template v-if="hrFlags.length">
            <div class="tt-date tt-section">Heart rate profile</div>
            <div v-for="f in hrFlags" :key="f" class="tt-row tt-row--warn">
              <i class="fa-solid fa-triangle-exclamation tt-icon tt-icon--warn"></i>
              <span>{{ f }}</span>
            </div>
          </template>
        </template>

        <template v-else>
        <div class="tt-foot tt-foot--lead">Load {{ load }} · {{ activity.durationMinutes }} min</div>

        <template v-if="rpe !== null || feeling !== null">
          <div class="tt-date tt-section">How it felt</div>
          <div class="tt-row">
            <i v-if="feeling !== null" class="fa-regular tt-icon" :class="[feelingEntry.icon, `feel-${feeling}`]"></i>
            <span v-else class="tt-key tt-key--none"></span>
            <strong>{{ feeling !== null ? `${feeling}/5` : '–' }}</strong>
            <span>After the ride{{ feeling !== null ? ` · ${feelingEntry.label}` : '' }}</span>
          </div>
          <div v-if="rpe !== null" class="tt-row">
            <span class="tt-key tt-key--none"></span>
            <strong>RPE {{ rpe }}</strong>
            <span>{{ RPE_HINTS[rpe] }}</span>
          </div>
        </template>

        <template v-if="planEntry?.executionScore != null">
          <div class="tt-date tt-section">Coach</div>
          <div class="tt-row">
            <i class="fa-solid tt-icon" :class="[workoutTypeIcon[planEntry.type] ?? 'fa-circle', `wt-${planEntry.type.toLowerCase()}`]"></i>
            <strong>{{ planEntry.executionScore }}</strong>
            <span>{{ scoreTypeLabel }} · ridden</span>
          </div>
          <div v-if="planEntry.executionNote" class="tt-note">{{ planEntry.executionNote }}</div>
        </template>
        </template>
      </div>
    </Teleport>
  </li>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { Activity, PlanEntry } from '@/types'
import { toRpe, toFeeling, ACTIVITY_TYPE_LABELS, workoutTypeLabel, workoutTypeIcon } from '@/utils'
import { rideLoad, zoneMinutes } from '@/utils/trainingLoad'
import { averagedAboveLthr, peakAboveMax } from '@/utils/hrCalibration'
import { useActivitiesStore } from '@/stores/activities.store'
import { useProfileStore }    from '@/stores/profile.store'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  activity: Activity
  planEntry: PlanEntry | null
}>()

/** Fires after a rating was accepted by Garmin; `regenerating` says whether AI re-evaluation started. */
const emit = defineEmits<{ rated: [regenerating: boolean] }>()

const activitiesStore = useActivitiesStore()
const profileStore    = useProfileStore()
const { show } = useToast()

const meta = computed(() => {
  const dateFormatted = new Date(props.activity.startTime).toLocaleDateString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
  const rawType = (props.activity.type || '').toLowerCase()
  const typeLabel = ACTIVITY_TYPE_LABELS[rawType]
    ?? (props.activity.type
      ? props.activity.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : 'Cycling')
  return `${dateFormatted} • ${typeLabel}`
})

const rpe = computed(() =>
  props.activity.perceivedExertion != null ? toRpe(props.activity.perceivedExertion) : null
)

const rpeClass = computed(() => {
  const r = rpe.value
  if (r == null) return ''
  return r <= 3 ? 'rpe-easy' : r <= 5 ? 'rpe-moderate' : r <= 7 ? 'rpe-hard' : 'rpe-max'
})

const feeling = computed(() =>
  props.activity.feelingAfterExercise != null ? toFeeling(props.activity.feelingAfterExercise) : null
)

const FEELING_MAP: Record<number, { label: string; icon: string; cls: string }> = {
  1: { label: 'Exhausted', icon: 'fa-face-dizzy',      cls: 'feeling-1' },
  2: { label: 'Tired',     icon: 'fa-face-tired',      cls: 'feeling-2' },
  3: { label: 'Normal',    icon: 'fa-face-smile',      cls: 'feeling-3' },
  4: { label: 'Good',      icon: 'fa-face-grin',       cls: 'feeling-4' },
  5: { label: 'Strong',    icon: 'fa-face-grin-stars', cls: 'feeling-5' }
}

/** Borg anchors, so the numbers mean the same thing here as on the watch. */
const RPE_HINTS: Record<number, string> = {
  1: 'Very easy',  2: 'Easy',       3: 'Light',      4: 'Comfortable', 5: 'Moderate',
  6: 'Somewhat hard', 7: 'Hard',    8: 'Very hard',  9: 'Extremely hard', 10: 'Maximal'
}

const feelingEntry = computed(() => {
  const f = feeling.value
  return f != null ? (FEELING_MAP[f] ?? FEELING_MAP[3]) : FEELING_MAP[3]
})

const feelingHtml = computed(() =>
  `<i class="fa-regular ${feelingEntry.value.icon}"></i> ${feelingEntry.value.label}`
)

const scoreClass = computed(() => {
  const score = props.planEntry?.executionScore ?? null
  if (score == null) return 'act-score-badge'
  return `act-score-badge ${score >= 80 ? 'score-great' : score >= 60 ? 'score-ok' : 'score-poor'}`
})

const scoreTypeLabel = computed(() =>
  props.planEntry ? (workoutTypeLabel[props.planEntry.type] || props.planEntry.type) : ''
)

const hasFeedback = computed(() =>
  rpe.value !== null || feeling.value !== null || (props.planEntry?.executionScore != null)
)

// ── Tooltip ──────────────────────────────────────────────────────────────────
// The Trend chart's tooltip, for this ride: how it felt and what the coach scored, with the
// coach's note in full (the old native title was hard to read and cut off). Fixed position
// and teleported, because the rides list scrolls and would clip anything absolute.

type TipKind = 'rating' | 'stats'
const tip   = ref<{ left: number; top: number; kind: TipKind } | null>(null)
const tipEl = ref<HTMLElement | null>(null)

function showTip(e: MouseEvent, kind: TipKind) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  tip.value = { left: r.left, top: r.bottom + 8, kind }
  document.addEventListener('scroll', hideTip, true)
  // Measure once rendered: flip above the row when there is no room below, keep it on screen.
  nextTick(() => {
    const el = tipEl.value
    if (!el || !tip.value) return
    const h = el.offsetHeight, w = el.offsetWidth
    const top  = r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, r.top - 8 - h) : r.bottom + 8
    const left = Math.min(r.left, window.innerWidth - 8 - w)
    tip.value = { left, top, kind }
  })
}
function hideTip() {
  tip.value = null
  document.removeEventListener('scroll', hideTip, true)
}
onBeforeUnmount(hideTip)

const tipDate = computed(() =>
  new Date(props.activity.startTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
)
const loadMaxHr = computed(() =>
  Math.max(profileStore.profile?.maxHr ?? 0, activitiesStore.analysis?.maxRecordedHr ?? 0) || 190)
/** Same load as the Trend chart (zone TRIMP), so the two never disagree. */
const load = computed(() => Math.round(rideLoad(props.activity, loadMaxHr.value)))
/** Minutes per zone: Garmin's own split, as in the Trend chart. */
const zoneMins = computed(() => zoneMinutes(props.activity, loadMaxHr.value).map(m => Math.round(m)))

const speed = computed(() => {
  const { distanceKm, durationMinutes } = props.activity
  return distanceKm > 0 && durationMinutes > 0 ? (distanceKm / (durationMinutes / 60)).toFixed(1) : null
})
const duration = computed(() => {
  const m = props.activity.durationMinutes ?? 0
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`
})
/** The zone the average HR falls in, by the athlete's own profile (not Garmin's split). */
const avgZone = computed(() => {
  const z = profileStore.profile?.zones
  const hr = props.activity.averageHr
  if (!z || !hr) return null
  return ([z.z1, z.z2, z.z3, z.z4, z.z5].findIndex(b => hr <= b.max) + 1) || 5
})
/** This ride's share of the header's heart rate warning, by the same rules (utils/hrCalibration). */
const hrFlags = computed(() => {
  const p = profileStore.profile
  if (!p?.maxHr || !p?.lthr) return []
  const out: string[] = []
  if (averagedAboveLthr(props.activity, p.lthr)) {
    out.push(`Averaged ${props.activity.averageHr} bpm for over an hour, above your LTHR (${p.lthr} bpm). LTHR is about the highest heart rate you can hold for an hour, so it is probably set too low.`)
  }
  if (peakAboveMax(props.activity, p.maxHr)) {
    out.push(`Peaked at ${props.activity.maxHr} bpm, above your Max HR (${p.maxHr} bpm). Unless that was a sensor spike, your zones sit too low.`)
  }
  return out
})

// ── Rating editor ────────────────────────────────────────────────────────────

const editing     = ref(false)
const saving      = ref(false)
const draftRpe     = ref<number | null>(null)
const draftFeeling = ref<number | null>(null)

const rateTitle = computed(() =>
  rpe.value !== null || feeling.value !== null ? 'Change your rating' : 'Rate this ride'
)

const hasDraft = computed(() => draftRpe.value !== null || draftFeeling.value !== null)

/**
 * A range input cannot represent "not rated", so an unrated ride parks the handle in the
 * middle while the track stays muted and the readout says so. Touching it is what commits
 * a value — which keeps "no opinion" distinguishable from "I rated this a 5".
 */
const rpeSlider = computed({
  get: () => draftRpe.value ?? 5,
  set: (v: number) => { draftRpe.value = v }
})

function openEditor() {
  draftRpe.value     = rpe.value
  draftFeeling.value = feeling.value
  editing.value      = true
}

/**
 * A click anywhere on the ride opens the rating editor. Controls handle their own clicks:
 * without the button/input guard, Cancel would close the editor and the same click would
 * bubble up here and reopen it.
 */
function onItemClick(e: Event) {
  if (editing.value) return
  if ((e.target as HTMLElement).closest('button, input, a')) return
  openEditor()
}

async function save() {
  saving.value = true
  const result = await activitiesStore.saveFeedback(String(props.activity.activityId), {
    rpe:     draftRpe.value,
    feeling: draftFeeling.value
  })
  saving.value = false

  if (!result.ok) {
    // The backend writes Garmin first, so a failure means nothing was stored anywhere —
    // keep the editor open rather than pretending the rating landed.
    show('error', 'Could not save rating', result.details || 'Garmin did not accept the update.')
    return
  }

  editing.value = false
  show('success', 'Rating saved', 'Synced to Garmin Connect.')
  emit('rated', result.regenerating)
}
</script>
