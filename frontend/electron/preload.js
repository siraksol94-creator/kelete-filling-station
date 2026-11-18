const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', cb),
  removeUpdateNotAvailableListener: (cb) => ipcRenderer.removeListener('update-not-available', cb),
  printSilent: (html) => ipcRenderer.invoke('print-silent', html),
});

// Runs in renderer context before any page scripts — clears auth so login is always required
window.addEventListener('DOMContentLoaded', () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
});
