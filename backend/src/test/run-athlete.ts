/**
 * Child process entry point: seed a fresh SQLite DB for one athlete, generate
 * a Gemini training plan, and write the full result JSON to stdout.
 *
 * Env vars (set by runner.ts before spawning):
 *   VELOMATE_DB_PATH         — path to the athlete's isolated test DB
 *   TEST_GEMINI_KEY      — Gemini API key (copied from real DB)
 *   TEST_GEMINI_MODEL    — Gemini model name
 */

import { ATHLETES, buildActivity, type AthleteDefinition } from './athletes';
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

const geminiKey   = process.env.TEST_GEMINI_KEY   || '';
const geminiModel = process.env.TEST_GEMINI_MODEL || 'gemini-2.0-flash';

async function main(athlete: AthleteDefinition) {
  // ── Settings ────────────────────────────────────────────────────────────────
  setSetting('gemini_api_key', geminiKey);
  setSetting('gemini_model', geminiModel);
  setSetting('preferred_long_ride_days', athlete.preferences.preferredLongRideDays.join(','));
  setSetting('user_goals', athlete.preferences.goals);
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
    athleteId:    athlete.id,
    name:         athlete.name,
    age:          athlete.age,
    fitnessLevel: athlete.fitnessLevel,
    profile:      athlete.profile,
    preferences:  athlete.preferences,
    ridesCount:   activities.length,
    analysis,
    recommendation,
  };

  process.stdout.write(JSON.stringify(output));
}

main(athleteFound).catch(err => {
  process.stderr.write(`[run-athlete:${athleteId}] Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
