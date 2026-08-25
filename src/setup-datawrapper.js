// One-time Datawrapper setup: creates the two published charts, each linked to
// a CSV in this repo so they live-update on every page view without republishing.
// Env: DATAWRAPPER_TOKEN (create at app.datawrapper.de/account/api-tokens).
// Usage: node src/setup-datawrapper.js
//
// Design: diverging partisan palette validated for CVD safety (dataviz skill,
// six-checks validator). Position + always-on labels carry identity; color
// reinforces the zone. Blue = left, neutral gray = center, red = right.

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

export const PALETTE = {
  'Left': '#2166ac',
  'Lean Left': '#4393c3',
  'Center': '#8f8f8f',
  'Lean Right': '#d6604d',
  'Right': '#b2182b',
};

async function dw(method, url, body, raw = false) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': raw ? 'text/csv' : 'application/json' },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const NOTES_METHOD = 'Method: 50 forced-choice survey statements (ANES/Pew-adapted topics, answer order randomized, asked 5x each) plus 25 left/right paired prompts graded with Anthropic’s open-source even-handedness rubric. Auto-updates monthly. Every prompt, response, and line of code: github.com/jbrew21/chatbot-bias-index';

async function createChart({ title, type, externalCsv, metadata }) {
  const chart = await dw('POST', '/charts', { title, type });
  await dw('PATCH', `/charts/${chart.id}`, {
    metadata: {
      data: { 'upload-method': 'external-data', 'external-data': externalCsv, 'use-datawrapper-cdn': false },
      describe: {
        'source-name': 'The Chatbot Bias Index',
        'source-url': 'https://github.com/jbrew21/chatbot-bias-index',
        byline: 'The Medium is the Message',
      },
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
    axes: { labels: 'Chatbot', values: ['Partisan lean score'], colors: 'Rating' },
    visualize: {
      'custom-range': ['-2', '2'],
      'show-value-labels': true,
      'value-label-format': '0.00',
      'dot-size': 5,
      'color-category': { map: PALETTE },
      'color-by-column': true,
      'show-color-key': true,
      'custom-grid-lines': '-2,-1,0,1,2',
    },
    annotate: { notes: NOTES_METHOD },
  },
});
console.log(`HERO chart: ${hero.url}  (id ${hero.id})`);

const table = await createChart({
  title: 'The Chatbot Bias Index',
  type: 'tables',
  externalCsv: `${RAW}/chart_table.csv`,
  metadata: {
    visualize: {
      striped: false,
      markdown: false,
      perPage: 15,
      header: { style: { bold: true } },
    },
    annotate: { notes: NOTES_METHOD },
  },
});
console.log(`TABLE chart: ${table.url}  (id ${table.id})`);

console.log('\nPaste these share URLs into Substack (they embed natively):');
console.log(`  ${hero.url}\n  ${table.url}`);
