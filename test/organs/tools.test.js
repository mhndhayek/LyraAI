// The tool registry is the agent's entire reach into the machine. These tests pin
// the shape of every tool and the switches that take them away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, merge } = require('../../main/kernel/settings');
const path = require('path');
const ws = require('../../main/organs/workspace');
const { TOOLS, byName, enabledTools, schemaFor } = require('../../main/organs/tools');

const settings = (patch = {}) => merge(DEFAULTS, patch);
// The same context the agent loop hands to a tool, minus the live services.
const OUTSIDE = path.join(path.sep, 'etc', 'hosts');
const context = (root = path.join(path.sep, 'tmp', 'lyra-workspace')) => ({
  root, abs: (p) => ws.resolvePath(root, p), settings: settings(), tools: byName, kernel: null,
  chatId: 'test', emit: () => {}, notify: () => {}, browserMode: () => 'visible',
});

test('every tool is well formed enough to be offered to a model', () => {
  assert.ok(TOOLS.length > 20, 'the registry should not shrink silently');
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} is not a valid function name`);
    assert.ok(t.description && t.description.length > 10, `${t.name} needs a real description`);
    assert.ok(t.key, `${t.name} needs a settings key so it can be switched off`);
    assert.equal(typeof t.run, 'function', `${t.name} needs run()`);
    assert.equal(typeof t.risk, 'function', `${t.name} needs risk()`);
    assert.equal(typeof t.summary, 'function', `${t.name} needs a summary for the approval prompt`);
    assert.equal(t.parameters.type, 'object', `${t.name} parameters must be a JSON schema object`);
    assert.ok(t.icon, `${t.name} needs an icon for the UI`);
  }
});

test('tool names are unique', () => {
  assert.equal(Object.keys(byName).length, TOOLS.length);
});

test('every tool key is a real settings switch', () => {
  const s = settings();
  for (const t of TOOLS) assert.ok(t.key in s.tools, `tools.${t.key} (used by ${t.name}) is not in the settings`);
});

test('the tools the app promises are all registered', () => {
  const promised = ['read_file', 'list_dir', 'write_file', 'edit_file', 'search_files', 'find_files', 'shell', 'run_code',
    'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_scroll', 'browser_screenshot', 'web_search',
    'look_at_image', 'remember', 'list_repos', 'http_get', 'todo', 'read_docs', 'app_state', 'read_logs', 'configure_app',
    'apply_changes', 'checkpoint', 'list_checkpoints', 'rollback', 'list_extensions', 'install_extension', 'set_extension',
    'generate_image', 'notify'];
  for (const name of promised) assert.ok(byName[name], `${name} is missing from the registry`);
});

test('the master switch takes every tool away', () => {
  assert.deepEqual(enabledTools(settings({ tools: { enabled: false } })), []);
  assert.deepEqual(enabledTools(settings({ tools: { enabled: false } }), [{ name: 'ext_tool' }]), [], 'extensions go too');
});

test('turning one tool off removes exactly that group', () => {
  const before = enabledTools(settings()).map((t) => t.name);
  const after = enabledTools(settings({ tools: { shell: false } })).map((t) => t.name);
  assert.ok(before.includes('shell'));
  assert.ok(!after.includes('shell'));
  assert.ok(after.includes('read_file'), 'unrelated tools stay');
});

test('browser tools disappear with the browser, image generation with its backend', () => {
  const noBrowser = enabledTools(settings({ browser: { enabled: false } })).map((t) => t.name);
  for (const n of ['browser_open', 'browser_read', 'browser_click', 'web_search']) assert.ok(!noBrowser.includes(n), `${n} should be gone`);
  assert.ok(!enabledTools(settings()).some((t) => t.name === 'generate_image'), 'image generation is off until a backend is configured');
  assert.ok(enabledTools(settings({ imagegen: { enabled: true } })).some((t) => t.name === 'generate_image'));
});

test('run_code follows the code execution setting', () => {
  assert.ok(enabledTools(settings()).some((t) => t.name === 'run_code'));
  assert.ok(!enabledTools(settings({ workspace: { codeExecution: false } })).some((t) => t.name === 'run_code'));
});

test('extension tools are included first and can be switched off on their own', () => {
  const ext = [{ name: 'ext_tool', key: 'ext' }];
  assert.equal(enabledTools(settings(), ext)[0].name, 'ext_tool');
  assert.ok(!enabledTools(settings({ tools: { ext: false } }), ext).some((t) => t.name === 'ext_tool'));
});

test('the schema handed to the model is valid OpenAI tool JSON', () => {
  const schema = schemaFor(enabledTools(settings()));
  assert.ok(schema.length > 0);
  for (const s of schema) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name && s.function.description);
    assert.equal(s.function.parameters.type, 'object');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)), 'must survive serialisation');
  }
});

test('destructive tools are not quietly low risk', () => {
  const ctx = context();
  for (const name of ['shell', 'write_file', 'edit_file', 'run_code']) {
    const risk = byName[name].risk({ path: OUTSIDE, command: 'rm -rf /' }, ctx);
    assert.ok(['medium', 'high'].includes(risk), `${name} outside the workspace should not be low risk, got ${risk}`);
  }
});

test('reading inside the workspace is low risk', () => {
  const ctx = context();
  assert.equal(byName.read_file.risk({ path: 'notes.txt' }, ctx), 'low');
  assert.equal(byName.read_file.risk({ path: OUTSIDE }, ctx), 'medium', 'and outside it is not');
  assert.equal(byName.list_dir.risk({ path: '.' }, ctx), 'low');
});

test('summaries are short human sentences, not dumps of the arguments', () => {
  const ctx = context();
  const args = { path: 'a.txt', command: 'ls', url: 'https://example.com', query: 'q', text: 'hello', prompt: 'a cat',
    code: 'print(1)', language: 'python', id: 'demo', what: 'renderer', topic: 'agent', label: 'x', ref: 'lkg',
    selector: 'button', patch: {}, title: 'note', items: [], scope: 'long', direction: 'down', message: 'hi' };
  for (const t of TOOLS) {
    const s = t.summary(args, ctx);
    assert.equal(typeof s, 'string', `${t.name} summary is not a string`);
    assert.ok(s.length > 0 && s.length < 200, `${t.name} summary is unusable: ${s}`);
  }
});
