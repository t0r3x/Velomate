'use strict'

// Electron on Windows runs this script in both the launcher process
// (process.type = undefined) and the real browser/main process
// (process.type = 'browser'). Only act in the real main process.
if (process.type !== 'browser') return

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, screen } = require('electron')
const { autoUpdater } = require('electron-updater')

// Set by setupAutoUpdater(). electron-updater only runs in a packaged build, so outside
// one the check has to answer honestly rather than not exist.
let autoUpdaterActive = false
const path = require('path')
const http = require('http')
const net = require('net')

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4h — mirrors the app's other periodic-check patterns

const isMac = process.platform === 'darwin'

let mainWindow = null

// A second launch (e.g. double-clicking the desktop shortcut again) would otherwise spin up
// its own backend + DB connection alongside the first, racing the same Garmin session — make
// the second launch just focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitForHttp(url, maxAttempts = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      const req = http.get(url, res => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (++attempts >= maxAttempts) {
          reject(new Error(`${url} did not respond after ${maxAttempts} attempts`))
        } else {
          setTimeout(check, 500)
        }
      })
      req.end()
    }
    setTimeout(check, 300)
  })
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

/** Preferred window size. Clamped to the screen below — see createWindow(). */
const DEFAULT_WIDTH = 1400
/**
 * Taller than it used to be (was 900): the training card now carries the daily check-in
 * above its scroll area, and at 900 the plan started out already scrolled.
 */
const DEFAULT_HEIGHT = 1040

function createWindow() {
  // workAreaSize excludes the taskbar/dock, so this never opens a window taller than the
  // screen can actually show — which 1040 would be on a 1366x768 or 1080p laptop.
  const { width: availableWidth, height: availableHeight } = screen.getPrimaryDisplay().workAreaSize

  const winOptions = {
    width:  Math.min(DEFAULT_WIDTH, availableWidth),
    height: Math.min(DEFAULT_HEIGHT, availableHeight),
    minWidth: 1000,
    minHeight: 650,
    title: 'Velomate',
    backgroundColor: '#0b0d12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }

  if (isMac) {
    winOptions.titleBarStyle = 'hiddenInset'
  } else {
    winOptions.frame = false
    winOptions.icon = path.join(__dirname, 'build', 'icon.ico') // matches electron-builder's win.icon; no .icns yet for mac
  }

  const win = new BrowserWindow(winOptions)
  mainWindow = win
  win.once('ready-to-show', () => win.show())

  // Electron denies window.open/target="_blank" by default — without this, the
  // external links in Settings/SyncResult (aistudio.google.com, connect.garmin.com)
  // silently do nothing instead of opening in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => win.close())

  // On-demand update check, so the user need not wait out the 4h interval. Returns a
  // result rather than only firing events: "no update available" fires no event at all,
  // and a button that silently does nothing is worse than no button.
  ipcMain.handle('update:supported', () => autoUpdaterActive)

  ipcMain.handle('update:check', async () => {
    if (!autoUpdaterActive) return { supported: false, current: app.getVersion() }
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result && result.updateInfo ? result.updateInfo.version : null
      return {
        supported: true,
        available: !!latest && latest !== app.getVersion(),
        version: latest,
        current: app.getVersion()
      }
    } catch (err) {
      console.error('[AutoUpdater] Manual check failed:', err)
      return { supported: true, error: (err && err.message) || String(err) }
    }
  })
  win.on('maximize', () => win.webContents.send('window:maximized-change', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized-change', false))

  return win
}

// GitHub Releases-based auto-update: downloads silently in the background once an
// update is found, then waits for the user to restart — never installs on its own
// while the app is running.
function setupAutoUpdater(win) {
  autoUpdaterActive = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update:status', { state: 'downloading', version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('update:status', { state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err == null ? 'unknown' : (err.stack || err).toString())
  })

  ipcMain.on('update:restart-and-install', () => autoUpdater.quitAndInstall())


  const check = () => autoUpdater.checkForUpdates().catch(err => console.error('[AutoUpdater] Check failed:', err))
  check()
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null)

    const devUrl = process.env.ELECTRON_DEV_URL
    const win = createWindow()

    // The backend (backend/dist/server.js) always runs in-process inside Electron —
    // its native better-sqlite3 binding must be built against Electron's Node ABI
    // (`npm run electron:rebuild`), so it can never also run under plain system Node
    // (e.g. `npm run dev --prefix backend`) at the same time without rebuilding again.
    let backendPort = 2012 // matches server.ts's default and frontend/vite.config.ts's dev proxy target

    if (!devUrl) {
      const userData = app.getPath('userData')
      backendPort = await findFreePort()
      process.env.PORT = String(backendPort)
      process.env.LOG_DIR = path.join(userData, 'logs')
    }

    require('./backend/dist/server.js')
    await waitForHttp(`http://127.0.0.1:${backendPort}/api/status`)

    if (devUrl) {
      win.loadURL(devUrl)
      win.webContents.openDevTools({ mode: 'detach' })
    } else {
      win.loadURL(`http://127.0.0.1:${backendPort}`)
      if (app.isPackaged) setupAutoUpdater(win)
    }
  } catch (err) {
    console.error('[Electron] Startup failed:', err)
    // console.error alone is invisible in a packaged app (no attached terminal) — without a
    // visible dialog, a startup failure just makes the app silently vanish with no clue why.
    dialog.showErrorBox('Velomate failed to start', (err && (err.stack || err.message)) || String(err))
    app.quit()
  }
})
