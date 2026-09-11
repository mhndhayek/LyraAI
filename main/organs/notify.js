const { Notification } = require('electron');
const { execFile } = require('child_process');

// macOS refuses notifications from apps it has not authorised (UNErrorDomain error 1,
// typical for unsigned builds). When that happens we fall back to the system's
// AppleScript notification path, which shows a banner and can play a sound.
function osascriptNotify(title, body, sound) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 300);
  const script = `display notification "${esc(body)}" with title "${esc(title)}"${sound ? ' sound name "Glass"' : ''}`;
  return new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', script], { timeout: 8000 }, (err) => resolve(!err)));
}

function makeNotifier(settings, getWindow) {
  const state = { lastError: null, blocked: false };
  return {
    state,
    notify(kind, title, body) {
      const n = settings.get().notifications;
      if (!n.desktop || (kind && n[kind] === false)) return false;
      const w = getWindow();
      if (w && w.isFocused() && kind !== 'test') return false;
      if (!Notification.isSupported() || state.blocked) { osascriptNotify(title, body, n.sound); return true; }
      const note = new Notification({ title, body, silent: !n.sound });
      note.on('click', () => { const win = getWindow(); if (win) { win.show(); win.focus(); } });
      note.on('failed', (_, err) => { state.lastError = String(err); state.blocked = true; console.error('[notify] native failed, using osascript:', err); osascriptNotify(title, body, n.sound); });
      note.show();
      return true;
    },
  };
}
module.exports = { makeNotifier, osascriptNotify };
