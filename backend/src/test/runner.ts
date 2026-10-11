/**
 * Velomate Test Runner — Athlete Plan Simulator
 *
 * Runs simulated plan generation for every athlete defined in athletes.ts,
 * using isolated SQLite databases so real user data is never touched.
 *
 * Usage (from /backend):
 *   npm run test
 *
 * Output:
 *   backend/data/test/<athleteId>.db   — isolated DB per athlete
 *   backend/data/test/report.html      — self-contained HTML report
 */

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config as loadDotenv } from 'dotenv';
import { ATHLETES, type FitnessLevel, type TrainingPhase } from './athletes';
import { evaluatePlan, type EvaluationResult } from './evaluator';
import { localDate } from '../utils';
import type { PlanEntry } from '../services/database.service';

const backendDir     = path.join(__dirname, '../..');
const testDataDir    = path.join(backendDir, 'data', 'test');
const runAthletePath = path.join(__dirname, 'run-athlete.ts');
// Use node + tsx CLI directly — avoids shell quoting issues with spaces in paths
const tsxCli         = path.join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// Load .env — TEST_GEMINI_KEY and TEST_GEMINI_MODEL must be set there
loadDotenv({ path: path.join(backendDir, '.env') });

// ── Gemini config ─────────────────────────────────────────────────────────────

function readGeminiConfig(): { key: string; model: string } | null {
  const key   = process.env.TEST_GEMINI_KEY;
  const model = process.env.TEST_GEMINI_MODEL;
  if (!key || !model) return null;
  return { key, model };
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface AthleteResult {
  athleteId:     string;
  name:          string;
  age:           number;
  fitnessLevel:  string;
  trainingPhase: string;
  profile:       { maxHr: number; lthr: number };
  preferences:   { preferredLongRideDays: string[]; goals: string };
  ridesCount:    number;
  analysis:      any;
  recommendation: any;
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     Velomate Athlete Plan Tester     ║');
  console.log('╚══════════════════════════════════════╝\n');

  fs.mkdirSync(testDataDir, { recursive: true });

  // `npm test -- --report-only` rebuilds report.html from the result JSONs already on disk —
  // no Gemini calls — so a change to the evaluator or the report can be checked for free.
  if (process.argv.includes('--report-only')) {
    const existing: AthleteResult[] = [];
    const missing: { name: string; reason: string }[] = [];
    for (const athlete of ATHLETES) {
      const resultPath = path.join(testDataDir, `${athlete.id}.json`);
      if (fs.existsSync(resultPath)) existing.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
      else missing.push({ name: athlete.name, reason: 'no result from the last run' });
    }
    const reportPath = path.join(testDataDir, 'report.html');
    fs.writeFileSync(reportPath, generateReport(existing, missing), 'utf8');
    console.log(`Report rebuilt from ${existing.length} stored result(s) → ${reportPath}`);
    return;
  }

  const geminiConfig = readGeminiConfig();
  if (!geminiConfig) {
    console.error(
      'ERROR: TEST_GEMINI_KEY and TEST_GEMINI_MODEL must both be set in backend/.env:\n\n' +
      '  TEST_GEMINI_KEY=your_api_key_here\n' +
      '  TEST_GEMINI_MODEL=gemini-3.8-flash\n'
    );
    process.exit(1);
  }

  console.log(`Gemini model : ${geminiConfig.model}`);
  console.log(`Athletes     : ${ATHLETES.map(a => a.name).join(', ')}`);
  console.log(`Output dir   : ${testDataDir}\n`);

  const results: AthleteResult[] = [];
  // Athletes whose run failed — listed in the report rather than silently missing from it.
  const failures: { name: string; reason: string }[] = [];
  const errorLine = (txt?: string): string => {
    const lines = (txt ?? '').trim().split('\n');
    return lines.find(l => l.includes('Error:')) ?? lines[0] ?? 'unknown error';
  };

  // Five back-to-back plan generations ran into Gemini's per-minute limit (429) on the last
  // two athletes. A pause between them keeps a run inside it. TEST_ATHLETE_DELAY_MS overrides.
  const delayMs = Number(process.env.TEST_ATHLETE_DELAY_MS ?? 15_000);

  for (const [index, athlete] of ATHLETES.entries()) {
    if (index > 0 && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const dbPath     = path.join(testDataDir, `${athlete.id}.db`);
    const resultPath = path.join(testDataDir, `${athlete.id}.json`);

    // Remove stale files from a previous run
    if (fs.existsSync(dbPath))     fs.unlinkSync(dbPath);
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);

    process.stdout.write(`► ${athlete.name.padEnd(18)} (${athlete.fitnessLevel.padEnd(12)}) … `);

    const child = spawnSync(process.execPath, [tsxCli, runAthletePath, athlete.id], {
      shell: false,
      encoding: 'utf8',
      timeout: 120_000,
      cwd: backendDir,
      env: {
        ...process.env,
        VELOMATE_DB_PATH:  dbPath,
        TEST_RESULT_PATH:  resultPath,
        TEST_GEMINI_KEY:   geminiConfig.key,
        TEST_GEMINI_MODEL: geminiConfig.model,
      },
    });

    if (child.status !== 0) {
      console.log('FAILED');
      if (child.stderr?.trim()) process.stderr.write(`[${athlete.id}] ${child.stderr.trim()}\n`);
      // child.error is set when spawnSync itself gave up (e.g. the 120s timeout).
      failures.push({ name: athlete.name, reason: child.error ? child.error.message : errorLine(child.stderr) });
      continue;
    }

    if (!fs.existsSync(resultPath)) {
      console.log('FAILED (no result file written)');
      failures.push({ name: athlete.name, reason: 'no result file written' });
      if (child.stderr?.trim()) process.stderr.write(`[${athlete.id}] ${child.stderr.trim()}\n`);
      continue;
    }

    let result: AthleteResult;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch {
      console.log('FAILED (JSON parse error)');
      failures.push({ name: athlete.name, reason: 'result file was not valid JSON' });
      continue;
    }

    results.push(result);
    console.log('done');
  }

  console.log(`\n${results.length}/${ATHLETES.length} athletes completed.\n`);

  // ── HTML report ─────────────────────────────────────────────────────────────
  const reportPath = path.join(testDataDir, 'report.html');
  fs.writeFileSync(reportPath, generateReport(results, failures), 'utf8');
  console.log(`Report saved → ${reportPath}`);

  // Open in default browser
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', reportPath], { shell: false });
  } else {
    spawnSync('open', [reportPath]);
  }
}

// ── HTML report generator ─────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

const TYPE_BG: Record<string, string> = {
  Sprint:    '#fde8e8', VO2Max: '#fde8e8',
  Threshold: '#fef3e2', Tempo:  '#e8f0fe',
  LongRide:  '#e6f4ea', Rest:   '#f5f5f5',
};
const TYPE_BORDER: Record<string, string> = {
  Sprint:    '#f28b82', VO2Max: '#f28b82',
  Threshold: '#f9ab00', Tempo:  '#8ab4f8',
  LongRide:  '#57bb8a', Rest:   '#dadada',
};
const LEVEL_BG: Record<string, string> = {
  beginner: '#e8f5e9', recreational: '#e3f2fd',
  intermediate: '#fff3e0', advanced: '#fce4ec', pro: '#ede7f6',
};
const LEVEL_BORDER: Record<string, string> = {
  beginner: '#43a047', recreational: '#1e88e5',
  intermediate: '#fb8c00', advanced: '#e53935', pro: '#7b1fa2',
};
const PHASE_BORDER: Record<string, string> = {
  base: '#607d8b', build: '#3f51b5', taper: '#f9a825', recovery: '#43a047',
};

function planRow(entry: PlanEntry): string {
  const bg     = TYPE_BG[entry.type]     || '#fff';
  const border = TYPE_BORDER[entry.type] || '#ccc';
  const duration = entry.structure?.totalMinutes
    ? `${entry.structure.totalMinutes} min`
    : entry.type === 'Rest' ? '—' : '?';
  const reason = (entry.reason || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Steps detail
  let stepsHtml = '';
  if (entry.structure?.steps?.length) {
    const stepLines = entry.structure.steps.map((s: any) =>
      `<span style="display:inline-block;margin:1px 3px 1px 0;padding:1px 6px;background:#fff;border:1px solid #ddd;border-radius:3px;font-size:10px;white-space:nowrap">${s.label} <em style="color:#888">${Math.round(s.durationSec/60)}m ${s.zone}</em></span>`
    ).join('');
    stepsHtml = `<div style="margin-top:4px">${stepLines}</div>`;
  }

  return `
    <tr style="background:${bg};border-left:3px solid ${border}">
      <td style="white-space:nowrap;font-size:12px">${formatDate(entry.date)}</td>
      <td><strong>${entry.type}</strong></td>
      <td style="white-space:nowrap">${duration}</td>
      <td style="color:#555;font-size:12px">${reason}${stepsHtml}</td>
    </tr>`;
}

/** The evaluator's verdict for one athlete — the report used to show plans with no judgement at all. */
function evaluate(r: AthleteResult): EvaluationResult {
  return evaluatePlan(
    r.fitnessLevel as FitnessLevel,
    r.recommendation?.weeklyPlan ?? [],
    (r.trainingPhase || 'build') as TrainingPhase,
    { ridesIn21Days: r.ridesCount, averageRideMinutes: r.analysis?.averageRideDurationMinutes ?? 0 }
  );
}

const STATUS_COLOR: Record<string, string> = { ok: '#188038', warn: '#b06000', fail: '#c5221f' };
const VERDICT_COLOR: Record<string, string> = { excellent: '#188038', good: '#1e8e3e', acceptable: '#b06000', poor: '#c5221f' };

function evaluationHtml(ev: EvaluationResult): string {
  const rows = ev.checks.map(c => `
    <tr>
      <td>${c.label}</td>
      <td style="text-align:center">${c.planned}</td>
      <td style="text-align:center">${c.expected}</td>
      <td style="color:${STATUS_COLOR[c.status]};font-weight:bold;text-transform:uppercase;font-size:11px">${c.status}</td>
    </tr>`).join('');
  return `
    <div style="margin-top:14px">
      <h3 style="margin:0 0 6px;font-size:15px">Evaluation (first 7 days) —
        <span style="color:${VERDICT_COLOR[ev.verdict]}">${ev.verdict} · ${ev.score}/100</span></h3>
      <div style="font-size:12px;color:#666;margin-bottom:6px">${ev.criteria.description}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f0f0f0;font-size:11px;text-transform:uppercase;letter-spacing:.4px">
          <th style="text-align:left">Check</th><th>Planned</th><th>Expected</th><th style="text-align:left">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function athleteSection(r: AthleteResult): string {
  // Local date, like the app and the evaluator — the UTC date lags a day after midnight here.
  const today = localDate();
  const planEntries: PlanEntry[] = (r.recommendation?.weeklyPlan ?? [])
    .filter((e: PlanEntry) => e.date >= today)
    .slice(0, 14);

  const loadAssessment = r.recommendation?.loadAssessment;
  const loadHtml = loadAssessment ? `
    <div style="margin-top:12px;padding:10px 14px;background:#f8f9fa;border-radius:6px;font-size:13px">
      <strong>Load assessment:</strong>
      Fatigue <em>${loadAssessment.fatigue}</em> ·
      Trend <em>${loadAssessment.weeklyLoadTrend}</em><br>
      <span style="color:#555">${(loadAssessment.insight || '').replace(/</g, '&lt;')}</span>
    </div>` : '';

  const phase = r.trainingPhase || 'unknown';

  return `
  <section style="border:2px solid ${LEVEL_BORDER[r.fitnessLevel]};border-radius:10px;margin:28px 0;overflow:hidden">
    <div style="background:${LEVEL_BG[r.fitnessLevel]};padding:16px 20px;border-bottom:1px solid ${LEVEL_BORDER[r.fitnessLevel]}">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:20px">${r.name}</h2>
        <span style="background:${LEVEL_BORDER[r.fitnessLevel]};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px">${r.fitnessLevel}</span>
        <span style="background:${PHASE_BORDER[phase]};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px">${phase}</span>
      </div>
      <div style="margin-top:8px;font-size:13px;color:#444;display:flex;gap:20px;flex-wrap:wrap">
        <span>Age ${r.age}</span>
        <span>Max HR <strong>${r.profile.maxHr}</strong> bpm</span>
        <span>LTHR <strong>${r.profile.lthr}</strong> bpm</span>
        <span>Long ride: <strong>${r.preferences.preferredLongRideDays.join(', ')}</strong></span>
        <span>Rides in 21d: <strong>${r.ridesCount}</strong></span>
        ${r.analysis ? `<span>Avg duration: <strong>${r.analysis.averageRideDurationMinutes} min</strong></span>` : ''}
      </div>
      <div style="margin-top:6px;font-size:13px;color:#555;font-style:italic">Goal: "${r.preferences.goals}"</div>
    </div>

    <div style="padding:20px">
      <h3 style="margin:0 0 10px;font-size:15px">14-Day Training Plan</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f0f0f0;font-size:11px;text-transform:uppercase;letter-spacing:.4px">
          <th style="padding:6px 8px;text-align:left">Date</th>
          <th style="padding:6px 8px;text-align:left">Type</th>
          <th style="padding:6px 8px;text-align:left">Duration</th>
          <th style="padding:6px 8px;text-align:left">AI Rationale + Steps</th>
        </tr></thead>
        <tbody>${planEntries.map(planRow).join('')}</tbody>
      </table>
      ${loadHtml}
      ${evaluationHtml(evaluate(r))}
    </div>
  </section>`;
}

function generateReport(results: AthleteResult[], failures: { name: string; reason: string }[] = []): string {
  const now = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const summary = results.map(r => {
    const load = r.recommendation?.loadAssessment;
    const ev   = evaluate(r);
    return `<li style="margin:4px 0">
      <strong>${r.name}</strong>
      <span style="background:${LEVEL_BORDER[r.fitnessLevel]};color:#fff;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;margin-left:6px">${r.fitnessLevel}</span>
      <span style="background:${PHASE_BORDER[r.trainingPhase||'base']};color:#fff;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;margin-left:4px">${r.trainingPhase}</span>
      · <strong style="color:${VERDICT_COLOR[ev.verdict]}">${ev.verdict} ${ev.score}/100</strong>
      ${load ? `· fatigue <em>${load.fatigue}</em> · trend <em>${load.weeklyLoadTrend}</em>` : ''}
    </li>`;
  }).join('') + failures.map(f => `<li style="margin:4px 0;color:#c5221f">
      <strong>${esc(f.name)}</strong> — not run: ${esc(f.reason)}
    </li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Velomate Plan Test Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1000px; margin: 0 auto; padding: 24px 20px 60px; color: #202124; background: #fafafa }
    h1, h2, h3 { margin: 0 }
    table td, table th { padding: 7px 10px; border-bottom: 1px solid #e0e0e0 }
    tr:last-child td { border-bottom: none }
  </style>
</head>
<body>
  <h1>Velomate Plan Test Report</h1>
  <p style="color:#666;margin:4px 0 6px;font-size:14px">Generated: ${now} · ${results.length} of ${results.length + failures.length} athletes · model ${esc(process.env.TEST_GEMINI_MODEL ?? '?')}</p>

  <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px 20px;margin:20px 0">
    <strong>Summary</strong>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:14px">${summary}</ul>
  </div>

  ${results.map(athleteSection).join('\n')}

  <footer style="margin-top:40px;font-size:12px;color:#aaa;text-align:center">
    Velomate Plan Test · Plans generated by Gemini AI · For evaluation purposes only
  </footer>
</body>
</html>`;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
