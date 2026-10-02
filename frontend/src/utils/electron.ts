export interface UpdateStatus {
  state: 'downloading' | 'ready'
  version: string
}

/** Result of a user-triggered update check. `supported` is false outside a packaged build. */
export interface UpdateCheckResult {
  supported: boolean
  available?: boolean
  version?: string | null
  current?: string
  error?: string
}

export interface ElectronAPI {
  platform: string
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => void
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => void
  restartAndInstallUpdate: () => void
  checkForUpdates: () => Promise<UpdateCheckResult>
  updatesSupported: () => Promise<boolean>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export const isElectron = (): boolean => typeof window !== 'undefined' && !!window.electronAPI

export const electronAPI = (): ElectronAPI | undefined => window.electronAPI

export const isMacElectron = (): boolean => isElectron() && window.electronAPI?.platform === 'darwin'
