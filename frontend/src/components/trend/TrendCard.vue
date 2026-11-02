<template>
  <section class="dashboard-card glass-panel trend-card" :class="{ 'is-collapsed': collapsed }" id="trend-card">
    <div class="card-header">
      <i class="fa-solid fa-chart-line header-icon"></i>
      <h2>Trend</h2>
      <button
        ref="helpButton"
        type="button"
        class="trend-help-btn"
        :aria-expanded="helpOpen"
        aria-controls="trend-help"
        title="How these numbers work"
        aria-label="How these numbers work"
        @click.stop="helpOpen = !helpOpen"
      >
        <i class="fa-regular fa-circle-question"></i>
      </button>

      <!-- Explanation of every number on the card. Floats over the chart; Escape, the button or a
           click outside closes it. -->
      <div
        v-if="helpOpen"
        id="trend-help"
        ref="helpPanel"
        class="trend-help"
        role="dialog"
        aria-label="How these numbers work"
        @click.stop
      >
        <div class="trend-help-head">
          <span>How these numbers work</span>
          <button type="button" class="trend-help-close" aria-label="Close" @click="helpOpen = false">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <dl class="trend-help-list">
          <dt>Load</dt>
          <dd>
            Every ride gets a score from your heart rate: each minute in zone 1 counts 1 point, in zone 2
            counts 2, up to 5 points per minute in zone 5. An easy hour is about 120, an hour with real
            intervals 200 or more. It uses Garmin's own zone split, so the HR zones set in Velomate do
            not change it.
          </dd>

          <dt><span class="trend-key" style="background: var(--series-fitness)"></span>Fitness</dt>
          <dd>
            Your average daily load over roughly the last six weeks (a 42-day weighted average). It
            rises slowly when you train consistently and fades slowly when you stop: this is your base.
          </dd>

          <dt><span class="trend-key" style="background: var(--series-fatigue)"></span>Fatigue</dt>
          <dd>
            The same average over roughly the last week (7 days). It jumps after a hard ride and drops
            quickly with rest.
          </dd>

          <dt>Form</dt>
          <dd>
            Yesterday's fitness minus yesterday's fatigue: how fresh you start today. The word next to
            it compares form with your fitness, so it means the same at any level.
            At {{ LOW_VOLUME_RIDES_PER_WEEK }} rides a week or fewer the two outer bands read calmer, because
            one ride moves the numbers a lot:
            <template v-for="(alias, band) in LOW_VOLUME_LABELS" :key="band">
              <strong>{{ band }}</strong> shows as <strong>{{ alias.label }}</strong><template v-if="band === 'Overreaching'"> and </template>
            </template>.
            <table class="trend-help-bands">
              <tbody>
                <tr v-for="b in FORM_BANDS" :key="b.label">
                  <th scope="row">{{ b.label }}</th>
                  <td class="trend-help-range">{{ b.range }}</td>
                  <td>{{ b.meaning }}</td>
                </tr>
              </tbody>
            </table>
          </dd>

          <dt>Bars</dt>
          <dd>
            One bar per week: the average daily load of that week, split by heart-rate zone. Same unit
            as the lines, which is why they share one scale.
          </dd>

          <dt><span class="trend-swatch trend-swatch--band"></span>The shaded gap</dt>
          <dd>
            The space between the two lines is your form. Violet where fitness is above fatigue (fresh),
            pink where fatigue is above fitness (carrying fatigue). The wider the gap, the bigger the number.
          </dd>

          <dt>Feel and Plan rows</dt>
          <dd>
            Under the chart, on the same dates: your daily check-ins and post-ride feeling as faces (a
            check-in wins when there are both), and the workouts the coach planned, faded when skipped.
            Hover a day for the RPE, your note and the coach's score. The plan row reaches back only as
            far as the app keeps history: two weeks of plan, or your last suggestions in free mode.
          </dd>

          <dt>Showing and hiding</dt>
          <dd>
            Click a line, a bar or a legend item to hide it; click the legend item again to bring it
            back. Hover anywhere on the chart for that day's and that week's exact values.
          </dd>
        </dl>

        <p class="trend-help-foot">
          Fitness needs about six weeks of rides to mean much<template v-if="shortHistory">, and your
          stored history covers only {{ daily.length }} days, so it still reads low</template>. These
          numbers come from your rides only; the AI coach does not set them.
        </p>
      </div>

      <!-- Today's numbers stay visible when the charts are collapsed. -->
      <div v-if="today" class="trend-stats">
        <div class="trend-stat">
          <span class="trend-stat-label"><span class="trend-key" style="background: var(--series-fitness)"></span>Fitness</span>
          <span class="trend-stat-value">{{ Math.round(today.fitness) }}</span>
          <span class="trend-stat-delta">{{ deltaText(today.fitness, weekAgo?.fitness) }}</span>
        </div>
        <div class="trend-stat">
          <span class="trend-stat-label"><span class="trend-key" style="background: var(--series-fatigue)"></span>Fatigue</span>
          <span class="trend-stat-value">{{ Math.round(today.fatigue) }}</span>
          <span class="trend-stat-delta">{{ deltaText(today.fatigue, weekAgo?.fatigue) }}</span>
        </div>
        <div class="trend-stat" :title="formExplanation(formWord)">
          <span class="trend-stat-label">Form</span>
          <span class="trend-stat-value">{{ signed(Math.round(today.form)) }}</span>
          <span class="trend-stat-delta trend-stat-word">{{ formWord }}</span>
        </div>
      </div>

      <div class="card-header-actions">
        <div v-if="!collapsed && today" class="trend-range" role="group" aria-label="Time range">
          <button
            v-for="r in RANGES" :key="r.id"
            type="button"
            class="trend-range-btn"
            :class="{ 'is-active': range === r.id }"
            :aria-pressed="range === r.id"
            @click="range = r.id"
          >{{ r.label }}</button>
        </div>
        <button
          v-if="!collapsed && today"
          type="button"
          class="btn-icon-sm"
          :class="{ 'is-active': tableView }"
          :aria-pressed="tableView"
          :title="tableView ? 'Show charts' : 'Show as table'"
          :aria-label="tableView ? 'Show charts' : 'Show as table'"
          @click="tableView = !tableView"
        >
          <i class="fa-solid" :class="tableView ? 'fa-chart-line' : 'fa-table'"></i>
        </button>
        <button
          type="button"
          class="btn-icon-sm"
          :aria-expanded="!collapsed"
          :title="collapsed ? 'Show charts' : 'Hide charts'"
          :aria-label="collapsed ? 'Show charts' : 'Hide charts'"
          @click="toggleCollapsed"
        >
          <i class="fa-solid" :class="collapsed ? 'fa-chevron-down' : 'fa-chevron-up'"></i>
        </button>
      </div>
    </div>

    <div v-if="!collapsed" class="trend-body">
      <p v-if="!today" class="helper-text trend-empty-state">
        Your trend appears here once rides have been synced from Garmin.
      </p>

      <template v-else-if="!tableView">
        <div class="trend-chart-head">
          <span class="trend-chart-title">Fitness, fatigue &amp; weekly load</span>
          <div class="trend-legend">
            <button
              v-for="s in LINE_SERIES" :key="s.key"
              type="button"
              class="trend-legend-item"
              :class="{ 'is-off': hiddenLines.includes(s.key) }"
              :aria-pressed="!hiddenLines.includes(s.key)"
              :title="hiddenLines.includes(s.key) ? `Show ${s.label}` : `Hide ${s.label}`"
              @click="toggleLine(s.key)"
            >
              <span class="trend-key" :style="{ background: s.color }"></span>{{ s.label }}
            </button>
            <button
              type="button"
              class="trend-legend-item"
              :class="{ 'is-off': hiddenLines.includes('form') }"
              :aria-pressed="!hiddenLines.includes('form')"
              @click="toggleLine('form')"
            >
              <span class="trend-swatch trend-swatch--band"></span>Form
            </button>
            <span class="trend-legend-sep" aria-hidden="true"></span>
            <button
              v-for="(z, i) in ZONE_LABELS" :key="z"
              type="button"
              class="trend-legend-item"
              :class="{ 'is-off': hiddenZones.includes(i) }"
              :aria-pressed="!hiddenZones.includes(i)"
              :title="hiddenZones.includes(i) ? `Show ${z}` : `Hide ${z}`"
              @click="toggleZone(i)"
            >
              <span class="trend-swatch" :style="{ background: `var(--z${i + 1}-color)` }"></span>{{ z }}
            </button>
          </div>
        </div>
        <TrendChart
          :points="rangePoints" :weeks="rangeWeeks"
          :hidden-lines="hiddenLines" :hidden-zones="hiddenZones"
          :feel-by-date="feelByDate" :plan-by-date="planByDate"
          @toggle-line="toggleLine" @toggle-zone="toggleZone"
        />

      </template>

      <!-- The table twin: every value the charts show, without hovering. -->
      <div v-else class="trend-table-wrap">
        <table class="trend-table">
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Rides</th>
              <th scope="col">Time</th>
              <th v-for="z in ZONE_LABELS" :key="z" scope="col">{{ z }} min</th>
              <th scope="col">Load / day</th>
              <th scope="col">Fitness</th>
              <th scope="col">Fatigue</th>
              <th scope="col">Form</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tableRows" :key="row.weekStart">
              <th scope="row">{{ formatDay(row.weekStart) }}</th>
              <td>{{ row.rides }}</td>
              <td>{{ fmtHours(row.totalMinutes) }}</td>
              <td v-for="(m, z) in row.zoneMinutes" :key="z">{{ Math.round(m) }}</td>
              <td>{{ row.loadPerDay }}</td>
              <td>{{ row.fitness }}</td>
              <td>{{ row.fatigue }}</td>
              <td>{{ signed(row.form) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useActivitiesStore } from '@/stores/activities.store'
import { useProfileStore }    from '@/stores/profile.store'
import { useSettingsStore }   from '@/stores/settings.store'
import {
  buildDailySeries, buildWeeklyZones, formLabel, formExplanation, addDays, FITNESS_DAYS, FORM_BANDS,
  LOW_VOLUME_LABELS, LOW_VOLUME_RIDES_PER_WEEK
} from '@/utils/trainingLoad'
import { isoDate, toFeeling } from '@/utils'
import { getCheckinsSince } from '@/api/client'
import { useCheckinStore }        from '@/stores/checkin.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useFreeTrainingStore }   from '@/stores/freeTraining.store'
import type { DailyCheckin } from '@/types'
import TrendChart from './TrendChart.vue'

type LineKey = 'fitness' | 'fatigue' | 'form'

const activitiesStore = useActivitiesStore()
const profileStore    = useProfileStore()
const settingsStore   = useSettingsStore()
const checkinStore        = useCheckinStore()
const recommendationStore = useRecommendationStore()
const freeTrainingStore   = useFreeTrainingStore()

const LINE_SERIES: { key: 'fitness' | 'fatigue'; label: string; color: string }[] = [
  { key: 'fitness', label: 'Fitness', color: 'var(--series-fitness)' },
  { key: 'fatigue', label: 'Fatigue', color: 'var(--series-fatigue)' },
]
const ZONE_LABELS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5']
const RANGES = [
  { id: '3m', label: '3M', days: 91 },
  { id: '6m', label: '6M', days: 182 },
  { id: '1y', label: '1Y', days: 365 },
] as const

// ── Help panel ───────────────────────────────────────────────────────────────
const helpOpen   = ref(false)
const helpButton = ref<HTMLButtonElement | null>(null)
const helpPanel  = ref<HTMLElement | null>(null)
const closeHelp  = () => { helpOpen.value = false }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && helpOpen.value) {
    helpOpen.value = false
    helpButton.value?.focus()
  }
}
// Focus moves into the panel when it opens, so keyboard and screen-reader users land on it.
watch(helpOpen, open => { if (open) nextTick(() => helpPanel.value?.querySelector<HTMLElement>('button')?.focus()) })
onMounted(() => {
  document.addEventListener('click', closeHelp)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeHelp)
  document.removeEventListener('keydown', onKeydown)
})

const range     = ref<(typeof RANGES)[number]['id']>('6m')
const tableView = ref(false)
const hiddenLines = ref<LineKey[]>([])
const hiddenZones = ref<number[]>([])

const collapsed = computed(() => settingsStore.trendCollapsed)
function toggleCollapsed() { settingsStore.saveTrendCollapsed(!collapsed.value) }

function toggleLine(key: LineKey) {
  hiddenLines.value = hiddenLines.value.includes(key)
    ? hiddenLines.value.filter(k => k !== key)
    : [...hiddenLines.value, key]
}
function toggleZone(zone: number) {
  hiddenZones.value = hiddenZones.value.includes(zone)
    ? hiddenZones.value.filter(z => z !== zone)
    : [...hiddenZones.value, zone]
}

// Only for rides without Garmin zone data: their zone is estimated from average HR against
// max HR. The highest known value is the closest to the max HR Garmin's zones are based on.
const maxHr = computed(() =>
  Math.max(profileStore.profile?.maxHr ?? 0, activitiesStore.analysis?.maxRecordedHr ?? 0) || 190
)

const daily = computed(() => buildDailySeries(activitiesStore.activities, maxHr.value))
const today = computed(() => daily.value[daily.value.length - 1] ?? null)
const weekAgo = computed(() => daily.value[daily.value.length - 8] ?? null)
const shortHistory = computed(() => daily.value.length < FITNESS_DAYS)
const formWord = computed(() =>
  today.value ? formLabel(today.value.form, today.value.fitness, today.value.ridesPerWeek) : ''
)

const rangeDays = computed(() => RANGES.find(r => r.id === range.value)!.days)
const rangePoints = computed(() => daily.value.slice(-rangeDays.value))
const rangeWeeks = computed(() => {
  const from = rangePoints.value[0]?.date ?? isoDate()
  return buildWeeklyZones(activitiesStore.activities, maxHr.value, from)
})

// ── Feel row: check-ins plus the post-ride rating ────────────────────────────
// /api/checkin only returns the last few rows (enough for the strip), so the chart asks for
// the whole year itself, and again whenever today's answer changes.
const checkins = ref<DailyCheckin[]>([])
async function loadCheckins() {
  try {
    checkins.value = (await getCheckinsSince(addDays(isoDate(), -370))).checkins
  } catch {
    checkins.value = []   // the rows are extra; the chart works without them
  }
}
onMounted(loadCheckins)
watch(() => checkinStore.today, loadCheckins)

/** RPE and feeling come per ride; on a day with two rides the longer one speaks for the day. */
const feelByDate = computed(() => {
  const out: Record<string, { checkin?: { feeling: number; note: string | null }; rideFeeling?: number; rpe?: number }> = {}
  const longest = new Map<string, number>()
  for (const a of activitiesStore.activities) {
    const d = (a.startTime ?? '').slice(0, 10)
    if (!d || (a.perceivedExertion == null && a.feelingAfterExercise == null)) continue
    if ((longest.get(d) ?? -1) >= (a.durationMinutes ?? 0)) continue
    longest.set(d, a.durationMinutes ?? 0)
    out[d] = {
      ...out[d],
      rideFeeling: a.feelingAfterExercise != null ? toFeeling(a.feelingAfterExercise) : undefined,
      rpe: a.perceivedExertion != null ? Math.round(a.perceivedExertion / 10) : undefined,
    }
  }
  for (const c of checkins.value) out[c.date] = { ...out[c.date], checkin: { feeling: c.feeling, note: c.note } }
  return out
})

// ── Plan row: what the coach had prescribed, and how it went ─────────────────
// Only as far back as the app keeps it: the plan holds a rolling 14 days of history, free mode
// its last suggestions. Rest days are left out; there is nothing to compare them with.
const planByDate = computed(() => {
  const out: Record<string, { type: string; state: 'done' | 'skipped' | 'planned'; score: number | null; note: string | null }> = {}
  const now = isoDate()
  if (settingsStore.freeTrainingMode) {
    for (const s of freeTrainingStore.history) {
      if (s.status !== 'completed' || !s.completedDate) continue
      out[s.completedDate] = { type: s.workoutType, state: 'done', score: s.executionScore ?? null, note: s.executionNote ?? null }
    }
  } else {
    for (const e of recommendationStore.recommendation?.weeklyPlan ?? []) {
      if (e.type === 'Rest' || e.date > now || e.isPlaceholder) continue
      const state = e.status === 'completed' ? 'done' : e.status === 'planned' ? 'planned' : 'skipped'
      out[e.date] = { type: e.type, state, score: e.executionScore ?? null, note: e.executionNote ?? null }
    }
  }
  return out
})

const tableRows = computed(() => {
  const byDate = new Map(daily.value.map(p => [p.date, p]))
  const now = isoDate()
  return [...rangeWeeks.value].reverse().map(w => {
    const end = addDays(w.weekStart, 6)
    const p = byDate.get(end < now ? end : now)
    const elapsed = Math.min(7, Math.max(1, Math.round(
      (new Date(now + 'T12:00:00').getTime() - new Date(w.weekStart + 'T12:00:00').getTime()) / 86_400_000) + 1))
    return {
      ...w,
      loadPerDay: Math.round(w.zoneMinutes.reduce((sum, m, z) => sum + m * (z + 1), 0) / elapsed),
      fitness: Math.round(p?.fitness ?? 0),
      fatigue: Math.round(p?.fatigue ?? 0),
      form:    Math.round(p?.form ?? 0),
    }
  })
})

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
function deltaText(now: number, before?: number): string {
  if (before === undefined) return ''
  const d = Math.round(now - before)
  return d === 0 ? 'same as last week' : `${signed(d)} vs last week`
}
const fmtHours = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`
const formatDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
</script>

<style scoped>
/* Its own layer above the cards below: the tooltip and the help panel are taller than the card
   and hang over Rides and Training, whose inputs otherwise painted on top of them. */
.trend-card { flex: none; margin-bottom: 1.75rem; position: relative; z-index: 2; }

.trend-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  margin-left: -0.2rem;
  padding: 0;
  font-size: 0.9rem;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.trend-help-btn:hover,
.trend-help-btn[aria-expanded='true'] { color: var(--primary-color); }
.trend-help-btn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

/* A genuinely floating layer, so it gets the overlay shadow (the one shadow token). */
.trend-help {
  position: absolute;
  top: 4.4rem;
  left: 1.75rem;
  z-index: 10;
  width: min(500px, calc(100% - 3.5rem));
  /* It outgrew short windows: scroll inside rather than run past the bottom of the app. */
  max-height: calc(100dvh - 14rem);
  overflow-y: auto;
  padding: 1rem 1.25rem;
  background: var(--surface-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay);
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}
.trend-help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.6rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.trend-help-close {
  padding: 0.2rem 0.35rem;
  font-size: 0.85rem;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
.trend-help-close:hover { color: var(--text-primary); background: var(--raise); }
.trend-help-close:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
.trend-help-list { margin: 0; }
.trend-help-list dt {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.65rem;
  font-weight: 600;
  color: var(--text-primary);
}
.trend-help-list dt:first-child { margin-top: 0; }
.trend-help-list dd { margin: 0.15rem 0 0; }
.trend-help-bands { width: 100%; margin-top: 0.4rem; border-collapse: collapse; font-size: 0.76rem; }
.trend-help-bands th, .trend-help-bands td { padding: 0.25rem 0.5rem; vertical-align: top; text-align: left; }
.trend-help-bands th { font-weight: 600; color: var(--text-primary); white-space: nowrap; }
.trend-help-range { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-muted); }
.trend-help-foot { margin: 0.75rem 0 0; padding-top: 0.6rem; border-top: 1px solid var(--hairline); font-size: 0.74rem; color: var(--text-muted); }

@media (max-width: 640px) {
  .trend-help { left: 1rem; width: calc(100% - 2rem); }
}
.trend-card.is-collapsed .card-header { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
.trend-card .card-header { flex-wrap: wrap; row-gap: 0.75rem; }

.trend-stats {
  display: flex;
  gap: 2rem;
  margin-left: 1.5rem;
}
.trend-stat { display: flex; flex-direction: column; gap: 0.1rem; min-width: 4.5rem; }
.trend-stat-label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
/* Proportional figures at display size; tabular is for columns. */
.trend-stat-value {
  font-family: var(--font-numeric);
  font-size: 1.35rem;
  font-weight: 500;
  line-height: 1.1;
  letter-spacing: -0.01em;
  font-variant-numeric: proportional-nums;
  color: var(--text-primary);
}
.trend-stat-delta { font-size: 0.7rem; color: var(--text-muted); }
.trend-stat-word { color: var(--text-secondary); font-weight: 600; }

.trend-range {
  display: inline-flex;
  padding: 2px;
  background: var(--surface-2);
  border-radius: var(--radius-pill);
}
.trend-range-btn {
  padding: 0.2rem 0.6rem;
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.trend-range-btn:hover { color: var(--text-primary); background: var(--raise); }
.trend-range-btn.is-active { color: var(--text-primary); border-color: var(--primary-color); }
.btn-icon-sm.is-active { color: var(--primary-color); }

.trend-body { display: flex; flex-direction: column; gap: 0.35rem; }
.trend-chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 0.4rem;
}
.trend-chart-title {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.trend-legend { display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; }
.trend-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.1rem 0;
  font: inherit;
  font-size: 0.74rem;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
}
.trend-legend-item:hover { color: var(--text-primary); }
.trend-legend-item:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: var(--radius-xs); }
.trend-legend-item.is-off { color: var(--text-muted); text-decoration: line-through; }
.trend-legend-item.is-off .trend-key,
.trend-legend-item.is-off .trend-swatch { opacity: 0.3; }

/* Legend mirrors the mark: a line key for lines, a rect for bars. */
.trend-key { display: inline-block; width: 12px; height: 2px; border-radius: 1px; }
.trend-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
.trend-legend-sep { width: 1px; align-self: stretch; background: var(--hairline); }
/* The form band's key: its two halves, like the shading between the lines. */
.trend-swatch--band {
  background: linear-gradient(135deg, var(--series-fitness) 50%, var(--series-fatigue) 50%);
  opacity: 0.55;
}
.trend-help-list dd strong { color: var(--text-primary); font-weight: 600; }

.trend-empty-state { margin: 0; }

.trend-table-wrap { max-height: 240px; overflow: auto; }
.trend-table { width: 100%; border-collapse: collapse; font-size: 0.76rem; font-variant-numeric: tabular-nums; }
.trend-table th, .trend-table td { padding: 0.35rem 0.6rem; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--hairline); }
.trend-table thead th {
  position: sticky; top: 0;
  background: var(--panel-bg);
  font-size: 0.64rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-muted);
}
.trend-table tbody th { text-align: left; font-weight: 500; color: var(--text-primary); }
.trend-table td { color: var(--text-secondary); }

@media (max-width: 1024px) {
  .trend-stats { order: 3; width: 100%; margin-left: 0; }
}
</style>

<!-- Shared by both charts: their tooltips. Not scoped, prefixed instead. -->
<style>
.trend-tooltip {
  position: absolute;
  z-index: 5;
  min-width: 150px;
  padding: 0.5rem 0.7rem;
  font-size: 0.75rem;
  /* See-through, so the chart under it stays readable while hovering. Plain transparency,
     no backdrop blur: a panel that blurs what is under itself is the glassmorphism the visual
     language rules out. No drop shadow either: it would muddy exactly what should show through. */
  background: color-mix(in srgb, var(--surface-3) 72%, transparent);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  pointer-events: none;
}
.trend-tooltip .tt-date { margin-bottom: 0.3rem; font-size: 0.7rem; color: var(--text-muted); }
/* Form leads the tooltip in the same type as the Form stat above the chart (eyebrow label,
   figure, word): it stands out by size and position, not by decoration. */
.trend-tooltip .tt-form { display: flex; flex-direction: column; gap: 0.1rem; margin: 0.1rem 0 0.5rem; }
.trend-tooltip .tt-form-label {
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.trend-tooltip .tt-form-value {
  font-family: var(--font-numeric);
  font-size: 1.2rem;
  font-weight: 500;
  line-height: 1.1;
  letter-spacing: -0.01em;
  font-variant-numeric: proportional-nums;
  color: var(--text-primary);
}
.trend-tooltip .tt-form-word { font-size: 0.7rem; font-weight: 600; color: var(--text-secondary); }
.trend-tooltip .tt-section { margin-top: 0.45rem; padding-top: 0.4rem; border-top: 1px solid var(--hairline); }
.trend-tooltip .tt-row { display: flex; align-items: center; gap: 0.45rem; line-height: 1.65; }
.trend-tooltip .tt-row strong {
  min-width: 3.4em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.trend-tooltip .tt-row span:last-child { color: var(--text-secondary); }
.trend-tooltip .tt-row.is-hidden { opacity: 0.45; }
/* Line keys in tooltips, never boxes. */
.trend-tooltip .tt-key { flex: none; width: 10px; height: 2px; border-radius: 1px; }
.trend-tooltip .tt-key--none { background: transparent; }
.trend-tooltip .tt-foot { margin-top: 0.3rem; font-size: 0.7rem; color: var(--text-muted); }
</style>
