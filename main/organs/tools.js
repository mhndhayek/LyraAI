// Tools the agent can call. Each has a JSON schema for the model, a risk
// classifier for approvals, a one-line summary for the UI, and an implementation.
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const imagegen = require('./imagegen');
const { clampText, hostOf } = require('./util');

const rel = (root, abs) => (ws.inside(root, abs) ? path.relative(root, abs) || '.' : abs);
const guardOf = (c) => (c.kernel ? c.kernel.guard : null);
// Writes outside the workspace: refused for kernel-owned paths, budgeted and checkpointed inside the state folder.
function stateWriteCheck(c, abs, what) {
  const g = guardOf(c); if (!g) return null;
  const why = g.forbiddenPath(abs); if (why) return `Refused: ${why}.`;
  if (g.inState(abs)) { const b = g.consume(1); if (!b.ok) return `Refused: the daily self-modification budget (${b.limit} writes) is used up. Ask the user to raise it under Settings › Recovery.`; c.kernel.beforeStateWrite(`${what} ${path.relative(c.kernel.paths.state, abs)}`, c.chatId); c.kernel.markDirty(abs); }
  return null;
}
const riskForPath = (c, abs, insideRisk, outsideRisk) => { const g = guardOf(c); if (g && g.inState(abs)) return g.stateRisk(abs); return ws.inside(c.root, abs) ? insideRisk : outsideRisk; };

const TOOLS = [
  {
    name: 'read_file', key: 'read_file', icon: 'file',
    description: 'Read a text file. Paths are relative to the workspace unless absolute. Large files are truncated at the file read limit; use offset to continue.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: 'character offset to start from' } }, required: ['path'] },
    risk: (a, c) => (ws.inside(c.root, c.abs(a.path)) ? 'low' : 'medium'),
    summary: (a, c) => `Read ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => {
      const p = c.abs(a.path); const limit = c.settings.workspace.fileReadLimit || 100000;
      const st = fs.statSync(p); if (st.isDirectory()) return c.tools.list_dir.run({ path: a.path }, c);
      if (st.size > 20 * 1024 * 1024) return 'File too large to read.';
      const text = fs.readFileSync(p, 'utf8'); const off = a.offset || 0; const slice = text.slice(off, off + limit);
      return slice + (text.length > off + limit ? `\n…[${text.length - off - limit} more chars; call again with offset ${off + limit}]` : '');
    },
  },
  {
    name: 'list_dir', key: 'read_file', icon: 'folder',
    description: 'List files and folders. Defaults to the workspace root.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    risk: (a, c) => (ws.inside(c.root, c.abs(a.path)) ? 'low' : 'medium'),
    summary: (a, c) => `Listed ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => {
      const p = c.abs(a.path);
      const entries = fs.readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules').slice(0, 300);
      return entries.map((e) => (e.isDirectory() ? e.name + '/' : `${e.name} (${fs.statSync(path.join(p, e.name)).size} B)`)).join('\n') || '(empty)';
    },
  },
  {
    name: 'write_file', key: 'write_file', icon: 'pen',
    description: 'Create or overwrite a text file (or append). Parent folders are created. Use the workspace for anything you make.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
    risk: (a, c) => riskForPath(c, c.abs(a.path), 'low', 'high'),
    summary: (a, c) => `${a.append ? 'Appended to' : 'Wrote'} ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => { const p = c.abs(a.path); const refused = stateWriteCheck(c, p, 'write'); if (refused) return refused; fs.mkdirSync(path.dirname(p), { recursive: true }); a.append ? fs.appendFileSync(p, a.content) : fs.writeFileSync(p, a.content); return `${a.append ? 'Appended' : 'Wrote'} ${a.content.length} chars to ${rel(c.root, p)}`; },
  },
  {
    name: 'shell', key: 'shell', icon: 'terminal',
    description: 'Run a shell command (zsh). The shell is persistent: cwd and variables carry over between calls. Output is truncated.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['command'] },
    risk: () => 'high',
    summary: (a) => `$ ${a.command.slice(0, 120)}`,
    run: async (a, c) => {
      const g = guardOf(c); const blocked = g && g.shellBlocked(a.command); if (blocked) return `Refused: this command would be ${blocked}. That is off-limits for you.`;
      const r = await c.runShell(a.command, (a.timeout_sec || 60) * 1000);
      return `exit ${r.code}${r.cwd ? ` · cwd ${r.cwd}` : ''}\n${clampText(r.stdout, 12000)}${r.stderr ? `\n[stderr]\n${clampText(r.stderr, 4000)}` : ''}`;
    },
  },
  {
    name: 'run_code', key: 'run_code', icon: 'cpu',
    description: 'Run a snippet of python, node or bash inside the workspace and return its output.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' } }, required: ['language', 'code'] },
    risk: () => 'high',
    summary: (a) => `Run ${a.language} (${a.code.split('\n').length} lines)`,
    run: async (a, c) => {
      if (!c.settings.workspace.codeExecution) return 'Code execution is turned off in Settings › Workspace.';
      const ext = { python: 'py', node: 'js', bash: 'sh' }[a.language]; const file = path.join(c.root, 'tmp', `run-${Date.now()}.${ext}`);
      fs.writeFileSync(file, a.code);
      const cmd = { python: `python3 ${JSON.stringify(file)}`, node: `node ${JSON.stringify(file)}`, bash: `bash ${JSON.stringify(file)}` }[a.language];
      const r = await c.runShell(cmd, 120000);
      return `exit ${r.code}\n${clampText(r.stdout, 12000)}${r.stderr ? `\n[stderr]\n${clampText(r.stderr, 4000)}` : ''}`;
    },
  },
  {
    name: 'browser_open', key: 'browser', icon: 'globe',
    description: 'Open a URL in your own browser and read the page (text plus a list of clickable elements).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    risk: () => 'low',
    summary: (a, c) => `Browsing ${c.browserMode()} · ${hostOf(a.url)}`,
    run: async (a, c) => c.browser.open(a.url),
  },
  { name: 'browser_read', key: 'browser', icon: 'globe', description: 'Read the current page again (after clicks, scrolls, or when it changed).', parameters: { type: 'object', properties: {} }, risk: () => 'low', summary: (a, c) => `Read the page`, run: async (a, c) => c.browser.read() },
  {
    name: 'browser_click', key: 'browser', icon: 'cursor',
    description: 'Click an element by its [index] from browser_read, or by its visible text.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    risk: () => 'low', summary: (a) => `Click ${JSON.stringify(String(a.target)).slice(0, 60)}`,
    run: async (a, c) => c.browser.click(a.target),
  },
  {
    name: 'browser_type', key: 'browser', icon: 'cursor',
    description: 'Type into an input by [index] or placeholder/label text. Set submit to press Enter afterwards.',
    parameters: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['target', 'text'] },
    risk: (a) => (a.submit ? 'medium' : 'low'), summary: (a) => `Type “${String(a.text).slice(0, 40)}”${a.submit ? ' and submit' : ''}`,
    run: async (a, c) => c.browser.type(a.target, a.text, !!a.submit),
  },
  { name: 'browser_scroll', key: 'browser', icon: 'globe', description: 'Scroll the page up or down and read what is visible.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } } }, risk: () => 'low', summary: (a) => `Scroll ${a.direction || 'down'}`, run: async (a, c) => c.browser.scroll(a.direction) },
  {
    name: 'browser_screenshot', key: 'browser', icon: 'image',
    description: 'Take a screenshot of the page and look at it with the vision model. Ask a question about what to look for.',
    parameters: { type: 'object', properties: { question: { type: 'string' } } },
    risk: () => 'low', summary: () => 'Look at the page',
    run: async (a, c) => { const file = await c.browser.screenshot(path.join(c.root, 'tmp')); return c.describeImage(file, a.question || 'Describe this page: layout, main content, and any errors or dialogs.'); },
  },
  {
    name: 'web_search', key: 'web_search', icon: 'search',
    description: 'Search the web and get the top results (title, url, snippet). Then browser_open a result to read it.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    risk: () => 'low', summary: (a) => `Search “${a.query.slice(0, 60)}”`,
    run: async (a, c) => c.browser.search(a.query),
  },
  {
    name: 'look_at_image', key: 'vision', icon: 'eye',
    description: 'Look at an image file (png, jpg, webp) with the vision model and answer a question about it.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' } }, required: ['path'] },
    risk: (a, c) => (ws.inside(c.root, c.abs(a.path)) ? 'low' : 'medium'), summary: (a, c) => `Looked at ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => c.describeImage(c.abs(a.path), a.question || 'Describe this image in detail.'),
  },
  {
    name: 'remember', key: 'memory_write', icon: 'database',
    description: 'Save a note to memory. scope "long" persists across all chats (facts about the user, their setup, preferences, e.g. their home network layout); scope "short" lives in this chat only (working notes).',
    parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['long', 'short'] }, text: { type: 'string' } }, required: ['scope', 'text'] },
    risk: () => 'low', summary: (a) => `Remembered (${a.scope}): ${a.text.slice(0, 60)}`,
    run: async (a, c) => {
      const p = c.settings.persona;
      if (!p.memoryEnabled) return 'Memory is turned off.';
      if (a.scope === 'long' && !(p.longTerm && c.settings.memory.longTerm)) return 'Long-term memory is turned off; saved nothing.';
      if (a.scope === 'short' && !p.shortTerm) return 'Short-term memory is turned off; saved nothing.';
      const m = c.store.addMemory(a.scope, c.chatId, a.text.trim());
      c.emit(c.chatId, 'memory', { scope: a.scope, id: m.id, text: m.text });
      return `Saved to ${a.scope}-term memory.`;
    },
  },
  {
    name: 'list_repos', key: 'repos', icon: 'git',
    description: 'List git repositories discovered in the workspace, with branch and last commit.',
    parameters: { type: 'object', properties: {} },
    risk: () => 'low', summary: () => 'Listed repositories',
    run: async (a, c) => { if (!c.settings.workspace.repoDiscovery) return 'Repository discovery is turned off.'; const r = ws.discoverRepos(c.root); return r.length ? r.map((x) => `${x.name} — ${x.path}\n  branch ${x.branch}${x.dirty ? ' (uncommitted changes)' : ''} · ${x.last}`).join('\n') : 'No repositories in the workspace.'; },
  },
  /* ---- coding tools ---- */
  {
    name: 'edit_file', key: 'write_file', icon: 'pen',
    description: 'Edit a text file by replacing an exact snippet. old must match exactly once (or set all=true to replace every occurrence). Prefer this over rewriting whole files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, all: { type: 'boolean' } }, required: ['path', 'old', 'new'] },
    risk: (a, c) => riskForPath(c, c.abs(a.path), 'low', 'high'),
    summary: (a, c) => `Edited ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => {
      const p = c.abs(a.path); if (!fs.existsSync(p)) return `No such file: ${a.path}`;
      const refused = stateWriteCheck(c, p, 'edit'); if (refused) return refused;
      const text = fs.readFileSync(p, 'utf8'); const n = text.split(a.old).length - 1;
      if (n === 0) return 'The old snippet was not found. Read the file and copy the exact text (whitespace matters).';
      if (n > 1 && !a.all) return `The old snippet appears ${n} times; include more context to make it unique, or set all=true.`;
      fs.writeFileSync(p, a.all ? text.split(a.old).join(a.new) : text.replace(a.old, () => a.new));
      return `Replaced ${a.all ? n : 1} occurrence(s) in ${rel(c.root, p)}.`;
    },
  },
  {
    name: 'search_files', key: 'read_file', icon: 'search',
    description: 'Search file contents (grep). Defaults to the workspace; pass a path to search elsewhere (e.g. the app state folder). regex=true for extended regex, glob to filter file names.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string' } }, required: ['query'] },
    risk: (a, c) => (ws.inside(c.root, c.abs(a.path)) || (guardOf(c) && guardOf(c).inState(c.abs(a.path))) ? 'low' : 'medium'),
    summary: (a, c) => `Searched “${a.query.slice(0, 40)}” in ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => {
      const { execFile } = require('child_process'); const dir = c.abs(a.path);
      const args = ['-rnI', a.regex ? '-E' : '-F', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=.venv', '--exclude-dir=vendor', ...(a.glob ? [`--include=${a.glob}`] : []), '--', a.query, dir];
      const out = await new Promise((res) => execFile('grep', args, { maxBuffer: 4 * 1024 * 1024, timeout: 20000 }, (err, stdout) => res(String(stdout || ''))));
      const lines = out.split('\n').filter(Boolean).map((l) => l.replace(dir + path.sep, '')); if (!lines.length) return 'No matches.';
      return clampText(lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n…${lines.length - 200} more` : ''), 12000);
    },
  },
  {
    name: 'find_files', key: 'read_file', icon: 'folder',
    description: 'Find files by name pattern (glob like *.js or theme.*) under a folder, recursively.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    risk: () => 'low', summary: (a, c) => `Found files ${a.pattern} in ${rel(c.root, c.abs(a.path))}`,
    run: async (a, c) => {
      const dir = c.abs(a.path); const re = new RegExp('^' + a.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); const out = [];
      const walk = (d, depth) => { if (depth > 7 || out.length >= 300) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (['node_modules', '.git', '.venv', 'vendor'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (re.test(e.name)) out.push(path.relative(dir, p)); } };
      walk(dir, 0); return out.length ? out.join('\n') : 'No files matched.';
    },
  },
  {
    name: 'http_get', key: 'http', icon: 'globe',
    description: 'Fetch a URL and return its text (HTML is reduced to text). For APIs and docs; use the browser tools for interactive sites.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['url'] },
    risk: () => 'low', summary: (a) => `GET ${hostOf(a.url)}`,
    run: async (a) => {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Lyra/1.0' } }); let t = await r.text();
      if (/<html|<body/i.test(t)) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
      return `HTTP ${r.status}\n` + clampText(t.trim(), a.max_chars || 12000);
    },
  },
  {
    name: 'todo', key: 'app', icon: 'check',
    description: 'Keep a short plan for a multi-step task. Send the full list each time with done flags; the user sees it as a checklist.',
    parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } } }, required: ['items'] },
    risk: () => 'low', summary: (a) => `Plan: ${(a.items || []).filter((i) => i.done).length}/${(a.items || []).length} done`,
    run: async (a, c) => { if (c.step) c.step.todo = (a.items || []).slice(0, 20).map((i) => ({ text: String(i.text).slice(0, 200), done: !!i.done })); return 'Plan noted; it is shown to the user.'; },
  },
  /* ---- app self-customization tools ---- */
  {
    name: 'read_docs', key: 'app', icon: 'file',
    description: 'Read Lyra’s own documentation. Topics: agent (start here), extensions, organs, recovery, avatars (how to draw and animate a character with SwarmUI), settings (live schema with locked keys), tools, ui (renderer file map), examples.',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    risk: () => 'low', summary: (a) => `Read docs: ${a.topic}`,
    run: async (a, c) => c.kernel.docs.read(a.topic),
  },
  {
    name: 'app_state', key: 'app', icon: 'cpu',
    description: 'The live picture of the app: version, organs, extensions and their health, checkpoints, locked settings, budget, pending changes.',
    parameters: { type: 'object', properties: {} },
    risk: () => 'low', summary: () => 'Checked app state',
    run: async (a, c) => JSON.stringify(c.kernel.appState(), null, 2),
  },
  {
    name: 'read_logs', key: 'app', icon: 'file',
    description: 'Read the app\'s own log: errors, warnings and notable events from every part of Lyra (voice, model calls, tools, browser, extensions, organs, the UI). Use it whenever something failed, fell back, or behaved oddly, including problems the user reports from an earlier session. Sources: voice, llm, agent, tools, browser, imagegen, extensions, organs, kernel, ui, main.',
    parameters: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warn', 'info', 'debug'], description: 'minimum level, default warn' }, source: { type: 'string' }, since_minutes: { type: 'integer' }, search: { type: 'string' }, limit: { type: 'integer' } } },
    risk: () => 'low', summary: (a) => `Read logs${a.source ? ' · ' + a.source : ''}${a.search ? ' · “' + a.search + '”' : ''}`,
    run: async (a, c) => {
      const logs = c.kernel.logs;
      const opts = { level: a.level || 'warn', source: a.source || null, sinceMinutes: a.since_minutes || null, search: a.search || null, limit: Math.min(a.limit || 60, 200), days: 7 };
      const text = logs.text(opts);
      const counts = logs.counts(60 * 24);
      return text ? `Last 24 h: ${counts.error || 0} errors, ${counts.warn || 0} warnings.\n\n${text}` : `Nothing in the log matching that (last 24 h: ${counts.error || 0} errors, ${counts.warn || 0} warnings). Try a lower level, a longer since_minutes, or no source filter.`;
    },
  },
  {
    name: 'configure_app', key: 'app', icon: 'sliders',
    description: 'Change app settings with a partial patch, e.g. {"appearance":{"theme":"pixel"}} or {"imagegen":{"enabled":true,"swarmEndpoint":"http://host:7801"}}. Locked keys are refused; model/provider choices are queued until you are idle. See read_docs("settings").',
    parameters: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] },
    risk: () => 'low', summary: (a) => `Settings: ${Object.keys(a.patch || {}).join(', ')}`,
    run: async (a, c) => {
      const { filterPatch } = require(path.join(c.kernel.paths.kernelDir, 'guard.js'));
      const r = filterPatch(a.patch || {}); const parts = [];
      const hasAllowed = Object.keys(r.allowed).length > 0, hasQueued = Object.keys(r.queued).length > 0;
      if (hasAllowed || hasQueued) { const b = c.kernel.guard.consume(1); if (!b.ok) return `Refused: daily self-modification budget used up (${b.limit}).`; c.kernel.beforeStateWrite('configure_app', c.chatId); }
      if (hasAllowed) { c.settings = c.kernel.settings.set(r.allowed); parts.push(`Applied: ${Object.keys(r.allowed).join(', ')}`); }
      if (hasQueued) { c.kernel.queueSettings(r.queued); parts.push('Queued until idle: ' + JSON.stringify(r.queued)); }
      if (r.rejected.length) parts.push('Refused: ' + r.rejected.map((x) => `${x.path} (${x.why})`).join('; '));
      return parts.join('\n') || 'Nothing to change.';
    },
  },
  {
    name: 'apply_changes', key: 'app', icon: 'refresh',
    description: 'Verify and apply edits you made to the app: what = "renderer" (UI reload), "main" (hot-swap the main organs; happens after your turn ends), "extensions" (reload extensions) or "all". dry_run=true only verifies. Broken changes are rolled back automatically.',
    parameters: { type: 'object', properties: { what: { type: 'string', enum: ['all', 'main', 'renderer', 'extensions'] }, dry_run: { type: 'boolean' }, label: { type: 'string' } }, required: ['what'] },
    risk: () => 'low', summary: (a) => `${a.dry_run ? 'Verify' : 'Apply'} ${a.what}`,
    run: async (a, c) => {
      const k = c.kernel;
      if (a.what === 'extensions') { k.dirty.extensions = false; k.extensions.unloadAll(); k.extensions.loadAll(); const l = k.extensions.list(); k.emit(null, 'extensions', {}); return 'Extensions reloaded:\n' + l.map((e) => `- ${e.id}: ${e.status}${e.error ? ' (' + e.error + ')' : ''}`).join('\n'); }
      if (a.dry_run) { const v = await k.loader.verify(a.what); return v.ok ? 'Verification passed.' : 'Verification failed:\n' + v.errors.map((e) => `${e.file}: ${e.message}`).join('\n'); }
      const r = await k.loader.reload(a.what, { chatId: c.chatId, label: a.label || 'agent changes' });
      if (k.deferReload) return 'Verified. The main organs will be hot-swapped as soon as this turn ends (they cannot be replaced while you are running inside them).' + (r.applied.length ? ` Already applied: ${r.applied.join(', ')}.` : '');
      return (r.ok ? `Applied: ${r.applied.join(', ') || 'nothing to apply'}.` : 'Failed:\n' + r.errors.map((e) => `${e.file}: ${e.message}`).join('\n')) + (r.note ? '\n' + r.note : '');
    },
  },
  {
    name: 'checkpoint', key: 'app', icon: 'database',
    description: 'Save a named checkpoint of the app state (organs, extensions, themes, settings) before a risky change.',
    parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    risk: () => 'low', summary: (a) => `Checkpoint: ${a.label.slice(0, 60)}`,
    run: async (a, c) => { const r = c.kernel.checkpoints.commit(a.label); return r ? `Checkpoint ${r.hash} saved.` : 'Nothing changed since the last checkpoint.'; },
  },
  {
    name: 'list_checkpoints', key: 'app', icon: 'database',
    description: 'List recent checkpoints (newest first) and what changed since the last known good boot.',
    parameters: { type: 'object', properties: {} },
    risk: () => 'low', summary: () => 'Listed checkpoints',
    run: async (a, c) => { const cp = c.kernel.checkpoints; const l = cp.list(20); return (l.map((x) => `${x.hash} ${new Date(x.time).toLocaleString()} ${x.label}${x.lkg ? ' [last known good]' : ''}`).join('\n') || 'No checkpoints.') + '\n\nChanged since last known good:\n' + (cp.changedSince('lkg').join('\n') || '(nothing)'); },
  },
  {
    name: 'rollback', key: 'app', icon: 'refresh',
    description: 'Restore the app state to a checkpoint (hash from list_checkpoints, or "lkg" for last known good), then reapply. part limits it to organs, extensions, themes or settings.',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, part: { type: 'string', enum: ['all', 'organs', 'extensions', 'themes', 'settings'] } }, required: ['ref'] },
    risk: () => 'high', summary: (a) => `Roll back ${a.part || 'all'} to ${a.ref}`,
    run: async (a, c) => { const k = c.kernel; const sub = { organs: 'organs', extensions: 'extensions', themes: 'themes', settings: 'settings.json' }[a.part] || null; k.checkpoints.rollback(a.ref, { subdir: sub }); k.settings.load(); k.settings.emit('change', k.settings.get(), null, {}); if (!sub || sub === 'organs') { k.dirty.main = true; k.dirty.renderer = true; } if (!sub || sub === 'extensions') { k.extensions.unloadAll(); k.extensions.loadAll(); } return `Rolled back ${a.part || 'everything'} to ${a.ref}. ${(!sub || sub === 'organs') ? 'Organs will be reapplied when this turn ends.' : ''}`; },
  },
  {
    name: 'list_extensions', key: 'app', icon: 'tool',
    description: 'List installed extensions with status (active, disabled, pending-approval, quarantined, broken), capabilities and tools.',
    parameters: { type: 'object', properties: {} },
    risk: () => 'low', summary: () => 'Listed extensions',
    run: async (a, c) => JSON.stringify(c.kernel.extensions.list(), null, 2),
  },
  {
    name: 'install_extension', key: 'app', icon: 'plus',
    description: 'Validate and activate an extension folder you wrote under the state extensions folder (manifest.json + main.js and/or panel.html). The user is asked to approve its capabilities. See read_docs("extensions").',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    risk: () => 'medium', summary: (a, c) => { try { const m = c.kernel.extensions.manifest(a.id); return `Install extension “${m.name}” (${m.capabilities.join(', ') || 'no capabilities'})`; } catch { return `Install extension ${a.id}`; } },
    run: async (a, c) => { const ex = c.kernel.extensions; let m; try { m = ex.manifest(a.id); } catch (e) { return `Manifest problem: ${e.message}`; } const r = ex.approve(a.id); c.kernel.emit(null, 'extensions', {}); return r.ok ? `Extension ${m.name} is active. Tools: ${r.tools.join(', ') || 'none'}${r.panel ? '; panel shown in the Live panel tabs' : ''}.` : `Could not load: ${r.error}`; },
  },
  {
    name: 'set_extension', key: 'app', icon: 'tool',
    description: 'Enable or disable an installed extension (also clears a quarantine when enabling).',
    parameters: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] },
    risk: () => 'low', summary: (a) => `${a.enabled ? 'Enable' : 'Disable'} extension ${a.id}`,
    run: async (a, c) => { const r = c.kernel.extensions.setEnabled(a.id, a.enabled); c.kernel.emit(null, 'extensions', {}); return r.ok ? 'Done.' : `Failed: ${r.error}`; },
  },
  {
    name: 'generate_image', key: 'image_gen', icon: 'image',
    description: 'Generate an image with the configured image backend (SwarmUI or ComfyUI). Write a detailed prompt. Returns the saved file path; the image is shown to the user automatically.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, negative_prompt: { type: 'string' }, size: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide', 'tall', 'small'], description: 'only used if the user allows you to choose the size' }, width: { type: 'integer' }, height: { type: 'integer' }, model: { type: 'string', description: 'only used if the user allows you to choose the model' }, seed: { type: 'integer' } }, required: ['prompt'] },
    risk: () => 'low', summary: (a) => `Generate image: ${a.prompt.slice(0, 70)}`,
    run: async (a, c) => {
      const s = c.settings.imagegen; if (!s.enabled) return 'Image generation is turned off (Settings › Image generation).';
      const r = await imagegen.generate(s, a, path.join(c.root, s.folder || 'images'), c.kernel.logs);
      if (c.step) c.step.image = r.file;
      return `Image saved to ${rel(c.root, r.file)} (${r.params.width}x${r.params.height}, model ${r.params.model || 'default'}, seed ${r.params.seed}). It is already shown to the user; describe it briefly, do not repeat the path.`;
    },
  },
  {
    name: 'notify', key: 'notify', icon: 'bell',
    description: 'Send a desktop notification to the user (for when something finished while they were away).',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
    risk: () => 'low', summary: (a) => `Notified: ${a.title}`,
    run: async (a, c) => (c.notify('longTask', a.title, a.body || '') ? 'Sent.' : 'Notifications are off or the window is focused; not sent.'),
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function enabledTools(settings, extra = []) {
  const t = settings.tools;
  if (!t.enabled) return [];
  const ext = t.ext === false ? [] : extra;
  return ext.concat(TOOLS.filter((x) => t[x.key] !== false && !(x.key === 'image_gen' && !settings.imagegen.enabled) && !(x.key === 'browser' && !settings.browser.enabled) && !(x.key === 'web_search' && !settings.browser.enabled) && !(x.name === 'run_code' && !settings.workspace.codeExecution)));
}
function schemaFor(tools) { return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })); }

module.exports = { TOOLS, byName, enabledTools, schemaFor };
