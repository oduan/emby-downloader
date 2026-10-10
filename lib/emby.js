'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CLIENT_INFO = 'MediaBrowser Client="Emby Downloader", Device="Emby Downloader", Version="1.0.0"';

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error(`无效的地址：${urlStr}`));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: () => buf.toString('utf8'),
          json: () => {
            try {
              return JSON.parse(buf.toString('utf8'));
            } catch {
              return null;
            }
          },
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时，请检查服务器地址与网络')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function authHeaderValue(deviceId, token) {
  let h = `${CLIENT_INFO}, DeviceId="${deviceId}"`;
  if (token) h += `, Token="${token}"`;
  return h;
}

function normalizeBase(url) {
  let base = String(url || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/emby$/i, '');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  return base;
}

// Emby 的 API 同时挂在 / 和 /emby 下，Jellyfin 只挂在 / 下，逐一探测
async function probe(base) {
  const candidates = [base, `${base}/emby`];
  let lastErr = null;
  for (const apiBase of candidates) {
    try {
      const res = await request(`${apiBase}/System/Info/Public`, { timeout: 8000 });
      if (res.status === 200) {
        const info = res.json();
        if (info && (info.Product || info.ServerName)) return { apiBase, info };
      }
      lastErr = new Error(`服务器响应异常 (HTTP ${res.status})`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法连接到服务器 ${base}${lastErr ? `：${lastErr.message}` : ''}`);
}

async function authenticate(rawUrl, username, password, deviceId) {
  const base = normalizeBase(rawUrl);
  const { apiBase, info } = await probe(base);
  const res = await request(`${apiBase}/Users/AuthenticateByName`, {
    method: 'POST',
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': authHeaderValue(deviceId),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (res.status === 401) throw new Error('用户名或密码错误');
  if (res.status !== 200) {
    const j = res.json();
    const detail = j && (j.Message || j.message || j.error);
    throw new Error(`登录失败 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
  }
  const data = res.json();
  if (!data || !data.AccessToken || !data.User || !data.User.Id) {
    throw new Error('服务器返回了无法识别的登录结果');
  }

  let serverName = info.ServerName || info.Product || base;
  try {
    const sys = await request(`${apiBase}/System/Info`, {
      headers: { 'X-Emby-Authorization': authHeaderValue(deviceId, data.AccessToken) },
      timeout: 10000,
    });
    const sysInfo = sys.status === 200 ? sys.json() : null;
    if (sysInfo && sysInfo.ServerName) serverName = sysInfo.ServerName;
  } catch {
    // 保留探测到的名称作为兜底
  }

  return {
    apiBase,
    serverId: data.ServerId || null,
    userId: data.User.Id,
    userName: data.User.Name,
    token: data.AccessToken,
    serverName,
    product: info.Product || 'Emby Server',
    productVersion: info.Version || '',
  };
}

async function apiGet(server, apiPath, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${server.apiBase}${apiPath}${qs ? `?${qs}` : ''}`;
  const res = await request(url, {
    headers: { 'X-Emby-Authorization': authHeaderValue(server.deviceId, server.token) },
    timeout: 20000,
  });
  if (res.status === 401) throw new Error('登录凭证已失效，请移除后重新添加该服务器');
  if (res.status !== 200) throw new Error(`请求失败 (HTTP ${res.status})：${apiPath}`);
  const data = res.json();
  if (data === null) throw new Error('服务器返回了无法解析的数据');
  return data;
}

// 不同类型的媒体库只列出可直接下载的叶子条目
const VIEW_TYPE_FILTERS = {
  movies: 'Movie',
  tvshows: 'Series',
  music: 'Audio',
  books: 'Book',
  homevideos: 'Video',
  musicvideos: 'MusicVideo',
  photos: 'Photo',
  boxsets: 'Movie',
};

const ITEM_FIELDS = 'Path,Size,DateCreated,MediaSources,ProductionYear,ParentIndexNumber,IndexNumber,SeriesName,Container';

function getViews(server) {
  return apiGet(server, `/Users/${encodeURIComponent(server.userId)}/Views`);
}

function getItems(server, { parentId, collectionType, startIndex = 0, limit = 100, searchTerm = '' }) {
  const params = {
    ParentId: parentId,
    Recursive: 'true',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    StartIndex: String(startIndex),
    Limit: String(limit),
    Fields: ITEM_FIELDS,
  };
  if (searchTerm) params.SearchTerm = searchTerm;
  const types = VIEW_TYPE_FILTERS[collectionType];
  if (types) {
    // 剧集库搜索时同时匹配剧集名与单集名
    params.IncludeItemTypes = searchTerm && types === 'Series' ? 'Series,Episode' : types;
  } else {
    params.ExcludeItemTypes = 'Folder,CollectionFolder,UserView,Playlist,BoxSet,Genre';
  }
  return apiGet(server, `/Users/${encodeURIComponent(server.userId)}/Items`, params);
}

// 获取剧集节点下的全部单集（跨季），用于层级展示与大小汇总
function getChildren(server, parentId) {
  return apiGet(server, `/Users/${encodeURIComponent(server.userId)}/Items`, {
    ParentId: parentId,
    Recursive: 'true',
    IncludeItemTypes: 'Episode',
    SortBy: 'ParentIndexNumber,IndexNumber,SortName',
    SortOrder: 'Ascending',
    Fields: ITEM_FIELDS,
  });
}

module.exports = { request, authenticate, getViews, getItems, getChildren, normalizeBase, authHeaderValue };
