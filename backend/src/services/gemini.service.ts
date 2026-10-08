import axios from 'axios';
import {
  getSetting,
  upsertRecommendation,
  getStoredRecommendation,
  getStoredActivities,
  getStoredProfile,
  getStoredAnalysis,
  getCurrentFreeSuggestion,
  getFreeSuggestionHistory,
  getRecentCheckins,
  getUnscoredFreeSuggestions,
  insertFreeSuggestion,
  setFreeSuggestionScore,
  PlanEntry,
  PlanChange,
  FreeSuggestion
} from './database.service';
import { localDate, toRpe, toFeeling, USER_TZ, APP_NAME } from '../utils';
import logger from '../logger';

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Forward-looking plan length in days — kept wide enough that a lagged regen still covers "next week" with real data. */
const PLAN_WINDOW_DAYS = 14;

/**
 * How many leading days of the plan get a full step-by-step workout structure.
 *
 * Only this window is ever pushed to Garmin (syncAndScheduleWorkouts covers today..today+6),
 * and the plan regenerates daily — so a second-week day is always re-planned, with a fresh
 * structure, before it can be ridden. Generating its steps now produces output the app
 * throws away, and it is exactly that waste that drives the response into MAX_TOKENS
 * truncation. Asking for structures on the first week only roughly halves the output
 * without losing anything the athlete can act on.
 */
const STRUCTURED_WINDOW_DAYS = 7;

export const getGeminiKey = (): string | null => getSetting('gemini_api_key') || null;

export const maskKey = (key: string): string =>
  key.length > 6 ? key.slice(0, 6) + '***' : '***';

// ── Model ID ──────────────────────────────────────────────────────────────────
// The model is user-supplied (the settings form allows a free-text ID so brand-new or
// paid-tier models can be used without an app update) and gets interpolated straight into
// the request path: /v1beta/models/{model}:generateContent. It therefore has to be
// validated, not just non-empty — a value containing '/', '?' or '..' would rewrite the
// endpoint rather than name a model.

/** Fallback model — what the app uses when nothing has been chosen yet. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * Tidy a user-entered model ID: trim, drop the 'models/' prefix Google's own docs and
 * ListModels responses show (people paste it verbatim), and lowercase it.
 */
export const normalizeModelId = (raw: string): string =>
  raw.trim().replace(/^models\//i, '').toLowerCase();

/**
 * Lowercase alphanumeric segments joined by dots or hyphens — the shape every Gemini and
 * Gemma model ID takes (gemini-3.8-flash, gemini-2.5-flash-lite, gemini-3.1-pro-preview,
 * gemma-3-27b-it). Deliberately not a hardcoded allowlist: the whole point is that a model
 * released after this build can still be entered.
 */
export const isValidModelId = (id: string): boolean =>
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id);

/** The model to call, falling back to the default if the stored value is missing/unusable. */
export const getGeminiModel = (): string => {
  const stored = normalizeModelId(getSetting('gemini_model') || '');
  return stored && isValidModelId(stored) ? stored : DEFAULT_GEMINI_MODEL;
};

/**
 * Thinking settings for a model, or undefined to leave the API default alone.
 *
 * Gemini 3+ thinks dynamically at a high level unless told otherwise, and on this prompt
 * that was 20-30s of hidden reasoning per plan (flash-lite answered the same prompt in
 * 2-5s). Thinking tokens also count against maxOutputTokens, so a long think could
 * trigger a MAX_TOKENS retry and double the wait. 'low' is accepted by every Gemini 3
 * tier, Pro included. Lite models already default to minimal thinking — forcing 'low'
 * would make them slower — and older families (2.x: thinkingBudget, Gemma: none) reject
 * thinkingLevel outright, so both are left untouched. The model is free text, hence a
 * pattern rather than a list.
 */
const thinkingConfigFor = (model: string): { thinkingLevel: string } | undefined => {
  const major = parseInt(model.match(/^gemini-(\d+)/)?.[1] ?? '0', 10);
  if (major < 3 || model.includes('lite')) return undefined;
  return { thinkingLevel: 'low' };
};

/**
 * Statuses worth retrying: 429 is a rate limit, 500/503/504 are Google-side and transient —
 * 503 ("model overloaded") is routine for a freshly released model and usually clears
 * within seconds. Anything else (400 bad request, 403 bad key, 404 unknown model) will
 * fail the same way every time, so it is thrown straight away.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);
const MAX_GEMINI_ATTEMPTS = 4;

/**
 * POST a generateContent request, retrying transient failures. A 429 honours Retry-After
 * (quota exhaustion sends a long one); a 5xx backs off 3s, 6s, 12s, because an overloaded
 * model needs longer to recover than a rate window does.
 */
const callGemini = async (label: string, model: string, key: string, body: object): Promise<any> => {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        body
      );
      logUsage(label, startedAt, response);
      return response;
    } catch (err: any) {
      const status = err.response?.status;
      const reason = err.response?.data?.error?.message ?? err.message;
      if (!RETRYABLE_STATUSES.has(status) || attempt >= MAX_GEMINI_ATTEMPTS) {
        logger.warn(`[Gemini] ${label} failed (${status ?? 'no response'}) after ${attempt} attempt(s): ${reason}`);
        throw err;
      }
      const retryAfterSec = parseInt(err.response.headers?.['retry-after'] ?? '0', 10);
      const waitMs = status === 429 && retryAfterSec > 0
        ? retryAfterSec * 1000
        : (status === 429 ? 2000 : 3000) * 2 ** (attempt - 1);
      logger.warn(`[Gemini] ${label}: ${status} (${reason}) — retry ${attempt}/${MAX_GEMINI_ATTEMPTS - 1} in ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
};

/** Duration + token split per call, so a slow generation shows where the time went. */
const logUsage = (label: string, startedAt: number, response: any): void => {
  const u = response?.data?.usageMetadata ?? {};
  logger.info(
    `[Gemini] ${label} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ` +
    `prompt: ${u.promptTokenCount ?? '?'} (cached: ${u.cachedContentTokenCount ?? 0}) | ` +
    `thoughts: ${u.thoughtsTokenCount ?? 0} | output: ${u.candidatesTokenCount ?? '?'} tokens`
  );
};

// ── Zone helpers ──────────────────────────────────────────────────────────────

/** Guard against short/malformed zone arrays from a stored activity row. */
const parseZones = (raw: any): number[] | null =>
  Array.isArray(raw) && raw.length >= 5 ? raw : null;

/** Format zone seconds array as a readable string for the prompt, e.g. "z1=8m z2=32m z3=6m z4=14m z5=3m" */
const fmtZones = (zones: number[]): string =>
  zones.map((s, i) => `z${i + 1}=${Math.round(s / 60)}m`).join(' ');

/**
 * One line per ride instead of JSON.stringify(..., null, 2).
 * Pretty-printed JSON spent a large share of the prompt on braces and indentation that carry
 * no meaning for the model, and a flat table is easier to scan across 21 rows than nested
 * objects. Keep the column order in sync with ACTIVITY_DATA_NOTES, which tells the model how
 * to read it.
 */
const formatActivityLines = (acts: any[]): string => {
  if (acts.length === 0) return '(no rides recorded in this window)';
  return acts.map(a => {
    const zones = a.zonesMin
      ? `z1=${a.zonesMin.z1} z2=${a.zonesMin.z2} z3=${a.zonesMin.z3} z4=${a.zonesMin.z4} z5=${a.zonesMin.z5}`
      : 'zones=n/a';
    const feedback = [
      a.rpe     != null ? `rpe=${a.rpe}`         : null,
      a.feeling != null ? `feeling=${a.feeling}` : null
    ].filter(Boolean).join(' ') || 'unrated';
    return `${a.date} | ${a.durationMin}min | ${a.avgHr}bpm | ${a.distKm}km | ${zones} | ${feedback}`;
  }).join('\n');
};

/**
 * Pre-computed training load.
 *
 * The model was being asked to derive all of this from the ride list on every call: summing
 * zone minutes across three weeks, and date arithmetic to work out how long ago the last hard
 * effort was. Both are things language models get wrong silently, and the answers drive every
 * decision downstream. Computing them here costs ~50 tokens and makes them exact.
 */
const buildTrainingLoadBlock = (): string => {
  const today = localDate();
  const dayOffset = (n: number): string => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return localDate(d);
  };

  const acts   = getStoredActivities().filter(a => a.startTime);   // newest first
  const dateOf = (a: any): string => a.startTime.slice(0, 10);
  const fmt    = (min: number): string => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;

  const windowStats = (fromOffset: number, toOffset: number) => {
    const from = dayOffset(fromOffset);
    const to   = dayOffset(toOffset);
    const inWindow = acts.filter(a => dateOf(a) >= from && dateOf(a) <= to);
    return {
      rides:   inWindow.length,
      minutes: inWindow.reduce((s, a) => s + (a.durationMinutes || 0), 0),
      z3plus:  Math.round(inWindow.reduce((s, a) => {
        const z = parseZones(a.timeInZones);
        return s + (z ? (z[2] + z[3] + z[4]) / 60 : 0);
      }, 0))
    };
  };

  const weeks = [windowStats(-6, 0), windowStats(-13, -7), windowStats(-20, -14), windowStats(-27, -21)];

  // Average only across the 7-day blocks the stored history actually reaches. Averaging a
  // real week against three empty ones would report a fraction of the athlete's true load
  // as if it were fact, and the model has no way to tell the difference.
  const oldestRide  = acts.length ? dateOf(acts[acts.length - 1]) : null;
  const historyDays = oldestRide
    ? Math.round((new Date(today + 'T12:00:00').getTime() - new Date(oldestRide + 'T12:00:00').getTime()) / 86_400_000)
    : 0;
  const blocksCovered = Math.max(1, Math.min(weeks.length, Math.ceil((historyDays + 1) / 7)));
  const avgPerWeek = Math.round(
    weeks.slice(0, blocksCovered).reduce((s, w) => s + w.minutes, 0) / blocksCovered
  );

  // "Hard" = at least 10 minutes above threshold, which is what actually needs recovering
  // from — a ride that merely touched Z4 for a minute on a climb does not count.
  const lastHard = acts.find(a => {
    const z = parseZones(a.timeInZones);
    return z && (z[3] + z[4]) / 60 >= 10;
  });
  const daysSinceHard = lastHard
    ? Math.round((new Date(today + 'T12:00:00').getTime() - new Date(dateOf(lastHard) + 'T12:00:00').getTime()) / 86_400_000)
    : null;

  const rideDates = new Set(acts.map(dateOf));
  const lastRide  = acts[0] ? dateOf(acts[0]) : null;
  let streak = 0;
  if (lastRide) {
    const cursor = new Date(lastRide + 'T12:00:00');
    while (rideDates.has(localDate(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  // Start at yesterday: today is not over, so its lack of a ride proves nothing.
  let lastRestDay: string | null = null;
  for (let i = -1; i >= -28; i--) {
    const d = dayOffset(i);
    if (!rideDates.has(d)) { lastRestDay = d; break; }
  }

  const withZones = acts.filter(a => parseZones(a.timeInZones)).length;

  return `TRAINING LOAD (pre-computed from the full ride history — use these figures, do not re-derive them):
- Last 7 days: ${weeks[0].rides} ride(s), ${fmt(weeks[0].minutes)} total, ${weeks[0].z3plus} min in Z3+
- Preceding 7-day blocks (most recent first): ${weeks.slice(1).map(w => `${fmt(w.minutes)} (${w.rides} rides)`).join(', ')}
- ${blocksCovered}-week average: ${fmt(avgPerWeek)} per week${blocksCovered < weeks.length ? ` (only ${historyDays} days of ride history are stored — do not read this as a long-term baseline)` : ''}
- Days since last hard effort (>=10 min in Z4/Z5): ${daysSinceHard ?? 'no such effort in stored history'}
- Consecutive training days: ${streak}${lastRide ? ` (most recent ride ${lastRide})` : ''}
- Most recent day without a ride: ${lastRestDay ?? 'none in the last 28 days'}
- Zone data present for ${withZones} of ${acts.length} stored rides${withZones < acts.length ? ' — the Z3+ and Z4/Z5 figures above count only those' : ''}

`;
};

/**
 * How far back check-in history is shown to the model.
 *
 * A window in DAYS, not a row count. Checking in is optional and many athletes will do it
 * sporadically, so "the last 10 rows" could reach back months and present a bad day from
 * five weeks ago directly under a heading the model is told to weigh above everything else.
 */
const CHECKIN_HISTORY_DAYS = 14;

const FEELING_WORDS: Record<number, string> = {
  1: 'exhausted', 2: 'tired', 3: 'normal', 4: 'good', 5: 'strong'
};

/**
 * The athlete's own reports, newest first, with today marked.
 * Empty string when they have never checked in — an empty header would read as evidence
 * of nothing being wrong, which is exactly the inference CHECKIN_NOTES forbids.
 */
const buildCheckinBlock = (): string => {
  const today  = localDate();
  const cutoff = new Date(today + 'T12:00:00');
  cutoff.setDate(cutoff.getDate() - CHECKIN_HISTORY_DAYS);
  const cutoffStr = localDate(cutoff);

  // Fetch generously, then bound by date — anything older is history, not current state.
  const checkins = getRecentCheckins(CHECKIN_HISTORY_DAYS).filter(c => c.date >= cutoffStr);
  if (checkins.length === 0) return '';
  const lines = checkins.map(c => {
    const dow  = new Date(c.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
    const when = c.date === today ? `TODAY (${c.date})` : `${c.date} (${dow})`;
    return `- ${when}: ${c.feeling}/5 ${FEELING_WORDS[c.feeling] ?? ''}${c.note ? ` — "${c.note}"` : ''}`;
  });

  return `DAILY CHECK-INS (self-reported, independent of any ride):\n${lines.join('\n')}\n\n`;
};

/**
 * Which future days changed workout type in this regeneration.
 *
 * Computed here rather than taken from the model, because a plan that rearranges itself
 * daily is only trustworthy if the list of what moved is exact. The model is asked for the
 * reason (changeNote) and never for the facts.
 *
 * Only forward, still-planned days count: a day that has passed cannot be acted on, and a
 * status flip (planned -> completed) is something the athlete did, not a change of plan.
 */
const diffPlans = (previous: PlanEntry[], next: PlanEntry[]): PlanChange[] => {
  const today      = localDate();
  const prevByDate = new Map(previous.map(e => [e.date, e]));

  return next.reduce<PlanChange[]>((changes, entry) => {
    if (entry.date < today) return changes;
    const was = prevByDate.get(entry.date);
    if (!was || was.status !== 'planned' || was.type === entry.type) return changes;
    changes.push({ date: entry.date, from: was.type, to: entry.type });
    return changes;
  }, []);
};

/**
 * The load assessment from the plan being revised.
 *
 * PLAN STABILITY condition (d) — "the athlete's fatigue assessment has changed from the
 * previous plan" — was unevaluable without this: the previous assessment was never in the
 * prompt, so the model could only guess at whether it had changed.
 */
const buildPreviousAssessmentBlock = (): string => {
  const prev = getStoredRecommendation()?.loadAssessment;
  if (!prev || typeof prev !== 'object') return '';
  return `PREVIOUS ASSESSMENT (your own, from the plan you are now revising):
- Fatigue: ${prev.fatigue ?? 'unknown'} | Load trend: ${prev.weeklyLoadTrend ?? 'unknown'}${prev.insight ? `
- "${prev.insight}"` : ''}
PLAN STABILITY condition (d) depends on whether your new assessment differs from this one.

`;
};


// ── Completion / skip detection ───────────────────────────────────────────────

/**
 * Returns true when an activity name looks like a Velomate structured workout.
 * Garmin prefixes the location when recording a scheduled workout, e.g.
 * "Tilburg - Velomate Long Ride" → contains "velomate".
 */
const isAppActivity = (name: string): boolean =>
  (name || '').toLowerCase().includes(APP_NAME.toLowerCase());

/**
 * Binary activity match: marks any planned entry as 'completed' if a Garmin activity
 * exists on that date. Quality scoring is delegated entirely to the AI in
 * generateRecommendation() — executionScore (0-100) and executionNote come back in the
 * same Gemini call that regenerates the weekly plan.
 *
 * Activity selection per date (priority order):
 *   1. Activity whose name contains "Velomate" (Garmin appended workout name on record)
 *   2. Longest activity on that date (fallback)
 *
 * Including today (<=) means a same-day sync immediately marks the workout as done.
 */
export const classifyCompletedEntries = (
  plan: PlanEntry[]
): Array<{ date: string; status: 'completed' }> => {
  const activities = getStoredActivities();

  // Best activity per date: prefer Velomate-named, then longest
  const actMap = new Map<string, any>();
  activities
    .filter(a => a.startTime)
    .forEach(a => {
      const date     = a.startTime.slice(0, 10);
      const existing = actMap.get(date);
      const aIsUB    = isAppActivity(a.name);
      const exIsUB   = existing ? isAppActivity(existing.name) : false;

      if (!existing) {
        actMap.set(date, a);
      } else if (aIsUB && !exIsUB) {
        actMap.set(date, a);
      } else if (aIsUB === exIsUB && a.durationMinutes > existing.durationMinutes) {
        actMap.set(date, a);
      }
    });

  const today = localDate();

  // Rest is deliberately excluded: riding on a planned rest day does not "complete" it, and
  // marking it so hands the AI a Rest entry flagged NEEDS SCORING — a case the rubric has no
  // band for, producing a meaningless score that then feeds straight back into planning.
  // The ride itself is already visible to the model in RECENT ACTIVITIES.
  return plan
    .filter(e => e.status === 'planned' && e.type !== 'Rest' && e.date <= today && actMap.has(e.date))
    .map(e => ({ date: e.date, status: 'completed' as const }));
};

/** Returns dates of plan entries that are 'planned', in the past, and NOT matched by any Garmin activity. */
export const detectAutoSkippedEntries = (plan: PlanEntry[]): string[] => {
  const activities = getStoredActivities();
  const activityDates = new Set(
    activities
      .filter(a => a.startTime)
      .map(a => a.startTime.slice(0, 10))
  );

  const today = localDate();

  return plan
    .filter(e => e.status === 'planned' && e.type !== 'Rest' && e.date < today && !activityDates.has(e.date))
    .map(e => e.date);
};

// ── Prompt builder ────────────────────────────────────────────────────────────

interface PauseContext {
  pausedSince: string
  pauseReason?: string
  activitiesCount: number
}

// ── Shared prompt blocks ──────────────────────────────────────────────────────
// Both the 14-day plan prompt and the free-training single-suggestion prompt describe
// the same athlete, the same workout vocabulary and the same scoring rubric — only the
// planning horizon and the output schema differ. Keeping these blocks in one place means
// a coaching tweak lands in both modes instead of silently drifting apart.

/** How to read the activity JSON — zone units, rpe/feeling scales and how to weight them. */
const ACTIVITY_DATA_NOTES = `How to read RECENT ACTIVITIES — one line per ride, columns in this order:
  date | duration | average HR | distance | minutes per HR zone | athlete rating
Zone figures are minutes spent in each Garmin HR zone (z1=lowest, z5=highest intensity), from Garmin's default 5-zone system based on max HR — boundaries may differ slightly from the athlete's custom LTHR zones. "zones=n/a" means Garmin supplied no zone breakdown for that ride; "unrated" means the athlete answered neither post-ride prompt.
rpe = athlete-reported perceived exertion after the ride (1=very easy, 5=moderate, 10=maximal effort). Absent = not rated.
feeling = athlete-reported post-ride feeling (1=exhausted/very tired, 2=tired, 3=normal, 4=good, 5=strong/excellent). Absent = not rated.
When rpe and feeling are present, weight them heavily — they are direct athlete feedback on recovery state. High rpe (≥8) or low feeling (≤2) after a session signals real fatigue even if HR data looks moderate.`;

/**
 * How to weigh a daily check-in.
 *
 * Deliberately strong: a check-in is the athlete speaking directly, which is the whole
 * premise of the app. Without this the model treats it as one more data point next to HR
 * and volume, and quietly lets the numbers win.
 *
 * Mode-aware because the two modes can act on it in completely different ways. The planned
 * week can turn today into a Rest day; free mode has no day to rest and no Rest type, so
 * the same signal has to come out as a gentler session held back by coachNote. Saying
 * "make it Rest" to free mode would be an instruction it is forbidden to follow.
 */
const buildCheckinNotes = (freeMode: boolean): string => `DAILY CHECK-INS — how to weigh them:
A check-in is the athlete telling you directly how they feel, on a day that may or may not contain a ride.
It is the most direct signal you get, and it OUTRANKS anything you would infer from heart rate or volume.
Scale: 1=exhausted, 2=tired, 3=normal, 4=good, 5=strong. A free-text note may explain why.
- A check-in marked TODAY is their current recovery state${freeMode
  ? ', and it decides BOTH what the next session should be and how long they should wait before riding it. At 1 or 2, choose a gentler session than the load figures alone would justify, set priority to "low", and say plainly in coachNote that they should not ride it yet and what has to be true first.'
  : ". At 1 or 2, lower today's intensity or make today a Rest day, regardless of what the load figures suggest."}
  Name the check-in in your reason, so the athlete can see you listened.
- Two or more consecutive days at 1-2 are genuine accumulated fatigue even when the ride data looks unremarkable. ${freeMode ? 'Hold the next session back further — not merely make it lighter.' : 'Ease off the coming days, not only today.'}
- A 4 or 5 is permission to go ahead as planned. It is not an instruction to add load.
- Days without a check-in carry NO information. Never read a missing day as either good or bad.
- Notes often mention things outside cycling — sleep, work, illness, another sport. Take them at face value: they are usually the reason the numbers look the way they do. Velomate deliberately does not import non-cycling activities, so a note is the only way you will hear about them.`;

/** The six workout types and their step templates. Caller supplies the header line. */
const WORKOUT_TYPE_GUIDELINES = `Sprint (requires neuromuscular recovery — use athlete's own history to judge adequate rest):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-8 sets of [Sprint [Run] 20-45 sec Z5 → Recovery [Recovery] 180-300 sec Z1]
  Cool-down [Cooldown]: 480-720 sec Z1
  Short maximal bursts — trains neuromuscular power. Fewer/shorter when less fresh.
  Recovery window: judge this from the TRAINING LOAD figures. At 5 or more rides per week with no
  negative recovery signals, 24-36h between hard sessions is this athlete's established pattern.
  At 4 or fewer rides per week, allow 48h+ before a sprint session.

VO2Max (requires good recovery — sustained Z5 is more demanding than Sprint):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-5 sets of [Work [Run] 180-300 sec Z5 → Recovery [Recovery] 180-240 sec Z1]
  Cool-down [Cooldown]: 480-600 sec Z1
  Sustained Z5 blocks raise the aerobic ceiling. Do NOT schedule after consecutive hard days without at least one easy session in between.
  Fewer sets when less fresh; 5 sets only when athlete is progressing well and compliance is high.

Threshold (when moderately fresh — core aerobic progression):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 2-4 sets of [Work [Run] 360-720 sec Z4 → Recovery [Recovery] 180-300 sec Z1/Z2]
  Cool-down [Cooldown]: 480-600 sec Z1
  Reduce interval count/duration when fatigued; increase when athlete is adapting well.
  If execution scores for Threshold sessions are consistently < 60, the athlete is cutting intervals short — reduce duration.

Tempo (ideal for moderate fatigue — sweet spot, Z3):
  Warm-up [WarmUp]: 480-600 sec Z2
  Intervals: 2-3 sets of [Work [Run] 900-1800 sec Z3 → Recovery [Recovery] 300-480 sec Z1/Z2]
  Cool-down [Cooldown]: 480 sec Z1
  Long Z3 blocks build fatigue resistance and muscular endurance. Perfect when athlete is too tired for Z4 Threshold but too fresh for Z2 only.

LongRide (safe even when moderately fatigued):
  Single steady block [Run]: 1800-14400 sec Z2
  Scale to the athlete's averageRideDurationMinutes — a beginner averaging 40 min rides should get a 50-70 min long ride, not 2+ hours.
  A pro averaging 90 min rides may go 2.5-4 hours. Shorter when tired, longer when fresh.

Rest: no structure needed — set structure to null.`;

/**
 * How to pitch the load: match what this athlete is actually doing and feeling.
 *
 * Deliberately NOT framed as progression. Velomate follows the athlete rather than a
 * training goal — an easier week in response to poor recovery signals is a correct answer,
 * not a failure to progress. The old "PROGRESSION GOAL … then progress from there" heading
 * biased the model toward adding load whenever nothing was visibly wrong, which is the
 * opposite of the product. Shared by both modes, and free mode has no schedule to build
 * progressive overload across in the first place.
 */
const CALIBRATION_GUIDELINES = `CALIBRATION: Pitch every session at what this athlete is currently doing and feeling. Progression is not a goal in itself — following their signals is.
  Training pyramid — use it to judge where a session sits, NOT as a ladder to climb: Rest → LongRide (Z2 base) → Tempo (Z3 fatigue resistance) → Threshold (Z4 aerobic power) → VO2Max (Z5 aerobic ceiling) → Sprint (Z5+ neuromuscular)

- If the athlete's history already shows regular Sprint/Threshold/VO2Max work: keep working at that level — do NOT reset to base.
  - Rule: Do NOT prescribe high-intensity interval sessions (Tempo, Threshold, VO2Max, Sprint) if the recent history is purely aerobic — meaning no ride shows more than roughly 5 minutes of combined Z4+Z5 time — unless their specific goals require race preparation.
  - Only stack VO2Max + Threshold + Sprint in the same period when the athlete is demonstrably managing that load (history shows it, rpe/feeling are fine).
  - If the athlete is already at a consistently high load with no negative signals, the right answer is to hold there. Adding volume or intensity because things are going well is not the goal.
  - Raise intensity or frequency only when recovery signals are good AND current load sits below what this athlete has already shown they can handle.
  - When recovery signals say back off, back off — a lighter week than the last one is a correct answer, not a failure. Do not treat reducing load as something to apologise for or recover from quickly.
If execution scores are consistently below 60, ease the load — the athlete is not absorbing what they are being given.`;

/** The 0-100 execution-quality bands. Identical in both modes so scores stay comparable. */
const SCORING_RUBRIC = `Score on a 0-100 scale based on zone distribution, duration, rpe, and feeling:
  90-100 : Textbook — target zone time met or exceeded, full duration, correct intensity
  75-89  : Good — mostly on target, minor deviations (slightly short, small zone drift)
  60-74  : Partial — significant reduction (e.g. 1-2 fewer intervals, ~30% short)
  40-59  : Poor — major deviations, wrong intensity, substantial shortfall
  0-39   : Mismatch — activity bears little resemblance to the planned workout
HEART RATE LAGS EFFORT — do not penalise a session for that:
For work intervals shorter than about 3 minutes, heart rate physically cannot reach the target
zone for much of the interval. All Sprint work falls in this category, as does the opening minute
of every VO2Max interval. Zone time therefore UNDERSTATES a correctly executed short-interval
session. Score those on total ride duration and on how many intervals were completed, and never
mark a Sprint session down for missing Z5 minutes. Zone time is a trustworthy signal only for
blocks of 3 minutes or longer — Tempo, Threshold and LongRide.

Worked examples — anchor your scale to these:
  Planned Threshold 3x8 min Z4; rode 54 min, z4=25, rpe=7, feeling=3      -> 92 (full session, target Z4 time met)
  Planned Threshold 3x8 min Z4; rode 41 min, z4=14, rpe=9, feeling=2      -> 66 (roughly two intervals of three, and it cost them)
  Planned VO2Max 4x4 min Z5;    rode 35 min, z1=20 z2=14 z3=1, no Z5      -> 25 (an easy ride, not the prescribed session)
  Planned Sprint 6x30s Z5;      rode 48 min, z1=30 z2=14 z3=2 z4=2 z5=0  -> 88 (HR cannot reach Z5 in 30s — duration and shape match the session)
Be honest — do not inflate scores. Reference specific data in the note (1 sentence, e.g. "12 min in Z4 vs target 24 min — significant shortfall").`;

/** Recent rides shaped for the prompt: zone minutes, rpe and feeling where available. */
const buildRecentActivities = (activityDays: number): any[] => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - activityDays);
  return getStoredActivities()
    .filter(a => a.startTime && new Date(a.startTime) >= cutoff)
    .map(a => {
      const zones = parseZones(a.timeInZones);
      const base: any = {
        date:        a.startTime?.slice(0, 10) ?? '',
        durationMin: a.durationMinutes ?? 0,
        avgHr:       a.averageHr ?? 0,
        distKm:      a.distanceKm ?? 0
      };
      if (zones) {
        // Convert seconds → minutes for readability in the prompt
        base.zonesMin = {
          z1: Math.round(zones[0] / 60),
          z2: Math.round(zones[1] / 60),
          z3: Math.round(zones[2] / 60),
          z4: Math.round(zones[3] / 60),
          z5: Math.round(zones[4] / 60)
        };
      }
      // Include perceived exertion and post-ride feeling when available — these are
      // subjective athlete signals that are strong indicators of recovery state.
      // DB stores raw Garmin 0–100 values; toRpe/toFeeling convert to human-readable scale.
      if (a.perceivedExertion != null)    base.rpe     = toRpe(a.perceivedExertion);
      if (a.feelingAfterExercise != null) base.feeling = toFeeling(a.feelingAfterExercise);
      return base;
    });
};

/** "Z1: 90-120 | Z2: 121-148 | …" for the HR PROFILE block. */
const buildZoneString = (profile: any): string =>
  profile?.zones
    ? Object.entries(profile.zones)
        .map(([k, z]: [string, any]) => `${k.toUpperCase()}: ${z.min}-${z.max}`)
        .join(' | ')
    : 'Not configured';

/**
 * Preferred long-ride days + free-text goals, as prompt lines.
 * `freeMode` drops the day-scheduling line: a single dateless suggestion has no calendar to
 * place a long ride on, so telling the model to treat Saturday as a "primary candidate" is
 * an instruction it cannot act on. The UI says the same thing under those day chips.
 */
const buildPreferenceLines = (freeMode = false): { prefLine: string; goalsBlock: string } => {
  // Support multiple preferred days (new plural key) with fallback to old singular key
  const rawDays = getSetting('preferred_long_ride_days') || getSetting('preferred_long_ride_day') || '';
  const preferredDays = rawDays ? rawDays.split(',').map(d => d.trim()).filter(Boolean) : [];
  const prefLine = freeMode
    ? `- The athlete chooses the day themselves, so day-of-week preferences do not apply here.`
    : preferredDays.length > 0
    ? `- Preferred Long Ride day(s): ${preferredDays.join(', ')} — Treat these as primary candidates for scheduling 'LongRide'. You are not required to schedule a ride on every preferred day. Prioritize optimal recovery; it is perfectly acceptable to schedule a Rest day on a preferred day if athletically justified.`
    : `- No preferred Long Ride days specified.`;

  const rawGoals = getSetting('user_goals') || '';
  const goalsBlock = rawGoals.trim()
    ? `\nATHLETE GOALS & PREFERENCES:\n${rawGoals.trim()}\nNote: treat the above as secondary context. Reflect it ${freeMode ? 'in the session you prescribe' : 'in the plan'} where appropriate (e.g. event timing, ${freeMode ? 'session length' : 'day preferences, duration constraints'}), but always prioritise objective load data, HR signals, and compliance history over these stated preferences.\n\n`
    : '';

  return { prefLine, goalsBlock };
};

/** Pause history block — empty string when training was never paused. */
const buildPauseBlock = (pauseContext: PauseContext | undefined, today: string): string => {
  if (!pauseContext) return '';
  const pauseDays = Math.round(
    (new Date(today).getTime() - new Date(pauseContext.pausedSince).getTime()) / 86_400_000
  );
  return `TRAINING PAUSE:\nThe athlete paused training from ${pauseContext.pausedSince} to ${today} (${pauseDays} day${pauseDays !== 1 ? 's' : ''})${pauseContext.pauseReason ? ` — reason: ${pauseContext.pauseReason}` : ''}.\n${pauseContext.activitiesCount > 0 ? `They recorded ${pauseContext.activitiesCount} ride(s) during the pause period.` : 'No rides were recorded during the pause period.'}\nConsider the duration, reason, and the athlete's prior training history to judge whether and how much re-adaptation is needed before resuming normal load.\n\n`;
};

/**
 * Everything in the plan prompt that never changes: the coaching role, how to read the data,
 * the workout vocabulary, the scoring rubric, the output schema and the rules.
 *
 * It lives in systemInstruction rather than in the user turn for two reasons. Gemini adheres
 * to instructions placed there more reliably than to the same text buried in a long user
 * message; and because it is byte-identical on every call, keeping it out of the per-call
 * text is what makes a shared prefix — and therefore caching — possible at all. The user turn
 * now carries only this athlete, today.
 */
const PLAN_SYSTEM_INSTRUCTION = `You are a professional cycling coach AI specializing in heart-rate based training.
Analyze the athlete's data and generate an adaptive training plan with exact, personalised workout structures.
Calibrate training volume and intensity to the athlete's demonstrated capacity from their recent history.
An athlete who consistently trains at high frequency and intensity has established that as their sustainable baseline — match that load.
Only reduce volume when recovery signals (rpe ≥ 8, feeling ≤ 2, HR drift upward over successive rides) indicate genuine fatigue accumulation.
High training volume alone is not a reason to prescribe rest — look at the quality signals.

${ACTIVITY_DATA_NOTES}

${buildCheckinNotes(false)}

WORKOUT TYPE GUIDELINES — you decide the exact structure for each day based on athlete load:

${WORKOUT_TYPE_GUIDELINES}

${CALIBRATION_GUIDELINES}

EXECUTION SCORING — for every entry marked "NEEDS SCORING" in the PREVIOUS PLAN COMPLIANCE block:
${SCORING_RUBRIC}
Use your scoring assessment DIRECTLY when deciding load, recovery, and session types for the new plan.

Where to put scores:
- NEEDS SCORING entries dated before TODAY: add to executionScores[] with date, score, note.
- Today's entry (weeklyPlan[0]) if its status was 'completed' (shown as NEEDS SCORING): set executionScore + executionNote inside weeklyPlan[0], NOT in executionScores[].
- Already SCORED entries: output their existing score in executionScores[] unchanged.
- Planned / skipped / Rest entries: executionScore = null, executionNote = null.

OUTPUT: Respond ONLY with this exact JSON schema, emitting the keys in exactly this order:
{
  "executionScores": [
    {
      "date": "YYYY-MM-DD",
      "score": <integer 0-100>,
      "note": "<1-sentence rationale>"
    }
  ],
  "loadAssessment": {
    "fatigue": "low|moderate|high",
    "weeklyLoadTrend": "increasing|stable|decreasing",
    "insight": "1-2 sentences about current training state and progression direction"
  },
  "today": {
    "type": "Sprint|VO2Max|Threshold|Tempo|LongRide|Rest",
    "reason": "2-3 sentences referencing specific data (last activity date, HR trend, etc.)",
    "priority": "high|medium|low"
  },
  "weeklyPlan": [
    {
      "date": "YYYY-MM-DD",
      "type": "Sprint|VO2Max|Threshold|Tempo|LongRide|Rest",
      "reason": "1 sentence",
      "executionScore": <integer 0-100 or null>,
      "executionNote": "<1-sentence scoring rationale or null>",
      "structure": {
        "totalMinutes": <sum of all durationSec values divided by 60, rounded to integer>,
        "steps": [
          { "stepType": "WarmUp|Run|Recovery|Cooldown", "durationSec": <positive integer seconds>, "zone": "z1|z2|z3|z4|z5", "label": "<short label>" }
        ]
      }
    }
  ],
  "changeNote": "1-2 sentences on what you changed relative to EXISTING SCHEDULED WORKOUTS and which signal drove it — name the signal (a check-in, an execution score, an rpe or feeling, a skip). If you kept every scheduled day exactly as it was, say that plainly instead. Never claim a change you did not make.",
  "nextWeekFocus": "1-2 sentences on the DIRECTION the second week (weeklyPlan[7..13]) is heading in — what ties those days together and why. Write it as a direction that will be revised as new rides and feedback arrive, not as a commitment."
}

THE KEY ORDER IS NOT COSMETIC — assess before you plan:
- Score the past first (executionScores), because those scores are the evidence.
- Then write loadAssessment as your actual judgement of the current state, based on that evidence and the TRAINING LOAD figures.
- Only then plan. today and weeklyPlan must FOLLOW from loadAssessment. Do not write a plan first and justify it afterwards.
- changeNote comes last for the opposite reason: it describes a plan you have already written, so you can only report it honestly once weeklyPlan exists.

STRICT RULES:
- PLAN STABILITY: If an EXISTING SCHEDULED WORKOUTS block is present in the athlete data, you MUST keep the same workout type for each date UNLESS at least one of these conditions applies:
    (a) A new execution score below 60 reveals the athlete cannot absorb that intensity
    (b) A skip or auto-skip has disrupted the recovery balance for that day
    (c) A recent feeling ≤2 or rpe ≥8 directly contradicts the planned intensity
    (d) Your loadAssessment differs from the one shown in PREVIOUS ASSESSMENT
  If none of these apply, output the same type. You may still adjust the workout structure (interval count, duration) based on new data.
- STRUCTURE WINDOW: only weeklyPlan[0..${STRUCTURED_WINDOW_DAYS - 1}] carry a "structure". weeklyPlan[${STRUCTURED_WINDOW_DAYS}..${PLAN_WINDOW_DAYS - 1}] MUST have "structure": null — the second week is a forward outline, and every one of its days is re-planned (and given its structure then) before it can be ridden. Give those entries date, type, reason and null scores only.
- For Rest days: set "structure": null
- For entries whose status is completed, skipped, or auto-skipped: set "structure": null (done — no workout to sync)
- executionScores[]: include ALL NEEDS SCORING entries dated before TODAY + already-SCORED entries. Empty array if none.
- weeklyPlan[0].executionScore: integer 0-100 ONLY if today's entry is completed and needs scoring. All others: null.
- weeklyPlan[0].executionNote: matching 1-sentence string if scored. All others: null.
- stepType MUST be one of: WarmUp, Run, Recovery, Cooldown
- zone MUST be one of: z1, z2, z3, z4, z5
- durationSec MUST be a positive integer (minimum 20 for sprint intervals)
- weeklyPlan MUST contain exactly ${PLAN_WINDOW_DAYS} entries, starting from the TODAY date given in the athlete data, one per consecutive calendar day
- changeNote is the athlete's explanation for why their plan looks different today than it did yesterday. They see the exact list of changed days alongside it, so an invented change is immediately visible as a lie. Write it for them, not about yourself: "Thursday drops to Tempo because this morning's check-in reported 2/5", not "I have adjusted the plan".
- nextWeekFocus describes weeklyPlan[7..13] AS A WHOLE (the training theme/rationale) — it is not a day-by-day recap, those already have their own "reason"
- totalMinutes MUST equal Math.round(sum(durationSec) / 60)
- COMPACT STRUCTURES: Sprint max 6 interval sets, Threshold max 3 sets, VO2Max max 4 sets. Step labels must be ≤ 4 words. reason fields: 1 short sentence only.`;

const buildPrompt = (previousPlan?: PlanEntry[], pauseContext?: PauseContext, activityDays = 21, pinnedTodayType?: string): string => {
  const today     = localDate();
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: USER_TZ });

  // Recent activities window — reduced automatically on MAX_TOKENS retry
  const allActivities    = getStoredActivities();
  const recentActivities = buildRecentActivities(activityDays);

  // HR profile + zone string
  const profile    = getStoredProfile();
  const zoneString = buildZoneString(profile);

  // Analysis
  const analysis = getStoredAnalysis();

  // Previous plan compliance block
  let prevBlock = '';
  if (previousPlan && previousPlan.length > 0) {
    const actMap = new Map<string, any>();
    allActivities
      .filter(a => a.startTime)
      .forEach(a => {
        const date = a.startTime.slice(0, 10);
        const existing = actMap.get(date);
        if (!existing || a.durationMinutes > existing.durationMinutes) {
          actMap.set(date, a);
        }
      });

    // Only include non-'planned' entries — future planned entries (tomorrow onwards)
    // are being regenerated and add no compliance signal.
    // This also prevents 14-day history pollution when the stored plan has scored history prepended.
    const complianceEntries = previousPlan.filter(e => e.status !== 'planned');
    if (complianceEntries.length === 0) {
      // No completed/skipped entries yet — omit the block entirely
      prevBlock = '';
    } else {
    const lines = complianceEntries.map(e => {
      const dow = new Date(e.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });

      if (e.status === 'completed') {
        const act = actMap.get(e.date);
        let actDetail = '';
        if (act) {
          actDetail = `${act.durationMinutes} min, avg ${act.averageHr} bpm`;
          const zones = parseZones(act.timeInZones);
          if (zones) actDetail += `, zones: ${fmtZones(zones)}`;
          if (act.perceivedExertion != null)    actDetail += `, rpe=${toRpe(act.perceivedExertion)}`;
          if (act.feelingAfterExercise != null) actDetail += `, feeling=${toFeeling(act.feelingAfterExercise)}`;
        }

        if (e.executionScore != null) {
          // Already scored — show existing score, do NOT re-score
          return `- ${e.date} (${dow}): ${e.type} → SCORED ${e.executionScore}/100${actDetail ? ` — ${actDetail}` : ''}${e.executionNote ? ` — "${e.executionNote}"` : ''}`;
        } else {
          // Needs AI scoring — include full activity data
          return `- ${e.date} (${dow}): ${e.type} → NEEDS SCORING${actDetail ? ` — activity: ${actDetail}` : ' — no activity data'}`;
        }
      }

      if (e.status === 'skipped')      return `- ${e.date} (${dow}): ${e.type} → SKIPPED (explicit)`;
      if (e.status === 'auto-skipped') return `- ${e.date} (${dow}): ${e.type} → AUTO-SKIPPED`;

      // Unreachable: complianceEntries filters out 'planned' entries
      return `- ${e.date} (${dow}): ${e.type} → ${e.status}`;
    });

    prevBlock = `PREVIOUS PLAN COMPLIANCE:\n${lines.join('\n')}\n\n`;
    } // end else (complianceEntries.length > 0)
  }

  // Future planned workouts — shown to the AI so it keeps them stable
  let plannedBlock = '';
  if (previousPlan && previousPlan.length > 0) {
    const futurePlanned = previousPlan.filter(e => e.status === 'planned' && e.date > today);
    const lines = futurePlanned.map(e => {
      const dow = new Date(e.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      return `- ${e.date} (${dow}): ${e.type}`;
    });
    if (pinnedTodayType) {
      const todayDow = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      lines.unshift(`- ${today} (${todayDow}): ${pinnedTodayType} ← RESCHEDULED BY USER — MANDATORY`);
    }
    if (lines.length > 0) {
      plannedBlock = `EXISTING SCHEDULED WORKOUTS (keep unless explicitly justified — see the PLAN STABILITY rule):\n${lines.join('\n')}\n\n`;
    }
  } else if (pinnedTodayType) {
    const todayDow = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
    plannedBlock = `EXISTING SCHEDULED WORKOUTS (keep unless explicitly justified — see the PLAN STABILITY rule):\n- ${today} (${todayDow}): ${pinnedTodayType} ← RESCHEDULED BY USER — MANDATORY\n\n`;
  }

  const pinnedTodayBlock = pinnedTodayType
    ? `CRITICAL — USER RESCHEDULED TODAY: The athlete explicitly moved a workout to today. Today (${today}) MUST be "${pinnedTodayType}". Output "${pinnedTodayType}" as today.type and weeklyPlan[0].type — this is a direct user instruction, not a suggestion.\n\n`
    : '';

  const { prefLine, goalsBlock } = buildPreferenceLines();
  const pauseBlock = buildPauseBlock(pauseContext, today);

  // A pinned type is stated twice on purpose — once up front, and once as the last thing the
  // model reads before answering. It is the only instruction here that overrides the data.
  const pinnedTail = pinnedTodayType
    ? `\nREMINDER — PINNED TODAY: today (${today}) MUST be "${pinnedTodayType}" in both today.type and weeklyPlan[0].type. No exceptions — not fatigue, not load assessment.\n`
    : '';

  return `TODAY: ${today} (${dayOfWeek})

ATHLETE PREFERENCES:
${prefLine}${goalsBlock}

${pauseBlock}${buildPreviousAssessmentBlock()}${prevBlock}${pinnedTodayBlock}${plannedBlock}HR PROFILE:
- Max HR: ${profile?.maxHr ?? 'unknown'} bpm | LTHR: ${profile?.lthr ?? 'unknown'} bpm
- Zones: ${zoneString}

TRAINING ANALYSIS (last 90 days):
- Total rides: ${analysis?.totalCyclingRides ?? 0} | Peak HR recorded: ${analysis?.maxRecordedHr ?? 0} bpm
- Average ride duration: ${analysis?.averageRideDurationMinutes ?? 0} min

${buildCheckinBlock()}${buildTrainingLoadBlock()}RECENT ACTIVITIES (last ${activityDays} days):
${formatActivityLines(recentActivities)}
${pinnedTail}`;
};

// ── Main generation function ──────────────────────────────────────────────────

/**
 * At most one plan generation runs at a time.
 *
 * Six paths can start one — manual refresh, skip, reschedule, resume, activity sync and the
 * hourly auto-check — and most of them fire without awaiting. An ordinary app launch alone
 * triggers two (the backend's startup auto-check and the dashboard's own Garmin sync), which
 * means two full Gemini calls that both write recommendation.id=1. A second caller joins the
 * run already in flight instead of starting its own.
 */
let planGenerationInFlight: Promise<any> | null = null;

/** True while a plan or free suggestion is being generated — lets the API tell the UI the truth. */
export const isGenerationInFlight = (): boolean =>
  planGenerationInFlight !== null || freeGenerationInFlight !== null;

export const generateRecommendation = (previousPlan?: PlanEntry[], pauseContext?: PauseContext, pinnedTodayType?: string): Promise<any> => {
  if (planGenerationInFlight) {
    logger.info('[Gemini] Plan generation already in flight — joining it instead of starting a second');
    return planGenerationInFlight;
  }
  planGenerationInFlight = _generatePlan(previousPlan, pauseContext, pinnedTodayType)
    .finally(() => { planGenerationInFlight = null; });
  return planGenerationInFlight;
};

const _generatePlan = async (previousPlan?: PlanEntry[], pauseContext?: PauseContext, pinnedTodayType?: string): Promise<any> => {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_KEY_NOT_CONFIGURED');

  // Retry with progressively smaller activity windows if Gemini truncates the response
  const ACTIVITY_WINDOWS = [21, 14, 10];

  for (const activityDays of ACTIVITY_WINDOWS) {
    const result = await _attemptGeneration(previousPlan, pauseContext, activityDays, pinnedTodayType);
    if (result.truncated) {
      logger.warn(`[Gemini] Response truncated (MAX_TOKENS) with ${activityDays}-day window — retrying with fewer activities`);
      continue;
    }
    return result.value;
  }
  throw new Error('[Gemini] Response truncated even with minimal activity window (10 days). Try a model with higher output limits.');
};

const _attemptGeneration = async (
  previousPlan: PlanEntry[] | undefined,
  pauseContext: PauseContext | undefined,
  activityDays: number,
  pinnedTodayType?: string
): Promise<{ truncated: true } | { truncated: false; value: any }> => {
  const key = getGeminiKey()!;
  const prompt = buildPrompt(previousPlan, pauseContext, activityDays, pinnedTodayType);

  // ── Log outgoing prompt ───────────────────────────────────────────────────────
  logger.info('\n' + '═'.repeat(72));
  logger.info('[Gemini] ── PROMPT SENT ─────────────────────────────────────────────');
  logger.info('─'.repeat(72));
  logger.info(prompt);
  logger.info('─'.repeat(72) + '\n');

  const model = getGeminiModel();
  logger.info(`[Gemini] Model: ${model} | system instruction: ${PLAN_SYSTEM_INSTRUCTION.length} chars (static, not repeated here)`);

  const response = await callGemini('Plan generation', model, key, {
    systemInstruction: { parts: [{ text: PLAN_SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // Plan stability is an explicit goal of the prompt; 0.4 sampled against it.
      temperature: 0.2,
      maxOutputTokens: 16384,
      thinkingConfig: thinkingConfigFor(model)
    }
  });

  const candidate  = response.data?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts || [];
  const rawText: string = parts.map((p: any) => p.text ?? '').join('');

  const finishReason = candidate?.finishReason ?? 'unknown';

  // ── Log raw response ──────────────────────────────────────────────────────────
  logger.info('[Gemini] ── RAW RESPONSE ────────────────────────────────────────────');
  logger.info(`[Gemini] finishReason: ${finishReason} | length: ${rawText.length} chars | activityDays: ${activityDays}`);
  logger.info('─'.repeat(72));
  logger.info(rawText ?? '(empty)');
  logger.info('─'.repeat(72) + '\n');

  if (!rawText) throw new Error('Empty response from Gemini API');

  // Response was cut short — signal to the caller to retry with less context
  if (finishReason === 'MAX_TOKENS') {
    return { truncated: true };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON (${rawText.length} chars, finishReason: ${finishReason}):\n${rawText}`);
  }

  // Validate required fields
  const validTypes = ['Sprint', 'VO2Max', 'Threshold', 'Tempo', 'LongRide', 'Rest'];
  if (!validTypes.includes(parsed?.today?.type)) {
    throw new Error(`Invalid today.type: ${parsed?.today?.type}`);
  }
  if (!Array.isArray(parsed?.weeklyPlan) || parsed.weeklyPlan.length !== PLAN_WINDOW_DAYS) {
    throw new Error(`weeklyPlan must be an array of ${PLAN_WINDOW_DAYS} entries, got ${parsed?.weeklyPlan?.length}`);
  }

  // Status + score preservation reads the plan as it stands RIGHT NOW, not the snapshot this
  // call opened with. The Gemini round trip takes many seconds, and a skip, a reschedule or a
  // completed-ride classification committed in the meantime would otherwise be silently
  // overwritten by the stale snapshot. `previousPlan` remains the prompt's view of the world;
  // the database is the authority on what actually happened.
  const livePlan     = getStoredRecommendation()?.weeklyPlan as PlanEntry[] | undefined;
  const statusSource = livePlan ?? previousPlan ?? [];
  const prevEntryMap = new Map<string, PlanEntry>();
  statusSource.forEach(e => prevEntryMap.set(e.date, e));

  // Merge into the new plan window:
  //  - Preserve non-planned statuses (completed/skipped/auto-skipped)
  //  - Preserve existing executionScores (never re-score an already-scored entry)
  //  - Apply new AI-generated scores for entries that just became completed (today's dates in new plan)
  const weeklyPlan: PlanEntry[] = parsed.weeklyPlan.map((e: any) => {
    const prev          = prevEntryMap.get(e.date);
    const status        = (prev && prev.status !== 'planned') ? prev.status : 'planned';
    const alreadyScored = prev?.executionScore != null;

    const structure = e.structure && Array.isArray(e.structure.steps) ? {
      totalMinutes: Math.round(
        e.structure.steps.reduce((s: number, st: any) => s + (st.durationSec || 0), 0) / 60
      ),
      steps: e.structure.steps
    } : null;

    return {
      date:           e.date,
      type:           e.type,
      reason:         e.reason,
      status,
      executionScore: alreadyScored
                        ? prev!.executionScore!
                        : (typeof e.executionScore === 'number' ? e.executionScore : null),
      executionNote:  alreadyScored
                        ? (prev!.executionNote ?? null)
                        : (typeof e.executionNote === 'string' ? e.executionNote : null),
      structure
    };
  });

  // ── Merge AI execution scores with past entries (scored history) ───────────
  // The AI returns executionScores[] for entries marked "NEEDS SCORING" in the compliance block.
  // Those dates are BEFORE today and NOT in the new weeklyPlan window — we keep them as
  // scored history prepended to the plan so that future AI calls have full execution context.
  const newPlanDates = new Set(weeklyPlan.map(e => e.date));
  const scoredMap    = new Map<string, { score: number; note: string }>();
  if (Array.isArray(parsed.executionScores)) {
    for (const s of parsed.executionScores) {
      if (s.date && typeof s.score === 'number') {
        scoredMap.set(s.date, { score: s.score, note: typeof s.note === 'string' ? s.note : '' });
      }
    }
  }
  if (scoredMap.size > 0) {
    logger.info(`[Gemini] executionScores received for: ${[...scoredMap.keys()].join(', ')}`);
  }

  // Keep ALL past entries from the last 14 days (any status), with AI scores applied where
  // scored. Rest days never reach 'completed' (no Garmin activity to match against a rest
  // day), so filtering to status === 'completed' here would silently drop every past Rest
  // day once it scrolls out of the forward window — invisible with a rolling "today onwards"
  // display, but a permanent, refresh-proof gap once the frontend renders a fixed calendar
  // week that includes days before today.
  const histCutoff = new Date();
  histCutoff.setDate(histCutoff.getDate() - 14);
  const histCutoffStr = localDate(histCutoff);

  const pastEntries: PlanEntry[] = statusSource
    .filter(e => !newPlanDates.has(e.date) && e.date >= histCutoffStr)
    .map(e => {
      const s = scoredMap.get(e.date);
      return {
        ...e,
        executionScore: e.executionScore != null ? e.executionScore : (s ? s.score : null),
        executionNote:  e.executionNote  != null ? e.executionNote  : (s ? s.note  : null),
        structure:      null   // past entries: no workout structure needed
      };
    });

  // Fallback: if the AI put today's score in executionScores[] instead of weeklyPlan[0],
  // apply it here. This handles AI non-compliance with the schema instruction.
  if (weeklyPlan.length > 0 && weeklyPlan[0].status === 'completed' && weeklyPlan[0].executionScore == null) {
    const todayScore = scoredMap.get(weeklyPlan[0].date);
    if (todayScore) {
      weeklyPlan[0].executionScore = todayScore.score;
      weeklyPlan[0].executionNote  = todayScore.note || null;
      logger.info(`[Gemini] executionScores[] fallback applied for today (${weeklyPlan[0].date}): score=${todayScore.score}`);
    }
  }

  // Full plan = past entries (any status, last 14 days) + new forward window (today onwards)
  const fullPlan = [...pastEntries, ...weeklyPlan];

  // weeklyPlan[0] is the authoritative source for today — always sync root fields to it
  // so the "Today's Recommendation" chip never diverges from the week grid.
  const todayEntry = weeklyPlan[0];
  // Diffed against the plan as the athlete last saw it, which is what statusSource holds.
  const changedEntries = diffPlans(statusSource, weeklyPlan);
  if (changedEntries.length > 0) {
    logger.info(`[Gemini] Plan changes: ${changedEntries.map(c => `${c.date} ${c.from}->${c.to}`).join(', ')}`);
  } else {
    logger.info('[Gemini] Plan changes: none — every scheduled day kept its type');
  }

  upsertRecommendation({
    workoutType:   todayEntry?.type    ?? parsed.today.type,
    reason:        todayEntry?.reason  ?? parsed.today.reason,
    priority:      parsed.today.priority,
    weeklyPlan:    fullPlan,
    nextWeekFocus: typeof parsed.nextWeekFocus === 'string' ? parsed.nextWeekFocus : null,
    changeNote:    typeof parsed.changeNote === 'string' ? parsed.changeNote : null,
    changedEntries,
    loadAssessment: parsed.loadAssessment
  });

  // ── Log parsed result summary ─────────────────────────────────────────────────
  logger.info('[Gemini] ── PARSED RESULT ───────────────────────────────────────────');
  logger.info(`  Today:    ${parsed.today.type} (priority: ${parsed.today.priority})`);
  logger.info(`  Reason:   ${parsed.today.reason}`);
  logger.info(`  Fatigue:  ${parsed.loadAssessment?.fatigue}  |  Trend: ${parsed.loadAssessment?.weeklyLoadTrend}`);
  logger.info(`  Insight:  ${parsed.loadAssessment?.insight}`);
  if (pastEntries.length > 0) {
    logger.info(`  Past entries (${pastEntries.length}):`);
    pastEntries.forEach(e =>
      logger.info(`    ${e.date}  ${e.type.padEnd(10)}  [${e.status}]  score=${e.executionScore ?? 'null'}  ${e.executionNote ?? ''}`)
    );
  }
  logger.info(`  New plan (${weeklyPlan.length} entries):`);
  weeklyPlan.forEach(e =>
    logger.info(`    ${e.date}  ${e.type.padEnd(10)}  [${e.status}]  ${e.reason}`)
  );
  logger.info(`  Next week focus: ${parsed.nextWeekFocus ?? '(none)'}`);
  logger.info('═'.repeat(72) + '\n');

  return { truncated: false, value: getStoredRecommendation() };
};

// ── Free training mode ────────────────────────────────────────────────────────
// Free mode swaps the 14-day calendar for a single, dateless "next workout" suggestion.
// The athlete rides it whenever it suits them, so the AI gets no schedule to plan against —
// instead it answers one question: given everything up to now, what is the best next session?
// It reuses the same athlete context, workout vocabulary and scoring rubric as the plan
// prompt, so a rider switching modes keeps the same coaching voice and the same score scale.

/** How many past suggestions are shown to the AI as compliance context. */
const FREE_HISTORY_DEPTH = 8;

export const isFreeTrainingMode = (): boolean => getSetting('free_training_mode') === '1';

/**
 * Finds the ride that answers a synced free suggestion: the first activity on or after the
 * date it was scheduled for. Free mode has no fixed day, so unlike the plan's strict
 * same-date match this deliberately looks forward — the athlete may sync on Monday and
 * ride on Wednesday, and that is still the session they were given.
 * Prefers a Velomate-named activity on that date, else the longest ride of that day.
 */
export const findRideForFreeSuggestion = (syncedForDate: string): any | null => {
  const today = localDate();
  const candidates = getStoredActivities()
    .filter(a => a.startTime)
    .filter(a => {
      const d = a.startTime.slice(0, 10);
      return d >= syncedForDate && d <= today;
    })
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (candidates.length === 0) return null;

  // Restrict to the earliest day that has a ride, then pick the best ride of that day.
  const firstDate = candidates[0].startTime.slice(0, 10);
  const sameDay   = candidates.filter(a => a.startTime.slice(0, 10) === firstDate);
  return sameDay.reduce((best, a) => {
    const aIsApp    = isAppActivity(a.name);
    const bestIsApp = isAppActivity(best.name);
    if (aIsApp && !bestIsApp) return a;
    if (aIsApp === bestIsApp && a.durationMinutes > best.durationMinutes) return a;
    return best;
  }, sameDay[0]);
};

/** One compliance line per past suggestion, mirroring the plan prompt's format. */
const buildFreeHistoryBlock = (
  history: FreeSuggestion[],
  current: FreeSuggestion | null
): string => {
  const activityById = new Map(getStoredActivities().map(a => [String(a.activityId), a]));

  const describeRide = (s: FreeSuggestion): string => {
    const act = s.completedActivityId ? activityById.get(String(s.completedActivityId)) : null;
    if (!act) return '';
    let detail = `${act.durationMinutes} min, avg ${act.averageHr} bpm`;
    const zones = parseZones(act.timeInZones);
    if (zones) detail += `, zones: ${fmtZones(zones)}`;
    if (act.perceivedExertion != null)    detail += `, rpe=${toRpe(act.perceivedExertion)}`;
    if (act.feelingAfterExercise != null) detail += `, feeling=${toFeeling(act.feelingAfterExercise)}`;
    return detail;
  };

  const line = (s: FreeSuggestion): string => {
    const suggested = `${s.workoutType} — suggested ${s.generatedAt.slice(0, 10)}`;
    const synced    = s.syncedForDate ? `, synced for ${s.syncedForDate}` : ', never synced';

    if (s.status === 'completed') {
      const ride = describeRide(s);
      const when = s.completedDate ? `, ridden ${s.completedDate}` : '';
      if (s.executionScore != null) {
        return `- [id ${s.id}] ${suggested}${synced}${when} → SCORED ${s.executionScore}/100${ride ? ` — ${ride}` : ''}${s.executionNote ? ` — "${s.executionNote}"` : ''}`;
      }
      return `- [id ${s.id}] ${suggested}${synced}${when} → NEEDS SCORING${ride ? ` — activity: ${ride}` : ' — no activity data'}`;
    }
    if (s.status === 'dismissed')  return `- [id ${s.id}] ${suggested}${synced} → NOT RIDDEN (athlete moved on without doing it)`;
    if (s.status === 'superseded') return `- [id ${s.id}] ${suggested}${synced} → REPLACED (athlete asked for a different suggestion)`;
    if (s.status === 'expired')    return `- [id ${s.id}] ${suggested}${synced} → SUPERSEDED automatically (a newer read of the same data replaced it — the athlete never rejected it, so draw no compliance conclusion from this line)`;
    return `- [id ${s.id}] ${suggested}${synced} → ${s.status.toUpperCase()}`;
  };

  const lines: string[] = [];
  if (current) {
    const syncState = current.syncedForDate
      ? `synced to their watch for ${current.syncedForDate} but not yet ridden`
      : 'not yet synced or ridden';
    lines.push(`- [id ${current.id}] ${current.workoutType} — suggested ${current.generatedAt.slice(0, 10)} → STILL OPEN (${syncState})`);
  }
  history.forEach(s => lines.push(line(s)));

  if (lines.length === 0) return '';
  return `PREVIOUS SUGGESTIONS (most recent first — this is the athlete's compliance history in free mode):\n${lines.join('\n')}\n\n`;
};

/**
 * The free-mode counterpart of PLAN_SYSTEM_INSTRUCTION: same coaching voice, same workout
 * vocabulary, same scoring scale — a different job (one session, no calendar) and a
 * different schema. Static for the same reason: adherence and a cacheable prefix.
 */
const FREE_SYSTEM_INSTRUCTION = `You are a professional cycling coach AI specializing in heart-rate based training.
This athlete trains in FREE TRAINING MODE: they have no fixed weekly schedule and ride when it suits them.
Your job is to prescribe exactly ONE workout — the single best next session for them right now — not a multi-day plan.
Calibrate training volume and intensity to the athlete's demonstrated capacity from their recent history.
An athlete who consistently trains at high frequency and intensity has established that as their sustainable baseline — match that load.
Only reduce volume when recovery signals (rpe ≥ 8, feeling ≤ 2, HR drift upward over successive rides) indicate genuine fatigue accumulation.
High training volume alone is not a reason to prescribe rest — look at the quality signals.

IMPORTANT — no fixed date: the athlete decides when to ride this session. Do NOT assume it happens today.
Because you cannot pick the day for them, use coachNote to tell them WHEN this session makes sense
(how recovered they should be, how long after their last hard effort, what to do instead if they feel worse than expected).

${ACTIVITY_DATA_NOTES}

${buildCheckinNotes(true)}

WORKOUT TYPE GUIDELINES — you decide the exact structure based on athlete load:

${WORKOUT_TYPE_GUIDELINES}

${CALIBRATION_GUIDELINES}

EXECUTION SCORING — for every past suggestion marked "NEEDS SCORING" in PREVIOUS SUGGESTIONS:
${SCORING_RUBRIC}
Use your scoring assessment DIRECTLY when deciding the type and load of the next suggestion.
A suggestion marked NOT RIDDEN or REPLACED carries no score, and one marked SUPERSEDED automatically says nothing about the athlete at all — but repeated non-compliance with a given
workout type is a signal it does not fit this athlete right now, so prefer something they will actually do.

OUTPUT: Respond ONLY with this exact JSON schema, emitting the keys in exactly this order:
{
  "executionScores": [
    {
      "suggestionId": <integer id from the PREVIOUS SUGGESTIONS list>,
      "score": <integer 0-100>,
      "note": "<1-sentence rationale>"
    }
  ],
  "loadAssessment": {
    "fatigue": "low|moderate|high",
    "weeklyLoadTrend": "increasing|stable|decreasing",
    "insight": "1-2 sentences about current training state and progression direction"
  },
  "suggestion": {
    "type": "Sprint|VO2Max|Threshold|Tempo|LongRide",
    "reason": "2-3 sentences referencing specific data (last activity date, HR trend, recent scores)",
    "priority": "high|medium|low",
    "coachNote": "1-2 sentences on WHEN to ride this and how to adjust if recovery is worse than expected",
    "structure": {
      "totalMinutes": <sum of all durationSec values divided by 60, rounded to integer>,
      "steps": [
        { "stepType": "WarmUp|Run|Recovery|Cooldown", "durationSec": <positive integer seconds>, "zone": "z1|z2|z3|z4|z5", "label": "<short label>" }
      ]
    }
  }
}

THE KEY ORDER IS NOT COSMETIC — assess before you prescribe:
- Score the past first (executionScores), because those scores are the evidence.
- Then write loadAssessment as your actual judgement of the current state, based on that evidence and the TRAINING LOAD figures.
- Only then choose the session. suggestion must FOLLOW from loadAssessment, not be justified by it after the fact.

STRICT RULES:
- Output exactly ONE suggestion — never an array of days, never a weekly plan.
- executionScores[]: include ONLY entries marked NEEDS SCORING in PREVIOUS SUGGESTIONS, keyed by their [id N]. Empty array if none.
- Never re-score a suggestion already shown as SCORED — leave it out entirely.
- NEVER output "Rest". There is no calendar here, so a dateless rest suggestion is something the athlete cannot ride, cannot sync and can never complete — it would sit in the one slot this mode has until it expires.
- When the honest answer is that they need recovery, still name the session they should come back to: pick the gentlest option that fits, set "priority" to "low", and use coachNote to say plainly that they should NOT ride it yet and what has to be true before they do (symptoms gone, check-in back to normal, a given number of easy days). The reason field explains why you are holding them back.
- "structure" MUST always be present, with at least one step.
- stepType MUST be one of: WarmUp, Run, Recovery, Cooldown
- zone MUST be one of: z1, z2, z3, z4, z5
- durationSec MUST be a positive integer (minimum 20 for sprint intervals)
- totalMinutes MUST equal Math.round(sum(durationSec) / 60)
- COMPACT STRUCTURES: Sprint max 6 interval sets, Threshold max 3 sets, VO2Max max 4 sets. Step labels must be ≤ 4 words.
- Do NOT reference a specific weekday or date inside reason/coachNote — the athlete picks the day.`;

const buildFreePrompt = (
  history: FreeSuggestion[],
  current: FreeSuggestion | null,
  pauseContext: PauseContext | undefined,
  activityDays: number
): string => {
  const today     = localDate();
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: USER_TZ });

  const recentActivities = buildRecentActivities(activityDays);
  const profile          = getStoredProfile();
  const zoneString       = buildZoneString(profile);
  const analysis         = getStoredAnalysis();

  const { prefLine, goalsBlock } = buildPreferenceLines(true);
  const pauseBlock   = buildPauseBlock(pauseContext, today);
  const historyBlock = buildFreeHistoryBlock(history, current);

  return `TODAY: ${today} (${dayOfWeek}) — use this only to judge how recent their last rides are.

ATHLETE PREFERENCES:
${prefLine}${goalsBlock}

${pauseBlock}${historyBlock}HR PROFILE:
- Max HR: ${profile?.maxHr ?? 'unknown'} bpm | LTHR: ${profile?.lthr ?? 'unknown'} bpm
- Zones: ${zoneString}

TRAINING ANALYSIS (last 90 days):
- Total rides: ${analysis?.totalCyclingRides ?? 0} | Peak HR recorded: ${analysis?.maxRecordedHr ?? 0} bpm
- Average ride duration: ${analysis?.averageRideDurationMinutes ?? 0} min

${buildCheckinBlock()}${buildTrainingLoadBlock()}RECENT ACTIVITIES (last ${activityDays} days):
${formatActivityLines(recentActivities)}`;
};

/**
 * Free mode's counterpart to planGenerationInFlight. Two concurrent runs would each insert a
 * row and each retire the other's as superseded, burning two Gemini calls to end up with one
 * suggestion and a confusing history.
 */
let freeGenerationInFlight: Promise<FreeSuggestion | null> | null = null;

/**
 * Generate the next free-mode suggestion and store it.
 * Applies any AI execution scores to past suggestions first, then inserts the new one
 * (which retires the previous current suggestion — see insertFreeSuggestion).
 * Always returns what was actually saved.
 */
/**
 * @param athleteRequested true when the athlete asked for a different suggestion (refresh),
 *   false for an automatic regeneration. Decides how the outgoing suggestion is recorded,
 *   and therefore whether the AI reads it as a rejection.
 */
export const generateFreeSuggestion = (pauseContext?: PauseContext, athleteRequested = false): Promise<FreeSuggestion | null> => {
  if (freeGenerationInFlight) {
    logger.info('[Gemini] Free suggestion generation already in flight — joining it instead of starting a second');
    return freeGenerationInFlight;
  }
  freeGenerationInFlight = _generateFree(pauseContext, athleteRequested)
    .finally(() => { freeGenerationInFlight = null; });
  return freeGenerationInFlight;
};

const _generateFree = async (pauseContext?: PauseContext, athleteRequested = false): Promise<FreeSuggestion | null> => {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_KEY_NOT_CONFIGURED');

  // Same shrinking-window retry as the plan: a single workout rarely truncates, but the
  // activity JSON is the same size and a small-output model can still run out of room.
  const ACTIVITY_WINDOWS = [21, 14, 10];

  for (const activityDays of ACTIVITY_WINDOWS) {
    const result = await _attemptFreeGeneration(pauseContext, activityDays, athleteRequested);
    if (result.truncated) {
      logger.warn(`[Gemini] Free suggestion truncated (MAX_TOKENS) with ${activityDays}-day window — retrying with fewer activities`);
      continue;
    }
    return result.value;
  }
  throw new Error('[Gemini] Free suggestion truncated even with minimal activity window (10 days). Try a model with higher output limits.');
};

const _attemptFreeGeneration = async (
  pauseContext: PauseContext | undefined,
  activityDays: number,
  athleteRequested = false
): Promise<{ truncated: true } | { truncated: false; value: FreeSuggestion | null }> => {
  const key     = getGeminiKey()!;
  const current = getCurrentFreeSuggestion();
  const history = getFreeSuggestionHistory(FREE_HISTORY_DEPTH);
  const prompt  = buildFreePrompt(history, current, pauseContext, activityDays);

  logger.info('\n' + '═'.repeat(72));
  logger.info('[Gemini] ── FREE SUGGESTION PROMPT SENT ────────────────────────────');
  logger.info('─'.repeat(72));
  logger.info(prompt);
  logger.info('─'.repeat(72) + '\n');

  const model = getGeminiModel();
  logger.info(`[Gemini] Model: ${model} (free training mode) | system instruction: ${FREE_SYSTEM_INSTRUCTION.length} chars (static, not repeated here)`);

  const response = await callGemini('Free suggestion', model, key, {
    systemInstruction: { parts: [{ text: FREE_SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // Plan stability is an explicit goal of the prompt; 0.4 sampled against it.
      temperature: 0.2,
      maxOutputTokens: 16384,
      thinkingConfig: thinkingConfigFor(model)
    }
  });

  const candidate    = response.data?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts || [];
  const rawText: string = parts.map((p: any) => p.text ?? '').join('');
  const finishReason = candidate?.finishReason ?? 'unknown';

  logger.info('[Gemini] ── FREE SUGGESTION RAW RESPONSE ────────────────────────────');
  logger.info(`[Gemini] finishReason: ${finishReason} | length: ${rawText.length} chars | activityDays: ${activityDays}`);
  logger.info('─'.repeat(72));
  logger.info(rawText ?? '(empty)');
  logger.info('─'.repeat(72) + '\n');

  if (!rawText) throw new Error('Empty response from Gemini API');
  if (finishReason === 'MAX_TOKENS') return { truncated: true };

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON (${rawText.length} chars, finishReason: ${finishReason}):\n${rawText}`);
  }

  // Rest is deliberately absent: free mode has no day to rest on, and a Rest suggestion
  // can never be synced, ridden or scored. Recovery advice belongs in coachNote instead.
  const validTypes = ['Sprint', 'VO2Max', 'Threshold', 'Tempo', 'LongRide'];
  const s = parsed?.suggestion;
  if (!validTypes.includes(s?.type)) {
    throw new Error(`Invalid suggestion.type: ${s?.type}${s?.type === 'Rest' ? ' — free mode has no Rest; recovery goes in coachNote' : ''}`);
  }

  // ── Apply execution scores to past suggestions ────────────────────────────
  // Only ids genuinely awaiting a score are accepted — this ignores a model that
  // re-scores an already-scored suggestion or invents an id, and setFreeSuggestionScore
  // is itself a no-op on rows that already carry a score.
  const scorable = new Set(getUnscoredFreeSuggestions(FREE_HISTORY_DEPTH).map(x => x.id));
  if (Array.isArray(parsed.executionScores)) {
    for (const e of parsed.executionScores) {
      const id = Number(e?.suggestionId);
      if (!scorable.has(id) || typeof e?.score !== 'number') continue;
      setFreeSuggestionScore(id, Math.round(e.score), typeof e.note === 'string' ? e.note : null);
      logger.info(`[Gemini] Free suggestion ${id} scored ${Math.round(e.score)}/100`);
    }
  }

  // Recompute totalMinutes from the steps — the model rounds inconsistently.
  const structure = s.structure && Array.isArray(s.structure.steps) && s.structure.steps.length > 0
    ? {
        totalMinutes: Math.round(
          s.structure.steps.reduce((sum: number, st: any) => sum + (st.durationSec || 0), 0) / 60
        ),
        steps: s.structure.steps
      }
    : null;

  if (!structure) {
    throw new Error(`Suggestion type ${s.type} came back without a workout structure`);
  }

  const newId = insertFreeSuggestion({
    workoutType:    s.type,
    reason:         typeof s.reason === 'string' ? s.reason : '',
    priority:       typeof s.priority === 'string' ? s.priority : 'medium',
    coachNote:      typeof s.coachNote === 'string' ? s.coachNote : null,
    structure,
    loadAssessment: parsed.loadAssessment ?? null
  }, athleteRequested ? 'superseded' : 'expired');

  logger.info('[Gemini] ── FREE SUGGESTION PARSED ──────────────────────────────────');
  logger.info(`  Suggestion #${newId}: ${s.type} (priority: ${s.priority})`);
  logger.info(`  Reason:    ${s.reason}`);
  logger.info(`  CoachNote: ${s.coachNote ?? '(none)'}`);
  logger.info(`  Duration:  ${structure ? `${structure.totalMinutes} min, ${structure.steps.length} steps` : 'rest day — no structure'}`);
  logger.info(`  Fatigue:   ${parsed.loadAssessment?.fatigue ?? '?'}  |  Trend: ${parsed.loadAssessment?.weeklyLoadTrend ?? '?'}`);
  logger.info('═'.repeat(72) + '\n');

  return { truncated: false, value: getCurrentFreeSuggestion() };
};
