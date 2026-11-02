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
import { sanitizeStructure, normalizeWorkoutType } from './workout.service';
import logger from '../logger';
import { loadPrompt, renderPrompt } from '../prompts/loader';

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
 * Per attempt. Generous on purpose: under heavy load a real gemini-3.8-flash plan call took
 * 322s to answer (measured), so this only exists to stop a call that never answers at all.
 * Not retried — a request that hung this long is not one to repeat three times.
 */
const GEMINI_TIMEOUT_MS = 420_000;

/**
 * POST a generateContent request, retrying transient failures. A 429 honours Retry-After
 * (quota exhaustion sends a long one); a 5xx backs off 3s, 6s, 12s, because an overloaded
 * model needs longer to recover than a rate window does.
 */
const callGemini = async (label: string, model: string, key: string, body: object): Promise<any> => {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      // A timeout is not optional. Under load Google can hold the connection open without
      // answering; with axios' default (none) the call never settled, the single-flight
      // guard never released, and every later generation joined the hung one — the UI sat on
      // "Your plan is being updated…" until the app was restarted. Real calls take 5-80s, 5+ min under load.
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        body,
        { timeout: GEMINI_TIMEOUT_MS }
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

  // Rides per week over the same covered blocks — the FREQUENCY rule in the plan prompt is
  // keyed on this number, so it has to be stated rather than left for the model to count.
  const avgRidesPerWeek = Math.round(
    (weeks.slice(0, blocksCovered).reduce((s, w) => s + w.rides, 0) / blocksCovered) * 10
  ) / 10;

  const withZones = acts.filter(a => parseZones(a.timeInZones)).length;

  return `TRAINING LOAD (pre-computed from the full ride history — use these figures, do not re-derive them):
- Last 7 days: ${weeks[0].rides} ride(s), ${fmt(weeks[0].minutes)} total, ${weeks[0].z3plus} min in Z3+
- Preceding 7-day blocks (most recent first): ${weeks.slice(1).map(w => `${fmt(w.minutes)} (${w.rides} rides)`).join(', ')}
- ${blocksCovered}-week average: ${fmt(avgPerWeek)} and ${avgRidesPerWeek} rides per week${blocksCovered < weeks.length ? ` (only ${historyDays} days of ride history are stored — do not read this as a long-term baseline)` : ''}
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
const ACTIVITY_DATA_NOTES = loadPrompt('shared/activity-data-notes');

/**
 * Evidence, computed from the numbers, that the athlete's HR profile is set too low.
 *
 * With zones too low every ride reads as a Z4/Z5 effort, and a model told to respect
 * recovery then prescribes easy riding forever — while the athlete, riding by feel at a
 * moderate rpe, keeps "failing" every Z2 ride it gives them. That loop is exactly what the
 * Oct-Nov 2026 server logs show (Max HR 180 configured, 191 recorded; 111 min averaging
 * 166 bpm against an LTHR of 157, at rpe 7). The prompt carried both numbers but never
 * connected them, and comparing them is the kind of arithmetic rule 20 in CLAUDE.md says to
 * do here rather than ask of the model. Empty string when nothing is off.
 */
const HR_CALIBRATION_MIN_RIDE_MIN = 60;

const buildHrCalibrationLines = (profile: any, analysis: any): string => {
  const lines: string[] = [];
  const maxHr = profile?.maxHr;
  const lthr  = profile?.lthr;
  const peak  = analysis?.maxRecordedHr;

  if (maxHr && peak && peak > maxHr + 2) {
    lines.push(renderPrompt('shared/hr-calibration-peak', { PEAK_HR: peak, MAX_HR: maxHr }));
  }

  if (lthr) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    // LTHR is roughly the highest heart rate an athlete can hold for about an hour, so a
    // ride of an hour or more AVERAGING above it means LTHR is set below the real value.
    const above = getStoredActivities().filter(a =>
      a.startTime && new Date(a.startTime) >= cutoff &&
      (a.durationMinutes ?? 0) >= HR_CALIBRATION_MIN_RIDE_MIN &&
      (a.averageHr ?? 0) > lthr
    );
    if (above.length > 0) {
      const ex = above[0];
      lines.push(renderPrompt('shared/hr-calibration-lthr', {
        RIDE_COUNT:      above.length,
        MIN_MINUTES:     HR_CALIBRATION_MIN_RIDE_MIN,
        EXAMPLE_DATE:    ex.startTime.slice(0, 10),
        EXAMPLE_MINUTES: ex.durationMinutes,
        EXAMPLE_HR:      ex.averageHr,
        LTHR:            lthr,
      }));
    }
  }

  // Leading newline per line: the caller appends this straight after the Zones line.
  return lines.map(l => `\n- HR CALIBRATION: ${l}`).join('');
};

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
const buildCheckinNotes = (freeMode: boolean): string =>
  renderPrompt('shared/checkin-notes', { MODE_RULES: loadPrompt(freeMode ? 'free/checkin-rules' : 'plan/checkin-rules') });

/** The six workout types and their step templates. Caller supplies the header line. */
const WORKOUT_TYPE_GUIDELINES = loadPrompt('shared/workout-types');

/**
 * How to pitch the load: match what this athlete is actually doing and feeling.
 *
 * Two-sided on purpose, and the history matters. The first version was framed as
 * "PROGRESSION GOAL … then progress from there", which biased the model toward adding load
 * whenever nothing was visibly wrong. The rewrite that replaced it swung the other way: five
 * separate instructions to hold or back off, one conditional permission to progress, and
 * "recovery signals are good" left undefined — so the model could never establish that the
 * condition for progressing was met. In production that produced twenty consecutive
 * free-mode LongRides for a fresh, once-a-week rider (Oct-Nov 2026 server logs).
 *
 * The fix is not to make progression the goal again. READINESS is an explicit, evaluable
 * check (rule 20 in CLAUDE.md): NOT READY means back off exactly as before; READY means give
 * a real stimulus. Neither is the default. Shared by both modes.
 */
const CALIBRATION_GUIDELINES = loadPrompt('shared/calibration');

/** The 0-100 execution-quality bands. Identical in both modes so scores stay comparable. */
const SCORING_RUBRIC = loadPrompt('shared/scoring-rubric');

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
    ? loadPrompt('free/preferred-days')
    : preferredDays.length > 0
    ? renderPrompt('plan/preferred-days', { DAYS: preferredDays.join(', ') })
    : loadPrompt('plan/no-preferred-days');

  const rawGoals = getSetting('user_goals') || '';
  const goalsBlock = rawGoals.trim()
    ? `\n${renderPrompt(freeMode ? 'free/athlete-goals' : 'plan/athlete-goals', { GOALS: rawGoals.trim() })}\n\n`
    : '';

  return { prefLine, goalsBlock };
};

/**
 * The athlete-data placeholders both per-call templates (plan/athlete.md, free/athlete.md)
 * share: HR profile, 90-day analysis, check-ins, training load and the ride table.
 */
const buildAthleteDataVars = (profile: any, analysis: any, recentActivities: any[], activityDays: number) => ({
  MAX_HR:           profile?.maxHr ?? 'unknown',
  LTHR:             profile?.lthr ?? 'unknown',
  ZONES:            buildZoneString(profile),
  HR_CALIBRATION:   buildHrCalibrationLines(profile, analysis),
  TOTAL_RIDES:      analysis?.totalCyclingRides ?? 0,
  PEAK_HR:          analysis?.maxRecordedHr ?? 0,
  AVG_RIDE_MINUTES: analysis?.averageRideDurationMinutes ?? 0,
  CHECKINS:         buildCheckinBlock(),
  TRAINING_LOAD:    buildTrainingLoadBlock(),
  ACTIVITY_DAYS:    activityDays,
  ACTIVITIES:       formatActivityLines(recentActivities),
});

/** Pause history block — empty string when training was never paused. */
const buildPauseBlock = (pauseContext: PauseContext | undefined, today: string): string => {
  if (!pauseContext) return '';
  const pauseDays = Math.round(
    (new Date(today).getTime() - new Date(pauseContext.pausedSince).getTime()) / 86_400_000
  );
  const pauseText = renderPrompt('shared/training-pause', {
    PAUSED_SINCE: pauseContext.pausedSince,
    TODAY:        today,
    PAUSE_LENGTH: `${pauseDays} day${pauseDays !== 1 ? 's' : ''}`,
    PAUSE_REASON: pauseContext.pauseReason ? ` — reason: ${pauseContext.pauseReason}` : '',
    PAUSE_RIDES:  pauseContext.activitiesCount > 0
      ? `They recorded ${pauseContext.activitiesCount} ride(s) during the pause period.`
      : 'No rides were recorded during the pause period.',
  });
  return `${pauseText}\n\n`;
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
const PLAN_SYSTEM_INSTRUCTION = renderPrompt('plan/system', {
  ACTIVITY_DATA_NOTES,
  CHECKIN_NOTES:       buildCheckinNotes(false),
  WORKOUT_TYPE_GUIDELINES,
  CALIBRATION_GUIDELINES,
  SCORING_RUBRIC,
  STRUCTURED_WINDOW_DAYS,
  STRUCTURED_LAST_DAY: STRUCTURED_WINDOW_DAYS - 1,
  PLAN_WINDOW_DAYS,
  PLAN_LAST_DAY:       PLAN_WINDOW_DAYS - 1,
});

const buildPrompt = (previousPlan?: PlanEntry[], pauseContext?: PauseContext, activityDays = 21, pinnedTodayType?: string): string => {
  const today     = localDate();
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: USER_TZ });

  // Recent activities window — reduced automatically on MAX_TOKENS retry
  const allActivities    = getStoredActivities();
  const recentActivities = buildRecentActivities(activityDays);

  const profile = getStoredProfile();

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
    // Today is included: diffPlans counts a change to today, so PLAN STABILITY and changeNote
    // must cover it too. With today left out, a model turned today's LongRide into Rest and
    // wrote "I kept every scheduled day" — true of the list it saw, false on the athlete's
    // screen, where the changed-days list showed exactly that change. A pinned today has its
    // own MANDATORY line below, so its stale entry is left out.
    const futurePlanned = previousPlan.filter(e =>
      e.status === 'planned' && (e.date > today || (e.date === today && !pinnedTodayType))
    );
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
    ? `${renderPrompt('plan/pinned-today', { TODAY: today, TYPE: pinnedTodayType })}\n\n`
    : '';

  const { prefLine, goalsBlock } = buildPreferenceLines();
  const pauseBlock = buildPauseBlock(pauseContext, today);

  // A pinned type is stated twice on purpose — once up front, and once as the last thing the
  // model reads before answering. It is the only instruction here that overrides the data.
  const pinnedTail = pinnedTodayType
    ? `\n${renderPrompt('plan/pinned-reminder', { TODAY: today, TYPE: pinnedTodayType })}\n`
    : '';

  return renderPrompt('plan/athlete', {
    TODAY:               today,
    DAY_OF_WEEK:         dayOfWeek,
    PREFERRED_DAYS:      prefLine,
    GOALS_BLOCK:         goalsBlock,
    PAUSE_BLOCK:         pauseBlock,
    PREVIOUS_ASSESSMENT: buildPreviousAssessmentBlock(),
    COMPLIANCE:          prevBlock,
    PINNED_TODAY:        pinnedTodayBlock,
    SCHEDULED:           plannedBlock,
    ...buildAthleteDataVars(profile, analysis, recentActivities, activityDays),
    PINNED_REMINDER:     pinnedTail,
  });
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
  if (!Array.isArray(parsed?.weeklyPlan) || parsed.weeklyPlan.length !== PLAN_WINDOW_DAYS) {
    throw new Error(`weeklyPlan must be an array of ${PLAN_WINDOW_DAYS} entries, got ${parsed?.weeklyPlan?.length}`);
  }
  // Every day's type, not only today's: an unknown type ("Recovery", "Endurance") used to be
  // stored as-is, could never be synced and rendered as a raw string. Spelling variants
  // ("VO2 Max", "Long Ride") are normalised; anything else fails the generation, which leaves
  // the previous plan in place rather than storing a broken one.
  const dayTypes = parsed.weeklyPlan.map((e: any, i: number) => {
    const t = normalizeWorkoutType(e?.type);
    if (!t) throw new Error(`Invalid weeklyPlan[${i}].type: ${e?.type}`);
    return t;
  });
  // today.type is only a cross-check — weeklyPlan[0] is authoritative (see upsert below).
  if (!normalizeWorkoutType(parsed?.today?.type)) {
    logger.warn(`[Gemini] today.type "${parsed?.today?.type}" is not a valid type — using weeklyPlan[0] (${dayTypes[0]})`);
  }

  // A reschedule to today is a direct athlete instruction; the prompt states it twice, and
  // this makes it true even when the model ignores it. The model's structure was written for
  // the type it chose, so it is dropped — sync then uses the built-in structure for the
  // pinned type rather than, say, a LongRide's steps under a Threshold name.
  const pinned = pinnedTodayType ? normalizeWorkoutType(pinnedTodayType) : null;
  if (pinned && dayTypes[0] !== pinned) {
    logger.warn(`[Gemini] Model ignored the pinned type for today (${dayTypes[0]} instead of ${pinned}) — enforcing ${pinned}`);
    dayTypes[0] = pinned;
    parsed.weeklyPlan[0].structure = null;
  }

  // Dates come from the calendar, not the model: weeklyPlan[i] is today + i by definition.
  // A model that started a day late or skipped a date would otherwise shift every workout
  // onto the wrong day, and the status merge below would attach to the wrong entries.
  const planDates = parsed.weeklyPlan.map((_: any, i: number) => {
    const d = new Date(localDate() + 'T12:00:00');
    d.setDate(d.getDate() + i);
    return localDate(d);
  });
  const shifted = parsed.weeklyPlan.filter((e: any, i: number) => e?.date !== planDates[i]).length;
  if (shifted > 0) {
    logger.warn(`[Gemini] ${shifted} weeklyPlan date(s) did not match today + index — corrected`);
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
  const weeklyPlan: PlanEntry[] = parsed.weeklyPlan.map((e: any, i: number) => {
    const date          = planDates[i];
    const type          = dayTypes[i];
    const prev          = prevEntryMap.get(date);
    const status        = (prev && prev.status !== 'planned') ? prev.status : 'planned';
    const alreadyScored = prev?.executionScore != null;

    // A structure only where something will actually be ridden from it: a planned, non-Rest
    // day inside the structured window. sanitizeStructure removes dead blocks, fixes bad
    // zones/types/durations and recomputes totalMinutes (the model rounds inconsistently).
    const structure = (type !== 'Rest' && i < STRUCTURED_WINDOW_DAYS && status === 'planned')
      ? sanitizeStructure(e.structure, type)
      : null;

    return {
      date,
      type,
      reason:         typeof e.reason === 'string' ? e.reason : '',
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
    workoutType:   todayEntry.type,
    reason:        todayEntry?.reason  || parsed?.today?.reason || '',
    // The UI colours priority by class name, so only the three known values get through.
    priority:      ['high', 'medium', 'low'].includes(parsed?.today?.priority) ? parsed.today.priority : 'medium',
    weeklyPlan:    fullPlan,
    nextWeekFocus: typeof parsed.nextWeekFocus === 'string' ? parsed.nextWeekFocus : null,
    changeNote:    typeof parsed.changeNote === 'string' ? parsed.changeNote : null,
    changedEntries,
    loadAssessment: parsed.loadAssessment
  });

  // ── Log parsed result summary ─────────────────────────────────────────────────
  logger.info('[Gemini] ── PARSED RESULT ───────────────────────────────────────────');
  logger.info(`  Today:    ${todayEntry.type} (priority: ${parsed?.today?.priority ?? "?"})`);
  logger.info(`  Reason:   ${todayEntry.reason}`);
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
    return `- [id ${s.id}] ${suggested}${synced} → ${s.status.toUpperCase()}`;
  };

  const lines: string[] = [];
  if (current) {
    const syncState = current.syncedForDate
      ? `synced to Garmin for ${current.syncedForDate} but not yet ridden`
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
const FREE_SYSTEM_INSTRUCTION = renderPrompt('free/system', {
  ACTIVITY_DATA_NOTES,
  CHECKIN_NOTES: buildCheckinNotes(true),
  WORKOUT_TYPE_GUIDELINES,
  CALIBRATION_GUIDELINES,
  SCORING_RUBRIC,
});

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
  const analysis         = getStoredAnalysis();

  const { prefLine, goalsBlock } = buildPreferenceLines(true);
  const pauseBlock   = buildPauseBlock(pauseContext, today);
  const historyBlock = buildFreeHistoryBlock(history, current);

  return renderPrompt('free/athlete', {
    TODAY:              today,
    DAY_OF_WEEK:        dayOfWeek,
    PREFERRED_DAYS:     prefLine,
    GOALS_BLOCK:        goalsBlock,
    PAUSE_BLOCK:        pauseBlock,
    SUGGESTION_HISTORY: historyBlock,
    ...buildAthleteDataVars(profile, analysis, recentActivities, activityDays),
  });
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
  const history = getFreeSuggestionHistory(FREE_HISTORY_DEPTH, true);
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
  const s = parsed?.suggestion;
  const freeType = normalizeWorkoutType(s?.type);
  if (!freeType || freeType === 'Rest') {
    throw new Error(`Invalid suggestion.type: ${s?.type}${freeType === 'Rest' ? ' — free mode has no Rest; recovery goes in coachNote' : ''}`);
  }
  s.type = freeType;

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

  // Same check as plan mode: no dead blocks, valid zones/types, recomputed totalMinutes.
  const structure = sanitizeStructure(s.structure, s.type);

  if (!structure) {
    throw new Error(`Suggestion type ${s.type} came back without a usable workout structure`);
  }

  const newId = insertFreeSuggestion({
    workoutType:    s.type,
    reason:         typeof s.reason === 'string' ? s.reason : '',
    priority:       ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
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
