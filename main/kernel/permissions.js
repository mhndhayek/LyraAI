// Who is allowed the microphone, the camera, a location, a USB device.
//
// Chromium asks before handing any of those to a page, and Electron's default
// answer is yes to most of them. For this app that default would cover every
// page the agent's browser is pointed at, and every extension panel, since a
// panel is an iframe loading a URL an extension chose. Nothing is granted here
// unless it is named below.
//
// This is kernel code on purpose. Organs are copied into the state folder and
// the agent may rewrite them, so a control living in the browser organ could be
// edited away by the thing it is meant to contain; the app bundle is read-only.

// The app's own window: a file:// page that is part of the build. It needs the
// microphone, so the user can talk to Lyra, and the clipboard, so "Copy address"
// and "Copy log" work. It has no use for a camera, a location or a device.
const APP = {
  name: 'app',
  allowed: new Set(['media', 'clipboard-sanitized-write']),
  media: new Set(['audio']),
};

// Every other session is a partition an organ made for web content — today the
// agent's browser, which reads pages and clicks things. It needs nothing.
const WEB = { name: 'web', allowed: new Set(), media: new Set() };

// Every permission Electron can ask or check, so a test can prove the web policy
// refuses all of them rather than only the ones we happened to think of.
const PERMISSIONS = [
  'clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read',
  'display-capture', 'fileSystem', 'fullscreen', 'geolocation', 'hid',
  'idle-detection', 'keyboardLock', 'media', 'mediaKeySystem', 'midi', 'midiSysex',
  'notifications', 'openExternal', 'pointerLock', 'serial', 'speaker-selection',
  'storage-access', 'top-level-storage-access', 'unknown', 'usb', 'window-management',
];

// Only the build itself is trusted, and the build is always loaded from disk.
// Anything else asking — an extension panel, a page in the agent's browser — is
// web content. A sandboxed iframe reports its origin as the string "null", and an
// origin we cannot read at all is refused rather than assumed to be ours.
function isBundled(origin) {
  return /^file:\/\//i.test(String(origin == null ? '' : origin));
}

// A request names every kind of capture it wants at once; a check names one, and
// says "unknown" when the question is about state rather than about capture.
function mediaKinds(details) {
  if (details && Array.isArray(details.mediaTypes)) return details.mediaTypes;
  if (details && details.mediaType) return [details.mediaType];
  return [];
}

function decide(policy, permission, origin, details) {
  if (!policy.allowed.has(permission)) return false;
  if (!isBundled(origin)) return false;
  if (permission !== 'media') return true;
  const kinds = mediaKinds(details);
  // A capture request that names nothing is one we cannot judge, so it is refused.
  if (!kinds.length) return false;
  return kinds.every((kind) => kind === 'unknown' || policy.media.has(kind));
}

function apply(ses, policy, onDenied) {
  if (!ses) return;
  const refused = (permission, origin) => { if (onDenied) { try { onDenied({ policy: policy.name, permission, origin }); } catch {} } };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (details && (details.securityOrigin || details.requestingUrl)) || (wc && wc.getURL ? wc.getURL() : '');
    const granted = decide(policy, permission, origin, details);
    if (!granted) refused(permission, origin);
    callback(granted);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => decide(policy, permission, requestingOrigin, details));
}

// Called once at startup. The listener covers partitions organs create later,
// which is how the agent's browser session gets locked down without the browser
// organ having to remember to do it.
function install({ app, session }, { onDenied } = {}) {
  app.on('session-created', (ses) => apply(ses, ses === session.defaultSession ? APP : WEB, onDenied));
  apply(session.defaultSession, APP, onDenied);
}

module.exports = { install, apply, decide, APP, WEB, PERMISSIONS };
