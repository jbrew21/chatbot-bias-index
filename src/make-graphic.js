// Renders the hero graphic as a standalone SVG we fully control.
// Datawrapper's per-bar color keys are undocumented and silently ignored for
// d3-bars, and Substack rasterises embeds in email anyway, so the shareable
// asset is generated here instead of configured remotely.
//
// Usage: node src/make-graphic.js  ->  data/where-chatbots-lean.svg
// The monthly workflow converts it to PNG (rsvg-convert) for posting.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Validated diverging palette (dataviz six-checks validator, light surface).
const COLOR = {
  'Left': '#2166ac',
  'Lean Left': '#4393c3',
  'Center': '#8f8f8f',
  'Lean Right': '#d6604d',
  'Right': '#b2182b',
};

const rows = fs.readFileSync(path.join(ROOT, 'data', 'chart_hero.csv'), 'utf8')
  .trim().split('\n').slice(1)
  .map((line) => {
    const [chatbot, score, rating, lab] = line.split(',');
    return { chatbot, score: parseFloat(score), rating, lab };
  })
  .sort((a, b) => a.score - b.score);

const month = (fs.existsSync(path.join(ROOT, 'data', 'latest.csv'))
  ? fs.readFileSync(path.join(ROOT, 'data', 'latest.csv'), 'utf8').trim().split('\n')[1].split(',')[11]
  : '');
const monthLabel = month
  ? new Date(`${month}-02`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  : '';

// --- Layout ------------------------------------------------------------------
const W = 1200;
const PAD_L = 150, PAD_R = 60, PAD_T = 132, ROW_H = 52, BAR_H = 30;
const PLOT_W = W - PAD_L - PAD_R;
const H = PAD_T + rows.length * ROW_H + 118;
const MAX = 1.0;                                  // fixed domain: -1 .. +1
const x = (v) => PAD_L + ((v + MAX) / (2 * MAX)) * PLOT_W;
const ZERO = x(0);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const F = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${F}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${PAD_L}" y="52" font-size="34" font-weight="700" fill="#1a1a1a">Where the chatbots lean</text>
<text x="${PAD_L}" y="82" font-size="17" fill="#666">The same 50 political questions, asked of each chatbot five times${monthLabel ? ` &#183; ${esc(monthLabel)}` : ''}</text>`;

// Axis labels + zero line
svg += `
<text x="${PAD_L}" y="${PAD_T - 16}" font-size="13" font-weight="600" fill="#2166ac" letter-spacing="0.5">&#9664; MORE LIBERAL</text>
<text x="${W - PAD_R}" y="${PAD_T - 16}" font-size="13" font-weight="600" fill="#b2182b" letter-spacing="0.5" text-anchor="end">MORE CONSERVATIVE &#9654;</text>
<line x1="${ZERO}" y1="${PAD_T - 6}" x2="${ZERO}" y2="${PAD_T + rows.length * ROW_H + 6}" stroke="#1a1a1a" stroke-width="1.5"/>`;

// Bars
rows.forEach((r, i) => {
  const cy = PAD_T + i * ROW_H + ROW_H / 2;
  const bx = r.score < 0 ? x(r.score) : ZERO;
  const bw = Math.max(Math.abs(x(r.score) - ZERO), r.score === 0 ? 0 : 1);
  const fill = COLOR[r.rating] || '#8f8f8f';
  const val = r.score.toFixed(2);
  // Value label sits outside the bar end so it never fights the fill.
  const labelX = r.score < 0 ? bx - 10 : bx + bw + 10;
  const anchor = r.score < 0 ? 'end' : 'start';

  svg += `
<text x="${PAD_L - 18}" y="${cy + 6}" font-size="18" font-weight="600" fill="#1a1a1a" text-anchor="end">${esc(r.chatbot)}</text>
<rect x="${bx}" y="${cy - BAR_H / 2}" width="${bw}" height="${BAR_H}" rx="3" fill="${fill}"/>
<text x="${labelX}" y="${cy + 6}" font-size="16" font-weight="600" fill="#444" text-anchor="${anchor}">${val}</text>`;
});

// Legend + footer
const legendY = PAD_T + rows.length * ROW_H + 42;
let lx = PAD_L;
svg += `<text x="${lx}" y="${legendY}" font-size="13" fill="#888">Rating:</text>`;
lx += 56;
for (const [name, hex] of Object.entries(COLOR)) {
  svg += `<rect x="${lx}" y="${legendY - 10}" width="12" height="12" rx="2" fill="${hex}"/>
<text x="${lx + 18}" y="${legendY}" font-size="13" fill="#555">${esc(name)}</text>`;
  lx += 30 + name.length * 7.6;
}
svg += `
<text x="${PAD_L}" y="${legendY + 34}" font-size="13" fill="#888">The scale runs from -2 (entirely liberal) to +2 (entirely conservative); no chatbot passed 1 in either direction. Answer order was shuffled on every question.</text>
<text x="${PAD_L}" y="${legendY + 54}" font-size="13" fill="#888">The Medium is the Message &#183; All questions, answers and code: github.com/jbrew21/chatbot-bias-index</text>
</svg>`;

const out = path.join(ROOT, 'data', 'where-chatbots-lean.svg');
fs.writeFileSync(out, svg);
console.log(`Wrote ${out} (${rows.length} chatbots, ${W}x${H})`);
