// Stand-in for the electron module when organs are dry-loaded in a plain Node child
// for verification: every export is a harmless no-op class or function.
const noop = () => {};
class Stub { constructor() { return new Proxy(this, { get: () => noop }); } }
module.exports = new Proxy({}, { get: (_, k) => (k === 'app' ? { getPath: () => '/tmp', getVersion: () => '0', isPackaged: false, whenReady: () => Promise.resolve(), on: noop } : /^[A-Z]/.test(String(k)) ? Stub : noop) });
