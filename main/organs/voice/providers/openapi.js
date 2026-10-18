// Reads a server's OpenAPI description (FastAPI serves one at /openapi.json) and
// works out what it can do from its paths and request schemas: where speech is
// made, where voices are listed, and whether it can clone (a */clone* or
// *reference* route) or design a voice (a *design*/*instruct* route, or an
// `instructions` field on the speech request). That is how a server Lyra has no
// file for still "just works".
const pick = (fields, names) => names.find((n) => fields.includes(n));
const TEXT = ['input', 'text', 'prompt'];
const VOICE = ['voice', 'speaker', 'voice_id', 'reference_id'];
const DESIGN = ['instructions', 'instruct', 'voice_description', 'description', 'style_prompt'];
const AUDIO = ['ref_audio', 'reference_audio', 'audio', 'file', 'files', 'sample', 'speaker_wav', 'reference'];
const REF_TEXT = ['ref_text', 'reference_text', 'prompt_text', 'transcript'];

function resolve(doc, s, depth = 0) {
  if (!s || typeof s !== 'object' || depth > 8) return s || {};
  if (s.$ref) {
    let cur = doc;
    for (const part of String(s.$ref).replace(/^#\//, '').split('/')) cur = cur && cur[part];
    return resolve(doc, cur, depth + 1);
  }
  if (Array.isArray(s.allOf)) {
    const out = { properties: {}, required: [] };
    for (const x of s.allOf) { const r = resolve(doc, x, depth + 1); Object.assign(out.properties, r.properties || {}); out.required.push(...(r.required || [])); }
    return out;
  }
  for (const k of ['anyOf', 'oneOf']) if (Array.isArray(s[k])) { const hit = s[k].map((x) => resolve(doc, x, depth + 1)).find((x) => x && x.properties); if (hit) return hit; }
  return s;
}

// The request a POST route takes: its field names and whether it is multipart.
function operation(doc, p) {
  const post = doc.paths && doc.paths[p] && doc.paths[p].post;
  if (!post) return null;
  const body = resolve(doc, post.requestBody || {});
  const content = body.content || {};
  const multipart = !!content['multipart/form-data'];
  const media = content['multipart/form-data'] || content['application/json'] || content['application/x-www-form-urlencoded'] || Object.values(content)[0];
  const schema = resolve(doc, media && media.schema);
  return { path: p, multipart, fields: Object.keys(schema.properties || {}), required: schema.required || [] };
}

function analyze(doc) {
  if (!doc || typeof doc !== 'object' || !doc.paths) return null;
  const paths = Object.keys(doc.paths);
  const posts = paths.filter((p) => doc.paths[p] && doc.paths[p].post);
  const speechPath = posts.find((p) => /\/audio\/speech$/.test(p)) || posts.find((p) => /\/(tts|speech|synthesi[sz]e)$/i.test(p));
  const clonePath = posts.find((p) => /clone/i.test(p)) || posts.find((p) => /reference/i.test(p) && !/delete|update|list/i.test(p));
  const designPath = posts.find((p) => /design|instruct/i.test(p));
  const voicesPath = paths.find((p) => /\/voices$/.test(p) && doc.paths[p].get);
  const speech = speechPath ? operation(doc, speechPath) : null;
  const clone = clonePath ? operation(doc, clonePath) : null;
  const design = designPath ? operation(doc, designPath) : null;
  const inlineDesign = speech ? pick(speech.fields, DESIGN) : null;
  return {
    title: String((doc.info && doc.info.title) || ''), paths, speech, clone, design, voicesPath,
    designField: design ? pick(design.fields, DESIGN) || 'instructions' : inlineDesign,
    cloning: !!clone, voiceDesign: !!(design || inlineDesign),
    speed: !!(speech && speech.fields.includes('speed')),
    stream: !!(speech && speech.fields.includes('stream')),
    stt: posts.some((p) => /transcri/i.test(p)),
  };
}

// The JSON body for a speech request, using the field names the schema has.
// With no schema, the OpenAI names (and `text` for the servers that use it).
function speechBody(a, o) {
  const f = (a && a.speech && a.speech.fields) || [];
  if (!f.length) return { model: o.model || 'tts-1', input: o.text, text: o.text, ...(o.voice ? { voice: o.voice } : {}), response_format: o.format || 'wav', ...(o.speed ? { speed: o.speed } : {}), ...(o.design ? { instructions: o.design } : {}) };
  const body = {};
  body[pick(f, TEXT) || 'input'] = o.text;
  const vf = pick(f, VOICE); if (o.voice && vf) body[vf] = o.voice;
  if (f.includes('model')) body.model = o.model || 'tts-1';
  if (f.includes('response_format')) body.response_format = o.format || 'wav'; else if (f.includes('format')) body.format = o.format || 'wav';
  if (o.speed && f.includes('speed')) body.speed = o.speed;
  if (o.design && a.designField && f.includes(a.designField)) body[a.designField] = o.design;
  return body;
}

// The fields for a clone request; the caller turns them into multipart or JSON.
function cloneFields(a, o) {
  const f = (a && a.clone && a.clone.fields) || [];
  return {
    text: pick(f, TEXT) || 'text',
    audio: pick(f, AUDIO) || 'ref_audio',
    refText: pick(f, REF_TEXT) || (f.length ? null : 'ref_text'),
    speed: f.includes('speed') ? 'speed' : null,
    multipart: a && a.clone ? a.clone.multipart || !f.length : true,
  };
}

module.exports = { analyze, operation, resolve, speechBody, cloneFields };
