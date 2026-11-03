<template>
  <section class="dashboard-card glass-panel trend-card" :class="{ 'is-collapsed': collapsed }" id="trend-card">
    <div class="card-header">
      <i class="fa-solid fa-chart-line header-icon"></i>
      <h2>Trend</h2>
      <HelpPopover title="How these numbers work">
        <dl class="help-list">
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
            <table class="help-bands">
              <tbody>
                <tr v-for="b in FORM_BANDS" :key="b.label">
                  <th scope="row">{{ b.label }}</th>
                  <td class="help-range">{{ b.range }}</td>
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
            Click a line, a bar, a row label or a legend item to hide it; click the legend item again
            to bring it back. What you hide is remembered. Hover anywhere on the chart for that day's and that week's exact values.
          </dd>
        </dl>
        <template #foot>
          Fitness needs about six weeks of rides to mean much<template v-if="shortHistory">, and your
          stored history covers only {{ daily.length }} days, so it still reads low</template>. These
          numbers come from your rides only; the AI coach does not set them.
        </template>
      </HelpPopover>

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
            <span v-if="rowItems.length" class="trend-legend-sep" aria-hidden="true"></span>
            <!-- The rows under the chart. Their keys are the glyphs they show: a face, and the
                 calendar of the AI Training Plan card. -->
            <button
              v-for="r in rowItems" :key="r.key"
              type="button"
              class="trend-legend-item"
              :class="{ 'is-off': hiddenRows.includes(r.key) }"
              :aria-pressed="!hiddenRows.includes(r.key)"
              @click="toggleRow(r.key)"
            >
              <i class="trend-legend-icon" :class="r.icon"></i>{{ r.label }}
            </button>
          </div>
        </div>
        <TrendChart
          :points="rangePoints" :weeks="rangeWeeks"
          :hidden-lines="hiddenLines" :hidden-zones="hiddenZones"
          :feel-by-date="feelByDate" :plan-by-date="planByDate" :hidden-rows="hiddenRows"
          @toggle-line="toggleLine" @toggle-zone="toggleZone" @toggle-row="toggleRow"
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
import { computed, onMounted, ref, watch } from 'vue'
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
import HelpPopover from '@/components/ui/HelpPopover.vue'

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
const ROW_ITEMS: { key: 'feel' | 'plan'; label: string; icon: string }[] = [
  { key: 'feel', label: 'Feel', icon: 'fa-regular fa-face-smile' },
  { key: 'plan', label: 'Plan', icon: 'fa-solid fa-calendar-week' },
]
const RANGES = [
  { id: '3m', label: '3M', days: 91 },
  { id: '6m', label: '6M', days: 182 },
  { id: '1y', label: '1Y', days: 365 },
] as const

const range     = ref<(typeof RANGES)[number]['id']>('6m')
const tableView = ref(false)
// What is switched off on the chart is persisted (settings key trend_hidden), so it survives a
// reload or a restart. Writes are optimistic: the chart reacts at once.
type RowKey = 'feel' | 'plan'
const hiddenLines = computed(() => settingsStore.trendHidden.lines as LineKey[])
const hiddenZones = computed(() => settingsStore.trendHidden.zones)
const hiddenRows  = computed(() => settingsStore.trendHidden.rows as RowKey[])
const toggled = <T>(list: T[], item: T): T[] => (list.includes(item) ? list.filter(x => x !== item) : [...list, item])

const collapsed = computed(() => settingsStore.trendCollapsed)
function toggleCollapsed() { settingsStore.saveTrendCollapsed(!collapsed.value) }

function toggleLine(key: LineKey) {
  settingsStore.saveTrendHidden({ ...settingsStore.trendHidden, lines: toggled(hiddenLines.value, key) })
}
function toggleZone(zone: number) {
  settingsStore.saveTrendHidden({ ...settingsStore.trendHidden, zones: toggled(hiddenZones.value, zone) })
}
function toggleRow(row: RowKey) {
  settingsStore.saveTrendHidden({ ...settingsStore.trendHidden, rows: toggled(hiddenRows.value, row) })
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
  today.value ? formLabel(today.value.form, today.value.fitness, today.value.ridesPerWeek, today.value.historyDays) : ''
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

/** Feel and Plan only get a legend entry once there is something in the range to show. */
const rowItems = computed(() => {
  const from = rangePoints.value[0]?.date ?? isoDate()
  const has = (byDate: Record<string, unknown>) => Object.keys(byDate).some(d => d >= from)
  return ROW_ITEMS.filter(r => (r.key === 'feel' ? has(feelByDate.value) : has(planByDate.value)))
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
.trend-legend-icon { font-size: 0.72rem; color: var(--text-muted); }
.trend-legend-item.is-off .trend-legend-icon { opacity: 0.3; }
/* The form band's key: its two halves, like the shading between the lines. */
.trend-swatch--band {
  background: linear-gradient(135deg, var(--series-fitness) 50%, var(--series-fatigue) 50%);
  opacity: 0.55;
}

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
