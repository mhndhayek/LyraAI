// Watchdog: reloads a hung or crashed UI, and drops into safe mode when it keeps crashing.
function attach(k, win) {
  const crashes = [];
  win.webContents.on('unresponsive', () => { k.log('UI unresponsive; reloading in 10 s'); setTimeout(() => { if (win.isDestroyed()) return; if (!win.webContents.isCrashed?.()) win.webContents.reload(); }, 10000); });
  win.webContents.on('render-process-gone', (_, d) => {
    const now = Date.now(); crashes.push(now); while (crashes.length && now - crashes[0] > 120000) crashes.shift();
    k.log(`UI process gone (${d.reason}); crash ${crashes.length} in 2 min`);
    if (crashes.length >= 3) k.loader.safeMode(`the UI crashed ${crashes.length} times in two minutes (${d.reason})`);
    else k.loader.reloadRenderer();
  });
}
module.exports = { attach };
