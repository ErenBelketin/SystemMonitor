const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const SystemMonitor = require('./monitor');

// Fix for Windows hiding windows over fullscreen apps
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow;
let tray;
let monitor;
let lhmProcess = null; // Declare lhmProcess globally
let overlayPosition = 'top-right';
let layoutMode = 'vertical'; // Default to vertical layout as requested
let isVisible = true;
let isLocked = true; // Default: click-through for gaming
let mouseTrackInterval = null;

function startLhm() {
  const lhmPath = path.join(__dirname, 'bin', 'LibreHardwareMonitor.exe');
  try {
    // Launch LHM minimized/hidden if possible
    lhmProcess = spawn(lhmPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    lhmProcess.unref();
    console.log('LHM Bridge started automatically.');
  } catch (e) {
    console.log('LHM Bridge could not be started (Executable missing).');
  }
}

function checkAndStartLhm() {
  exec('reg query "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full" /v Release', (err, stdout) => {
    if (err || !stdout) {
      console.log('.NET Framework 4.7.2+ not found. Skipping LHM to prevent download prompt.');
      return; 
    }
    const match = stdout.match(/0x([0-9a-fA-F]+)/);
    if (match) {
      const releaseNum = parseInt(match[1], 16);
      if (releaseNum >= 461808) { // 4.7.2 or higher
         startLhm();
         return;
      }
    }
    console.log('.NET Framework version is too old. Skipping LHM to prevent download prompt.');
  });
}

function stopLhm() {
  if (lhmProcess) {
    try {
      process.kill(lhmProcess.pid);
    } catch (e) {
      console.error('Failed to kill LHM process:', e.message);
    }
  }
}

// Helper for checking admin if needed
async function checkAdmin() {
  try {
    require('child_process').execSync('net session', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  let winWidth = 820;
  let winHeight = 24;

  if (layoutMode === 'vertical') {
    winWidth = 280;
    winHeight = 480;
  }

  const positions = {
    'top-right': { x: screenWidth - winWidth - 20, y: 20 },
    'top-left': { x: 20, y: 20 },
    'bottom-right': { x: screenWidth - winWidth - 20, y: screenHeight - winHeight - 20 },
    'bottom-left': { x: 20, y: screenHeight - winHeight - 20 }
  };

  const pos = positions[overlayPosition];

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    type: 'screen-saver', // Use screen-saver type for better fullscreen coverage
    focusable: false,
    enableLargerThanScreen: true, // Allow window to sit over fullscreen apps
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // Prevention of lag when game is focused
    }
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile('index.html');
  
  // Highest possible level to stay over most things
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 999);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  let trayIcon;
  try {
    // Try both app_icon.png and icon.png
    const iconPath = path.join(__dirname, 'icon.png');
    trayIcon = nativeImage.createFromPath(iconPath);
    
    if (trayIcon.isEmpty()) {
       trayIcon = nativeImage.createFromPath(path.join(__dirname, 'app_icon.png'));
    }

    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('System Monitor Overlay');
  updateTrayMenu();
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: '📊 System Monitor Overlay', enabled: false },
    { type: 'separator' },
    {
      label: isVisible ? '👁️ Gizle' : '👁️ Göster',
      click: () => {
        if (isVisible) { mainWindow.hide(); } else { mainWindow.show(); }
        isVisible = !isVisible;
        updateTrayMenu();
      }
    },
    {
      label: '📏 Görünüm (F3)',
      submenu: [
        { label: '📋 Dikey (Kart)', type: 'radio', checked: layoutMode === 'vertical', click: () => setLayoutMode('vertical') },
        { label: '➖ Yatay (Bar)', type: 'radio', checked: layoutMode === 'horizontal', click: () => setLayoutMode('horizontal') }
      ]
    },
    {
      label: isLocked ? '🔓 Kilidi Aç (Taşıma) (F7)' : '🔒 Kilitle (Taşıma) (F7)',
      click: () => { isLocked = !isLocked; setLocked(isLocked); }
    },
    { type: 'separator' },
    {
      label: '📍 Konum',
      submenu: [
        { label: '↗️ Sağ Üst', type: 'radio', checked: overlayPosition === 'top-right', click: () => setPosition('top-right') },
        { label: '↖️ Sol Üst', type: 'radio', checked: overlayPosition === 'top-left', click: () => setPosition('top-left') },
        { label: '↘️ Sağ Alt', type: 'radio', checked: overlayPosition === 'bottom-right', click: () => setPosition('bottom-right') },
        { label: '↙️ Sol Alt', type: 'radio', checked: overlayPosition === 'bottom-left', click: () => setPosition('bottom-left') }
      ]
    },
    { type: 'separator' },
    { label: '🔄 Yeniden Başlat', click: () => { app.relaunch(); app.exit(0); } },
    { label: '❌ Çıkış', click: () => { if (monitor) monitor.stop(); app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

function setLayoutMode(mode) {
  layoutMode = mode;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  let winWidth, winHeight;
  if (mode === 'vertical') {
    winWidth = 280;
    winHeight = 480;
  } else {
    // Horizontal mode: ULTRA SLEEK (24px height)
    winWidth = 820;
    winHeight = 24;
  }

  // Workaround for Electron bug on Windows where setSize fails if resizable is false
  mainWindow.setResizable(true);
  mainWindow.setSize(winWidth, winHeight);
  mainWindow.setResizable(false);
  
  // Recalculate position to keep it in the same corner
  const positions = {
    'top-right': { x: screenWidth - winWidth - 20, y: 20 },
    'top-left': { x: 20, y: 20 },
    'bottom-right': { x: screenWidth - winWidth - 20, y: screenHeight - winHeight - 20 },
    'bottom-left': { x: 20, y: screenHeight - winHeight - 20 }
  };
  
  const pos = positions[overlayPosition];
  mainWindow.setPosition(pos.x, pos.y);
  
  // Notify renderer
  mainWindow.webContents.send('layout-change', mode);
  updateTrayMenu();
}

function setLocked(locked) {
  isLocked = locked;
  if (mainWindow) {
    if (locked) {
      // Locked: Click-through and forwarding
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      // Unlocked: Normal interaction for dragging
      mainWindow.setIgnoreMouseEvents(false);
    }
    // Notify renderer to show drag hints
    mainWindow.webContents.send('lock-change', locked);
  }
  updateTrayMenu();
}

function setPosition(position) {
  overlayPosition = position;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const winBounds = mainWindow.getBounds();

  const positions = {
    'top-right': { x: screenWidth - winBounds.width - 20, y: 20 },
    'top-left': { x: 20, y: 20 },
    'bottom-right': { x: screenWidth - winBounds.width - 20, y: screenHeight - winBounds.height - 20 },
    'bottom-left': { x: 20, y: screenHeight - winBounds.height - 20 }
  };

  const pos = positions[position];
  mainWindow.setPosition(pos.x, pos.y);
  updateTrayMenu();
}

app.whenReady().then(async () => {
  // Simple check for debugging, the EXE manifest will handle the actual UAC prompt
  const elevated = await checkAdmin();
  console.log(`Administrator Privileges: ${elevated ? 'YES' : 'NO'}`);

  ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  ipcMain.on('resize-window', (event, height) => {
    if (mainWindow && !mainWindow.isDestroyed() && layoutMode === 'vertical') {
        const bounds = mainWindow.getBounds();
        // Sadece yüksekliği güncelle (titrememesi için tolerans ekle)
        if (Math.abs(bounds.height - height) > 5) {
            mainWindow.setResizable(true);
            mainWindow.setSize(280, height);
            mainWindow.setResizable(false);
            
            // Eğer pencere sağ alttaysa, yüksekliği değiştiği için konumunu da yukarı itmeliyiz
            if (overlayPosition.includes('bottom')) {
               setPosition(overlayPosition);
            }
        }
    }
  });

  createWindow();
  createTray();
  checkAndStartLhm();

  // Ultra-responsive Mouse Tracking (20Hz)
  mouseTrackInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!isLocked) return; // If manually unlocked via menu, keep interactive

    const point = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    
    // 5px Buffer for easier hover detection on thin bar
    const buffer = 5;
    const isOver = point.x >= bounds.x - buffer && 
                   point.x <= bounds.x + bounds.width + buffer &&
                   point.y >= bounds.y - buffer && 
                   point.y <= bounds.y + bounds.height + buffer;

    if (isOver) {
      mainWindow.setIgnoreMouseEvents(false);
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }, 150);

  monitor = new SystemMonitor();
  monitor.start((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system-data', data);
    }
  });

  // Global quit shortcut (Failsafe)
  globalShortcut.register('CommandOrControl+Shift+F12', () => {
    if (monitor) monitor.stop();
    stopLhm();
    app.quit();
  });

  // Hotkey to toggle layout mode
  globalShortcut.register('F3', () => {
    const nextMode = layoutMode === 'vertical' ? 'horizontal' : 'vertical';
    setLayoutMode(nextMode);
  });

  // Hotkey to toggle lock (moving) mode
  globalShortcut.register('F7', () => {
    isLocked = !isLocked;
    setLocked(isLocked);
  });
});

app.on('window-all-closed', () => {
  stopLhm();
  if (monitor) monitor.stop();
  app.quit();
});

app.on('before-quit', () => {
  stopLhm();
  if (monitor) monitor.stop();
});
