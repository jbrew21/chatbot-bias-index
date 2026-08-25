// Chatbot Bias Index — monthly run.
// Queries each subject model with the fixed prompt set, grades paired prompts
// with an independent grader model, scores everything, and writes the CSVs
// the published Datawrapper charts read. Idempotent per calendar month.
//
// Env: OPENROUTER_API_KEY (required), FORCE=1 (rerun a month), MONTH=YYYY-MM
// (override), SMOKE=1 (tiny run: 2 models, 3 items, 2 pairs, 1 repetition).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, listModels, pool } from './openrouter.js';
import { evenHandednessPrompt, refusalPrompt, forcedChoicePrompt, LIKERT, LIKERT_VALUE } from './rubrics.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));

// Load .env if present (local runs; Actions uses secrets).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const SMOKE = process.env.SMOKE === '1';
const month = process.env.MONTH || new Date().toISOString().slice(0, 7);
const runFile = path.join(ROOT, 'data', 'runs', `${month}.json`);
if (fs.existsSync(runFile) && process.env.FORCE !== '1' && !SMOKE) {
  console.log(`Run for ${month} already exists (${runFile}). Set FORCE=1 to redo.`);
  process.exit(0);
}

const models = cfg('models.json');
const fcBank = cfg('forced_choice.json').items;
const pairBank = cfg('paired_prompts.json').pairs;

const FC_RUNS = SMOKE ? 1 : models.forced_choice_runs;
const PAIR_RUNS = SMOKE ? 1 : models.paired_runs;
const subjects = SMOKE ? models.subjects.slice(0, 2) : models.subjects;
const fcItems = SMOKE ? fcBank.slice(0, 3) : fcBank;
const pairs = SMOKE ? pairBank.slice(0, 2) : pairBank;

// --- Deterministic shuffle (mulberry32 seeded by string hash) ---------------
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, seedStr) { const r = rng(hash(seedStr)); const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// --- Model resolution (deprecation roll-forward) ----------------------------
async function resolveSubjects() {
  const catalog = await listModels();
  const ids = new Set(catalog.map((m) => m.id));
  const out = [];
  const swaps = [];
  for (const s of subjects) {
    if (ids.has(s.id)) { out.push({ ...s, resolved: s.id }); continue; }
    const candidates = catalog
      .filter((m) => m.id.startsWith(s.lab_prefix))
      .filter((m) => !models.fallback_exclude_patterns.some((p) => m.id.includes(p)))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    if (candidates.length === 0) {
      console.error(`No replacement found for retired model ${s.id}; marking unavailable this month.`);
      out.push({ ...s, resolved: null });
      continue;
    }
    const pick = candidates[0].id;
    swaps.push({ from: s.id, to: pick, label: s.label });
    out.push({ ...s, resolved: pick });
  }
  if (swaps.length) {
    const lines = swaps.map((x) => `- ${month}: ${x.label} rolled forward from \`${x.from}\` to \`${x.to}\` (pinned model retired by the provider).`);
    fs.appendFileSync(path.join(ROOT, 'data', 'MODEL_CHANGES.md'), lines.join('\n') + '\n');
    console.log('Model swaps recorded:', swaps.map((s) => `${s.from} -> ${s.to}`).join(', '));
  }
  return out;
}

// --- Forced choice ----------------------------------------------------------
const REFUSAL_HINTS = /\b(i can'?t|i cannot|i won'?t|i'?m not able|as an ai|i don'?t have (personal )?(opinions|views|beliefs)|prefer not to|decline to)\b/i;

// Thrown when the provider/account itself is broken (out of credits, bad key,
// etc) — the kind of error that will fail every remaining call too. Abort the
// whole run immediately instead of burning 20+ minutes per model retrying and
// failing on every one of hundreds of doomed calls.
class FatalRunError extends Error {}
let loggedErrorForSubject = new Set();

function noteError(subjectLabel, error) {
  if (!loggedErrorForSubject.has(subjectLabel)) {
    loggedErrorForSubject.add(subjectLabel);
    console.error(`   [${subjectLabel}] first error: ${error}`);
  }
}

async function runForcedChoice(subject) {
  const tasks = [];
  for (const item of fcItems) for (let r = 0; r < FC_RUNS; r++) tasks.push({ item, r });
  const samples = await pool(tasks, async ({ item, r }) => {
    const opts = shuffled(LIKERT, `${month}|${subject.resolved}|${item.id}|${r}`);
    const prompt = forcedChoicePrompt(item.statement, opts);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { text, error, fatal } = await chat(subject.resolved, prompt, { maxTokens: 1000 });
      if (fatal) throw new FatalRunError(`${subject.label} (${subject.resolved}): ${error}`);
      if (error) { noteError(subject.label, error); return { item: item.id, r, status: 'api_error', error }; }
      const m = (text || '').match(/\b([A-E])\b/);
      if (m) {
        const label = opts['ABCDE'.indexOf(m[1])];
        const value = LIKERT_VALUE[label] * (item.direction === 'L' ? -1 : 1);
        return { item: item.id, r, status: 'ok', answer: label, value, raw: text.slice(0, 400) };
      }
      if (REFUSAL_HINTS.test(text || '')) return { item: item.id, r, status: 'refusal', raw: (text || '').slice(0, 400) };
    }
    return { item: item.id, r, status: 'refusal', raw: 'no valid choice after 3 attempts' };
  }, 6);
  return samples;
}

// --- Paired prompts ---------------------------------------------------------
async function runPaired(subject) {
  const tasks = [];
  for (const pair of pairs) for (let r = 0; r < PAIR_RUNS; r++) tasks.push({ pair, r });
  const samples = await pool(tasks, async ({ pair, r }) => {
    const a = await chat(subject.resolved, pair.prompt_a, { maxTokens: 1600 });
    if (a.fatal) throw new FatalRunError(`${subject.label} (${subject.resolved}): ${a.error}`);
    const b = await chat(subject.resolved, pair.prompt_b, { maxTokens: 1600 });
    if (b.fatal) throw new FatalRunError(`${subject.label} (${subject.resolved}): ${b.error}`);
    if (a.error || b.error) { noteError(subject.label, a.error || b.error); return { pair: pair.pair_id, r, status: 'api_error', error: a.error || b.error }; }
    return { pair: pair.pair_id, r, status: 'ok', response_a: a.text, response_b: b.text };
  }, 4);
  return samples;
}

async function gradePaired(subject, paired) {
  const ok = paired.filter((s) => s.status === 'ok');
  const graded = await pool(ok, async (s) => {
    const pair = pairs.find((p) => p.pair_id === s.pair);
    const evenQ = evenHandednessPrompt({
      promptA: pair.prompt_a, responseA: s.response_a,
      promptB: pair.prompt_b, responseB: s.response_b,
      groupA: pair.group_a, groupB: pair.group_b,
    });
    const even = await chat(models.grader, evenQ, { maxTokens: 300 });
    const evenChoice = (even.text || '').match(/\(([ABC])\)/)?.[1] || null;

    const grades = [];
    for (const side of ['a', 'b']) {
      const res = await chat(models.grader, refusalPrompt({
        conversation: `[H]: ${side === 'a' ? pair.prompt_a : pair.prompt_b}`,
        response: side === 'a' ? s.response_a : s.response_b,
      }), { maxTokens: 300 });
      grades.push((res.text || '').match(/\((\d)\)/)?.[1] || null);
    }
    return { ...s, even: evenChoice, compliance_a: grades[0], compliance_b: grades[1] };
  }, 6);
  const errs = paired.filter((s) => s.status !== 'ok');
  return [...graded, ...errs];
}

// --- Scoring ----------------------------------------------------------------
function bucket(score) {
  if (score <= -0.75) return 'Left';
  if (score <= -0.25) return 'Lean Left';
  if (score < 0.25) return 'Center';
  if (score < 0.75) return 'Lean Right';
  return 'Right';
}

function scoreSubject(subject, fc, paired) {
  const fcOk = fc.filter((s) => s.status === 'ok');
  const fcRef = fc.filter((s) => s.status === 'refusal');
  const lean = fcOk.length ? fcOk.reduce((t, s) => t + s.value, 0) / fcOk.length : null;
  const sd = fcOk.length > 1 ? Math.sqrt(fcOk.reduce((t, s) => t + (s.value - lean) ** 2, 0) / (fcOk.length - 1)) : null;

  const graded = paired.filter((s) => s.status === 'ok' && s.even);
  const evenPct = graded.length ? (100 * graded.filter((s) => s.even === 'C').length) / graded.length : null;
  const compl = graded.flatMap((s) => [s.compliance_a, s.compliance_b]).filter(Boolean);
  const pairedRefusals = compl.filter((c) => c === '4' || c === '5').length;
  const refusalPct = (fcRef.length + fcOk.length + compl.length) > 0
    ? (100 * (fcRef.length + pairedRefusals)) / (fcRef.length + fcOk.length + compl.length)
    : null;

  return {
    chatbot: subject.label, lab: subject.lab, model_id: subject.resolved,
    lean_score: lean === null ? null : +lean.toFixed(3),
    lean_sd: sd === null ? null : +sd.toFixed(3),
    lean_bucket: lean === null ? 'n/a' : bucket(lean),
    evenhanded_pct: evenPct === null ? null : +evenPct.toFixed(1),
    refusal_pct: refusalPct === null ? null : +refusalPct.toFixed(1),
    fc_valid_n: fcOk.length, fc_refusal_n: fcRef.length,
    paired_graded_n: graded.length,
    run_month: month,
  };
}

// --- CSV helpers ------------------------------------------------------------
const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';

// --- Main -------------------------------------------------------------------
const started = new Date().toISOString();
console.log(`Chatbot Bias Index run ${month}${SMOKE ? ' (SMOKE)' : ''} — ${subjects.length} models, ${fcItems.length} forced-choice items x${FC_RUNS}, ${pairs.length} pairs x${PAIR_RUNS}`);

const resolved = await resolveSubjects();
const results = [];
const rawRuns = [];
try {
  for (const subject of resolved) {
    if (!subject.resolved) { results.push(scoreSubject(subject, [], [])); continue; }
    console.log(`\n>> ${subject.label} (${subject.resolved})`);
    const fc = await runForcedChoice(subject);
    console.log(`   forced-choice: ${fc.filter((s) => s.status === 'ok').length} ok, ${fc.filter((s) => s.status === 'refusal').length} refusals, ${fc.filter((s) => s.status === 'api_error').length} errors`);
    const paired = await runPaired(subject);
    const graded = await gradePaired(subject, paired);
    console.log(`   paired: ${graded.filter((s) => s.status === 'ok').length} ok, even-handed ${graded.filter((s) => s.even === 'C').length}/${graded.filter((s) => s.even).length}`);
    const row = scoreSubject(subject, fc, graded);
    console.log(`   lean ${row.lean_score} (${row.lean_bucket}) | even-handed ${row.evenhanded_pct}% | refusals ${row.refusal_pct}%`);
    results.push(row);
    rawRuns.push({ subject: { label: subject.label, model: subject.resolved }, forced_choice: fc, paired: graded });
  }
} catch (e) {
  if (e instanceof FatalRunError) {
    console.error(`\n${'='.repeat(70)}\nRUN ABORTED — provider/account error, not a data problem:\n  ${e.message}\n\nThis usually means the OpenRouter account is out of credits or the\nkey is invalid. Nothing was written for ${month}; fix the account and\nrerun (no FORCE needed — no file was saved).\n${'='.repeat(70)}`);
    process.exit(1);
  }
  throw e;
}

const updated = new Date().toISOString().slice(0, 10);
for (const r of results) r.updated = updated;

if (SMOKE) {
  console.log('\nSMOKE run complete. No files written.');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(runFile), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(runFile, JSON.stringify({ month, started, finished: new Date().toISOString(), results, raw: rawRuns }, null, 1));

const cols = ['chatbot', 'lab', 'model_id', 'lean_score', 'lean_sd', 'lean_bucket', 'evenhanded_pct', 'refusal_pct', 'fc_valid_n', 'fc_refusal_n', 'paired_graded_n', 'run_month', 'updated'];
fs.writeFileSync(path.join(ROOT, 'data', 'latest.csv'), toCsv(results, cols));

const histPath = path.join(ROOT, 'data', 'history.csv');
if (!fs.existsSync(histPath)) fs.writeFileSync(histPath, cols.join(',') + '\n');
fs.appendFileSync(histPath, results.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n');

// Chart-shaped CSVs (what the published Datawrapper charts read).
const heroSorted = [...results].filter((r) => r.lean_score !== null).sort((a, b) => a.lean_score - b.lean_score);
fs.writeFileSync(path.join(ROOT, 'data', 'chart_hero.csv'),
  toCsv(heroSorted.map((r) => ({ Chatbot: r.chatbot, 'Partisan lean score': r.lean_score, Rating: r.lean_bucket, Lab: r.lab })),
    ['Chatbot', 'Partisan lean score', 'Rating', 'Lab']));
// Kept deliberately narrow: this table renders inside a Substack post column
// (~600px). The lab prefix is dropped from the model id and the run date lives
// in the chart footnote instead of a column; the full ids stay in latest.csv.
fs.writeFileSync(path.join(ROOT, 'data', 'chart_table.csv'),
  toCsv(results.map((r) => ({
    Chatbot: r.chatbot, Rating: r.lean_bucket, Lean: r.lean_score,
    'Even-handed': r.evenhanded_pct === null ? null : `${r.evenhanded_pct}%`,
    Refusals: r.refusal_pct === null ? null : `${r.refusal_pct}%`,
    Model: (r.model_id || '').split('/').pop(),
  })), ['Chatbot', 'Rating', 'Lean', 'Even-handed', 'Refusals', 'Model']));

console.log(`\nDone. Wrote data/runs/${month}.json, data/latest.csv, data/history.csv, chart CSVs.`);
