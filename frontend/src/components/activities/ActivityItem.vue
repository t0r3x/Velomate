<template>
  <!-- The whole ride opens and closes its details: the hover outline promises that clicking it
       does something. The pencil (or "Rate this ride") opens the rating editor. -->
  <li
    class="activity-item"
    :class="{ 'is-clickable': !editing, 'is-expanded': expanded }"
    :tabindex="editing ? undefined : 0"
    @click="onItemClick"
    @keydown.enter.self="toggleDetails"
  >
    <div class="activity-details-main">
      <span class="activity-title">{{ activity.name || 'Cycling Activity' }}</span>
      <span class="activity-meta">{{ meta }}</span>

      <div v-if="hasFeedback || editing" class="act-feedback">
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

    <div class="activity-stats-summary" :style="{ '--stat-cols': statCols }">
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
      <!-- Only on rides from the bike with a power meter; NP, IF and the 20-minute best are in the details. -->
      <div v-if="activity.averagePower > 0" class="act-stat act-stat--power">
        <span class="act-stat-val">{{ activity.averagePower }} W</span>
        <span class="act-stat-label">Avg power</span>
      </div>
    </div>

    <!-- The details used to be two hover tooltips (numbers, rating row). With power, zones, warnings
         and the coach's note they had become a page of text that vanished when the mouse moved,
         and nothing on the card said they existed. Now a visible toggle, read at leisure, and
         several rides can be open side by side to compare. -->
    <button
      v-if="!editing"
      type="button"
      class="act-details-toggle"
      :aria-expanded="expanded"
      :aria-controls="detailsId"
      @click="toggleDetails"
    >
      <i class="fa-solid fa-chevron-down act-details-chevron" aria-hidden="true"></i>
      <span>{{ expanded ? 'Hide details' : 'Details' }}</span>
    </button>

    <div v-if="expanded && !editing" :id="detailsId" class="act-details">
      <div class="ad-rows">
        <div class="ad-row">
          <i class="fa-solid fa-route ad-icon"></i>
          <strong>{{ activity.distanceKm }} km</strong>
          <span>{{ speed ? `${speed} km/h average` : 'Distance' }}</span>
        </div>
        <div class="ad-row">
          <i class="fa-regular fa-clock ad-icon"></i>
          <strong>{{ duration }}</strong>
          <span>Load {{ load }}</span>
        </div>
        <div v-if="activity.averageHr > 0" class="ad-row">
          <i class="fa-solid fa-heart-pulse ad-icon ad-icon--hr"></i>
          <strong>{{ activity.averageHr }} bpm</strong>
          <span>average{{ activity.maxHr > 0 ? ` · max ${activity.maxHr}` : '' }}{{ avgZone ? ` · Z${avgZone}` : '' }}</span>
        </div>
        <div v-else class="ad-row">
          <i class="fa-solid fa-heart-pulse ad-icon"></i>
          <strong>–</strong>
          <span>No heart rate recorded</span>
        </div>
        <div v-if="activity.averagePower > 0" class="ad-row">
          <i class="fa-solid fa-bolt ad-icon"></i>
          <strong>{{ activity.averagePower }} W</strong>
          <span>average{{ activity.maxPower > 0 ? ` · max ${activity.maxPower}` : '' }}</span>
        </div>
        <div v-if="activity.averagePower > 0 && activity.normPower" class="ad-row">
          <i class="fa-solid fa-wave-square ad-icon"></i>
          <strong>{{ activity.normPower }} W</strong>
          <span>normalized{{ intensity ? ` · IF ${intensity}` : '' }}</span>
        </div>
        <div v-if="best20" class="ad-row">
          <i class="fa-solid fa-stopwatch ad-icon"></i>
          <strong>{{ best20 }} W</strong>
          <span>best 20 min</span>
        </div>
      </div>

      <!-- Only a measured split. Without any heart rate the load is an estimate, not a split to show. -->
      <template v-if="hasMeasuredZones">
        <div class="ad-label">Time in zone</div>
        <div class="ad-zone-bar" role="img" :aria-label="zoneAria">
          <span
            v-for="(m, z) in zoneMins"
            v-show="m > 0"
            :key="'bar' + z"
            class="ad-zone-seg"
            :style="{ flexGrow: m, background: `var(--z${z + 1}-color)` }"
          ></span>
        </div>
        <div class="ad-zones">
          <template v-for="(m, z) in zoneMins" :key="'z' + z">
            <span v-if="m > 0" class="ad-zone">
              <span class="ad-key" :style="{ background: `var(--z${z + 1}-color)` }"></span>Z{{ z + 1 }}
              <strong>{{ m }}m</strong>
            </span>
          </template>
        </div>
        <p v-if="hrGap > 0" class="ad-note">
          Heart rate covered {{ (activity.durationMinutes ?? 0) - hrGap }} of {{ activity.durationMinutes }} min.
          The load counts the other {{ hrGap }} min {{ activity.averagePower > 0 && profileStore.profile?.ftp && activity.normPower ? 'by power' : 'by average heart rate' }}.
        </p>
      </template>

      <template v-if="hrFlags.length">
        <div class="ad-label">Heart rate profile</div>
        <div v-for="f in hrFlags" :key="f" class="ad-row ad-row--warn">
          <i class="fa-solid fa-triangle-exclamation ad-icon ad-icon--warn"></i>
          <span>{{ f }}</span>
        </div>
      </template>

      <template v-if="rpe !== null || feeling !== null">
        <div class="ad-label">How it felt</div>
        <div v-if="feeling !== null" class="ad-row">
          <i class="fa-regular ad-icon" :class="[feelingEntry.icon, feelingEntry.cls]"></i>
          <strong>{{ feeling }}/5</strong>
          <span>After the ride · {{ feelingEntry.label }}</span>
        </div>
        <div v-if="rpe !== null" class="ad-row">
          <i class="fa-solid fa-gauge-high ad-icon"></i>
          <strong>RPE {{ rpe }}</strong>
          <span>{{ RPE_HINTS[rpe] }}</span>
        </div>
      </template>

      <template v-if="planEntry?.executionScore != null">
        <div class="ad-label">Coach</div>
        <div class="ad-row">
          <i class="fa-solid ad-icon" :class="[workoutTypeIcon[planEntry.type] ?? 'fa-circle', `wt-${planEntry.type.toLowerCase()}`]"></i>
          <strong>{{ planEntry.executionScore }}</strong>
          <span>{{ scoreTypeLabel }} · ridden</span>
        </div>
        <p v-if="planEntry.executionNote" class="ad-note">{{ planEntry.executionNote }}</p>
      </template>
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
  </li>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Activity, PlanEntry } from '@/types'
import { toRpe, toFeeling, ACTIVITY_TYPE_LABELS, workoutTypeLabel, workoutTypeIcon } from '@/utils'
import { rideLoad, zoneMinutes, measuredZoneMinutes, hrGapMinutes } from '@/utils/trainingLoad'
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

/** Columns in the stats row: never fewer than 3, so rides without HR or power keep the usual grid. */
const statCols = computed(() =>
  Math.max(3, 2 + (props.activity.averageHr > 0 ? 1 : 0) + (props.activity.averagePower > 0 ? 1 : 0)))

// ── Details ──────────────────────────────────────────────────────────────────

const expanded  = ref(false)
const detailsId = `ride-details-${props.activity.activityId}`

function toggleDetails() {
  if (editing.value) return
  expanded.value = !expanded.value
}

/**
 * A click anywhere on the ride toggles its details. Controls handle their own clicks: without
 * the button/input guard, the pencil would open the editor and the same click would bubble up
 * here and toggle the details as well.
 */
function onItemClick(e: Event) {
  if (editing.value) return
  // Inside the open details too: selecting or reading text there must not fold the ride shut.
  if ((e.target as HTMLElement).closest('button, input, a, .act-details')) return
  toggleDetails()
}

const loadMaxHr = computed(() =>
  Math.max(profileStore.profile?.maxHr ?? 0, activitiesStore.analysis?.maxRecordedHr ?? 0) || 190)
/** Same load as the Trend chart (zone TRIMP), so the two never disagree. */
const load = computed(() => Math.round(rideLoad(props.activity, loadMaxHr.value, profileStore.profile?.ftp)))
/** Minutes per zone: Garmin's own split as measured (a strap dropout's gap is in the load, not
 *  drawn as if it were measured), else the one zone the average heart rate places the ride in. */
const zoneMins = computed(() =>
  (measuredZoneMinutes(props.activity) ?? zoneMinutes(props.activity, loadMaxHr.value, profileStore.profile?.ftp)).map(m => Math.round(m)))
const hrGap = computed(() => Math.round(hrGapMinutes(props.activity)))
/** A split worth drawing: Garmin's own, or one placed by a real average heart rate. */
const hasMeasuredZones = computed(() =>
  zoneMins.value.some(m => m > 0) && (props.activity.averageHr > 0 || !!props.activity.timeInZones?.some(s => s > 0)))
const zoneAria = computed(() =>
  zoneMins.value.map((m, z) => (m > 0 ? `Z${z + 1} ${m} minutes` : null)).filter(Boolean).join(', '))

const speed = computed(() => {
  const { distanceKm, durationMinutes } = props.activity
  return distanceKm > 0 && durationMinutes > 0 ? (distanceKm / (durationMinutes / 60)).toFixed(1) : null
})
const duration = computed(() => {
  const m = props.activity.durationMinutes ?? 0
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`
})
/** NP as a share of FTP, two decimals; only with both (power.service.ts on the backend does the same). */
const intensity = computed(() => {
  const ftp = profileStore.profile?.ftp
  const np  = props.activity.normPower
  return ftp && np ? (np / ftp).toFixed(2) : null
})
/** Best 20 minutes, left out of rides too short to contain one (as in the prompt). */
const best20 = computed(() =>
  props.activity.averagePower > 0 && (props.activity.durationMinutes ?? 0) >= 20 ? props.activity.max20MinPower ?? null : null)
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
