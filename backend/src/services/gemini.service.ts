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

// ── Key helpers ───────────────────────────────────────────────────────────────

export const getGeminiKey = (): string | null => getSetting('gemini_api_key');

export const maskKey = (key: string): string =>
  key.length > 6 ? key.slice(0, 6) + '***' : '***';

// ── Zone helpers ──────────────────────────────────────────────────────────────

/** Parse timeInZones from a stored activity row (stored as JSON string or already an array). */
const parseZones = (raw: any): number[] | null => {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.length >= 5 ? raw : null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length >= 5 ? parsed : null;
  } catch { return null; }
};

/** Format zone seconds array as a readable string for the prompt, e.g. "z1=8m z2=32m z3=6m z4=14m z5=3m" */
const fmtZones = (zones: number[]): string =>
  zones.map((s, i) => `z${i + 1}=${Math.round(s / 60)}m`).join(' ');


// ── Completion / skip detection ───────────────────────────────────────────────

/**
 * Returns true when an activity name looks like an Unbound structured workout.
 * Garmin prefixes the location when recording a scheduled workout, e.g.
 * "Tilburg - Unbound Long Ride" → contains "unbound".
 */
const isUnboundActivity = (name: string): boolean =>
  (name || '').toLowerCase().includes(APP_NAME.toLowerCase());

/**
 * Binary activity match: marks any planned entry as 'completed' if a Garmin activity
 * exists on that date. Quality scoring is delegated entirely to the AI in
 * generateRecommendation() — executionScore (0-100) and executionNote come back in the
 * same Gemini call that regenerates the weekly plan.
 *
 * Activity selection per date (priority order):
 *   1. Activity whose name contains "Unbound" (Garmin appended workout name on record)
 *   2. Longest activity on that date (fallback)
 *
 * Including today (<=) means a same-day sync immediately marks the workout as done.
 */
export const classifyCompletedEntries = (
  plan: PlanEntry[]
): Array<{ date: string; status: 'completed' }> => {
  const activities = getStoredActivities();

  // Best activity per date: prefer Unbound-named, then longest
  const actMap = new Map<string, any>();
  activities
    .filter(a => a.startTime)
    .forEach(a => {
      const date     = a.startTime.slice(0, 10);
      const existing = actMap.get(date);
      const aIsUB    = isUnboundActivity(a.name);
      const exIsUB   = existing ? isUnboundActivity(existing.name) : false;

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
    .filter(e => e.status === 'planned' && e.date < today && !activityDates.has(e.date))
    .map(e => e.date);
};

// ── Prompt builder ────────────────────────────────────────────────────────────

const buildPrompt = (previousPlan?: PlanEntry[]): string => {
  const today     = localDate();
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: USER_TZ });

  // Recent 21 days of activities — include zone distribution when available
  const allActivities = getStoredActivities();
  const cutoff21 = new Date();
  cutoff21.setDate(cutoff21.getDate() - 21);
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

  // Support multiple preferred days (new plural key) with fallback to old singular key
  const rawDays = getSetting('preferred_long_ride_days') || getSetting('preferred_long_ride_day') || '';
  const preferredDays = rawDays ? rawDays.split(',').map(d => d.trim()).filter(Boolean) : [];
  const prefLine = preferredDays.length > 0
    ? `- Preferred Long Ride day(s): ${preferredDays.join(', ')} — schedule the LongRide on one of these days when load allows.`
    : `- No preferred Long Ride days specified.`;

  return `You are a professional cycling coach AI specializing in heart-rate based training.
Analyze the athlete's data and generate an adaptive training plan with exact, personalised workout structures.
The most important factor is training load management — never sacrifice recovery for volume.

TODAY: ${today} (${dayOfWeek})

ATHLETE PREFERENCES:
${prefLine}

${prevBlock}RECENT ACTIVITIES (last 21 days):
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

Sprint (ONLY when fully rested — 48h+ since last hard effort, low fatigue):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-8 sets of [Sprint [Run] 20-45 sec Z5 → Recovery [Recovery] 180-300 sec Z1]
  Cool-down [Cooldown]: 480-720 sec Z1
  Short maximal bursts — trains neuromuscular power. Fewer/shorter when less fresh.

VO2Max (only when well-rested — 48h+ since last hard effort, low-to-moderate fatigue):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-5 sets of [Work [Run] 180-300 sec Z5 → Recovery [Recovery] 180-240 sec Z1]
  Cool-down [Cooldown]: 480-600 sec Z1
  Sustained Z5 blocks raise the aerobic ceiling. More demanding than Sprint — do NOT schedule after consecutive hard days.
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
  Single steady block [Run]: 3600-14400 sec Z2
  Scale to fatigue level and averageRideDurationMinutes — shorter when tired, longer when fresh.

Rest: no structure needed — set structure to null.

PROGRESSION GOAL: Develop all energy systems using the full training pyramid:
  Rest → LongRide (Z2 base) → Tempo (Z3 fatigue resistance) → Threshold (Z4 aerobic power) → VO2Max (Z5 aerobic ceiling) → Sprint (Z5+ neuromuscular)
Higher-intensity sessions require more recovery. Build from the base — do not stack VO2Max + Threshold + Sprint in the same week unless fatigue is consistently low and compliance is excellent.
Gradually increase intensity/frequency when fatigue is low and compliance is good.
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
  "nextWeekOverview": {
    "summary": "e.g. '3 sessions: 1 Sprint, 1 Threshold, 1 Long Ride'",
    "sessions": [
      { "type": "Threshold", "estimatedDay": "Tuesday" }
    ],
    "emphasis": "1 sentence"
  },
  "loadAssessment": {
    "fatigue": "low|moderate|high",
    "weeklyLoadTrend": "increasing|stable|decreasing",
    "insight": "1-2 sentences about current training state and progression direction"
  }
}

STRICT RULES:
- For Rest days: set "structure": null
- For entries whose status is completed, skipped, or auto-skipped: set "structure": null (done — no workout to sync)
- executionScores[]: include ALL past (date < TODAY) NEEDS SCORING entries + already-SCORED entries. Empty array if none.
- weeklyPlan[0].executionScore: integer 0-100 ONLY if today's entry is completed and needs scoring. All others: null.
- weeklyPlan[0].executionNote: matching 1-sentence string if scored. All others: null.
- stepType MUST be one of: WarmUp, Run, Recovery, Cooldown
- zone MUST be one of: z1, z2, z3, z4, z5
- durationSec MUST be a positive integer (minimum 20 for sprint intervals)
- weeklyPlan MUST contain exactly 7 entries starting from TODAY (${today})
- totalMinutes MUST equal Math.round(sum(durationSec) / 60)`;
};

// ── Main generation function ──────────────────────────────────────────────────

export const generateRecommendation = async (previousPlan?: PlanEntry[]): Promise<any> => {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_KEY_NOT_CONFIGURED');

  const prompt = buildPrompt(previousPlan);

  // ── Log outgoing prompt ───────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('[Gemini] ── PROMPT SENT ─────────────────────────────────────────────');
  console.log('─'.repeat(72));
  console.log(prompt);
  console.log('─'.repeat(72) + '\n');

  const model = getSetting('gemini_model') || 'gemini-3.5-flash';
  console.log(`[Gemini] Model: ${model}`);

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
        maxOutputTokens: 8192
      }
    }
  );

  const candidate  = response.data?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts || [];
  const rawText: string = parts.map((p: any) => p.text ?? '').join('');

  // Log finish reason so we can spot premature stops
  const finishReason = candidate?.finishReason ?? 'unknown';

  // ── Log raw response ──────────────────────────────────────────────────────────
  console.log('[Gemini] ── RAW RESPONSE ────────────────────────────────────────────');
  console.log(`[Gemini] finishReason: ${finishReason} | length: ${rawText.length} chars`);
  console.log('─'.repeat(72));
  console.log(rawText ?? '(empty)');
  console.log('─'.repeat(72) + '\n');

  if (!rawText) throw new Error('Empty response from Gemini API');

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON (${rawText.length} chars):\n${rawText}`);
  }

  // Validate required fields
  const validTypes = ['Sprint', 'VO2Max', 'Threshold', 'Tempo', 'LongRide', 'Rest'];
  if (!validTypes.includes(parsed?.today?.type)) {
    throw new Error(`Invalid today.type: ${parsed?.today?.type}`);
  }
  if (!Array.isArray(parsed?.weeklyPlan) || parsed.weeklyPlan.length !== 7) {
    throw new Error(`weeklyPlan must be an array of 7 entries, got ${parsed?.weeklyPlan?.length}`);
  }

  // Build a lookup of the previous plan for status + score preservation
  const prevEntryMap = new Map<string, PlanEntry>();
  if (previousPlan) {
    previousPlan.forEach(e => prevEntryMap.set(e.date, e));
  }

  // Merge into the new 7-day plan:
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
  // Those dates are BEFORE today and NOT in the new 7-day weeklyPlan — we keep them as
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
    console.log(`[Gemini] executionScores received for: ${[...scoredMap.keys()].join(', ')}`);
  }

  // Keep past completed entries from the last 14 days, with AI scores applied
  const histCutoff = new Date();
  histCutoff.setDate(histCutoff.getDate() - 14);
  const histCutoffStr = localDate(histCutoff);

  const scoredHistory: PlanEntry[] = (previousPlan || [])
    .filter(e => !newPlanDates.has(e.date) && e.date >= histCutoffStr && e.status === 'completed')
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
      console.log(`[Gemini] executionScores[] fallback applied for today (${weeklyPlan[0].date}): score=${todayScore.score}`);
    }
  }

  // Full plan = scored history (past completed) + new 7-day window (today onwards)
  const fullPlan = [...scoredHistory, ...weeklyPlan];

  upsertRecommendation({
    workoutType:      parsed.today.type,
    reason:           parsed.today.reason,
    priority:         parsed.today.priority,
    weeklyPlan:       fullPlan,
    nextWeekOverview: parsed.nextWeekOverview,
    loadAssessment:   parsed.loadAssessment
  });

  // ── Log parsed result summary ─────────────────────────────────────────────────
  console.log('[Gemini] ── PARSED RESULT ───────────────────────────────────────────');
  console.log(`  Today:    ${parsed.today.type} (priority: ${parsed.today.priority})`);
  console.log(`  Reason:   ${parsed.today.reason}`);
  console.log(`  Fatigue:  ${parsed.loadAssessment?.fatigue}  |  Trend: ${parsed.loadAssessment?.weeklyLoadTrend}`);
  console.log(`  Insight:  ${parsed.loadAssessment?.insight}`);
  if (scoredHistory.length > 0) {
    console.log(`  Scored history (${scoredHistory.length} past entries):`);
    scoredHistory.forEach(e =>
      console.log(`    ${e.date}  ${e.type.padEnd(10)}  [${e.status}]  score=${e.executionScore ?? 'null'}  ${e.executionNote ?? ''}`)
    );
  }
  console.log(`  New 7-day plan (${weeklyPlan.length} entries):`);
  weeklyPlan.forEach(e =>
    console.log(`    ${e.date}  ${e.type.padEnd(10)}  [${e.status}]  ${e.reason}`)
  );
  console.log(`  Next week: ${parsed.nextWeekOverview?.summary}`);
  console.log('═'.repeat(72) + '\n');

  return getStoredRecommendation();
};
