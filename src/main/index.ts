import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { openDatabase, type Db } from './db/connection';
import { seedDemoWorkspaces } from './db/demo';
import { addWorkspace, listWorkspaces, switchWorkspace } from './db/workspaces';
import { assertGitRepository } from './git';
import { tutorHandlers } from './tutor/ipc';
import { createGenerator, createTutorRunner } from './tutor/provider';
import { TutorSession } from './tutor/session';
import { readerHandlers } from './reader/ipc';
import { graphHandlers } from './graph-ipc';
import { LearnInbox } from './repository/intents';
import { RepositoryLearning } from './repository/service';
import { LabHost } from './environment/host';
import { registerIpc, type IpcHandlers } from './ipc';
import { registerAppScheme, serveRenderer } from './protocol';
import { detectProviders } from './providers/detect';
import { APP_ORIGIN, applySecurityPolicy, isAppUrl } from './security';

// electron-vite sets this in development only; an empty value means "not set".
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined;

// Tests and portable setups point Delve at a separate data directory.
const userDataOverride = process.env['DELVE_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

function createWindow(labs: LabHost): BrowserWindow {
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
  window.webContents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) labs.clear(); });
  window.webContents.on('render-process-gone', () => labs.clear());
  window.webContents.on('destroyed', () => labs.clear());
  window.once('ready-to-show', () => window.show());
  const url = devServerUrl ?? `${APP_ORIGIN}/index.html`;
  window.loadURL(url).catch((error: unknown) => {
    dialog.showErrorBox('Delve could not start', `Failed to load ${url}: ${String(error)}`);
    app.exit(1);
  });
  return window;
}

function buildHandlers(db: Db, tutor: TutorSession, labs: LabHost, learning: RepositoryLearning, links: LearnInbox): IpcHandlers {
  return {
    'workspaces:list': () => listWorkspaces(db),
    'workspaces:add': async (input) => {
      if (input.kind === 'git') await assertGitRepository(input.path);
      const workspace = addWorkspace(db, input);
      labs.clear();
      return workspace;
    },
    'workspaces:switch': ({ id }) => {
      const result = switchWorkspace(db, id);
      labs.clear();
      return result;
    },
    'workspaces:pick-folder': async () => {
      const owner = BrowserWindow.getFocusedWindow();
      const options = { title: 'Choose a Git repository', properties: ['openDirectory' as const] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'providers:detect': () => detectProviders(),
    ...readerHandlers(db),
    ...tutorHandlers(db, tutor),
    ...graphHandlers(db),
    'repo:files': ({ workspaceId }) => learning.files(workspaceId),
    'repo:changes': ({ workspaceId }) => learning.changes(workspaceId),
    'repo:preview': request => learning.preview(request),
    'repo:saved': request => learning.saved(request),
    'repo:generate': ({ token, requestId }) => learning.generate(token, requestId),
    'repo:cancel': ({ requestId }) => learning.cancel(requestId),
    'learn:pending': () => links.peek(),
    'learn:resolve': ({ id, accept }) => {
      const workspace = links.resolve(db, id, accept);
      if (workspace) labs.clear();
      return workspace;
    },
    'lab:open': request => labs.open(request),
    'lab:input': request => labs.input(request),
    'lab:close': request => labs.close(request),
  };
}

async function start(links: LearnInbox): Promise<void> {
  await app.whenReady();
  applySecurityPolicy(devServerUrl);
  serveRenderer(join(__dirname, '../renderer'), devServerUrl);
  const db = openDatabase(join(app.getPath('userData'), 'delve.sqlite'));
  const runner = createTutorRunner();
  const learning = new RepositoryLearning(db, join(app.getPath('userData'), 'repositories'), runner);
  const tutor = new TutorSession(db, createGenerator(runner));
  let draining = false;
  let drained = false;
  app.on('before-quit', event => {
    if (drained) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    tutor.close();
    void Promise.all([learning.close(), runner.drain()]).then(() => { drained = true; app.quit(); });
  });
  app.on('will-quit', () => db.close());
  seedDemoWorkspaces(db);
  const labs = new LabHost(db);
  registerIpc(ipcMain, buildHandlers(db, tutor, labs, learning, links), (url) => isAppUrl(url, devServerUrl));
  createWindow(labs);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(labs);
  });
}

registerAppScheme();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const links = new LearnInbox();
  const receive = (url: string) => {
    try { links.receive(url); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid learn link.';
      void app.whenReady().then(() => dialog.showMessageBox({ type: 'warning', title: 'Learn link', message }));
    }
  };
  const receiveArgs = (args: string[]) => args.filter(arg => /^delve:\/\//i.test(arg)).slice(0, 16).forEach(receive);
  app.on('open-url', (event, url) => { event.preventDefault(); receive(url); });
  receiveArgs(process.argv);
  if (app.isPackaged && !app.isDefaultProtocolClient('delve') && !app.setAsDefaultProtocolClient('delve')) {
    console.warn('[delve] The OS did not register delve:// links. Select Delve as the handler in system settings.');
  }
  app.on('second-instance', (_event, argv) => {
    receiveArgs(argv);
    const [window] = BrowserWindow.getAllWindows();
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  start(links).catch((error: unknown) => {
    console.error('[delve] startup failed', error);
    dialog.showErrorBox('Delve could not start', String(error));
    app.exit(1);
  });
}
