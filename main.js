const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const GEMINI_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');

// Enable CDP remote debugging for Playwright/automation (Electron 30+ requires this approach)
if (process.argv.includes('--dev')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow;
let activeProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    // icon: path.join(__dirname, 'src', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (activeProcess) {
    activeProcess.kill();
  }
  app.quit();
});

// Window controls
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized());

// Folder selection
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Folder'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// File selection
ipcMain.handle('dialog:selectFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach Files'
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// Open folder in explorer or URL in browser
ipcMain.handle('shell:openFolder', async (_, pathOrUrl) => {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    shell.openExternal(pathOrUrl);
  } else {
    shell.openPath(pathOrUrl);
  }
});

// Read folder-specific instructions (GEMINI.md)
ipcMain.handle('gemini:readFolderInstructions', async (_, workingDir) => {
  try {
    const filePath = path.join(workingDir, 'GEMINI.md');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (e) { /* ignore */ }
  return null;
});

// Check if Gemini CLI is installed
ipcMain.handle('gemini:checkInstalled', async () => {
  // gemini --version hangs on Windows, so use 'where' to check existence
  // then read the package.json for the actual version
  return new Promise((resolve) => {
    const proc = spawn('where', ['gemini'], { shell: true });
    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        resolve(null);
        return;
      }
      // Try to read version from the globally installed package
      try {
        const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'gemini-cli', 'package.json');
        const npmGlobal2 = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
        const geminiPkg = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'package.json');
        for (const pkgPath of [geminiPkg, npmGlobal, npmGlobal2]) {
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            resolve(pkg.version || 'installed');
            return;
          }
        }
      } catch (e) { /* ignore */ }
      resolve('installed');
    });
    proc.on('error', () => resolve(null));
  });
});

// Send message to Gemini CLI
ipcMain.handle('gemini:sendMessage', async (event, { message, workingDir, options }) => {
  // Kill any existing process
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }

  // Build command string for Windows shell execution
  // (Node.js spawn with shell:true on Windows has quoting issues with .cmd files)
  const cmdParts = ['gemini'];

  // Quote the message to handle special characters
  const escapedMessage = message.replace(/"/g, '\\"');
  cmdParts.push('-p', `"${escapedMessage}"`);

  // Use structured JSON output for reliable parsing
  cmdParts.push('-o', 'stream-json');

  // Skip MCP servers to reduce startup time (~15s faster)
  cmdParts.push('--allowed-mcp-server-names', 'none');

  // Resume previous session for follow-up messages
  if (options.sessionIndex != null) {
    cmdParts.push('--resume', String(options.sessionIndex));
  } else if (options.resume) {
    cmdParts.push('--resume', 'latest');
  }

  // Model selection
  if (options.model) {
    cmdParts.push('-m', options.model);
  }

  // Approval mode
  if (options.approvalMode) {
    cmdParts.push('--approval-mode', options.approvalMode === 'default' ? 'yolo' : options.approvalMode);
  } else {
    cmdParts.push('--approval-mode', 'yolo');
  }

  // Sandbox mode
  if (options.sandbox) {
    cmdParts.push('-s');
  }

  const fullCommand = cmdParts.join(' ');

  // Build environment with API key if provided
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  if (options.apiKey) {
    env.GEMINI_API_KEY = options.apiKey;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(fullCommand, [], {
      cwd: workingDir || undefined,
      shell: true,
      env
    });

    activeProcess = proc;
    let fullOutput = '';
    let errorOutput = '';
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      fullOutput += text;

      // Parse newline-delimited JSON (stream-json format)
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          mainWindow.webContents.send('gemini:stream', event);
        } catch (e) {
          // Fallback for non-JSON output
          mainWindow.webContents.send('gemini:stream', { type: 'text', content: line });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      activeProcess = null;
      // Flush remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          mainWindow.webContents.send('gemini:stream', event);
        } catch (e) {
          mainWindow.webContents.send('gemini:stream', { type: 'text', content: lineBuffer });
        }
      }
      mainWindow.webContents.send('gemini:stream', { type: 'done', code, error: errorOutput });
      resolve({ output: fullOutput, error: errorOutput, code });
    });

    proc.on('error', (err) => {
      activeProcess = null;
      mainWindow.webContents.send('gemini:stream', { type: 'error', content: err.message });
      reject(err);
    });
  });
});

// Cancel active Gemini process
ipcMain.handle('gemini:cancel', () => {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    return true;
  }
  return false;
});

// Write to stdin of active process
ipcMain.handle('gemini:writeStdin', (_, text) => {
  if (activeProcess && activeProcess.stdin.writable) {
    activeProcess.stdin.write(text);
    return true;
  }
  return false;
});

// Launch Google OAuth login flow via a terminal window
ipcMain.handle('gemini:googleLogin', async () => {
  // Open a terminal window running `gemini` which triggers the OAuth browser flow
  // The user completes login in the browser, then closes the terminal
  const proc = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'echo Gemini Google Login - Complete the login in your browser, then type exit to close this window. && gemini'], {
    shell: false,
    detached: true,
    stdio: 'ignore'
  });
  proc.unref();

  // Switch auth type to oauth-personal
  try {
    let settings = {};
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    }
    if (!settings.security) settings.security = {};
    if (!settings.security.auth) settings.security.auth = {};
    settings.security.auth.selectedType = 'oauth-personal';
    fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to update auth settings:', e);
  }

  return true;
});

// Check current auth status
ipcMain.handle('gemini:getAuthType', async () => {
  try {
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
      return settings?.security?.auth?.selectedType || 'oauth-personal';
    }
  } catch (e) { /* ignore */ }
  return 'oauth-personal';
});

// Configure Gemini CLI auth settings
ipcMain.handle('gemini:setAuthType', async (_, authType) => {
  try {
    let settings = {};
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    }
    if (!settings.security) settings.security = {};
    if (!settings.security.auth) settings.security.auth = {};
    settings.security.auth.selectedType = authType;
    fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to update Gemini settings:', e);
    return false;
  }
});

// List Gemini sessions for a directory
ipcMain.handle('gemini:listSessions', async (_, workingDir) => {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['--list-sessions'], {
      cwd: workingDir || undefined,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });
    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => resolve(output.trim()));
    proc.on('error', () => resolve(''));
  });
});
