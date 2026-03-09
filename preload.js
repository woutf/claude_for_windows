const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true
});

// Initialize DOMPurify with the renderer window
const DOMPurify = createDOMPurify(window);

contextBridge.exposeInMainWorld('geminiAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximized: (callback) => {
    ipcRenderer.on('window:maximized', (_, val) => callback(val));
  },

  // Folder/file selection
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  openFolder: (path) => ipcRenderer.invoke('shell:openFolder', path),

  // Gemini CLI
  readFolderInstructions: (dir) => ipcRenderer.invoke('gemini:readFolderInstructions', dir),
  checkInstalled: () => ipcRenderer.invoke('gemini:checkInstalled'),
  sendMessage: (payload) => ipcRenderer.invoke('gemini:sendMessage', payload),
  cancel: () => ipcRenderer.invoke('gemini:cancel'),
  writeStdin: (text) => ipcRenderer.invoke('gemini:writeStdin', text),
  listSessions: (dir) => ipcRenderer.invoke('gemini:listSessions', dir),
  setAuthType: (type) => ipcRenderer.invoke('gemini:setAuthType', type),
  getAuthType: () => ipcRenderer.invoke('gemini:getAuthType'),
  googleLogin: () => ipcRenderer.invoke('gemini:googleLogin'),
  onStream: (callback) => {
    ipcRenderer.on('gemini:stream', (_, data) => callback(data));
  },
  onReady: (callback) => {
    ipcRenderer.on('gemini:ready', () => callback());
  },
  onShutdownSummaries: (callback) => {
    ipcRenderer.on('gemini:shutdown-summaries', (_, summaries) => callback(summaries));
  },

  // File attachments
  copyToWorkDir: (files, workingDir) => ipcRenderer.invoke('files:copyToWorkDir', { files, workingDir }),
  cleanAttachments: (workingDir) => ipcRenderer.invoke('files:cleanAttachments', workingDir),

  // Subagents
  setSubagents: (enabled) => ipcRenderer.invoke('gemini:setSubagents', enabled),
  getSubagents: () => ipcRenderer.invoke('gemini:getSubagents'),

  // Extensions
  fetchExtensions: () => ipcRenderer.invoke('gemini:fetchExtensions'),
  installExtension: (name) => ipcRenderer.invoke('gemini:installExtension', name),
  uninstallExtension: (name) => ipcRenderer.invoke('gemini:uninstallExtension', name),
  listInstalledExtensions: () => ipcRenderer.invoke('gemini:listInstalledExtensions'),

  // ACP mode
  preloadACP: (options) => ipcRenderer.invoke('gemini:preloadACP', options),
  setActiveSession: (uiSessionId) => ipcRenderer.invoke('gemini:setActiveSession', uiSessionId),
  killACP: () => ipcRenderer.invoke('gemini:killACP'),
  respondPermission: (toolId, outcome) => ipcRenderer.invoke('gemini:respondPermission', { toolId, outcome }),

  // App settings (startup, tray)
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('app:setMinimizeToTray', enabled),
  getMinimizeToTray: () => ipcRenderer.invoke('app:getMinimizeToTray'),

  // File utilities
  readFileBase64: (filePath) => ipcRenderer.invoke('files:readAsBase64', filePath),

  // Chat API (Code Assist)
  chatInit: () => ipcRenderer.invoke('chat:init'),
  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatCancel: () => ipcRenderer.invoke('chat:cancel'),
  onChatStream: (callback) => {
    ipcRenderer.on('chat:stream', (_, data) => callback(data));
  },
  chatListSessions: () => ipcRenderer.invoke('chat:sessions:list'),
  chatLoadSession: (id) => ipcRenderer.invoke('chat:sessions:load', id),
  chatSaveSession: (session) => ipcRenderer.invoke('chat:sessions:save', session),
  chatUpdateSession: (id, fields) => ipcRenderer.invoke('chat:sessions:update', { id, fields }),
  chatDeleteSession: (id) => ipcRenderer.invoke('chat:sessions:delete', id),

  // Markdown parsing (sanitized)
  parseMarkdown: (text) => DOMPurify.sanitize(marked.parse(text))
});
