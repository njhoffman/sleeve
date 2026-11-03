// The page's one channel to the shell, one way: the wallpaper colors behind the overlay, as backdrop samples them.
// Plain CommonJS, since sandboxed preloads run without Node's loader (no TypeScript, no ESM).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sleeveShell', {
  onColors(listener) {
    if (typeof listener !== 'function') return;
    ipcRenderer.on('sleeve:colors', (_event, colors) => listener(colors));
    ipcRenderer.send('sleeve:colors-wanted');
  }
});
