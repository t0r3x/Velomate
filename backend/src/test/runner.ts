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
 *   backend/data/test/report.html      — self-contained HTML evaluation report
 */

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config as loadDotenv } from 'dotenv';
import { ATHLETES } from './athletes';
import { evaluatePlan, type EvaluationResult } from './evaluator';
import type { PlanEntry } from '../services/database.service';

const backendDir     = path.join(__dirname, '../..');
const testDataDir    = path.join(backendDir, 'data', 'test');
const runAthletePath = path.join(__dirname, 'run-athlete.ts');
const isWin          = process.platform === 'win32';
const tsxBin         = path.join(backendDir, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

// Load .env — TEST_GEMINI_KEY and TEST_GEMINI_MODEL must be set there
loadDotenv({ path: path.join(backendDir, '.env') });

// ── Gemini config ─────────────────────────────────────────────────────────────

function readGeminiConfig(): { key: string; model: string } | null {
  const key   = process.env.TEST_GEMINI_KEY;
  const model = process.env.TEST_GEMINI_MODEL || 'gemini-2.0-flash';
  if (!key) return null;
  return { key, model };
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface AthleteResult {
  athleteId:    string;
  name:         string;
  age:          number;
  fitnessLevel: string;
  profile:      { maxHr: number; lthr: number };
  preferences:  { preferredLongRideDays: string[]; goals: string };
  ridesCount:   number;
  analysis:     any;
  recommendation: any;
  evaluation:   EvaluationResult;
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     Velomate Athlete Plan Tester     ║');
  console.log('╚══════════════════════════════════════╝\n');

  fs.mkdirSync(testDataDir, { recursive: true });

  const geminiConfig = readGeminiConfig();
  if (!geminiConfig) {
    console.error(
      'ERROR: TEST_GEMINI_KEY is not set.\n' +
      'Add it to backend/.env:\n\n' +
      '  TEST_GEMINI_KEY=your_api_key_here\n' +
      '  TEST_GEMINI_MODEL=gemini-2.0-flash   # optional, this is the default\n'
    );
    process.exit(1);
  }

  console.log(`Gemini model : ${geminiConfig.model}`);
  console.log(`Athletes     : ${ATHLETES.map(a => a.name).join(', ')}`);
  console.log(`Output dir   : ${testDataDir}\n`);

  const results: AthleteResult[] = [];

  for (const athlete of ATHLETES) {
    const dbPath = path.join(testDataDir, `${athlete.id}.db`);

    // Remove stale DB from a previous run
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    process.stdout.write(`► ${athlete.name.padEnd(18)} (${athlete.fitnessLevel.padEnd(12)}) … `);

    const child = spawnSync(tsxBin, [runAthletePath, athlete.id], {
      shell: isWin,
      encoding: 'utf8',
      timeout: 120_000,
      cwd: backendDir,
      env: {
        ...process.env,
        VELOMATE_DB_PATH:      dbPath,
        TEST_GEMINI_KEY:   geminiConfig.key,
        TEST_GEMINI_MODEL: geminiConfig.model,
      },
    });

    if (child.stderr?.trim()) {
      process.stderr.write(`\n[${athlete.id}] ${child.stderr.trim()}\n`);
    }

    if (child.status !== 0 || !child.stdout?.trim()) {
      console.log('FAILED');
      continue;
    }

    let result: AthleteResult;
    try {
      result = JSON.parse(child.stdout);
    } catch {
      console.log('FAILED (JSON parse error)');
      continue;
    }

    const plan: PlanEntry[] = result.recommendation?.weeklyPlan ?? [];
    const evaluation = evaluatePlan(athlete.fitnessLevel as any, plan);
    results.push({ ...result, evaluation });

    const icon = evaluation.score >= 75 ? '✓' : evaluation.score >= 55 ? '~' : '✗';
    console.log(`${icon} ${evaluation.verdict.toUpperCase()} (${evaluation.score}/100)`);

    for (const issue of evaluation.issues) {
      console.log(`     ⚠ ${issue}`);
    }
  }

  console.log(`\n${results.length}/${ATHLETES.length} athletes completed.\n`);

  // ── HTML report ─────────────────────────────────────────────────────────────
  const reportPath = path.join(testDataDir, 'report.html');
  fs.writeFileSync(reportPath, generateReport(results), 'utf8');
  console.log(`Report saved → ${reportPath}`);

  // Open in default browser
  if (isWin) {
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
const STATUS_BG: Record<string, string>    = { ok: '#e8f5e9', warn: '#fff3e0', fail: '#ffebee' };
const STATUS_COLOR: Record<string, string> = { ok: '#1b5e20', warn: '#e65100', fail: '#b71c1c' };
const VERDICT_COLOR: Record<string, string> = {
  excellent: '#1b5e20', good: '#2e7d32', acceptable: '#e65100', poor: '#b71c1c',
};

function planRow(entry: PlanEntry): string {
  const bg     = TYPE_BG[entry.type]     || '#fff';
  const border = TYPE_BORDER[entry.type] || '#ccc';
  const duration = entry.structure?.totalMinutes
    ? `${entry.structure.totalMinutes} min`
    : entry.type === 'Rest' ? '—' : '?';
  const reason = (entry.reason || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
    <tr style="background:${bg};border-left:3px solid ${border}">
      <td style="white-space:nowrap;font-size:12px">${formatDate(entry.date)}</td>
      <td><strong>${entry.type}</strong></td>
      <td style="white-space:nowrap">${duration}</td>
      <td style="color:#555;font-size:12px">${reason}</td>
    </tr>`;
}

function evalRow(c: { label: string; planned: number; expected: string; status: string }): string {
  const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
  return `
    <tr>
      <td style="font-size:13px">${c.label}</td>
      <td style="text-align:center;font-weight:bold">${c.planned}</td>
      <td style="text-align:center;color:#777">${c.expected}</td>
      <td style="text-align:center;background:${STATUS_BG[c.status]};color:${STATUS_COLOR[c.status]};font-weight:bold;font-size:12px">
        ${icon} ${c.status.toUpperCase()}
      </td>
    </tr>`;
}

function athleteSection(r: AthleteResult): string {
  const vColor = VERDICT_COLOR[r.evaluation.verdict];
  const today = new Date().toISOString().slice(0, 10);
  const planEntries: PlanEntry[] = (r.recommendation?.weeklyPlan ?? [])
    .filter((e: PlanEntry) => e.date >= today)
    .slice(0, 7);

  const loadAssessment = r.recommendation?.loadAssessment;
  const loadHtml = loadAssessment ? `
    <div style="margin-top:12px;padding:10px 14px;background:#f8f9fa;border-radius:6px;font-size:13px">
      <strong>Load assessment:</strong>
      Fatigue <em>${loadAssessment.fatigue}</em> ·
      Trend <em>${loadAssessment.weeklyLoadTrend}</em><br>
      <span style="color:#555">${(loadAssessment.insight || '').replace(/</g, '&lt;')}</span>
    </div>` : '';

  return `
  <section style="border:2px solid ${LEVEL_BORDER[r.fitnessLevel]};border-radius:10px;margin:28px 0;overflow:hidden">
    <div style="background:${LEVEL_BG[r.fitnessLevel]};padding:16px 20px;border-bottom:1px solid ${LEVEL_BORDER[r.fitnessLevel]}">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:20px">${r.name}</h2>
        <span style="background:${LEVEL_BORDER[r.fitnessLevel]};color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px">${r.fitnessLevel}</span>
        <span style="color:${vColor};font-weight:bold;margin-left:auto">${r.evaluation.verdict.toUpperCase()} — ${r.evaluation.score}/100</span>
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

    <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div>
        <h3 style="margin:0 0 10px;font-size:15px">7-Day Training Plan</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f0f0f0;font-size:11px;text-transform:uppercase;letter-spacing:.4px">
            <th style="padding:6px 8px;text-align:left">Date</th>
            <th style="padding:6px 8px;text-align:left">Type</th>
            <th style="padding:6px 8px;text-align:left">Duration</th>
            <th style="padding:6px 8px;text-align:left">AI Rationale</th>
          </tr></thead>
          <tbody>${planEntries.map(planRow).join('')}</tbody>
        </table>
        ${loadHtml}
      </div>

      <div>
        <h3 style="margin:0 0 4px;font-size:15px">Plan Evaluation</h3>
        <p style="margin:0 0 10px;font-size:12px;color:#666">${r.evaluation.criteria.description}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f0f0f0;font-size:11px;text-transform:uppercase;letter-spacing:.4px">
            <th style="padding:6px 8px;text-align:left">Criterion</th>
            <th style="padding:6px 8px;text-align:center">Got</th>
            <th style="padding:6px 8px;text-align:center">Expected</th>
            <th style="padding:6px 8px;text-align:center">Status</th>
          </tr></thead>
          <tbody>${r.evaluation.checks.map(evalRow).join('')}</tbody>
        </table>

        ${r.evaluation.issues.length ? `
        <div style="margin-top:10px;padding:10px;background:#fff3e0;border-radius:6px;font-size:13px">
          <strong>Issues:</strong>
          <ul style="margin:6px 0 0;padding-left:18px">${r.evaluation.issues.map(i => `<li>${i}</li>`).join('')}</ul>
        </div>` : `
        <div style="margin-top:10px;padding:10px;background:#e8f5e9;border-radius:6px;font-size:13px;color:#2e7d32">
          <strong>✓ All criteria met</strong> — plan looks appropriate for this athlete.
        </div>`}
      </div>
    </div>
  </section>`;
}

function generateReport(results: AthleteResult[]): string {
  const now = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

  const summary = results.map(r => {
    const vColor = VERDICT_COLOR[r.evaluation.verdict];
    return `<li style="margin:4px 0">
      <strong>${r.name}</strong> (${r.fitnessLevel}) —
      <span style="color:${vColor};font-weight:bold">${r.evaluation.verdict}</span>
      ${r.evaluation.score}/100
      ${r.evaluation.issues.length ? `· <span style="color:#e65100">${r.evaluation.issues.length} issue(s)</span>` : ''}
    </li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Velomate Plan Test Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; color: #202124; background: #fafafa }
    h1, h2, h3 { margin: 0 }
    table td, table th { padding: 7px 10px; border-bottom: 1px solid #e0e0e0 }
    tr:last-child td { border-bottom: none }
    @media (max-width: 700px) { section > div:last-child { grid-template-columns: 1fr !important } }
  </style>
</head>
<body>
  <h1>Velomate Plan Test Report</h1>
  <p style="color:#666;margin:4px 0 6px;font-size:14px">Generated: ${now} · ${results.length} athletes</p>

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
