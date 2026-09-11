// Where everything lives. The app bundle (appPath) is read-only and holds the kernel,
// the shipped organs, the docs and the voice sidecar. The state folder under app data
// holds the live organs, extensions, themes and settings: the part the agent may edit,
// and the part checkpoints cover. Chats, memory and media live beside it, unversioned.
const path = require('path');
const fs = require('fs');

function layout(userData, appPath) {
  const state = path.join(userData, 'state');
  return {
    userData, appPath, state,
    organsMain: path.join(state, 'organs', 'main'),
    organsRenderer: path.join(state, 'organs', 'renderer'),
    organsVersion: path.join(state, 'organs', 'VERSION'),
    extensions: path.join(state, 'extensions'),
    extensionsState: path.join(state, 'extensions-state.json'),
    themes: path.join(state, 'themes'),
    settingsFile: path.join(state, 'settings.json'),
    media: path.join(userData, 'media'),
    bootFile: path.join(userData, 'boot.json'),
    healthLog: path.join(userData, 'health.log'),
    logs: path.join(userData, 'logs'),
    docs: path.join(appPath, 'docs'),
    shippedOrgans: path.join(appPath, 'main', 'organs'),
    shippedRenderer: path.join(appPath, 'renderer'),
    kernelDir: path.join(appPath, 'main', 'kernel'),
    voiceDir: path.join(appPath, 'voice'),
  };
}

// Older builds kept settings.json and themes directly under app data.
function migrate(p) {
  fs.mkdirSync(p.state, { recursive: true });
  const oldSettings = path.join(p.userData, 'settings.json');
  if (fs.existsSync(oldSettings) && !fs.existsSync(p.settingsFile)) fs.renameSync(oldSettings, p.settingsFile);
  const oldThemes = path.join(p.userData, 'themes');
  if (fs.existsSync(oldThemes) && !fs.existsSync(p.themes)) fs.renameSync(oldThemes, p.themes);
  for (const d of [p.extensions, p.themes, p.media]) fs.mkdirSync(d, { recursive: true });
}

function copyDir(src, dst, { skip = [] } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, { skip }); else fs.copyFileSync(s, d);
  }
}

// 0.9 renamed the app from Nova to Lyra. On the first start, adopt the old app data
// folder (a sibling named Nova) so chats, memory, settings and pairings carry over.
function adoptOldUserData(userData, oldName = 'Nova') {
  const old = path.join(path.dirname(userData), oldName);
  const has = (d) => fs.existsSync(path.join(d, 'state')) || fs.existsSync(path.join(d, 'nova.sqlite')) || fs.existsSync(path.join(d, 'lyra.sqlite'));
  if (!fs.existsSync(old) || !has(old) || (fs.existsSync(userData) && has(userData))) return null;
  fs.mkdirSync(userData, { recursive: true });
  const moved = [], kept = [];
  for (const name of fs.readdirSync(old)) {
    const from = path.join(old, name), to = path.join(userData, name);
    if (fs.existsSync(to)) { kept.push(name); continue; }
    try { fs.renameSync(from, to); moved.push(name); } catch { try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); moved.push(name); } catch { kept.push(name); } }
  }
  try { if (!fs.readdirSync(old).length) fs.rmdirSync(old); } catch {}
  return { from: old, moved, kept };
}

module.exports = { layout, migrate, adoptOldUserData, copyDir };
