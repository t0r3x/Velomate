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

// ── Key helpers ───────────────────────────────────────────────────────────────

export const getGeminiKey = (): string | null => getSetting('gemini_api_key');

export const maskKey = (key: string): string =>
  key.length > 6 ? key.slice(0, 6) + '***' : '***';

// ── Completion / skip detection ───────────────────────────────────────────────

/** Returns dates of plan entries that are 'planned', in the past, and matched by a Garmin activity. */
export const detectCompletedEntries = (plan: PlanEntry[]): string[] => {
  const activities = getStoredActivities();
  const activityDates = new Set(
    activities
      .filter(a => a.startTime)
      .map(a => a.startTime.slice(0, 10))   // YYYY-MM-DD
  );

  const today = new Date().toLocaleDateString('sv-SE');

  return plan
    .filter(e => e.status === 'planned' && e.date < today && activityDates.has(e.date))
    .map(e => e.date);
};

/** Returns dates of plan entries that are 'planned', in the past, and NOT matched by any Garmin activity. */
export const detectAutoSkippedEntries = (plan: PlanEntry[]): string[] => {
  const activities = getStoredActivities();
  const activityDates = new Set(
    activities
      .filter(a => a.startTime)
      .map(a => a.startTime.slice(0, 10))
  );

  const today = new Date().toLocaleDateString('sv-SE');

  return plan
    .filter(e => e.status === 'planned' && e.date < today && !activityDates.has(e.date))
    .map(e => e.date);
};

// ── Prompt builder ────────────────────────────────────────────────────────────

const buildPrompt = (previousPlan?: PlanEntry[]): string => {
  const today     = new Date().toLocaleDateString('sv-SE');
  const dayOfWeek = new Date().toLocaleDateString('en-GB', { weekday: 'long' });

  // Recent 21 days of activities
  const allActivities = getStoredActivities();
  const cutoff21 = new Date();
  cutoff21.setDate(cutoff21.getDate() - 21);
  const recentActivities = allActivities
    .filter(a => a.startTime && new Date(a.startTime) >= cutoff21)
    .map(a => ({
      date:        a.startTime?.slice(0, 10) ?? '',
      durationMin: a.durationMinutes ?? 0,
      avgHr:       a.averageHr ?? 0,
      distKm:      a.distanceKm ?? 0
    }));

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
    const actMap = new Map(
      allActivities
        .filter(a => a.startTime)
        .map(a => [a.startTime.slice(0, 10), a])
    );

    const lines = previousPlan.map(e => {
      const dow = new Date(e.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      if (e.status === 'completed') {
        const act = actMap.get(e.date);
        const detail = act ? ` (matched Garmin activity: ${act.durationMinutes} min avg ${act.averageHr} bpm)` : '';
        return `- ${e.date} (${dow}): ${e.type} → COMPLETED${detail}`;
      }
      if (e.status === 'skipped')      return `- ${e.date} (${dow}): ${e.type} → SKIPPED (explicit)`;
      if (e.status === 'auto-skipped') return `- ${e.date} (${dow}): ${e.type} → AUTO-SKIPPED (no activity recorded)`;
      const isToday = e.date === today;
      return `- ${e.date} (${dow}): ${e.type} → ${isToday ? '[today, planned]' : e.status}`;
    });

    prevBlock = `PREVIOUS PLAN COMPLIANCE:\n${lines.join('\n')}\n\n`;
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

HR PROFILE:
- Max HR: ${profile?.maxHr ?? 'unknown'} bpm | LTHR: ${profile?.lthr ?? 'unknown'} bpm
- Zones: ${zoneString}

TRAINING ANALYSIS (last 90 days):
- Total rides: ${analysis?.totalCyclingRides ?? 0} | Peak HR recorded: ${analysis?.maxRecordedHr ?? 0} bpm
- Average ride duration: ${analysis?.averageRideDurationMinutes ?? 0} min

WORKOUT TYPE GUIDELINES — you decide the exact structure for each day based on athlete load:

Sprint (ONLY when fully rested — 48h+ since last hard effort):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 4-8 sets of [Sprint [Run] 20-45 sec Z5 → Recovery [Recovery] 180-300 sec Z1]
  Cool-down [Cooldown]: 480-720 sec Z1
  Fewer/shorter intervals when less fresh; more repeats when athlete is progressing well.

Threshold (when moderately fresh — core aerobic progression):
  Warm-up [WarmUp]: 480-720 sec Z2
  Intervals: 2-4 sets of [Work [Run] 360-720 sec Z4 → Recovery [Recovery] 180-300 sec Z1/Z2]
  Cool-down [Cooldown]: 480-600 sec Z1
  Reduce interval count/duration when fatigued; increase when athlete is adapting well.

LongRide (safe even when moderately fatigued):
  Single steady block [Run]: 3600-14400 sec Z2
  Scale to fatigue level and averageRideDurationMinutes — shorter when tired, longer when fresh.

Rest: no structure needed — set structure to null.

PROGRESSION GOAL: Systematically build the athlete's threshold capacity over weeks.
Gradually increase intensity/frequency when fatigue is low and compliance is good.

OUTPUT: Respond ONLY with this exact JSON schema:
{
  "today": {
    "type": "Sprint|Threshold|LongRide|Rest",
    "reason": "2-3 sentences referencing specific data (last activity date, HR trend, etc.)",
    "priority": "high|medium|low"
  },
  "weeklyPlan": [
    {
      "date": "YYYY-MM-DD",
      "type": "Sprint|Threshold|LongRide|Rest",
      "reason": "1 sentence",
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
        maxOutputTokens: 4096
      }
    }
  );

  const rawText: string = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

  // ── Log raw response ──────────────────────────────────────────────────────────
  console.log('[Gemini] ── RAW RESPONSE ────────────────────────────────────────────');
  console.log('─'.repeat(72));
  console.log(rawText ?? '(empty)');
  console.log('─'.repeat(72) + '\n');

  if (!rawText) throw new Error('Empty response from Gemini API');

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    const snippet = rawText.slice(0, 300);
    const truncated = rawText.length >= 300 ? '… (truncated)' : '';
    throw new Error(`Gemini returned invalid JSON (${rawText.length} chars):\n${snippet}${truncated}`);
  }

  // Validate required fields
  const validTypes = ['Sprint', 'Threshold', 'LongRide', 'Rest'];
  if (!validTypes.includes(parsed?.today?.type)) {
    throw new Error(`Invalid today.type: ${parsed?.today?.type}`);
  }
  if (!Array.isArray(parsed?.weeklyPlan) || parsed.weeklyPlan.length !== 7) {
    throw new Error(`weeklyPlan must be an array of 7 entries, got ${parsed?.weeklyPlan?.length}`);
  }

  // Preserve existing statuses from previousPlan (completed/skipped/auto-skipped entries)
  const prevStatusMap = new Map<string, PlanEntry['status']>();
  if (previousPlan) {
    previousPlan.forEach(e => {
      if (e.status !== 'planned') prevStatusMap.set(e.date, e.status);
    });
  }

  // Merge statuses into the new plan (preserve structure from AI output)
  const weeklyPlan: PlanEntry[] = parsed.weeklyPlan.map((e: any) => {
    // Recompute totalMinutes from steps to catch any AI rounding errors
    const structure = e.structure && Array.isArray(e.structure.steps) ? {
      totalMinutes: Math.round(
        e.structure.steps.reduce((s: number, st: any) => s + (st.durationSec || 0), 0) / 60
      ),
      steps: e.structure.steps
    } : null;
    return {
      date:      e.date,
      type:      e.type,
      reason:    e.reason,
      status:    prevStatusMap.get(e.date) ?? 'planned',
      structure
    };
  });

  upsertRecommendation({
    workoutType:      parsed.today.type,
    reason:           parsed.today.reason,
    priority:         parsed.today.priority,
    weeklyPlan,
    nextWeekOverview: parsed.nextWeekOverview,
    loadAssessment:   parsed.loadAssessment
  });

  // ── Log parsed result summary ─────────────────────────────────────────────────
  console.log('[Gemini] ── PARSED RESULT ───────────────────────────────────────────');
  console.log(`  Today:    ${parsed.today.type} (priority: ${parsed.today.priority})`);
  console.log(`  Reason:   ${parsed.today.reason}`);
  console.log(`  Fatigue:  ${parsed.loadAssessment?.fatigue}  |  Trend: ${parsed.loadAssessment?.weeklyLoadTrend}`);
  console.log(`  Insight:  ${parsed.loadAssessment?.insight}`);
  console.log('  Weekly plan:');
  weeklyPlan.forEach(e =>
    console.log(`    ${e.date}  ${e.type.padEnd(10)}  [${e.status}]  ${e.reason}`)
  );
  console.log(`  Next week: ${parsed.nextWeekOverview?.summary}`);
  console.log('═'.repeat(72) + '\n');

  return getStoredRecommendation();
};
