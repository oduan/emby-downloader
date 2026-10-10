'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Config = require('./lib/config');
const Emby = require('./lib/emby');
const { Downloader, sanitizeFileName } = require('./lib/downloader');

const isSmoke = process.argv.includes('--smoke');

let mainWindow = null;
let config = null;
let downloader = null;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function findServer(serverId) {
  const server = config.data.servers.find((s) => s.id === serverId);
  if (!server) throw new Error('服务器不存在或已被移除');
  return server;
}

function publicServer(server) {
  return { id: server.id, name: server.name, url: server.url, userName: server.userName };
}

function buildFileName(item) {
  let base;
  if (item.type === 'Episode') {
    const parts = [];
    if (item.seriesName) parts.push(item.seriesName);
    if (item.season != null && item.episode != null) parts.push(`S${pad2(item.season)}E${pad2(item.episode)}`);
    parts.push(item.name || '未命名');
    base = parts.join(' ');
  } else if (item.type === 'Movie' && item.year) {
    base = `${item.name || '未命名'} (${item.year})`;
  } else {
    base = item.name || '未命名';
  }
  const ext = item.ext || '';
  if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) base += ext;
  return sanitizeFileName(base);
}

function mapItem(i) {
  const ms = (i.MediaSources && i.MediaSources[0]) || null;
  let ext = '';
  const filePath = i.Path || (ms && ms.Path) || '';
  if (filePath) ext = path.extname(filePath);
  if (!ext) {
    const container = (ms && ms.Container) || i.Container || '';
    if (container) ext = `.${String(container).split(',')[0].trim()}`;
  }
  // Emby 通常把文件大小放在 MediaSources[0].Size，顶层 Size 常为空
  const size = typeof i.Size === 'number'
    ? i.Size
    : (ms && typeof ms.Size === 'number' ? ms.Size : null);
  return {
    id: i.Id,
    name: i.Name || '未命名',
    type: i.Type || '',
    year: i.ProductionYear || null,
    dateCreated: i.DateCreated || null,
    size,
    seriesName: i.SeriesName || null,
    season: i.ParentIndexNumber ?? null,
    episode: i.IndexNumber ?? null,
    ext,
  };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('listServers', () => config.data.servers.map(publicServer));

  handle('addServer', async ({ url, username, password }) => {
    if (!url || !username) throw new Error('请填写服务器地址和用户名');
    const auth = await Emby.authenticate(url, username, password, config.data.deviceId);
    const id = auth.serverId || crypto.randomUUID();
    const server = {
      id,
      name: auth.serverName,
      url: Emby.normalizeBase(url),
      apiBase: auth.apiBase,
      userId: auth.userId,
      userName: auth.userName,
      token: auth.token,
    };
    config.data.servers = config.data.servers.filter((s) => s.id !== id);
    config.data.servers.push(server);
    config.save();
    return publicServer(server);
  });

  handle('removeServer', (serverId) => {
    config.data.servers = config.data.servers.filter((s) => s.id !== serverId);
    config.save();
    return true;
  });

  handle('getViews', async (serverId) => {
    const data = await Emby.getViews(findServer(serverId));
    return (data.Items || []).map((i) => ({
      id: i.Id,
      name: i.Name || '未命名',
      collectionType: i.CollectionType || '',
    }));
  });

  handle('getItems', async ({ serverId, viewId, collectionType, startIndex, limit, searchTerm }) => {
    const data = await Emby.getItems(findServer(serverId), {
      parentId: viewId,
      collectionType,
      startIndex: startIndex || 0,
      limit: limit || 100,
      searchTerm: searchTerm || '',
    });
    const items = (data.Items || []).map(mapItem);
    return { items, total: typeof data.TotalRecordCount === 'number' ? data.TotalRecordCount : items.length };
  });

  handle('getChildren', async ({ serverId, parentId }) => {
    const data = await Emby.getChildren(findServer(serverId), parentId);
    return (data.Items || []).map(mapItem);
  });

  handle('getSettings', () => ({ ...config.data.settings }));

  handle('setSettings', (patch) => {
    const s = config.data.settings;
    if (patch && typeof patch.downloadPath === 'string' && patch.downloadPath.trim()) {
      s.downloadPath = patch.downloadPath.trim();
    }
    if (patch && Number.isFinite(Number(patch.concurrency))) {
      s.concurrency = Math.min(6, Math.max(1, Math.round(Number(patch.concurrency))));
    }
    config.save();
    if (downloader) downloader.setConcurrency(s.concurrency);
    return { ...s };
  });

  handle('chooseDownloadPath', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存位置',
      defaultPath: config.data.settings.downloadPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  handle('startDownload', ({ serverId, item }) => {
    const server = findServer(serverId);
    if (!item || !item.id) throw new Error('无效的内容项');
    const dir = config.data.settings.downloadPath;
    fs.mkdirSync(dir, { recursive: true });
    const url = `${server.apiBase}/Items/${encodeURIComponent(item.id)}/Download?api_key=${encodeURIComponent(server.token)}`;
    return downloader.add({ url, fileName: buildFileName(item), directory: dir });
  });

  handle('listDownloads', () => downloader.list());
  handle('cancelDownload', (id) => downloader.cancel(id));
  handle('retryDownload', (id) => downloader.retry(id));
  handle('removeDownload', (id) => downloader.remove(id));
  handle('clearFinishedDownloads', () => {
    downloader.clearFinished();
    return true;
  });
  handle('openDownloadFolder', async () => {
    await fs.promises.mkdir(config.data.settings.downloadPath, { recursive: true });
    shell.openPath(config.data.settings.downloadPath);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Emby 下载器',
    backgroundColor: '#131418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isSmoke) {
    mainWindow.webContents.on('console-message', (...args) => {
      const e = args[0];
      if (e && typeof e === 'object' && 'message' in e) console.log(`[renderer:${e.level}] ${e.message}`);
      else console.log(`[renderer:${args[1]}] ${args[2]}`);
    });
    mainWindow.webContents.on('did-finish-load', () => console.log('[smoke] renderer loaded'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  config = new Config(path.join(app.getPath('userData'), 'config.json'), {
    settings: {
      downloadPath: app.getPath('downloads'),
      concurrency: 3,
    },
  });
  config.load();

  downloader = new Downloader({ concurrency: config.data.settings.concurrency });
  downloader.on('change', (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:change', task);
    }
  });

  registerIpc();
  createWindow();

  if (isSmoke) {
    setTimeout(() => {
      console.log('[smoke] done');
      app.exit(0);
    }, 3500);
  }
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  if (isSmoke) app.exit(1);
});
