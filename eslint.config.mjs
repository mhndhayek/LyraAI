// Lint rules for the three runtimes in this repo: the kernel and organs (Node in
// the main process), the UI (a browser page with the `lyra` bridge), and the
// tests and build scripts (plain Node).
import js from '@eslint/js';

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', global: 'readonly',
  console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly',
  TextEncoder: 'readonly', fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly', Intl: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  console: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
  FileReader: 'readonly', FormData: 'readonly', Image: 'readonly', Audio: 'readonly', AudioContext: 'readonly',
  MediaRecorder: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  CustomEvent: 'readonly', Event: 'readonly', DOMParser: 'readonly', ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly', MutationObserver: 'readonly', WebSocket: 'readonly',
  AbortController: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', crypto: 'readonly',
  structuredClone: 'readonly', Intl: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  HTMLElement: 'readonly', Node: 'readonly', speechSynthesis: 'readonly', SpeechSynthesisUtterance: 'readonly',
  performance: 'readonly', history: 'readonly', EventSource: 'readonly', matchMedia: 'readonly',
  // Provided by the app itself: the preload bridge, vendored libraries, and the
  // globals the renderer scripts publish for one another.
  lyra: 'readonly', marked: 'readonly', PIXI: 'readonly', Live2DCubismCore: 'readonly',
  icon: 'readonly', fillIcons: 'readonly', ICONS: 'readonly', Settings: 'readonly', LyraCharacter: 'readonly',
};

const rules = {
  ...js.configs.recommended.rules,
  // Unused code is a bug the moment it is a typo, but an intentionally ignored
  // argument or caught error is idiomatic here.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Mistakes that would break the app at runtime.
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-await-in-loop': 'off',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'renderer/vendor/**', 'assets/**', 'coverage/**'] },
  {
    files: ['main/**/*.js', 'preload.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules,
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browserGlobals },
    rules,
  },
  {
    files: ['scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules,
  },
];
