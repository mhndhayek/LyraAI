// Documentation the agent reads on demand: shipped markdown plus generated pages for
// the live settings schema, the tool registry and the UI file map.
const fs = require('fs');
const path = require('path');
const { flatten, LOCKED, REASONS } = require('./guard');

const STATIC = { agent: 'AGENT.md', extensions: 'EXTENSIONS.md', organs: 'ORGANS.md', recovery: 'RECOVERY.md', avatars: 'AVATARS.md' };

class Docs {
  constructor(k) { this.k = k; }
  topics() { return [...Object.keys(STATIC), 'settings', 'tools', 'ui', 'examples']; }
  read(topic) {
    topic = String(topic || 'agent').toLowerCase();
    if (STATIC[topic]) { const f = path.join(this.k.paths.docs, STATIC[topic]); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `Missing doc ${STATIC[topic]}`; }
    if (topic === 'settings') return this.settingsDoc();
    if (topic === 'tools') return this.toolsDoc();
    if (topic === 'ui') return this.uiDoc();
    if (topic === 'examples') return this.examplesDoc();
    return `Unknown topic. Topics: ${this.topics().join(', ')}`;
  }
  settingsDoc() {
    const { DEFAULTS } = require('./settings'); const cur = this.k.settings.get();
    const profiles = this.k.settings.profiles();
    const lines = ['# Settings (live values, with defaults)', '',
      'Change them with configure_app({patch}). Paths marked LOCKED are refused; paths under model.* are queued until you are idle.', '',
      // The values below are this profile's. Saying so beats letting the agent
      // think it is editing the app for everyone.
      `You are the profile "${profiles.list.find((p) => p.id === profiles.active).name}", one of ${profiles.list.length}. Persona, appearance, voice, goals, model and providers belong to this profile; everything else is shared by all of them. Only the user adds, switches or removes profiles, and the other profiles' settings are not yours to read.`, ''];
    const curFlat = Object.fromEntries(flatten(cur));
    for (const [p, def] of flatten(DEFAULTS)) { const lock = LOCKED.find((l) => p === l || p.startsWith(l + '.')); lines.push(`- ${p} = ${JSON.stringify(curFlat[p])} (default ${JSON.stringify(def)})${lock ? ` LOCKED: ${REASONS[lock]}` : p.startsWith('model.') ? ' (queued until idle)' : ''}`); }
    // Locked settings that have no default to list, so the agent still learns
    // they exist and that they are refused. Their values are deliberately not
    // shown: the profile list carries every profile's soul and API keys.
    const listed = flatten(DEFAULTS).map(([p]) => p);
    for (const l of LOCKED) if (!listed.some((p) => p === l || p.startsWith(l + '.'))) lines.push(`- ${l} LOCKED: ${REASONS[l]}`);
    return lines.join('\n');
  }
  toolsDoc() {
    const o = this.k.organs; if (!o) return 'Organs not loaded.';
    const s = this.k.settings.get(); const all = o.tools.enabledTools(s, this.k.extensions.tools());
    return ['# Tools available to you right now', '', ...all.map((t) => `## ${t.name}${t.extension ? ` (extension ${t.extension})` : ''}\n${t.description}\nParameters: ${JSON.stringify(t.parameters)}\n`)].join('\n');
  }
  uiDoc() {
    const dir = this.k.paths.organsRenderer; const files = [];
    const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'vendor' || e.name.startsWith('.')) continue; if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name)); else files.push(path.join(rel, e.name)); } };
    try { walk(dir); } catch {}
    return ['# UI organ (renderer)', '', `Live copy: ${dir}`, 'Edit these files, then call apply_changes({what:"renderer"}); the window reloads and must report ready within 10 s or the kernel rolls the change back.', '', 'Files:', ...files.map((f) => `- ${f}`), '', 'Key ids: #thread (messages), #composer, #live-panel, #stage (character), #browser-panel, #settings (settings page), #theme-css (active theme link). Styles hang off CSS variables declared in styles.css :root; themes override them in themes/<id>/theme.css. Scripts: icons.js (icon set), character.js (live character), settings.js (settings pages; add a section by adding to SECTIONS and sections{}), app.js (chat, events from main via lyra.onEvent).'].join('\n');
  }
  examplesDoc() {
    const dir = path.join(this.k.paths.docs, 'examples'); const out = ['# Examples shipped with the app', ''];
    const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, path.join(rel, e.name)); else out.push(`## ${path.join(rel, e.name)}\n\`\`\`\n${fs.readFileSync(p, 'utf8')}\n\`\`\`\n`); } };
    try { walk(dir); } catch {}
    return out.join('\n');
  }
}
module.exports = { Docs };
