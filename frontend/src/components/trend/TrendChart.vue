<template>
  <div ref="wrap" class="trend-chart" @pointermove="onMove" @pointerleave="hoverIndex = null">
    <svg
      v-if="width > 0"
      :width="width"
      :height="HEIGHT"
      class="trend-svg"
      role="img"
      :aria-label="ariaLabel"
    >
      <defs>
        <!-- Form is the gap between the two lines. Each half of the band is the same polygon
             (fitness forward, fatigue back), clipped to the side of the other line it belongs on. -->
        <clipPath :id="`${uid}-above-fatigue`"><path :d="aboveClip('fatigue')" /></clipPath>
        <clipPath :id="`${uid}-above-fitness`"><path :d="aboveClip('fitness')" /></clipPath>
      </defs>

      <!-- Recessive grid: solid hairlines, never dashed. -->
      <g class="grid">
        <line v-for="t in yTicks" :key="t" :x1="PAD_L" :x2="PAD_L + plotW" :y1="y(t)" :y2="y(t)" />
      </g>
      <g class="axis-text">
        <!-- The unit, so the scale reads as one axis for lines AND bars (both are load per day). -->
        <text x="0" y="9" class="axis-unit">load / day</text>
        <text v-for="t in yTicks" :key="'y' + t" :x="PAD_L - 6" :y="y(t)" text-anchor="end" dominant-baseline="middle">{{ t }}</text>
        <text v-for="m in monthTicks" :key="m.date" :x="m.x" :y="HEIGHT - 4" text-anchor="start">{{ m.label }}</text>
      </g>

      <!-- Weekly bars behind the lines: average daily load that week, stacked by zone. Same
           unit as the lines (fitness is the 42-day average of exactly this), so one axis. -->
      <g v-for="(bar, i) in bars" :key="bar.week.weekStart">
        <path
          v-for="seg in bar.segments" :key="seg.zone"
          :d="seg.d"
          class="seg"
          :class="{ 'is-hovered': hoverWeekIndex === i }"
          :style="{ fill: `var(--z${seg.zone + 1}-color)` }"
          role="button"
          :aria-label="`Hide ${ZONE_LABELS[seg.zone]}`"
          @click.stop="emit('toggleZone', seg.zone)"
        />
      </g>

      <!-- Form band: violet where fitness is above fatigue (fresh), pink where fatigue is above
           fitness (tired). It needs both lines, so it goes when either is hidden. -->
      <g v-if="showBand" class="band">
        <path :d="bandPolygon" :clip-path="`url(#${uid}-above-fatigue)`" :style="{ fill: 'var(--series-fitness)' }" />
        <path :d="bandPolygon" :clip-path="`url(#${uid}-above-fitness)`" :style="{ fill: 'var(--series-fatigue)' }" />
      </g>

      <!-- Lines, and a wide transparent stroke on top that takes the click. -->
      <g v-for="s in visibleLines" :key="s.key">
        <path :d="linePath(s.key)" class="line" :style="{ stroke: s.color }" />
        <path
          :d="linePath(s.key)"
          class="hit"
          role="button"
          :aria-label="`Hide ${s.label}`"
          @click.stop="emit('toggleLine', s.key)"
        />
      </g>

      <!-- End markers + labels, never nudged: on collision only Fitness keeps its label. -->
      <g v-if="hoverIndex === null" class="deco">
        <g v-for="s in endLabelLines" :key="'end' + s.key">
          <circle :cx="x(lastIndex)" :cy="y(valueAt(s.key, lastIndex))" r="4" class="dot" :style="{ fill: s.color }" />
          <text :x="x(lastIndex) + 9" :y="y(valueAt(s.key, lastIndex))" dominant-baseline="middle" class="end-label">
            {{ s.label }} {{ Math.round(valueAt(s.key, lastIndex)) }}
          </text>
        </g>
      </g>

      <!-- Crosshair snaps to the nearest day. Click-through: its dot sits right under the pointer. -->
      <g v-if="hoverIndex !== null" class="deco crosshair">
        <line :x1="x(hoverIndex)" :x2="x(hoverIndex)" :y1="PAD_T" :y2="PLOT_BOTTOM" />
        <circle
          v-for="s in visibleLines" :key="'hv' + s.key"
          :cx="x(hoverIndex)" :cy="y(valueAt(s.key, hoverIndex))" r="4" class="dot" :style="{ fill: s.color }"
        />
        <!-- Each element's own value, beside it, on the side away from the tooltip. -->
        <text
          v-for="s in hoverLabelLines" :key="'hl' + s.key"
          :x="x(hoverIndex) + (tooltipOnRight ? -9 : 9)" :y="y(valueAt(s.key, hoverIndex))"
          :text-anchor="tooltipOnRight ? 'end' : 'start'" dominant-baseline="middle" class="value-label"
        >{{ Math.round(valueAt(s.key, hoverIndex)) }}</text>
        <text
          v-if="hoverBar && hoverBar.visibleLoad >= 0.5"
          :x="hoverBar.center" :y="hoverBar.stackTop - 6"
          text-anchor="middle" class="value-label value-label--bar"
        >{{ Math.round(hoverBar.visibleLoad) }}/day · {{ fmtHours(hoverBar.week.totalMinutes) }}</text>
      </g>
    </svg>

    <!-- Rows on the same time axis: how it felt, and what the coach had planned. HTML rather
         than SVG so the faces and workout icons are the same Font Awesome glyphs as elsewhere. -->
    <div v-if="width > 0 && (feelMarks.length || planMarks.length)" class="trend-rows">
      <div v-if="feelMarks.length" class="trend-row">
        <span class="trend-row-label">Feel</span>
        <i
          v-for="m in feelMarks" :key="'f' + m.date"
          class="fa-regular trend-mark" :class="[FEEL[m.feeling].icon, `feel-${m.feeling}`]"
          :style="{ left: `${m.x}px` }"
          aria-hidden="true"
        ></i>
      </div>
      <div v-if="planMarks.length" class="trend-row">
        <span class="trend-row-label">Plan</span>
        <i
          v-for="m in planMarks" :key="'p' + m.date"
          class="fa-solid trend-mark" :class="[workoutTypeIcon[m.type] ?? 'fa-circle', `wt-${m.type.toLowerCase()}`, `plan-${m.state}`]"
          :style="{ left: `${m.x}px` }"
          aria-hidden="true"
        ></i>
      </div>
      <div v-if="hoverIndex !== null" class="trend-rows-cross" :style="{ left: `${x(hoverIndex)}px` }"></div>
    </div>

    <div v-if="hoverPoint" class="trend-tooltip" :style="tooltipStyle">
      <div class="tt-date">{{ formatDay(hoverPoint.date) }}</div>
      <!-- Form leads the tooltip, set like the Form stat above the chart. -->
      <div class="tt-form">
        <span class="tt-form-label">Form</span>
        <span class="tt-form-value">{{ signed(Math.round(hoverPoint.form)) }}</span>
        <span class="tt-form-word">{{ formLabel(hoverPoint.form, hoverPoint.fitness, hoverPoint.ridesPerWeek) }}</span>
      </div>
      <div v-for="s in LINES" :key="'tt' + s.key" class="tt-row" :class="{ 'is-hidden': hiddenLines.includes(s.key) }">
        <span class="tt-key" :style="{ background: s.color }"></span>
        <strong>{{ Math.round(hoverPoint[s.key]) }}</strong>
        <span>{{ s.label }}</span>
      </div>
      <div class="tt-foot">{{ hoverPoint.rides ? `Ridden this day: load ${hoverPoint.load}` : 'Rest day' }}</div>

      <template v-if="hoverFeel">
        <div class="tt-date tt-section">How it felt</div>
        <div v-if="hoverFeel.checkin" class="tt-row">
          <i class="fa-regular tt-icon" :class="[FEEL[hoverFeel.checkin.feeling].icon, `feel-${hoverFeel.checkin.feeling}`]"></i>
          <strong>{{ hoverFeel.checkin.feeling }}/5</strong>
          <span>Check-in · {{ FEEL[hoverFeel.checkin.feeling].label }}</span>
        </div>
        <!-- Notes start under the icon, at the tooltip's left edge, and use its full width. -->
        <div v-if="hoverFeel.checkin?.note" class="tt-note">"{{ hoverFeel.checkin.note }}"</div>
        <div v-if="hoverFeel.rideFeeling || hoverFeel.rpe" class="tt-row">
          <i v-if="hoverFeel.rideFeeling" class="fa-regular tt-icon" :class="[FEEL[hoverFeel.rideFeeling].icon, `feel-${hoverFeel.rideFeeling}`]"></i>
          <span v-else class="tt-key tt-key--none"></span>
          <strong>{{ hoverFeel.rideFeeling ? `${hoverFeel.rideFeeling}/5` : '–' }}</strong>
          <span>After the ride{{ hoverFeel.rpe ? ` · RPE ${hoverFeel.rpe}` : '' }}</span>
        </div>
      </template>

      <template v-if="hoverPlan">
        <div class="tt-date tt-section">Coach</div>
        <div class="tt-row">
          <i class="fa-solid tt-icon" :class="[workoutTypeIcon[hoverPlan.type] ?? 'fa-circle', `wt-${hoverPlan.type.toLowerCase()}`]"></i>
          <strong>{{ hoverPlan.score != null ? hoverPlan.score : '–' }}</strong>
          <span>{{ workoutTypeLabel[hoverPlan.type] ?? hoverPlan.type }} · {{ PLAN_STATE_LABEL[hoverPlan.state] }}</span>
        </div>
        <div v-if="hoverPlan.note" class="tt-note">{{ hoverPlan.note }}</div>
      </template>

      <template v-if="hoverBar">
        <div class="tt-date tt-section">Week of {{ formatDay(hoverBar.week.weekStart, false) }}</div>
        <div class="tt-row">
          <span class="tt-key tt-key--none"></span>
          <strong>{{ Math.round(hoverBar.loadPerDay) }}</strong>
          <span>load / day · {{ fmtHours(hoverBar.week.totalMinutes) }} · {{ hoverBar.week.rides }} ride{{ hoverBar.week.rides === 1 ? '' : 's' }}</span>
        </div>
        <!-- Minutes per ridden zone on one line: a row per zone made the tooltip taller than the
             chart and hang over the cards below. -->
        <div class="tt-zones">
          <template v-for="(m, z) in hoverBar.week.zoneMinutes" :key="'z' + z">
            <span v-if="Math.round(m) > 0" class="tt-zone" :class="{ 'is-hidden': hiddenZones.includes(z) }">
              <span class="tt-key" :style="{ background: `var(--z${z + 1}-color)` }"></span>{{ ZONE_LABELS[z] }}
              <strong>{{ Math.round(m) }}m</strong>
            </span>
          </template>
        </div>
      </template>
    </div>

    <p v-if="visibleLines.length === 0 && hiddenZones.length === 5" class="trend-empty">
      Everything is hidden. Use the legend to show a series again.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DayPoint, WeekPoint } from '@/utils/trainingLoad'
import { formLabel } from '@/utils/trainingLoad'
import { isoDate, workoutTypeIcon, workoutTypeLabel } from '@/utils'

type LineKey = 'fitness' | 'fatigue'
type SeriesKey = LineKey | 'form'

interface DayFeel {
  checkin?: { feeling: number; note: string | null }
  rideFeeling?: number   // 1-5, post-ride feeling of the day's (longest) ride
  rpe?: number           // 1-10
}
interface DayPlan {
  type: string
  state: 'done' | 'skipped' | 'planned'
  score: number | null
  note: string | null
}

const props = defineProps<{
  points: DayPoint[]
  weeks: WeekPoint[]
  hiddenLines: SeriesKey[]
  hiddenZones: number[]
  feelByDate: Record<string, DayFeel>
  planByDate: Record<string, DayPlan>
}>()
const emit = defineEmits<{ toggleLine: [SeriesKey]; toggleZone: [number] }>()

const LINES: { key: LineKey; label: string; color: string }[] = [
  { key: 'fitness', label: 'Fitness', color: 'var(--series-fitness)' },
  { key: 'fatigue', label: 'Fatigue', color: 'var(--series-fatigue)' },
]
const ZONE_LABELS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5']
/** Same faces and words as the check-in strip and the ride ratings. */
const FEEL: Record<number, { icon: string; label: string }> = {
  1: { icon: 'fa-face-dizzy',      label: 'Exhausted' },
  2: { icon: 'fa-face-tired',      label: 'Tired' },
  3: { icon: 'fa-face-smile',      label: 'Normal' },
  4: { icon: 'fa-face-grin',       label: 'Good' },
  5: { icon: 'fa-face-grin-stars', label: 'Strong' },
}
const PLAN_STATE_LABEL: Record<DayPlan['state'], string> = { done: 'ridden', skipped: 'skipped', planned: 'planned' }

const PAD_L = 30, PAD_R = 92, PAD_T = 20, PAD_B = 20
const plotH       = 162
const PLOT_BOTTOM = PAD_T + plotH
const HEIGHT      = PLOT_BOTTOM + PAD_B
const GAP = 2          // surface gap between stacked segments
const RADIUS = 4       // rounded data end, square at the baseline
const MARK_MIN_GAP = 13 // px between row icons; closer ones collapse into one

// Unique per instance: clip-path ids are document-global.
const uid = `trend-${Math.random().toString(36).slice(2, 8)}`

const wrap  = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(([entry]) => { width.value = Math.floor(entry.contentRect.width) })
  if (wrap.value) observer.observe(wrap.value)
})
onBeforeUnmount(() => observer?.disconnect())

const plotW = computed(() => Math.max(10, width.value - PAD_L - PAD_R))
const lastIndex = computed(() => props.points.length - 1)
const fromDate  = computed(() => props.points[0]?.date ?? isoDate())
const visibleLines = computed(() => LINES.filter(s => !props.hiddenLines.includes(s.key)))
const showBand = computed(() => !props.hiddenLines.includes('form') && visibleLines.value.length === 2)
const valueAt = (key: LineKey, i: number) => props.points[i]?.[key] ?? 0

const dayIndex = (date: string) =>
  Math.round((new Date(date + 'T12:00:00').getTime() - new Date(fromDate.value + 'T12:00:00').getTime()) / 86_400_000)
const x = (i: number) => PAD_L + (props.points.length <= 1 ? 0 : (i / (props.points.length - 1)) * plotW.value)

// ── Weekly bars ──────────────────────────────────────────────────────────────

/**
 * Average daily load per zone for each week. The current week is divided by the days it
 * has had so far, not by 7, or every Monday would show an almost empty bar.
 */
const today = isoDate()
const weekLoads = computed(() => props.weeks.map(week => {
  const elapsed = Math.min(7, Math.max(1, dayIndexFrom(week.weekStart, today) + 1))
  const perZone = week.zoneMinutes.map((m, z) => (m * (z + 1)) / elapsed)
  return { week, perZone, loadPerDay: perZone.reduce((a, b) => a + b, 0) }
}))
function dayIndexFrom(from: string, to: string): number {
  return Math.round((new Date(to + 'T12:00:00').getTime() - new Date(from + 'T12:00:00').getTime()) / 86_400_000)
}
const visibleBarTotal = (perZone: number[]) => perZone.reduce((s, v, z) => s + (props.hiddenZones.includes(z) ? 0 : v), 0)

// ── Scale (one axis for lines and bars: both are load per day) ────────────────

function niceStep(max: number): number {
  const raw = Math.max(max, 1) / 3
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}
const yMax = computed(() => {
  const keys = visibleLines.value.map(s => s.key)
  const lineMax = Math.max(0, ...props.points.flatMap(p => keys.map(k => p[k])))
  const barMax  = Math.max(0, ...weekLoads.value.map(w => visibleBarTotal(w.perZone)))
  const max = Math.max(1, lineMax, barMax)
  const step = niceStep(max)
  return Math.ceil(max / step) * step
})
const yTicks = computed(() => {
  const step = niceStep(yMax.value)
  const ticks: number[] = []
  for (let t = 0; t <= yMax.value + 1e-9; t += step) ticks.push(Math.round(t))
  return ticks
})
const y = (v: number) => PAD_T + plotH - (v / yMax.value) * plotH

// ── Geometry ─────────────────────────────────────────────────────────────────

function linePath(key: LineKey): string {
  return props.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('')
}
/** Fitness forward, fatigue back: the area between the two lines. */
const bandPolygon = computed(() => {
  if (props.points.length < 2) return ''
  const back = [...props.points.keys()].reverse()
    .map(i => `L${x(i).toFixed(1)},${y(props.points[i].fatigue).toFixed(1)}`).join('')
  return `${linePath('fitness')}${back}Z`
})
/** Everything above a line: the clip that keeps only the part of the band on that side of it. */
function aboveClip(key: LineKey): string {
  if (props.points.length < 2) return ''
  const top = (PAD_T - 1).toFixed(1)
  return `${linePath(key)}L${x(lastIndex.value).toFixed(1)},${top}L${x(0).toFixed(1)},${top}Z`
}

/** Rect path with only the top corners rounded (the data end), square at the bottom. */
function segPath(left: number, top: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(RADIUS, h, w / 2) : 0
  const b = top + h
  return `M${left},${b}V${top + r}${r ? `Q${left},${top} ${left + r},${top}` : ''}H${left + w - r}${r ? `Q${left + w},${top} ${left + w},${top + r}` : ''}V${b}Z`
}

const slotW = computed(() => (7 / Math.max(1, props.points.length - 1)) * plotW.value)
const barW  = computed(() => Math.max(2, Math.min(24, slotW.value - 3)))

const bars = computed(() => weekLoads.value.map(w => {
  const start = dayIndex(w.week.weekStart)
  // The first week can start before the range: keep its bar inside the plot.
  const center = Math.min(PAD_L + plotW.value - barW.value / 2, Math.max(PAD_L + barW.value / 2, x(start + 3)))
  const left = center - barW.value / 2
  const visible = w.perZone
    .map((v, zone) => ({ zone, h: (v / yMax.value) * plotH }))
    .filter(s => !props.hiddenZones.includes(s.zone) && s.h > 0.5)
  let bottom = PAD_T + plotH
  const segments = visible.map((s, k) => {
    const isTop = k === visible.length - 1
    const top = bottom - s.h
    // The gap comes off the top of every segment but the highest, so the stack keeps its
    // true height and still stands on the baseline.
    const h = isTop ? s.h : Math.max(0, s.h - GAP)
    const d = segPath(left, isTop ? top : top + GAP, barW.value, h, isTop)
    bottom = top
    return { zone: s.zone, d }
  })
  return { week: w.week, loadPerDay: w.loadPerDay, start, segments, center, stackTop: bottom, visibleLoad: visibleBarTotal(w.perZone) }
}))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthTicks = computed(() => {
  const ticks: { date: string; x: number; label: string }[] = []
  let lastX = -Infinity
  props.points.forEach((p, i) => {
    if (!p.date.endsWith('-01')) return
    if (x(i) - lastX < 34 || x(i) > PAD_L + plotW.value - 20) return
    lastX = x(i)
    ticks.push({ date: p.date, x: x(i), label: MONTHS[parseInt(p.date.slice(5, 7), 10) - 1] })
  })
  return ticks
})

const endLabelLines = computed(() => {
  const ys = visibleLines.value.map(s => y(valueAt(s.key, lastIndex.value)))
  if (ys.length < 2 || Math.abs(ys[0] - ys[1]) >= 14) return visibleLines.value
  return visibleLines.value.filter(s => s.key === 'fitness')
})

// ── Feel and plan rows ───────────────────────────────────────────────────────

/**
 * Icons that would overlap collapse into one. For feel the worse day wins: a bad day is the
 * one worth seeing. The tooltip still has every day.
 */
function placeMarks<T extends { x: number }>(marks: T[], keepSecond: (kept: T, next: T) => boolean): T[] {
  const out: T[] = []
  for (const m of marks) {
    const last = out[out.length - 1]
    if (last && m.x - last.x < MARK_MIN_GAP) {
      if (keepSecond(last, m)) out[out.length - 1] = m
      continue
    }
    out.push(m)
  }
  return out
}
const inRange = (date: string) => date >= fromDate.value && date <= (props.points[lastIndex.value]?.date ?? today)

const feelMarks = computed(() => {
  const marks = Object.entries(props.feelByDate)
    .filter(([date, f]) => inRange(date) && (f.checkin || f.rideFeeling))
    .map(([date, f]) => ({ date, x: x(dayIndex(date)), feeling: (f.checkin?.feeling ?? f.rideFeeling)! }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return placeMarks(marks, (kept, next) => next.feeling < kept.feeling)
})
const planMarks = computed(() => {
  const marks = Object.entries(props.planByDate)
    .filter(([date]) => inRange(date))
    .map(([date, p]) => ({ date, x: x(dayIndex(date)), type: p.type, state: p.state }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return placeMarks(marks, () => false)
})

// ── Hover ────────────────────────────────────────────────────────────────────

const hoverIndex = ref<number | null>(null)
function onMove(e: PointerEvent) {
  if (props.points.length === 0) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const i = Math.round(((e.clientX - rect.left - PAD_L) / plotW.value) * (props.points.length - 1))
  hoverIndex.value = Math.min(props.points.length - 1, Math.max(0, i))
}
const hoverPoint = computed(() => (hoverIndex.value === null ? null : props.points[hoverIndex.value]))
const hoverFeel  = computed(() => (hoverPoint.value ? props.feelByDate[hoverPoint.value.date] ?? null : null))
const hoverPlan  = computed(() => (hoverPoint.value ? props.planByDate[hoverPoint.value.date] ?? null : null))
/** The week the hovered day falls in: its bar lifts, and its numbers join the tooltip. */
const hoverWeekIndex = computed(() => {
  if (hoverIndex.value === null) return null
  const i = bars.value.findIndex(b => hoverIndex.value! >= b.start && hoverIndex.value! < b.start + 7)
  return i < 0 ? null : i
})
const hoverBar = computed(() => (hoverWeekIndex.value === null ? null : bars.value[hoverWeekIndex.value]))
const tooltipOnRight = computed(() => hoverIndex.value !== null && x(hoverIndex.value) <= width.value - 240)
const tooltipStyle = computed(() => {
  if (hoverIndex.value === null) return {}
  const px = x(hoverIndex.value)
  return tooltipOnRight.value ? { left: `${px + 12}px`, top: '0px' } : { right: `${width.value - px + 12}px`, top: '0px' }
})
/** Same no-nudge rule as the end labels: when the two values sit on top of each other, Fitness keeps its label. */
const hoverLabelLines = computed(() => {
  if (hoverIndex.value === null) return []
  const i = hoverIndex.value
  const ys = visibleLines.value.map(s => y(valueAt(s.key, i)))
  if (ys.length < 2 || Math.abs(ys[0] - ys[1]) >= 12) return visibleLines.value
  return visibleLines.value.filter(s => s.key === 'fitness')
})

const formatDay = (d: string, weekday = true) =>
  new Date(d + 'T12:00:00').toLocaleDateString('en-GB', weekday
    ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
const fmtHours = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`

const ariaLabel = computed(() => {
  const last = props.points[lastIndex.value]
  if (!last) return 'Fitness, fatigue and weekly load: no data'
  return `Fitness and fatigue over ${props.points.length} days, the gap between them shaded as form, with weekly load by heart-rate zone behind them. Today: fitness ${Math.round(last.fitness)}, fatigue ${Math.round(last.fatigue)}, form ${Math.round(last.form)}.`
})
</script>

<style scoped>
.trend-chart { position: relative; width: 100%; }
.trend-svg { display: block; overflow: visible; }
.grid line { stroke: var(--hairline); stroke-width: 1; }
.axis-text text { fill: var(--text-muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
.seg { cursor: pointer; opacity: 0.55; transition: opacity var(--transition-fast); }
.seg.is-hovered { opacity: 0.85; }
/* The band and the visible strokes sit on top of the bars but must not take their clicks.
   Only .hit (lines) and .seg (bars) are clickable. */
.band path { opacity: 0.16; pointer-events: none; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; pointer-events: none; }
.hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; pointer-events: stroke; }
.dot { stroke: var(--panel-bg); stroke-width: 2; }
.end-label { fill: var(--text-secondary); font-size: 0.72rem; font-weight: 500; }
.axis-unit { font-size: 0.62rem; letter-spacing: 0.06em; }
/* Hover values: text tokens with a surface halo, so they stay legible over bars and lines. */
.value-label {
  fill: var(--text-primary);
  font-size: 0.72rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  paint-order: stroke;
  stroke: var(--panel-bg);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.value-label--bar { fill: var(--text-secondary); font-weight: 500; }
.deco { pointer-events: none; }
.crosshair line { stroke: var(--hairline-strong); stroke-width: 1; }

/* Feel and plan rows: one line of icons each, under the month labels. */
.trend-rows { position: relative; margin-top: 0.15rem; }
.trend-row { position: relative; height: 22px; }
.trend-row-label {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.trend-mark {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.78rem;
  pointer-events: none;
}
.trend-mark.plan-done { color: var(--wt); }
.trend-mark.plan-skipped { color: var(--wt); opacity: 0.3; }
.trend-mark.plan-planned { color: var(--wt); opacity: 0.55; }
.trend-rows-cross {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--hairline-strong);
  pointer-events: none;
}

.trend-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  margin: 0; font-size: 0.8rem; color: var(--text-muted); pointer-events: none;
}
</style>
