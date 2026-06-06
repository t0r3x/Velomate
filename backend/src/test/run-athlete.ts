/**
 * Child process entry point: seed a fresh SQLite DB for one athlete, generate
 * a Gemini training plan, and write the full result JSON to stdout.
 *
 * Env vars (set by runner.ts before spawning):
 *   VELOMATE_DB_PATH         — path to the athlete's isolated test DB
 *   TEST_GEMINI_KEY      — Gemini API key (copied from real DB)
 *   TEST_GEMINI_MODEL    — Gemini model name
 */

import fs from 'fs';
import { ATHLETES, buildActivity, type AthleteDefinition, type TrainingPhase } from './athletes';
import {
  upsertActivities,
  updateActivityFeedback,
  upsertProfileDB,
  upsertAnalysis,
  setSetting,
} from '../services/database.service';
import { assessProgression } from '../services/activity.service';
import { calculateDefaultZones } from '../services/profile.service';
import { generateRecommendation } from '../services/gemini.service';

const athleteId = process.argv[2];
if (!athleteId) {
  process.stderr.write('Usage: run-athlete.ts <athleteId>\n');
  process.exit(1);
}

const athleteFound = ATHLETES.find(a => a.id === athleteId);
if (!athleteFound) {
  process.stderr.write(`Unknown athlete id: "${athleteId}"\n`);
  process.exit(1);
}

const geminiKey   = process.env.TEST_GEMINI_KEY   ?? '';
const geminiModel = process.env.TEST_GEMINI_MODEL ?? '';

// Enrich goals with training phase context — the AI infers fitness level and volume
// from the ride history, but the current training phase (taper, recovery, etc.) is
// intentional context the athlete explicitly provides, not derivable from data alone.
function buildEnrichedGoals(athlete: AthleteDefinition): string {
  const phaseInstructions: Record<TrainingPhase, string> = {
    base:     'Currently in base phase. Focus on aerobic foundation and consistency.',
    build:    'Currently in build phase. Progressively increase structured load.',
    taper:    'Currently tapering for an upcoming race. Reduce volume ~30-40%, maintain intensity sharpness.',
    recovery: 'Currently in post-race recovery. Prioritize rest and easy aerobic work only.',
  };

  return `${athlete.preferences.goals}\n${phaseInstructions[athlete.trainingPhase]}`;
}

async function main(athlete: AthleteDefinition) {
  // ── Settings ────────────────────────────────────────────────────────────────
  setSetting('gemini_api_key', geminiKey);
  setSetting('gemini_model', geminiModel);
  setSetting('preferred_long_ride_days', athlete.preferences.preferredLongRideDays.join(','));
  setSetting('user_goals', buildEnrichedGoals(athlete));
  setSetting('setup_complete', '1');
  setSetting('gemini_last_generated', '0'); // force generation, never stale

  // ── Activities ──────────────────────────────────────────────────────────────
  const activities = athlete.rides.map(r => buildActivity(athlete.id, r, athlete.profile));
  upsertActivities(activities);

  // upsertActivities sets feedback columns to NULL; update them separately
  for (const [i] of athlete.rides.entries()) {
    const act = activities[i];
    updateActivityFeedback(act.activityId, act.perceivedExertion, act.feelingAfterExercise);
  }

  // ── Analysis ─────────────────────────────────────────────────────────────────
  const analysis = assessProgression(activities);
  upsertAnalysis(analysis);

  // ── Profile ──────────────────────────────────────────────────────────────────
  const zones = calculateDefaultZones(athlete.profile.lthr, athlete.profile.maxHr);
  upsertProfileDB({
    maxHr: athlete.profile.maxHr,
    lthr:  athlete.profile.lthr,
    zones,
    hasCustomOverrides: false,
  });

  // ── Generate plan ─────────────────────────────────────────────────────────────
  const recommendation = await generateRecommendation();

  // ── Output ────────────────────────────────────────────────────────────────────
  const output = {
    athleteId:     athlete.id,
    name:          athlete.name,
    age:           athlete.age,
    fitnessLevel:  athlete.fitnessLevel,
    trainingPhase: athlete.trainingPhase,
    profile:       athlete.profile,
    preferences:   athlete.preferences,
    ridesCount:    activities.length,
    analysis,
    recommendation,
  };

  const resultPath = process.env.TEST_RESULT_PATH;
  if (!resultPath) throw new Error('TEST_RESULT_PATH env var not set');
  fs.writeFileSync(resultPath, JSON.stringify(output), 'utf8');
}

main(athleteFound).catch(err => {
  process.stderr.write(`[run-athlete:${athleteId}] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
