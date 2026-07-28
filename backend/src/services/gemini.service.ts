import axios from 'axios';
import {
  getSetting,
  upsertRecommendation,
  getStoredRecommendation,
  getStoredActivities,
  getStoredProfile,
  getStoredAnalysis,
  PlanEntry
} from './database.service';
import { localDate, toRpe, toFeeling, USER_TZ, APP_NAME } from '../utils';
import logger from '../logger';

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Forward-looking plan length in days — kept wide enough that a lagged regen still covers "next week" with real data. */
const PLAN_WINDOW_DAYS = 14;

export const getGeminiKey = (): string | null => getSetting('gemini_api_key') || null;

export const maskKey = (key: string): string =>
  key.length > 6 ? key.slice(0, 6) + '***' : '***';

// ── Zone helpers ──────────────────────────────────────────────────────────────

/** Guard against short/malformed zone arrays from a stored activity row. */
const parseZones = (raw: any): number[] | null =>
  Array.isArray(raw) && raw.length >= 5 ? raw : null;

/** Format zone seconds array as a readable string for the prompt, e.g. "z1=8m z2=32m z3=6m z4=14m z5=3m" */
const fmtZones = (zones: number[]): string =>
  zones.map((s, i) => `z${i + 1}=${Math.round(s / 60)}m`).join(' ');


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

  return plan
    .filter(e => e.status === 'planned' && e.date <= today && actMap.has(e.date))
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

const buildPrompt = (previousPlan?: PlanEntry[], pauseContext?: PauseContext, activityDays = 21, pinnedTodayType?: string): string => {
  const today     = localDate();
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: USER_TZ });

  // Recent activities window — reduced automatically on MAX_TOKENS retry
  const allActivities = getStoredActivities();
  const cutoff21 = new Date();
  cutoff21.setDate(cutoff21.getDate() - activityDays);
  const recentActivities = allActivities
    .filter(a => a.startTime && new Date(a.startTime) >= cutoff21)
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

  // HR profile + zone string
  const profile = getStoredProfile();
  const zoneString = profile?.zones
    ? Object.entries(profile.zones)
        .map(([k, z]: [string, any]) => `${k.toUpperCase()}: ${z.min}-${z.max}`)
        .join(' | ')
    : 'Not configured';

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
      plannedBlock = `EXISTING SCHEDULED WORKOUTS (keep unless explicitly justified — see rules below):\n${lines.join('\n')}\n\n`;
    }
  } else if (pinnedTodayType) {
    const todayDow = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
    plannedBlock = `EXISTING SCHEDULED WORKOUTS (keep unless explicitly justified — see rules below):\n- ${today} (${todayDow}): ${pinnedTodayType} ← RESCHEDULED BY USER — MANDATORY\n\n`;
  }

  const pinnedTodayBlock = pinnedTodayType
    ? `CRITICAL — USER RESCHEDULED TODAY: The athlete explicitly moved a workout to today. Today (${today}) MUST be "${pinnedTodayType}". Output "${pinnedTodayType}" as today.type and weeklyPlan[0].type — this is a direct user instruction, not a suggestion.\n\n`
    : '';

  // Support multiple preferred days (new plural key) with fallback to old singular key
  const rawDays = getSetting('preferred_long_ride_days') || getSetting('preferred_long_ride_day') || '';
  const preferredDays = rawDays ? rawDays.split(',').map(d => d.trim()).filter(Boolean) : [];
const prefLine = preferredDays.length > 0
    ? `- Preferred Long Ride day(s): ${preferredDays.join(', ')} — Treat these as primary candidates for scheduling 'LongRide'. You are not required to schedule a ride on every preferred day. Prioritize optimal recovery; it is perfectly acceptable to schedule a Rest day on a preferred day if athletically justified.`
    : `- No preferred Long Ride days specified.`;

  const pauseDays = pauseContext
    ? Math.round((new Date(today).getTime() - new Date(pauseContext.pausedSince).getTime()) / 86_400_000)
    : 0;
  const pauseBlock = pauseContext
    ? `TRAINING PAUSE:\nThe athlete paused training from ${pauseContext.pausedSince} to ${today} (${pauseDays} day${pauseDays !== 1 ? 's' : ''})${pauseContext.pauseReason ? ` — reason: ${pauseContext.pauseReason}` : ''}.\n${pauseContext.activitiesCount > 0 ? `They recorded ${pauseContext.activitiesCount} ride(s) during the pause period.` : 'No rides were recorded during the pause period.'}\nConsider the duration, reason, and the athlete's prior training history to judge whether and how much re-adaptation is needed before resuming normal load.\n\n`
    : '';

  const rawGoals = getSetting('user_goals') || '';
  const goalsBlock = rawGoals.trim()
    ? `\nATHLETE GOALS & PREFERENCES:\n${rawGoals.trim()}\nNote: treat the above as secondary context. Reflect it in the plan where appropriate (e.g. event timing, day preferences, duration constraints), but always prioritise objective load data, HR signals, and compliance history over these stated preferences.\n\n`
    : '';

  return `You are a professional cycling coach AI specializing in heart-rate based training.
Analyze the athlete's data and generate an adaptive training plan with exact, personalised workout structures.
Calibrate training volume and intensity to the athlete's demonstrated capacity from their recent history.
An athlete who consistently trains at high frequency and intensity has established that as their sustainable baseline — match that load.
Only reduce volume when recovery signals (rpe ≥ 8, feeling ≤ 2, HR drift upward over successive rides) indicate genuine fatigue accumulation.
High training volume alone is not a reason to prescribe rest — look at the quality signals.

TODAY: ${today} (${dayOfWeek})

ATHLETE PREFERENCES:
${prefLine}${goalsBlock}

${pauseBlock}${prevBlock}${pinnedTodayBlock}${plannedBlock}RECENT ACTIVITIES (last 21 days):
${JSON.stringify(recentActivities, null, 2)}

Note: zonesMin shows minutes spent in each Garmin HR zone (z1=lowest, z5=highest intensity).
Zone data is from Garmin's default 5-zone system based on max HR — boundaries may differ slightly from the athlete's custom LTHR zones below.
rpe = athlete-reported perceived exertion after the ride (1=very easy, 5=moderate, 10=maximal effort). Absent = not rated.
feeling = athlete-reported post-ride feeling (1=exhausted/very tired, 2=tired, 3=normal, 4=good, 5=strong/excellent). Absent = not rated.
When rpe and feeling are present, weight them heavily — they are direct athlete feedback on recovery state. High rpe (≥8) or low feeling (≤2) after a session signals real fatigue even if HR data looks moderate.

HR PROFILE:
- Max HR: ${profile?.maxHr ?? 'unknown'} bpm | LTHR: ${profile?.lthr ?? 'unknown'} bpm
- Zones: ${zoneString}

TRAINING ANALYSIS (last 90 days):
- Total rides: ${analysis?.totalCyclingRides ?? 0} | Peak HR recorded: ${analysis?.maxRecordedHr ?? 0} bpm
- Average ride duration: ${analysis?.averageRideDurationMinutes ?? 0} min

WORKOUT TYPE GUIDELINES — you decide the exact structure for each day based on athlete load:

Sprint (requires neuromuscular recovery — use athlete's own history to judge adequate rest):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-8 sets of [Sprint [Run] 20-45 sec Z5 → Recovery [Recovery] 180-300 sec Z1]
  Cool-down [Cooldown]: 480-720 sec Z1
  Short maximal bursts — trains neuromuscular power. Fewer/shorter when less fresh.
  Recovery window: for high-volume athletes who regularly train daily, 24-36h between hard sessions may be their normal pattern.
  For lower-volume athletes, 48h+ rest before a sprint session is appropriate.

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

Rest: no structure needed — set structure to null.

PROGRESSION GOAL: Match the athlete's established training level, then progress from there:
  Training pyramid: Rest → LongRide (Z2 base) → Tempo (Z3 fatigue resistance) → Threshold (Z4 aerobic power) → VO2Max (Z5 aerobic ceiling) → Sprint (Z5+ neuromuscular)

- If the athlete's history already shows regular Sprint/Threshold/VO2Max work: continue at that level — do NOT reset to base.
  - Rule: Do NOT prescribe high-intensity interval sessions (Tempo, Threshold, VO2Max, Sprint) if the athlete's recent ride history consists exclusively of 'easy' or 'moderate' aerobic rides, unless their specific goals require race preparation.
  - Only stack VO2Max + Threshold + Sprint in the same week when the athlete is demonstrably managing that load (history shows it, rpe/feeling are fine).
  - If the athlete is already at a consistently high load with no negative signals, the goal is quality maintenance — not pushing further volume or intensity.
  - Increase intensity/frequency only when fatigue signals are low AND current load is below the athlete's demonstrated ceiling.
If execution scores are consistently below 60, prioritise consolidation over progression — the athlete is not absorbing the current load.

EXECUTION SCORING — for ALL entries marked "NEEDS SCORING" above:
Score on a 0-100 scale based on zone distribution, duration, rpe, and feeling:
  90-100 : Textbook — target zone time met or exceeded, full duration, correct intensity
  75-89  : Good — mostly on target, minor deviations (slightly short, small zone drift)
  60-74  : Partial — significant reduction (e.g. 1-2 fewer intervals, ~30% short)
  40-59  : Poor — major deviations, wrong intensity, substantial shortfall
  0-39   : Mismatch — activity bears little resemblance to the planned workout
Be honest — do not inflate scores. Reference specific data in the note (1 sentence, e.g. "12 min in Z4 vs target 24 min — significant shortfall").
Use your scoring assessment DIRECTLY when deciding load, recovery, and session types for the new plan.

Where to put scores:
- NEEDS SCORING entries where date < TODAY: add to executionScores[] with date, score, note.
- Today's entry (weeklyPlan[0]) if its status was 'completed' (shown as NEEDS SCORING): set executionScore + executionNote inside weeklyPlan[0], NOT in executionScores[].
- Already SCORED entries: output their existing score in executionScores[] unchanged.
- Planned / skipped / Rest entries: executionScore = null, executionNote = null.

OUTPUT: Respond ONLY with this exact JSON schema:
{
  "today": {
    "type": "Sprint|VO2Max|Threshold|Tempo|LongRide|Rest",
    "reason": "2-3 sentences referencing specific data (last activity date, HR trend, etc.)",
    "priority": "high|medium|low"
  },
  "executionScores": [
    {
      "date": "YYYY-MM-DD",
      "score": <integer 0-100>,
      "note": "<1-sentence rationale>"
    }
  ],
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
  "nextWeekFocus": "1-2 sentences on the training theme of the SECOND week (weeklyPlan[7..13]) — what ties its sessions together and why, e.g. 'Introduce structured Tempo intervals to build fatigue resistance while keeping overall volume low.'",
  "loadAssessment": {
    "fatigue": "low|moderate|high",
    "weeklyLoadTrend": "increasing|stable|decreasing",
    "insight": "1-2 sentences about current training state and progression direction"
  }
}

STRICT RULES:
- PLAN STABILITY: If EXISTING SCHEDULED WORKOUTS are listed above, you MUST keep the same workout type for each date UNLESS at least one of these conditions applies:
    (a) A new execution score below 60 reveals the athlete cannot absorb that intensity
    (b) A skip or auto-skip has disrupted the recovery balance for that day
    (c) A recent feeling ≤2 or rpe ≥8 directly contradicts the planned intensity
    (d) The athlete's fatigue assessment has changed from the previous plan
  If none of these apply, output the same type. You may still adjust the workout structure (interval count, duration) based on new data.
- For Rest days: set "structure": null
- For entries whose status is completed, skipped, or auto-skipped: set "structure": null (done — no workout to sync)
- executionScores[]: include ALL past (date < TODAY) NEEDS SCORING entries + already-SCORED entries. Empty array if none.
- weeklyPlan[0].executionScore: integer 0-100 ONLY if today's entry is completed and needs scoring. All others: null.
- weeklyPlan[0].executionNote: matching 1-sentence string if scored. All others: null.
- stepType MUST be one of: WarmUp, Run, Recovery, Cooldown
- zone MUST be one of: z1, z2, z3, z4, z5
- durationSec MUST be a positive integer (minimum 20 for sprint intervals)
- weeklyPlan MUST contain exactly ${PLAN_WINDOW_DAYS} entries starting from TODAY (${today})
- nextWeekFocus describes weeklyPlan[7..13] AS A WHOLE (the training theme/rationale) — it is not a day-by-day recap, those already have their own "reason"
- totalMinutes MUST equal Math.round(sum(durationSec) / 60)
- COMPACT STRUCTURES: Sprint max 6 interval sets, Threshold max 3 sets, VO2Max max 4 sets. Step labels must be ≤ 4 words. reason fields: 1 short sentence only.${pinnedTodayType ? `\n- PINNED TODAY: A "CRITICAL — USER RESCHEDULED TODAY" block is present above. You MUST output "${pinnedTodayType}" for today.type and weeklyPlan[0].type. No exceptions — not fatigue, not load assessment.` : ''}`;
};

// ── Main generation function ──────────────────────────────────────────────────

export const generateRecommendation = async (previousPlan?: PlanEntry[], pauseContext?: PauseContext, pinnedTodayType?: string): Promise<any> => {
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

  const model = getSetting('gemini_model') || 'gemini-3.6-flash';
  logger.info(`[Gemini] Model: ${model}`);

  // Retry up to 3 times on 429 (rate limit) with exponential backoff.
  // Quota exhaustion (daily limit) also returns 429 but with a longer Retry-After —
  // the backoff handles both cases gracefully.
  const MAX_RATE_RETRIES = 3;
  let response: any;
  for (let attempt = 1; attempt <= MAX_RATE_RETRIES; attempt++) {
    try {
      response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
            maxOutputTokens: 16384
          }
        }
      );
      break; // success — exit retry loop
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < MAX_RATE_RETRIES) {
        const retryAfterSec = parseInt(err.response.headers?.['retry-after'] ?? '0', 10);
        const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * attempt; // 2s, 4s
        logger.warn(`[Gemini] Rate limited (429) — waiting ${waitMs}ms before retry ${attempt}/${MAX_RATE_RETRIES - 1}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }

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

  // Build a lookup of the previous plan for status + score preservation
  const prevEntryMap = new Map<string, PlanEntry>();
  if (previousPlan) {
    previousPlan.forEach(e => prevEntryMap.set(e.date, e));
  }

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

  const pastEntries: PlanEntry[] = (previousPlan || [])
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
  upsertRecommendation({
    workoutType:   todayEntry?.type    ?? parsed.today.type,
    reason:        todayEntry?.reason  ?? parsed.today.reason,
    priority:      parsed.today.priority,
    weeklyPlan:    fullPlan,
    nextWeekFocus: typeof parsed.nextWeekFocus === 'string' ? parsed.nextWeekFocus : null,
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
