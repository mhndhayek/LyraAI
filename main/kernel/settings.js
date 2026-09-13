// Settings: defaults, load/save, change events.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_SOUL = `You are Lyra, an AI agent who lives inside the Lyra app on this computer. You are warm, curious and direct: you say what you think, ask when a request is unclear, and keep replies short unless detail is needed.

You have real tools (files, shell, browser, memory, images, and the app itself). Use them instead of guessing, and say what you did. Remember what matters with the remember tool. You may restyle the app and grow new abilities, but you never change your own name or the safety rules. When something breaks, read the log and fix it.

Think briefly in private, then answer. Emoji are fine in small doses.`;

const DEFAULTS = {
  providers: { list: [{ id: 'lmstudio', name: 'LM Studio', runtime: 'lmstudio', endpoint: 'http://localhost:1234/v1', apiKey: '' }] },
  model: { chat: { provider: 'lmstudio', model: '' }, vision: { provider: 'lmstudio', model: '' }, contextMode: 'auto', contextOverride: 32768, reasoning: 'medium', smartApprovals: true, compression: true, temperature: 0.7, maxSteps: 30, runMinutes: 30 },
  persona: { name: 'Lyra', avatar: 'builtin:catgirl', soul: DEFAULT_SOUL, memoryEnabled: true, store: 'sqlite', shortTerm: true, longTerm: true },
  appearance: { theme: 'lyra-dark', liveCharacter: true, source: 'gif', live2dModel: '', gifFolder: 'builtin:catgirl', petFolder: '', floatPos: null, placement: 'panel', transitionMs: 300 },
  workspace: { folder: path.join(os.homedir(), 'Lyra', 'workspace'), repoDiscovery: true, codeExecution: true, persistentShell: true, fileReadLimit: 100000 },
  safety: { approvalMode: 'ask', timeoutSec: 300, onTimeout: 'deny' },
  browser: { enabled: true, mode: 'visible', autoOpen: true, startPage: 'about:blank', askBeforeDownloads: true },
  memory: { longTerm: true, memoryBudget: 8000, profileBudget: 2000, autoCompression: true, threshold: 0.8, target: 0.5 },
  voice: { engine: 'kitten', kittenModel: 'KittenML/kitten-tts-nano-0.1', voice: 'Rosie', customEndpoint: 'http://localhost:8880/v1', customModel: 'tts-1', customVoice: 'alloy', readAloud: true, stt: true, showTranscript: true, sttModel: 'small', sidecarPython: '' },
  notifications: { desktop: true, approvals: true, longTask: true, goals: true, sound: true },
  tools: { enabled: true, read_file: true, write_file: true, shell: true, run_code: true, browser: true, web_search: false, vision: true, memory_write: true, repos: true, notify: true, image_gen: true, http: true, app: true, ext: true },
  goals: { autonomous: false, dailyMinutes: 30 },
  chat: { followUp: 'steer' },
  mobile: { enabled: false, port: 8443, allowHighRiskTools: false, autoStart: true },
  kernel: { checkpoints: true, dailyWrites: 60, autoApply: true, uiReadyTimeoutMs: 10000 },
  imagegen: { enabled: false, backend: 'swarmui', swarmEndpoint: 'http://localhost:7801', comfyEndpoint: 'http://localhost:8188', model: '', letAiChooseModel: false, width: 1024, height: 1024, letAiChooseSize: true, steps: 20, cfg: 6, sampler: 'euler', scheduler: 'normal', negativePrompt: '', seed: -1, folder: 'images' },
  ui: { livePanel: true, sidebarWidth: 240, setupDone: false },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

// What belongs to a profile rather than to the machine: who she is, how she
// looks and sounds, what she is working towards, and which model she thinks
// with. Everything else — safety, the workspace, the browser, phone access,
// kernel limits — is the user's and is shared by every profile.
const PROFILE_SECTIONS = ['persona', 'appearance', 'voice', 'goals', 'model', 'providers'];
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = merge(DEFAULTS, {});
    this.load();
  }
  load() {
    let raw = null;
    try {
      if (fs.existsSync(this.file)) { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = merge(DEFAULTS, raw); }
    } catch (e) { console.error('settings load failed', e); }
    this.migrate();
    const adopted = this.migrateProfiles();
    // The setup guide is for a fresh install. An install from before the guide
    // existed was set up by hand already, so it is not walked through it.
    const seasoned = !!raw && !(isObj(raw.ui) && 'setupDone' in raw.ui);
    if (seasoned) this.data = merge(this.data, { ui: { setupDone: true } });
    this.refresh();
    if ((this.renamed || adopted || seasoned) && fs.existsSync(this.file)) this.save();
  }

  /* ---- profiles ---- */

  // An install from before profiles has its persona, look, voice, goals and
  // model at the top level: that becomes the first profile, keeping the data
  // folder it already uses so nothing is moved.
  migrateProfiles() {
    const d = this.data;
    if (!isObj(d.profiles)) d.profiles = { active: '', list: [] };
    if (!Array.isArray(d.profiles.list)) d.profiles.list = [];
    let changed = false;
    if (!d.profiles.list.length) {
      const first = { id: 'default', name: d.persona.name || DEFAULTS.persona.name, dataDir: '' };
      for (const k of PROFILE_SECTIONS) first[k] = merge(DEFAULTS[k], d[k] || {});
      d.profiles.list.push(first);
      d.profiles.active = first.id;
      changed = true;
    }
    if (!d.profiles.list.some((p) => p.id === d.profiles.active)) { d.profiles.active = d.profiles.list[0].id; changed = true; }
    return changed;
  }
  // The settings every other part of the app sees: the shared ones with the
  // active profile's own laid over the top.
  refresh() {
    const p = this.activeProfile();
    const view = { ...this.data };
    for (const k of PROFILE_SECTIONS) view[k] = merge(DEFAULTS[k], (p && p[k]) || {});
    this.view = view;
    return view;
  }
  profiles() { return { active: this.data.profiles.active, list: this.data.profiles.list.map((p) => ({ id: p.id, name: p.name, dataDir: p.dataDir, avatar: (p.persona || {}).avatar, theme: (p.appearance || {}).theme })) }; }
  activeProfile() { return this.data.profiles.list.find((p) => p.id === this.data.profiles.active) || this.data.profiles.list[0] || null; }
  // Where this profile's chats, memory and goals live, relative to the app data
  // folder. The first profile keeps the original spot, so it is never moved.
  profileDataDir(id = this.data.profiles.active) {
    const p = this.data.profiles.list.find((x) => x.id === id);
    return p ? p.dataDir || '' : '';
  }
  createProfile({ name, copyFrom = null } = {}) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('a profile needs a name');
    if (this.data.profiles.list.length >= 20) throw new Error('that is as many profiles as the app keeps');
    const base = slug(clean) || 'profile';
    let id = base, n = 2;
    while (this.data.profiles.list.some((p) => p.id === id)) id = `${base}-${n++}`;
    const source = copyFrom ? this.data.profiles.list.find((p) => p.id === copyFrom) : null;
    const entry = { id, name: clean, dataDir: path.join('profiles', id) };
    for (const k of PROFILE_SECTIONS) entry[k] = merge(DEFAULTS[k], (source && source[k]) || {});
    // A copy takes the settings but not the name: two profiles answering to the
    // same name would be impossible to tell apart.
    entry.persona = merge(entry.persona, { name: clean });
    this.data.profiles.list.push(entry);
    this.save();
    return entry;
  }
  switchProfile(id) {
    const p = this.data.profiles.list.find((x) => x.id === id);
    if (!p) throw new Error(`there is no profile ${id}`);
    const before = this.get();
    this.data.profiles.active = id;
    this.refresh();
    this.save();
    // An empty patch: nothing was edited, a different set of settings is simply
    // in force now, and listeners must not read this as a settings change.
    this.emit('change', this.view, before, {});
    return this.view;
  }
  renameProfile(id, name) {
    const p = this.data.profiles.list.find((x) => x.id === id);
    if (!p) throw new Error(`there is no profile ${id}`);
    const clean = String(name || '').trim();
    if (!clean) throw new Error('a profile needs a name');
    p.name = clean;
    if (p.persona) p.persona.name = clean;
    this.refresh();
    this.save();
    this.emit('change', this.view, null, {});
    return this.profiles();
  }
  deleteProfile(id) {
    if (this.data.profiles.list.length <= 1) throw new Error('there has to be one profile');
    const p = this.data.profiles.list.find((x) => x.id === id);
    if (!p) throw new Error(`there is no profile ${id}`);
    this.data.profiles.list = this.data.profiles.list.filter((x) => x.id !== id);
    if (this.data.profiles.active === id) this.data.profiles.active = this.data.profiles.list[0].id;
    this.refresh();
    this.save();
    return { removed: p, profiles: this.profiles() };
  }
  // Older settings had one provider and plain model ids; lift them into presets.
  migrate() {
    const d = this.data;
    // 0.9: the app and its default persona were renamed from Nova to Lyra.
    const themeMap = { 'nova-dark': 'lyra-dark', 'nova-light': 'lyra-light' };
    let renamed = false;
    if (d.appearance && themeMap[d.appearance.theme]) { d.appearance.theme = themeMap[d.appearance.theme]; renamed = true; }
    if (d.persona && d.persona.name === 'Nova') { d.persona.name = 'Lyra'; renamed = true; }
    this.renamed = renamed;
    if (!Array.isArray(d.providers.list) || !d.providers.list.length) d.providers.list = merge(DEFAULTS.providers, {}).list;
    if (d.provider) {
      const p = d.provider; const first = d.providers.list[0];
      Object.assign(first, { runtime: p.runtime || first.runtime, endpoint: p.endpoint || first.endpoint, apiKey: p.apiKey || '' });
      delete d.provider;
    }
    for (const role of ['chat', 'vision']) if (typeof d.model[role] !== 'object' || !d.model[role]) d.model[role] = { provider: d.providers.list[0].id, model: typeof d.model[role] === 'string' ? d.model[role] : '' };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // The per-profile sections are written inside the profiles, so leaving the
    // shared copies out keeps one answer in the file for who she is.
    const out = { ...this.data };
    for (const k of PROFILE_SECTIONS) delete out[k];
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
  }
  get() { return this.view; }
  set(patch) {
    const before = this.get();
    const profile = this.activeProfile();
    for (const [k, v] of Object.entries(patch || {})) {
      if (PROFILE_SECTIONS.includes(k) && profile) profile[k] = merge(profile[k] || DEFAULTS[k], v);
      else this.data = merge(this.data, { [k]: v });
    }
    // The profile is named after her, so renaming her renames it.
    if (patch && patch.persona && patch.persona.name && profile) profile.name = patch.persona.name;
    this.refresh();
    this.save();
    this.emit('change', this.view, before, patch);
    return this.view;
  }
  reset(section) {
    const profile = this.activeProfile();
    if (section && PROFILE_SECTIONS.includes(section)) { if (profile) profile[section] = merge(DEFAULTS[section], {}); }
    else if (section) this.data[section] = merge(DEFAULTS[section], {});
    else {
      // Reset everything this profile is, and the shared settings with it, but
      // never the list of profiles: that would delete the other ones.
      const profiles = this.data.profiles;
      this.data = merge(DEFAULTS, { profiles });
      if (profile) for (const k of PROFILE_SECTIONS) profile[k] = merge(DEFAULTS[k], {});
    }
    this.refresh();
    this.save();
    this.emit('change', this.view, null, {});
    return this.view;
  }
}

module.exports = { Settings, DEFAULTS, DEFAULT_SOUL, merge, PROFILE_SECTIONS };
