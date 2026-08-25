// Minimal OpenRouter client. No dependencies.
const BASE = 'https://openrouter.ai/api/v1';

export function apiKey() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) {
    console.error('OPENROUTER_API_KEY is not set. Put it in .env (local) or repo secrets (Actions).');
    process.exit(1);
  }
  return k;
}

export async function listModels() {
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) throw new Error(`models endpoint ${res.status}`);
  return (await res.json()).data;
}

// Errors that mean "this will fail every time until a human acts" — never worth
// retrying. Insufficient balance is the big one: with retries, one exhausted
// account turns a 10-second failure into a 20-minute silent stall per model.
function isFatal(status, message) {
  if (status === 401 || status === 402) return true;
  return /insufficient|credit|balance|payment required|quota exceeded/i.test(message || '');
}

// One chat completion with retries. Returns { text, error, fatal }.
export async function chat(model, userPrompt, { maxTokens = 1200, attempts = 4 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150_000);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/jbrew21/chatbot-bias-index',
          'X-Title': 'Chatbot Bias Index',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: maxTokens,
        }),
      });
      clearTimeout(timer);
      if (res.status !== 200) {
        const bodyText = await res.text();
        if (isFatal(res.status, bodyText)) {
          return { text: null, error: `HTTP ${res.status}: ${bodyText.slice(0, 300)}`, fatal: true };
        }
        if (res.status === 429 || res.status >= 500) {
          if (i < attempts) { await sleep(2000 * 2 ** i); continue; }
          return { text: null, error: `HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
        }
        return { text: null, error: `HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
      }
      const json = await res.json();
      if (json.error) {
        // Provider-level error object (can arrive with HTTP 200)
        const msg = String(json.error.message || json.error);
        if (isFatal(json.error.code, msg)) return { text: null, error: msg, fatal: true };
        if (i < attempts) { await sleep(2000 * 2 ** i); continue; }
        return { text: null, error: msg };
      }
      const text = json.choices?.[0]?.message?.content ?? '';
      return { text, error: null };
    } catch (e) {
      clearTimeout(timer);
      if (i < attempts) { await sleep(2000 * 2 ** i); continue; }
      return { text: null, error: String(e.message || e) };
    }
  }
  return { text: null, error: 'retries exhausted' };
}

// Simple promise pool.
export async function pool(items, worker, size = 6) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
