// One-time Datawrapper setup: creates the two published charts, each linked to
// a CSV in this repo so they live-update on every page view without republishing.
// Env: DATAWRAPPER_TOKEN (create at app.datawrapper.de/account/api-tokens).
// Usage: node src/setup-datawrapper.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const TOKEN = process.env.DATAWRAPPER_TOKEN;
if (!TOKEN) { console.error('DATAWRAPPER_TOKEN not set (put it in .env).'); process.exit(1); }

const RAW = 'https://raw.githubusercontent.com/jbrew21/chatbot-bias-index/main/data';
const API = 'https://api.datawrapper.de/v3';

async function dw(method, url, body, raw = false) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': raw ? 'text/csv' : 'application/json' },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const SOURCE = { 'source-name': 'Chatbot Bias Index', 'source-url': 'https://github.com/jbrew21/chatbot-bias-index' };

async function createChart({ title, type, externalCsv, metadata }) {
  const chart = await dw('POST', '/charts', { title, type });
  await dw('PATCH', `/charts/${chart.id}`, {
    metadata: {
      data: { 'upload-method': 'external-data', 'external-data': externalCsv, 'use-datawrapper-cdn': false },
      describe: SOURCE,
      ...metadata,
    },
  });
  // Seed the data once so the editor/publish has something to render.
  const csvName = externalCsv.split('/').pop();
  const local = path.join(ROOT, 'data', csvName);
  if (fs.existsSync(local)) await dw('PUT', `/charts/${chart.id}/data`, fs.readFileSync(local, 'utf8'), true);
  const pub = await dw('POST', `/charts/${chart.id}/publish`);
  return { id: chart.id, url: pub?.data?.publicUrl || `https://datawrapper.dwcdn.net/${chart.id}/` };
}

const hero = await createChart({
  title: 'Where the chatbots lean',
  type: 'd3-dot-plot',
  externalCsv: `${RAW}/chart_hero.csv`,
  metadata: {
    axes: { labels: 'Chatbot', values: ['Partisan lean score'] },
    visualize: {
      'custom-range': ['-2', '2'],
      'show-value-labels': true,
    },
    annotate: {
      notes: 'Score from 50 forced-choice survey items adapted from ANES/Pew topics, asked 5 times each. Negative = left, positive = right. Auto-updates monthly. Full method: github.com/jbrew21/chatbot-bias-index',
    },
  },
});
console.log(`HERO chart: ${hero.url}  (id ${hero.id})`);

const table = await createChart({
  title: 'The Chatbot Bias Index',
  type: 'tables',
  externalCsv: `${RAW}/chart_table.csv`,
  metadata: {
    annotate: {
      notes: 'Lean from 50 forced-choice items (5 runs each). Even-handed % and Refusal % from 25 left/right paired prompts (3 runs), graded with the open-source Anthropic even-handedness rubric. Auto-updates monthly.',
    },
    visualize: { perPage: 15, striped: true },
  },
});
console.log(`TABLE chart: ${table.url}  (id ${table.id})`);

console.log('\nPaste these share URLs into Substack (they embed natively):');
console.log(`  ${hero.url}\n  ${table.url}`);
