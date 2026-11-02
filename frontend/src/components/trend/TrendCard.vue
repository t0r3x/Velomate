<template>
  <section class="dashboard-card glass-panel trend-card" :class="{ 'is-collapsed': collapsed }" id="trend-card">
    <div class="card-header">
      <i class="fa-solid fa-chart-line header-icon"></i>
      <h2>Trend</h2>

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
          @toggle-line="toggleLine" @toggle-zone="toggleZone"
        />

        <p class="trend-note">
          Bars: average daily load per week, by zone (same unit as the lines; fitness is their 42-day average).
          Click a line, a bar or a legend item to hide it; click the legend again to bring it back.
          <template v-if="shortHistory"> Fitness needs about six weeks of rides to settle, so the first weeks read low.</template>
        </p>
      </template>

      <!-- The table twin: every value the charts show, without hovering. -->
      <div v-else class="trend-table-wrap">
        <table class="trend-table">
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Rides</th>
              <th scope="col">Time</th>
              <th v-for="z in ZONE_LABELS" :key="z" scope="col">{{ z.split(' ')[0] }} min</th>
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
import { computed, ref } from 'vue'
import { useActivitiesStore } from '@/stores/activities.store'
import { useProfileStore }    from '@/stores/profile.store'
import { useSettingsStore }   from '@/stores/settings.store'
import {
  buildDailySeries, buildWeeklyZones, formLabel, formExplanation, addDays, FITNESS_DAYS
} from '@/utils/trainingLoad'
import { isoDate } from '@/utils'
import TrendChart from './TrendChart.vue'

type LineKey = 'fitness' | 'fatigue'

const activitiesStore = useActivitiesStore()
const profileStore    = useProfileStore()
const settingsStore   = useSettingsStore()

const LINE_SERIES: { key: LineKey; label: string; color: string }[] = [
  { key: 'fitness', label: 'Fitness', color: 'var(--series-fitness)' },
  { key: 'fatigue', label: 'Fatigue', color: 'var(--series-fatigue)' },
]
const ZONE_LABELS = ['Z1 Recovery', 'Z2 Aerobic', 'Z3 Tempo', 'Z4 Threshold', 'Z5 Anaerobic']
const RANGES = [
  { id: '3m', label: '3M', days: 91 },
  { id: '6m', label: '6M', days: 182 },
  { id: '1y', label: '1Y', days: 365 },
] as const

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
const formWord = computed(() => (today.value ? formLabel(today.value.form, today.value.fitness) : ''))

const rangeDays = computed(() => RANGES.find(r => r.id === range.value)!.days)
const rangePoints = computed(() => daily.value.slice(-rangeDays.value))
const rangeWeeks = computed(() => {
  const from = rangePoints.value[0]?.date ?? isoDate()
  return buildWeeklyZones(activitiesStore.activities, maxHr.value, from)
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
.trend-card { flex: none; margin-bottom: 1.75rem; }
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

.trend-note { margin: 0.35rem 0 0; font-size: 0.72rem; color: var(--text-muted); }
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
  background: var(--surface-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-overlay);
  pointer-events: none;
}
.trend-tooltip .tt-date { margin-bottom: 0.3rem; font-size: 0.7rem; color: var(--text-muted); }
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
