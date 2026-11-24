/**
 * A stand-in for OpenRouter's /chat/completions, so AI Insights is tested end
 * to end without a real call, a key or a cost. It answers with a minimal
 * object that satisfies the JSON schema the request asked for, and records
 * every request so a test can assert what left the server (the PII surface).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LOG = path.join(require('./runtime-env').RUNTIME_DIR, 'ai-requests.jsonl');

/** Every request the fake received, oldest first (read from the log file). */
function requests() {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

function sample(schema) {
  if (!schema || typeof schema !== 'object') return 'e2e';
  if (schema.enum) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (t === 'object' || schema.properties) {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties || {})) o[k] = sample(v);
    return o;
  }
  if (t === 'array') return [sample(schema.items)];
  if (t === 'number' || t === 'integer') return 1;
  if (t === 'boolean') return true;
  return 'e2e sample text with **bold**';
}

function start(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ url: req.url, headers: req.headers, body: parsed }) + '\n');
      const schema = parsed.response_format?.json_schema?.schema;
      const out = schema ? sample(schema) : { sections: [] };
      // Like a real model told to "choose only from the recommendable list",
      // name real courses from the context it was sent, so the server's
      // role filter has something real to keep or drop.
      try {
        const ctx = JSON.parse((parsed.messages || []).find((m) => m.role === 'user')?.content || '{}');
        const pool = Array.isArray(ctx.recommendable) ? ctx.recommendable.map((c) => c.name) : [];
        if (pool.length && Array.isArray(out.recommendations) && out.recommendations[0]) {
          out.recommendations = pool.slice(0, 3).map((name) => ({ ...out.recommendations[0], name }));
        }
      } catch {}
      const content = JSON.stringify(out);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'e2e', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start, requests, sample };
