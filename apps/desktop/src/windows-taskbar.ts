/** Windows taskbar identity without changing Electron's application or data-directory name. */
import { join } from 'node:path'

interface TaskbarWindow {
  setIcon: (path: string) => void
  setAppDetails: (options: { appId: string; appIconPath: string; relaunchCommand: string; relaunchDisplayName: string }) => void
}

/**
 * Quote one Windows argument using the executable's command-line parsing rules.
 * @param argument - One executable path or argument, without shell expansion.
 * @returns A double-quoted argument with backslashes and quotes preserved.
 */
export function windowsTaskbarArgument(argument: string): string {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

/**
 * Assign the product icon, taskbar label, and pin/relaunch information to a main window.
 * @param window - Newly created main window, before it is shown.
 * @param options - Existing release identity, resources, and launch information.
 */
export function configureWindowsTaskbar(window: TaskbarWindow, options: {
  development: boolean
  appPath: string
  resourcesPath: string
  manifest: unknown
  executable: string
  args: readonly string[]
  relaunchCommand?: string | undefined
}): void {
  const manifest = options.manifest
  const id = typeof manifest === 'object' && manifest !== null && 'dshDesktopAppId' in manifest ? manifest.dshDesktopAppId : undefined
  if (!options.development && (typeof id !== 'string' || id === '')) throw new Error('desktop taskbar: packaged application identifier is missing')
  const icon = options.development ? join(options.appPath, 'resources', 'icon-windows.png') : join(options.resourcesPath, 'icon.png')
  const relaunchIcon = options.development ? join(options.appPath, 'resources', 'tray-windows.ico') : join(options.resourcesPath, 'tray.ico')
  window.setIcon(icon)
  window.setAppDetails({
    appId: options.development ? 'com.lelov.aevora.development' : String(id),
    appIconPath: relaunchIcon,
    relaunchDisplayName: 'Aevora',
    relaunchCommand: options.development && options.relaunchCommand
      ? options.relaunchCommand
      : [options.executable, ...options.development ? options.args : []].map(windowsTaskbarArgument).join(' '),
  })
}
