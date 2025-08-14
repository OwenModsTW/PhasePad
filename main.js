const { app, BrowserWindow, globalShortcut, screen, ipcMain, dialog, shell, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const remoteMain = require('@electron/remote/main');
const { autoUpdater } = require('electron-updater');
remoteMain.initialize();

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let overlayWindow = null;
let isOverlayVisible = false;
let tray = null;
let currentHotkeys = {
  toggleOverlay: 'Alt+Q',
  newNote: 'Ctrl+Shift+N',
  search: 'Ctrl+F',
  archive: 'Ctrl+Shift+A'
};

// Load hotkeys from config
function loadHotkeysConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.hotkeys) {
        currentHotkeys = { ...currentHotkeys, ...config.hotkeys };
      }
    }
  } catch (error) {
    console.error('Error loading hotkeys config:', error);
  }
}

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  overlayWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreen: false,
    resizable: false,
    movable: false,
    focusable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: true,
      enableWebSQL: false,
      webgl: true,
      plugins: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  
  // Enable remote module for this window
  remoteMain.enable(overlayWindow.webContents);
  
  // Enable spell check context menu
  overlayWindow.webContents.on('context-menu', (event, params) => {
    const { selectionText, isEditable, misspelledWord, dictionarySuggestions } = params;
    
    if (misspelledWord) {
      // Create context menu for misspelled words
      const spellingMenu = Menu.buildFromTemplate([
        ...dictionarySuggestions.slice(0, 6).map(suggestion => ({
          label: suggestion,
          click: () => overlayWindow.webContents.replaceMisspelling(suggestion)
        })),
        { type: 'separator' },
        {
          label: 'Add to Dictionary',
          click: () => overlayWindow.webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
        }
      ]);
      spellingMenu.popup();
    } else if (isEditable) {
      // Create standard edit context menu
      const editMenu = Menu.buildFromTemplate([
        { role: 'cut', enabled: selectionText.length > 0 },
        { role: 'copy', enabled: selectionText.length > 0 },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]);
      editMenu.popup();
    }
  });
  
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.setVisibleOnAllWorkspaces(true);
  
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function toggleOverlay() {
  if (!overlayWindow) return;
  
  if (isOverlayVisible) {
    // Send fade out event to renderer
    overlayWindow.webContents.send('fade-out');
    // Wait for animation to complete before hiding
    setTimeout(() => {
      overlayWindow.hide();
      isOverlayVisible = false;
    }, 300);
  } else {
    overlayWindow.show();
    overlayWindow.focus();
    overlayWindow.webContents.send('fade-in');
    isOverlayVisible = true;
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'media', 'PhasePad.ico');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Notes',
      click: () => {
        toggleOverlay();
      }
    },
    {
      label: 'Quit PhasePad',
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('PhasePad - Desktop Notes');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    toggleOverlay();
  });
}

function registerGlobalShortcuts() {
  // Unregister all existing shortcuts first
  globalShortcut.unregisterAll();
  
  // Register toggle overlay hotkey
  if (currentHotkeys.toggleOverlay) {
    const ret = globalShortcut.register(currentHotkeys.toggleOverlay, () => {
      toggleOverlay();
    });
    if (ret) {
      console.log(`Successfully registered hotkey: ${currentHotkeys.toggleOverlay} for toggle overlay`);
    } else {
      console.log(`Failed to register hotkey: ${currentHotkeys.toggleOverlay}`);
    }
  }
  
  // Register new note hotkey
  if (currentHotkeys.newNote) {
    const ret = globalShortcut.register(currentHotkeys.newNote, () => {
      console.log('New note hotkey pressed');
      // Show overlay if hidden
      if (!isOverlayVisible) {
        overlayWindow.show();
        overlayWindow.focus();
        overlayWindow.webContents.send('fade-in');
        isOverlayVisible = true;
      }
      // Send command to create new note
      overlayWindow.webContents.send('create-new-note', 'text');
    });
    if (ret) {
      console.log(`Successfully registered hotkey: ${currentHotkeys.newNote} for new note`);
    }
  }
  
  // Register search hotkey (only works when overlay is visible)
  if (currentHotkeys.search) {
    const ret = globalShortcut.register(currentHotkeys.search, () => {
      console.log('Search hotkey pressed');
      // Only trigger search if overlay is already visible
      if (isOverlayVisible) {
        overlayWindow.webContents.send('focus-search');
      }
    });
    if (ret) {
      console.log(`Successfully registered hotkey: ${currentHotkeys.search} for search`);
    }
  }
  
  // Register archive hotkey
  if (currentHotkeys.archive) {
    const ret = globalShortcut.register(currentHotkeys.archive, () => {
      console.log('Archive hotkey pressed');
      if (!isOverlayVisible) {
        overlayWindow.show();
        overlayWindow.focus();
        overlayWindow.webContents.send('fade-in');
        isOverlayVisible = true;
      }
      overlayWindow.webContents.send('toggle-archive');
    });
    if (ret) {
      console.log(`Successfully registered hotkey: ${currentHotkeys.archive} for archive`);
    }
  }
}

app.whenReady().then(() => {
  createOverlayWindow();
  createTray();
  
  // Load hotkeys configuration
  loadHotkeysConfig();
  
  // Register global shortcuts
  registerGlobalShortcuts();
  
  // Handle startup behavior
  const isStartup = process.argv.includes('--startup');
  if (isStartup) {
    // Started with Windows - start hidden
    overlayWindow.hide();
    isOverlayVisible = false;
  }
  
  // Setup auto-updater
  setupAutoUpdater();
  
  // Check for updates after a delay
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 3000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createOverlayWindow();
  }
});

// IPC handlers for file operations
ipcMain.handle('open-file-dialog', async () => {
  // Temporarily hide overlay to show dialog on top
  if (overlayWindow) {
    overlayWindow.setAlwaysOnTop(false);
  }
  
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  // Restore overlay on top
  if (overlayWindow) {
    overlayWindow.setAlwaysOnTop(true);
  }
  
  return result;
});

ipcMain.handle('open-image-dialog', async () => {
  // Temporarily hide overlay to show dialog on top
  if (overlayWindow) {
    overlayWindow.setAlwaysOnTop(false);
  }
  
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }
    ]
  });
  
  // Restore overlay on top
  if (overlayWindow) {
    overlayWindow.setAlwaysOnTop(true);
  }
  
  return result;
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    // Normalize the path for Windows
    const normalizedPath = path.normalize(filePath);
    console.log('Opening file:', normalizedPath);
    
    // Use shell.openPath which returns a promise with error string if failed
    const errorMessage = await shell.openPath(normalizedPath);
    if (errorMessage) {
      console.error('Failed to open file:', errorMessage);
      return { error: errorMessage };
    }
    return { success: true };
  } catch (error) {
    console.error('Error opening file:', error);
    return { error: error.message };
  }
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 300, height: 200 }
  });
  return sources;
});

// Handle area screenshot
ipcMain.handle('start-area-screenshot', async () => {
  // Hide overlay for area selection
  if (overlayWindow) {
    overlayWindow.hide();
  }
  
  // Get all displays to create area selection windows on each
  const displays = screen.getAllDisplays();
  const areaWindows = [];
  
  // Create an area selection window for each display
  for (const display of displays) {
    const areaWindow = new BrowserWindow({
      width: display.bounds.width,
      height: display.bounds.height,
      x: display.bounds.x,
      y: display.bounds.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: true,
        enableWebSQL: false,
        webgl: true,
        plugins: false
      }
    });
    
    areaWindow.loadFile(path.join(__dirname, 'overlay', 'area-select.html'));
    
    // Enable remote module for this window
    remoteMain.enable(areaWindow.webContents);
    
    // Pass display info to the window
    areaWindow.webContents.once('did-finish-load', () => {
      areaWindow.webContents.send('display-info', {
        id: display.id,
        bounds: display.bounds
      });
    });
    
    areaWindows.push(areaWindow);
  }
  
  return new Promise((resolve) => {
    ipcMain.once('area-selected', (event, bounds) => {
      // Close all area windows
      areaWindows.forEach(win => win.close());
      // Delay showing overlay to prevent capturing it in screenshot
      setTimeout(() => {
        if (overlayWindow) {
          overlayWindow.show();
        }
      }, 1000); // 1 second delay
      resolve(bounds);
    });
    
    ipcMain.once('area-cancelled', () => {
      // Close all area windows
      areaWindows.forEach(win => win.close());
      if (overlayWindow) {
        overlayWindow.show();
      }
      resolve(null);
    });
  });
});

// Handle screenshot capture
ipcMain.handle('capture-screenshot', async (event, sourceId, bounds = null) => {
  try {
    // If bounds are provided, get higher resolution capture and determine correct display
    let targetDisplaySize = screen.getPrimaryDisplay().size;
    let targetSourceId = sourceId;
    
    if (bounds && bounds.displayBounds) {
      // Use the display size from the area selection
      targetDisplaySize = {
        width: bounds.displayBounds.width,
        height: bounds.displayBounds.height
      };
      
      // Find the correct screen source for this display
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: targetDisplaySize.width, height: targetDisplaySize.height }
      });
      
      // Try to find the screen source that matches the display
      const matchingSource = sources.find(s => {
        // Screen sources are usually named like 'screen:0:0', 'screen:1:0', etc.
        return s.name.includes(`${bounds.displayId}`) || s.display_id === bounds.displayId;
      });
      
      if (matchingSource) {
        targetSourceId = matchingSource.id;
        console.log('Found matching screen source:', targetSourceId, 'for display:', bounds.displayId);
      } else {
        // Fallback: use the first available screen source
        targetSourceId = sources.length > bounds.displayId ? sources[bounds.displayId].id : sources[0].id;
        console.log('Using fallback screen source:', targetSourceId);
      }
    } else {
      // For non-area screenshots, get all sources
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });
    }
    
    // Get sources with appropriate thumbnail size
    const thumbnailSize = bounds ? 
      { width: targetDisplaySize.width, height: targetDisplaySize.height } :
      { width: 1920, height: 1080 };
      
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: thumbnailSize
    });
    
    const source = sources.find(s => s.id === targetSourceId);
    if (!source) {
      throw new Error(`Source not found: ${targetSourceId}`);
    }
    
    let screenshot = source.thumbnail;
    
    // If bounds are provided (area selection), crop using Electron's built-in cropping
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      try {
        const originalSize = screenshot.getSize();
        console.log('Original screenshot size:', originalSize);
        console.log('Crop bounds:', bounds);
        console.log('Target display size:', targetDisplaySize);
        
        // Calculate scale factors based on the actual display size
        const scaleX = originalSize.width / targetDisplaySize.width;
        const scaleY = originalSize.height / targetDisplaySize.height;
        
        // Adjust bounds for scaling
        const cropBounds = {
          x: Math.round(bounds.x * scaleX),
          y: Math.round(bounds.y * scaleY),
          width: Math.round(bounds.width * scaleX),
          height: Math.round(bounds.height * scaleY)
        };
        
        console.log('Scaled crop bounds:', cropBounds);
        
        // Use Electron's crop method
        screenshot = screenshot.crop(cropBounds);
        console.log('Successfully cropped screenshot using Electron crop');
      } catch (error) {
        console.log('Electron cropping failed, using full image:', error.message);
        // Fall back to full screenshot if cropping fails
      }
    }
    
    // Convert to data URL
    const dataUrl = screenshot.toDataURL();
    return { success: true, dataUrl };
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    return { error: error.message };
  }
});

// Handle showing overlay and focusing on specific note
ipcMain.handle('show-overlay-and-focus-note', async (event, noteId) => {
  if (!overlayWindow) return;
  
  // Show overlay if hidden
  if (!isOverlayVisible) {
    overlayWindow.show();
    overlayWindow.focus();
    overlayWindow.webContents.send('fade-in');
    isOverlayVisible = true;
  }
  
  // Send message to focus on specific note
  overlayWindow.webContents.send('focus-on-note', noteId);
  
  // Bring window to front
  overlayWindow.moveTop();
  overlayWindow.focus();
  
  return { success: true };
});

// Handle hide overlay request from renderer
ipcMain.on('fade-out', () => {
  if (overlayWindow && isOverlayVisible) {
    // Wait for fade animation to complete before hiding
    setTimeout(() => {
      overlayWindow.hide();
      isOverlayVisible = false;
    }, 300);
  }
});

// Handle toggle overlay from ESC key
ipcMain.on('toggle-overlay', () => {
  toggleOverlay();
});

// Timer window management
const timerWindows = {};

ipcMain.handle('create-timer-window', async (event, noteData) => {
  const { id, x, y, width, height } = noteData;
  
  // Check if window already exists
  if (timerWindows[id]) {
    timerWindows[id].focus();
    return;
  }
  
  // Create a new window for the timer
  const timerWindow = new BrowserWindow({
    width: 300,
    height: 200,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: true,
      enableWebSQL: false,
      webgl: true,
      plugins: false
    }
  });
  
  timerWindow.loadFile(path.join(__dirname, 'overlay', 'timer-window.html'));
  
  // Enable remote module for this window
  remoteMain.enable(timerWindow.webContents);
  
  // Pass note data to the window
  timerWindow.webContents.on('did-finish-load', () => {
    timerWindow.webContents.send('timer-data', noteData);
  });
  
  timerWindow.on('closed', () => {
    delete timerWindows[id];
  });
  
  timerWindows[id] = timerWindow;
});

ipcMain.handle('close-timer-window', async (event, noteId) => {
  if (timerWindows[noteId]) {
    timerWindows[noteId].close();
    delete timerWindows[noteId];
  }
});

ipcMain.handle('update-timer-window', async (event, noteId, data) => {
  if (timerWindows[noteId]) {
    timerWindows[noteId].webContents.send('update-timer', data);
  }
});

// Handle timer widget actions from detached windows
ipcMain.on('timer-widget-action', (event, data) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('timer-widget-action', data);
  }
});

ipcMain.on('timer-widget-update', (event, data) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('timer-widget-update', data);
  }
});

// Handle hotkey updates
ipcMain.handle('update-hotkeys', async (event, newHotkeys) => {
  currentHotkeys = newHotkeys;
  registerGlobalShortcuts();
  return true;
});

// Handle startup management
ipcMain.handle('get-startup-status', async () => {
  try {
    const Registry = require('winreg');
    const regKey = new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    });
    
    return new Promise((resolve) => {
      regKey.get('PhasePad', (err, item) => {
        resolve(!err && item);
      });
    });
  } catch (error) {
    console.error('Error checking startup status:', error);
    return false;
  }
});

ipcMain.handle('set-startup-status', async (event, enabled) => {
  try {
    const Registry = require('winreg');
    const regKey = new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    });
    
    if (enabled) {
      const exePath = process.execPath;
      return new Promise((resolve, reject) => {
        regKey.set('PhasePad', Registry.REG_SZ, `"${exePath}" --startup`, (err) => {
          if (err) reject(err);
          else resolve(true);
        });
      });
    } else {
      return new Promise((resolve, reject) => {
        regKey.remove('PhasePad', (err) => {
          if (err && err.code !== 2) reject(err); // Code 2 = key doesn't exist
          else resolve(true);
        });
      });
    }
  } catch (error) {
    console.error('Error setting startup status:', error);
    return false;
  }
});

// Auto-updater setup
function setupAutoUpdater() {
  // Configure update server
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'OwenModsTW',
    repo: 'PhasePad'
  });

  // Auto-updater events
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(overlayWindow, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available. Would you like to download it?`,
      detail: 'The update will be installed when you quit the application.',
      buttons: ['Download', 'Later'],
      defaultId: 0
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    console.log(log_message);
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(overlayWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded. The application will restart to apply the update.',
      buttons: ['Restart Now', 'Later']
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
}

// Handle update check from renderer
ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify();
    return result;
  } catch (error) {
    console.error('Error checking for updates:', error);
    return null;
  }
});

