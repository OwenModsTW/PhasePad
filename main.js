const { app, BrowserWindow, globalShortcut, screen, ipcMain, dialog, shell, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const remoteMain = require('@electron/remote/main');
remoteMain.initialize();

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
      contextIsolation: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  
  // Enable remote module for this window
  remoteMain.enable(overlayWindow.webContents);
  
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
  
  // Register search hotkey
  if (currentHotkeys.search) {
    const ret = globalShortcut.register(currentHotkeys.search, () => {
      console.log('Search hotkey pressed');
      if (!isOverlayVisible) {
        overlayWindow.show();
        overlayWindow.focus();
        overlayWindow.webContents.send('fade-in');
        isOverlayVisible = true;
      }
      overlayWindow.webContents.send('focus-search');
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
  
  // Create a fullscreen transparent window for area selection
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const areaWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  areaWindow.loadFile(path.join(__dirname, 'overlay', 'area-select.html'));
  
  // Enable remote module for this window
  remoteMain.enable(areaWindow.webContents);
  
  return new Promise((resolve) => {
    ipcMain.once('area-selected', (event, bounds) => {
      areaWindow.close();
      // Delay showing overlay to prevent capturing it in screenshot
      setTimeout(() => {
        if (overlayWindow) {
          overlayWindow.show();
        }
      }, 1000); // 1 second delay
      resolve(bounds);
    });
    
    ipcMain.once('area-cancelled', () => {
      areaWindow.close();
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
    // For area screenshots, get higher resolution capture
    const thumbnailSize = bounds ? 
      { width: screen.getPrimaryDisplay().size.width, height: screen.getPrimaryDisplay().size.height } :
      { width: 1920, height: 1080 };
      
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: thumbnailSize
    });
    
    const source = sources.find(s => s.id === sourceId);
    if (!source) {
      throw new Error('Source not found');
    }
    
    let screenshot = source.thumbnail;
    
    // If bounds are provided (area selection), crop using Electron's built-in cropping
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      try {
        const originalSize = screenshot.getSize();
        console.log('Original screenshot size:', originalSize);
        console.log('Crop bounds:', bounds);
        
        // Calculate scale factors
        const scaleX = originalSize.width / screen.getPrimaryDisplay().size.width;
        const scaleY = originalSize.height / screen.getPrimaryDisplay().size.height;
        
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
      contextIsolation: false
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

