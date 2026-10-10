#!/usr/bin/env node
// A stand-in llama-server for the tests and the smoke test: it takes the same
// flags (--host, --port, --api-key-file, --alias, -m, -c) and answers /health,
// /props and /v1/models the way the real one does, including the 401 for a
// request without the key. Unknown flags are ignored, like a newer build's.
const http = require('http'); const fs = require('fs');
const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const key = arg('--api-key-file') ? fs.readFileSync(arg('--api-key-file'), 'utf8').trim() : null;
console.log('fake llama-server ' + a.join(' '));
const json = (res, status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
http.createServer((req, res) => {
  if (req.url === '/health') return json(res, 200, { status: 'ok' });
  if (key && req.headers.authorization !== 'Bearer ' + key) return json(res, 401, { error: { message: 'Invalid API Key' } });
  if (req.url === '/props') return json(res, 200, { model_path: arg('-m'), model_alias: arg('--alias'), default_generation_settings: { n_ctx: Number(arg('-c')) }, build_info: 'b1-fake' });
  if (req.url === '/v1/models') return json(res, 200, { data: [{ id: arg('--alias'), meta: { n_ctx: Number(arg('-c')) } }] });
  res.writeHead(404).end();
}).listen(Number(arg('--port')), arg('--host'));
