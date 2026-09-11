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
  ui: { livePanel: true, sidebarWidth: 240 },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = merge(DEFAULTS, {});
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.file)) this.data = merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) { console.error('settings load failed', e); }
    this.migrate();
  }
  // Older settings had one provider and plain model ids; lift them into presets.
  migrate() {
    const d = this.data;
    // 0.9: the app and its default persona were renamed from Nova to Lyra.
    const themeMap = { 'nova-dark': 'lyra-dark', 'nova-light': 'lyra-light' };
    if (d.appearance && themeMap[d.appearance.theme]) d.appearance.theme = themeMap[d.appearance.theme];
    if (d.persona && d.persona.name === 'Nova') d.persona.name = 'Lyra';
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
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  get() { return this.data; }
  set(patch) {
    const before = this.data;
    this.data = merge(this.data, patch);
    this.save();
    this.emit('change', this.data, before, patch);
    return this.data;
  }
  reset(section) {
    if (section) this.data[section] = merge(DEFAULTS[section], {});
    else this.data = merge(DEFAULTS, {});
    this.save();
    this.emit('change', this.data, null, {});
    return this.data;
  }
}

module.exports = { Settings, DEFAULTS, DEFAULT_SOUL, merge };
