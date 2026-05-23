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

  return `You are a professional cycling coach AI specializing in heart-rate based training.
Analyze the athlete's data and generate an adaptive training plan. The most important factor is
BELASTBAARHEID (training load management) — never sacrifice recovery for volume.

TODAY: ${today} (${dayOfWeek})

${prevBlock}RECENT ACTIVITIES (last 21 days):
${JSON.stringify(recentActivities, null, 2)}

HR PROFILE:
- Max HR: ${profile?.maxHr ?? 'unknown'} bpm | LTHR: ${profile?.lthr ?? 'unknown'} bpm
- Zones: ${zoneString}

TRAINING ANALYSIS (last 90 days):
- Total rides: ${analysis?.totalCyclingRides ?? 0} | Peak HR recorded: ${analysis?.maxRecordedHr ?? 0} bpm
- Average ride duration: ${analysis?.averageRideDurationMinutes ?? 0} min

AVAILABLE WORKOUT TYPES:
- Sprint: ~47 min, 6×30s Z5 intervals + Z1 recovery. Only when fully rested (48h+ since hard effort).
- Threshold: ~56 min, 3×8min Z4 intervals. Use when moderately fresh. Core progression workout.
- LongRide: 90-240 min Z2 endurance. Safe when fatigued. Duration scaled to athlete history.
- Rest: Mandatory after 2+ consecutive hard sessions or when fatigue is high.

PROGRESSION GOAL: The plan should systematically build the athlete's threshold capacity over weeks.
Gradually increase intensity/frequency when fatigue is low and compliance is good.

OUTPUT: Respond ONLY with this exact JSON schema:
{
  "today": {
    "type": "Sprint|Threshold|LongRide|Rest",
    "reason": "2-3 sentences referencing specific data (last activity date, HR trend, etc.)",
    "priority": "high|medium|low"
  },
  "weeklyPlan": [
    { "date": "YYYY-MM-DD", "type": "Sprint|Threshold|LongRide|Rest", "reason": "brief" }
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

IMPORTANT: weeklyPlan must contain exactly 7 entries starting from TODAY (${today}).`;
};

// ── Main generation function ──────────────────────────────────────────────────

export const generateRecommendation = async (previousPlan?: PlanEntry[]): Promise<any> => {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_KEY_NOT_CONFIGURED');

  const prompt = buildPrompt(previousPlan);

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
        maxOutputTokens: 1200
      }
    }
  );

  const rawText: string = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty response from Gemini API');

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON: ${rawText.slice(0, 200)}`);
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

  // Merge statuses into the new plan
  const weeklyPlan: PlanEntry[] = parsed.weeklyPlan.map((e: any) => ({
    date:   e.date,
    type:   e.type,
    reason: e.reason,
    status: prevStatusMap.get(e.date) ?? 'planned'
  }));

  upsertRecommendation({
    workoutType:      parsed.today.type,
    reason:           parsed.today.reason,
    priority:         parsed.today.priority,
    weeklyPlan,
    nextWeekOverview: parsed.nextWeekOverview,
    loadAssessment:   parsed.loadAssessment
  });

  console.log(`[Gemini] Recommendation generated: ${parsed.today.type} (${parsed.loadAssessment?.fatigue} fatigue)`);
  return getStoredRecommendation();
};
