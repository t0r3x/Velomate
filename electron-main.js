'use strict'

// Electron on Windows runs this script in both the launcher process
// (process.type = undefined) and the real browser/main process
// (process.type = 'browser'). Only act in the real main process.
if (process.type !== 'browser') return

const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const http = require('http')
const net = require('net')

const isMac = process.platform === 'darwin'

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

function createWindow() {
  const winOptions = {
    width: 1400,
    height: 900,
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
  }

  const win = new BrowserWindow(winOptions)
  win.once('ready-to-show', () => win.show())

  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => win.close())
  win.on('maximize', () => win.webContents.send('window:maximized-change', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized-change', false))

  return win
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
    }
  } catch (err) {
    console.error('[Electron] Startup failed:', err)
    app.quit()
  }
})
