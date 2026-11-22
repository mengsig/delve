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
import { installShutdown } from './shutdown';
import { ConnectionSession } from './connections/session';
import { createTransferLink, getGlobalKnowledgeGraph } from './db/knowledge';
import { transaction } from './db/connection';
import { DomainError } from '../shared/errors';

// electron-vite sets this in development only; an empty value means "not set".
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined;

// Tests and portable setups point Delve at a separate data directory.
const userDataOverride = process.env['DELVE_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

type Shutdown = ReturnType<typeof installShutdown>;

function connectionHandlers(db: Db, connections: ConnectionSession, signal: AbortSignal): Pick<IpcHandlers, 'connections:preview' | 'connections:cancel' | 'connections:run'> {
  let running: AbortController | null = null;
  return {
    'connections:preview': request => {
      if (running) throw new DomainError('CONNECTIONS_BUSY', 'A connection request is already running.');
      return connections.preview(request);
    },
    'connections:cancel': () => { connections.clearPreview(); running?.abort(); return null; },
    'connections:run': async request => {
      if (running) throw new DomainError('CONNECTIONS_BUSY', 'A connection request is already running.');
      const controller = new AbortController();
      running = controller;
      try {
        const result = await connections.run(request, AbortSignal.any([signal, controller.signal]));
        transaction(db, () => {
          for (const suggestion of result.suggestions) createTransferLink(db, { ...suggestion,
            provider: result.provenance.provider, model: result.provenance.model ?? 'provider default' });
        });
        return result;
      } finally { if (running === controller) running = null; }
    },
  };
}

function createWindow(labs: LabHost, shutdown: Shutdown): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
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
  const showWindow = () => { if (!window.isDestroyed()) window.show(); };
  const showFallback = setTimeout(showWindow, 2000);
  window.once('ready-to-show', () => { clearTimeout(showFallback); showWindow(); });
  window.once('closed', () => clearTimeout(showFallback));
  const url = devServerUrl ?? `${APP_ORIGIN}/index.html`;
  window.loadURL(url).catch((error: unknown) => {
    if (shutdown.signal.aborted) return;
    dialog.showErrorBox('Delve could not start', `Failed to load ${url}: ${String(error)}`);
    shutdown.quit(1);
  });
  return window;
}

function buildHandlers(db: Db, tutor: TutorSession, labs: LabHost, learning: RepositoryLearning, links: LearnInbox,
  connections: ConnectionSession, detect: typeof detectProviders, signal: AbortSignal): IpcHandlers {
  return {
    'workspaces:list': () => listWorkspaces(db),
    'workspaces:add': async (input) => {
      if (input.kind === 'git') await assertGitRepository(input.path);
      signal.throwIfAborted();
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
    'providers:detect': () => detect(),
    ...readerHandlers(db),
    ...tutorHandlers(db, tutor),
    ...graphHandlers(db),
    ...connectionHandlers(db, connections, signal),
    'repo:stage': ({ source }) => learning.stage(source),
    'repo:attach': ({ token }) => {
      const workspace = learning.attach(token);
      labs.clear();
      return workspace;
    },
    'repo:files': ({ workspaceId }) => learning.files(workspaceId),
    'repo:changes': ({ workspaceId }) => learning.changes(workspaceId),
    'repo:preview': request => learning.preview(request),
    'repo:history': request => learning.history(request),
    'repo:detail': request => learning.detail(request),
    'repo:saved': request => learning.saved(request),
    'repo:generate': ({ token, requestId }) => learning.generate(token, requestId),
    'repo:cancel': ({ requestId }) => learning.cancel(requestId),
    'learn:pending': () => links.preview(db),
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

async function start(links: LearnInbox, shutdown: Shutdown): Promise<void> {
  await app.whenReady();
  if (shutdown.signal.aborted) return;
  applySecurityPolicy(devServerUrl);
  serveRenderer(join(__dirname, '../renderer'), devServerUrl);
  const db = openDatabase(join(app.getPath('userData'), 'delve.sqlite'));
  const probes = new Set<ReturnType<typeof detectProviders>>();
  const detect = () => {
    shutdown.signal.throwIfAborted();
    const pending = detectProviders({ signal: shutdown.signal }).finally(() => { probes.delete(pending); });
    probes.add(pending);
    return pending;
  };
  const runner = createTutorRunner(detect);
  const connections = new ConnectionSession(conceptId => {
    const graph = getGlobalKnowledgeGraph(db);
    const anchor = graph.concepts.find(concept => concept.id === conceptId);
    if (!anchor) return null;
    const linkedConceptIds = graph.links.flatMap(link => link.fromConceptId === conceptId ? [link.toConceptId]
      : link.toConceptId === conceptId ? [link.fromConceptId] : []);
    return { anchor, candidates: graph.concepts.filter(concept => concept.id !== conceptId), linkedConceptIds };
  }, runner);
  const learning = new RepositoryLearning(db, join(app.getPath('userData'), 'repositories'), runner);
  const tutor = new TutorSession(db, createGenerator(runner));
  shutdown.setCleanup(async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => tutor.close()),
      learning.close(),
      ...probes,
    ]);
    await runner.drain();
    db.close();
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Could not finish shutting down Delve.');
  });
  seedDemoWorkspaces(db);
  const labs = new LabHost(db);
  const handlers = buildHandlers(db, tutor, labs, learning, links, connections, detect, shutdown.signal);
  registerIpc(ipcMain, handlers, (url) => isAppUrl(url, devServerUrl), shutdown.signal);
  createWindow(labs, shutdown);
  app.on('activate', () => {
    if (!shutdown.signal.aborted && BrowserWindow.getAllWindows().length === 0) createWindow(labs, shutdown);
  });
}

registerAppScheme();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const shutdown = installShutdown();
  const links = new LearnInbox();
  const receive = (url: string) => {
    if (shutdown.signal.aborted) return;
    try { links.receive(url); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid learn link.';
      void app.whenReady().then(() => {
        if (!shutdown.signal.aborted) return dialog.showMessageBox({ type: 'warning', title: 'Learn link', message });
      });
    }
  };
  const receiveArgs = (args: string[]) => args.filter(arg => /^delve:\/\//i.test(arg)).slice(0, 16).forEach(receive);
  app.on('open-url', (event, url) => { event.preventDefault(); receive(url); });
  receiveArgs(process.argv);
  if (app.isPackaged && process.platform !== 'linux'
    && !app.isDefaultProtocolClient('delve') && !app.setAsDefaultProtocolClient('delve')) {
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
  start(links, shutdown).catch((error: unknown) => {
    console.error('[delve] startup failed', error);
    dialog.showErrorBox('Delve could not start', String(error));
    shutdown.quit(1);
  });
}
