import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { openDatabase, type Db } from './db/connection';
import { addWorkspace, listWorkspaces, switchWorkspace } from './db/workspaces';
import { assertGitRepository } from './git';
import { registerIpc, type IpcHandlers } from './ipc';
import { registerAppScheme, serveRenderer } from './protocol';
import { detectProviders } from './providers/detect';
import { APP_ORIGIN, applySecurityPolicy, isAppUrl } from './security';

// electron-vite sets this in development only; an empty value means "not set".
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined;

// Tests and portable setups point Delve at a separate data directory.
const userDataOverride = process.env['DELVE_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Delve',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  const url = devServerUrl ?? `${APP_ORIGIN}/index.html`;
  window.loadURL(url).catch((error: unknown) => {
    dialog.showErrorBox('Delve could not start', `Failed to load ${url}: ${String(error)}`);
    app.exit(1);
  });
  return window;
}

function buildHandlers(db: Db): IpcHandlers {
  return {
    'workspaces:list': () => listWorkspaces(db),
    'workspaces:add': async (input) => {
      if (input.kind === 'git') await assertGitRepository(input.path);
      return addWorkspace(db, input);
    },
    'workspaces:switch': ({ id }) => switchWorkspace(db, id),
    'workspaces:pick-folder': async () => {
      const owner = BrowserWindow.getFocusedWindow();
      const options = { title: 'Choose a Git repository', properties: ['openDirectory' as const] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'providers:detect': () => detectProviders(),
  };
}

async function start(): Promise<void> {
  await app.whenReady();
  applySecurityPolicy(devServerUrl);
  serveRenderer(join(__dirname, '../renderer'));
  const db = openDatabase(join(app.getPath('userData'), 'delve.sqlite'));
  app.on('will-quit', () => db.close());
  registerIpc(ipcMain, buildHandlers(db), (url) => isAppUrl(url, devServerUrl));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

registerAppScheme();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  start().catch((error: unknown) => {
    console.error('[delve] startup failed', error);
    dialog.showErrorBox('Delve could not start', String(error));
    app.exit(1);
  });
}
