// Image generation through SwarmUI or ComfyUI. Exposed to the model as the
// generate_image tool when enabled under Settings › Image generation.
const fs = require('fs');
const path = require('path');

const j = (r) => r.json();
const base = (u) => (u || '').replace(/\/+$/, '');

/* ---------- SwarmUI ---------- */
async function swarmSession(ep) { const r = await fetch(`${base(ep)}/API/GetNewSession`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`SwarmUI ${r.status}`); return (await j(r)).session_id; }
async function swarmModels(ep) {
  const session_id = await swarmSession(ep);
  const r = await fetch(`${base(ep)}/API/ListModels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id, path: '', depth: 4, subtype: 'Stable-Diffusion' }), signal: AbortSignal.timeout(15000) });
  const d = await j(r); return (d.files || []).map((f) => f.name);
}
async function swarmGenerate(ep, p, outDir) {
  const session_id = await swarmSession(ep);
  const body = { session_id, images: 1, prompt: p.prompt, negativeprompt: p.negative || '', width: p.width, height: p.height, steps: p.steps, cfgscale: p.cfg, seed: p.seed };
  if (p.model) body.model = p.model;
  const r = await fetch(`${base(ep)}/API/GenerateText2Image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  const d = await j(r); if (d.error) throw new Error(d.error); const img = (d.images || [])[0]; if (!img) throw new Error('SwarmUI returned no image');
  const file = path.join(outDir, `swarm-${Date.now()}.png`);
  if (img.startsWith('data:')) fs.writeFileSync(file, Buffer.from(img.split(',')[1], 'base64'));
  else { const ir = await fetch(`${base(ep)}/${img.replace(/^\//, '')}`); fs.writeFileSync(file, Buffer.from(await ir.arrayBuffer())); }
  return file;
}

/* ---------- ComfyUI ---------- */
async function comfyModels(ep) { const r = await fetch(`${base(ep)}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`ComfyUI ${r.status}`); const d = await j(r); return d.CheckpointLoaderSimple.input.required.ckpt_name[0] || []; }
function comfyWorkflow(p) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.model } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: p.negative || '', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler || 'euler', scheduler: p.scheduler || 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'lyra', images: ['8', 0] } },
  };
}
async function comfyGenerate(ep, p, outDir) {
  if (!p.model) { const ms = await comfyModels(ep); if (!ms.length) throw new Error('ComfyUI has no checkpoints'); p.model = ms[0]; }
  const r = await fetch(`${base(ep)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: comfyWorkflow(p), client_id: 'lyra' }), signal: AbortSignal.timeout(15000) });
  const d = await j(r); if (d.error) throw new Error(d.error.message || JSON.stringify(d.error)); const id = d.prompt_id;
  const started = Date.now();
  while (Date.now() - started < 600000) {
    await new Promise((res) => setTimeout(res, 1500));
    const h = await j(await fetch(`${base(ep)}/history/${id}`)); const entry = h[id]; if (!entry) continue;
    if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI: ' + JSON.stringify(entry.status.messages || '').slice(0, 300));
    const outs = Object.values(entry.outputs || {}).flatMap((o) => o.images || []); if (!outs.length) continue;
    const im = outs[0]; const ir = await fetch(`${base(ep)}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type || 'output'}`);
    const file = path.join(outDir, `comfy-${Date.now()}.png`); fs.writeFileSync(file, Buffer.from(await ir.arrayBuffer())); return file;
  }
  throw new Error('ComfyUI timed out');
}

/* ---------- facade ---------- */
function endpointOf(s) { return s.backend === 'comfyui' ? s.comfyEndpoint : s.swarmEndpoint; }
async function listModels(s) { return s.backend === 'comfyui' ? comfyModels(s.comfyEndpoint) : swarmModels(s.swarmEndpoint); }
async function test(s) { try { const m = await listModels(s); return { ok: true, count: m.length, models: m }; } catch (e) { return { ok: false, error: e.message }; } }
const SIZES = { square: [1024, 1024], portrait: [832, 1216], landscape: [1216, 832], wide: [1344, 768], tall: [768, 1344], small: [512, 512] };
async function generate(s, args, outDir, logs) {
  fs.mkdirSync(outDir, { recursive: true });
  let [w, h] = [s.width, s.height];
  if (s.letAiChooseSize && (args.size || (args.width && args.height))) { if (args.size && SIZES[args.size]) [w, h] = SIZES[args.size]; else if (args.width && args.height) [w, h] = [args.width, args.height]; }
  w = Math.max(256, Math.min(2048, Math.round(w / 8) * 8)); h = Math.max(256, Math.min(2048, Math.round(h / 8) * 8));
  const p = { prompt: args.prompt, negative: [s.negativePrompt, args.negative_prompt].filter(Boolean).join(', '), width: w, height: h, steps: s.steps, cfg: s.cfg, sampler: s.sampler, scheduler: s.scheduler, seed: args.seed ?? (s.seed >= 0 ? s.seed : Math.floor(Math.random() * 2 ** 31)), model: (s.letAiChooseModel && args.model) ? args.model : s.model };
  try {
    const file = s.backend === 'comfyui' ? await comfyGenerate(s.comfyEndpoint, p, outDir) : await swarmGenerate(s.swarmEndpoint, p, outDir);
    logs && logs.info('imagegen', `Generated an image (${p.width}x${p.height})`, `backend=${s.backend} model=${p.model || 'default'} seed=${p.seed}`);
    return { file, params: p };
  } catch (e) { logs && logs.error('imagegen', `Image generation failed: ${e.message}`, `backend=${s.backend} endpoint=${endpointOf(s)} model=${p.model || 'default'}`); throw e; }
}
module.exports = { listModels, test, generate, SIZES, endpointOf };
