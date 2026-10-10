'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  servers: [], // { id, name, url, userName, expanded, views, viewsLoading, error }
  selected: null, // { serverId, viewId, serverName, viewName, collectionType }
  search: '',
  pageSize: 100,
  total: 0,
  items: [],
  _visible: [],
  loadingItems: false,
  loadingMore: false,
  moreError: null,
  itemsError: null,
  settings: { downloadPath: '', concurrency: 3 },
  downloads: new Map(), // id -> task
  drawerOpen: false,
};

const VIEW_ICONS = {
  movies: '🎬',
  tvshows: '📺',
  music: '🎵',
  books: '📚',
  photos: '🖼️',
  homevideos: '🎥',
  musicvideos: '🎤',
  playlists: '🎧',
  boxsets: '📦',
  folders: '📁',
  livetv: '📡',
};

const TYPE_META = {
  Movie: { label: '电影', icon: '🎬' },
  Episode: { label: '剧集', icon: '📺' },
  Series: { label: '剧集', icon: '📺' },
  Season: { label: '季', icon: '🗂️' },
  Audio: { label: '音乐', icon: '🎵' },
  MusicAlbum: { label: '专辑', icon: '💿' },
  Book: { label: '图书', icon: '📚' },
  AudioBook: { label: '有声书', icon: '🎧' },
  Video: { label: '视频', icon: '🎞️' },
  MusicVideo: { label: 'MV', icon: '🎤' },
  Photo: { label: '图片', icon: '🖼️' },
};

const STATUS_LABEL = {
  queued: '等待中',
  downloading: '下载中',
  cancelling: '取消中',
  retrying: '重试中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

async function call(channel, ...args) {
  const res = await window.api[channel](...args);
  if (!res || res.ok !== true) throw new Error(res && res.error ? res.error : '调用失败');
  return res.data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function typeMeta(t) {
  return TYPE_META[t] || { label: '文件', icon: '📄' };
}

function displayName(it) {
  if (it.type === 'Episode') {
    if (it.season != null && it.episode != null) return `S${pad2(it.season)}E${pad2(it.episode)} ${it.name || ''}`.trim();
    if (it.seriesName) return `${it.seriesName} · ${it.name || ''}`;
  }
  if ((it.type === 'Movie' || it.type === 'Series') && it.year) return `${it.name} (${it.year})`;
  return it.name || '未命名';
}

function toast(msg, kind = 'info') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = msg;
  $('#toast-container').appendChild(box);
  setTimeout(() => {
    box.classList.add('out');
    setTimeout(() => box.remove(), 300);
  }, 3200);
}

function serverById(id) {
  return state.servers.find((s) => s.id === id);
}

/* ==================== 侧栏：服务器与分组 ==================== */

function renderSidebar() {
  const tree = $('#server-tree');
  if (!state.servers.length) {
    tree.innerHTML = `<div class="empty-hint">还没有添加服务器<br><span>点击上方「添加服务器」开始使用</span></div>`;
    return;
  }
  tree.innerHTML = state.servers.map((s) => {
    const open = s.expanded;
    let children;
    if (!open) children = '';
    else if (s.viewsLoading) children = `<div class="view-loading">加载中…</div>`;
    else if (s.error) children = `<div class="view-error">${esc(s.error)}<br><button class="link retry-views" data-id="${esc(s.id)}">重试</button></div>`;
    else if (!s.views || !s.views.length) children = `<div class="view-empty">该服务器没有可见的媒体库</div>`;
    else {
      children = s.views.map((v) => {
        const selected = state.selected && state.selected.serverId === s.id && state.selected.viewId === v.id;
        return `<div class="view-item${selected ? ' selected' : ''}" data-server="${esc(s.id)}" data-view="${esc(v.id)}" title="${esc(v.name)}">
          <span class="view-icon">${VIEW_ICONS[v.collectionType] || '📁'}</span>
          <span class="view-name">${esc(v.name)}</span>
        </div>`;
      }).join('');
    }
    return `<div class="server-node">
      <div class="server-row" data-id="${esc(s.id)}" title="${esc(s.url)}">
        <span class="chevron${open ? ' open' : ''}">▶</span>
        <span class="server-icon">🗄️</span>
        <span class="server-name">${esc(s.name)}</span>
        <span class="server-user">${esc(s.userName || '')}</span>
      </div>
      <div class="server-children">${children}</div>
    </div>`;
  }).join('');
}

async function loadViews(server) {
  server.viewsLoading = true;
  server.error = null;
  renderSidebar();
  try {
    server.views = await call('getViews', server.id);
  } catch (err) {
    server.error = err.message;
  }
  server.viewsLoading = false;
  renderSidebar();
}

function toggleServer(id) {
  const s = serverById(id);
  if (!s) return;
  s.expanded = !s.expanded;
  if (s.expanded && !s.views && !s.viewsLoading && !s.error) loadViews(s);
  renderSidebar();
}

function selectView(serverId, viewId) {
  const s = serverById(serverId);
  if (!s || !s.views) return;
  const v = s.views.find((x) => x.id === viewId);
  if (!v) return;
  state.selected = {
    serverId,
    viewId,
    serverName: s.name,
    viewName: v.name,
    collectionType: v.collectionType,
  };
  clearSearchInput();
  renderSidebar();
  loadItems();
}

function clearSearchInput() {
  state.search = '';
  $('#search-input').value = '';
  $('#search-clear').classList.add('hidden');
}

function clearSearch() {
  clearSearchInput();
  if (state.selected) {
    loadItems();
  }
}

async function removeServer(id) {
  const s = serverById(id);
  if (!s) return;
  if (!confirm(`确定要移除服务器「${s.name}」吗？（不会删除已下载的文件）`)) return;
  try {
    await call('removeServer', id);
    state.servers = state.servers.filter((x) => x.id !== id);
    if (state.selected && state.selected.serverId === id) {
      state.selected = null;
      renderItems();
    }
    renderSidebar();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ==================== 右侧：内容列表 ==================== */

function buildFooter() {
  if (state.loadingMore) {
    return `<div class="list-footer"><span class="mini-spinner"></span>加载中…</div>`;
  }
  if (state.moreError) {
    return `<div class="list-footer">加载失败：${esc(state.moreError)} <button class="link" data-retry-more="1">重试</button></div>`;
  }
  if (!state.items.length) return '';
  if (state.items.length < state.total) {
    return `<div class="list-footer">向下滚动加载更多（已显示 ${state.items.length} / ${state.total}）</div>`;
  }
  return `<div class="list-footer">已加载全部 ${state.total} 项</div>`;
}

// 内容不足一屏时自动继续加载，保证可以滚动触发无限加载
function maybeAutoLoadMore() {
  const el = $('#list-container');
  if (!state.selected || state.loadingItems || state.loadingMore || state.moreError) return;
  if (!state.items.length || state.items.length >= state.total) return;
  if (el.scrollHeight <= el.clientHeight + 60) loadMore();
}

const isNodeItem = (it) => it.type === 'Series' || it.type === 'Season';

function wrapNode(c) {
  return { ...c, expanded: false, children: null, loading: false, error: null };
}

// 根据单集列表构建「季 → 单集」层级；没有季信息时保持平铺
function buildSeasonNodes(episodes) {
  if (!episodes.some((e) => e.season != null)) return episodes;
  const groups = new Map();
  for (const e of episodes) {
    const key = e.season != null ? e.season : 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'none') return 1;
    if (b === 'none') return -1;
    return a - b;
  });
  return keys.map((k) => {
    const eps = groups.get(k);
    return {
      id: `season:${k}`,
      name: k === 'none' ? '未分季' : k === 0 ? '特别篇' : `第 ${k} 季`,
      type: 'Season',
      season: k === 'none' ? null : k,
      dateCreated: null,
      size: eps.reduce((n, e) => n + (e.size || 0), 0),
      episodeCount: eps.length,
      children: eps,
      expanded: false,
      loading: false,
      error: null,
    };
  });
}

// 后台预取每个剧集的单集信息：列表直接显示总大小与集数，同时缓存展开内容
async function prefetchSeriesSizes() {
  const list = state.items;
  const targets = list.filter((it) => it.type === 'Series');
  if (!targets.length || !state.selected) return;
  const serverId = state.selected.serverId;
  let idx = 0;
  const worker = async () => {
    while (state.items === list && idx < targets.length) {
      const it = targets[idx++];
      if (!it || it.children || it._fetching) continue;
      it._fetching = true;
      renderItems();
      try {
        const episodes = await call('getChildren', { serverId, parentId: it.id });
        it.children = buildSeasonNodes(episodes.map(wrapNode));
        it.size = episodes.reduce((n, e) => n + (e.size || 0), 0);
        it.episodeCount = episodes.length;
      } catch {
        // 预取失败不打扰列表，展开该剧集时会重试
      }
      it._fetching = false;
      if (state.items === list) renderItems();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

function rowHtml(it, depth, idx, retryMap) {
  const m = typeMeta(it.type);
  const name = displayName(it);
  const indent = 10 + depth * 22;
  const chevron = isNodeItem(it)
    ? `<span class="chevron${it.expanded ? ' open' : ''}">▶</span>`
    : `<span class="chevron invisible">▶</span>`;
  const rowClass = isNodeItem(it) ? 'item-row node' : 'item-row leaf';
  let html = `<div class="${rowClass}" data-index="${idx}" title="${esc(name)}">
    <div class="cell-name" style="padding-left:${indent}px">${chevron}<span class="item-icon">${m.icon}</span><span class="item-name">${esc(name)}</span>${isNodeItem(it) && it.episodeCount != null ? `<span class="name-count">· ${it.episodeCount} 集</span>` : ''}</div>
    <div class="cell-type">${m.label}</div>
    <div class="cell-date">${fmtDate(it.dateCreated)}</div>
    <div class="cell-size num">${isNodeItem(it) && it._fetching ? '…' : fmtSize(it.size)}</div>
  </div>`;
  if (it.expanded && (it.loading || it.error || (Array.isArray(it.children) && !it.children.length))) {
    let statusText;
    if (it.loading) statusText = '加载中…';
    else if (it.error) {
      const rid = `r${retryMap.size}`;
      retryMap.set(rid, it);
      statusText = `${esc(it.error)} <button class="link" data-retry-id="${rid}">重试</button>`;
    } else statusText = '暂无剧集';
    html += `<div class="tree-status${it.error ? ' error' : ''}" style="padding-left:${indent + 22}px">${statusText}</div>`;
  }
  return html;
}

function buildRows(items, depth, visible, retryMap) {
  let html = '';
  for (const it of items) {
    const entry = { item: it, depth, idx: visible.length };
    visible.push(entry);
    html += rowHtml(it, depth, entry.idx, retryMap);
    if (it.expanded && !it.loading && !it.error && Array.isArray(it.children) && it.children.length) {
      html += buildRows(it.children, depth + 1, visible, retryMap);
    }
  }
  return html;
}

async function toggleNode(it) {
  if (it.loading) return;
  if (it.expanded) {
    it.expanded = false;
    renderItems();
    return;
  }
  it.expanded = true;
  if (!it.children) {
    it.loading = true;
    renderItems();
    const sel = state.selected;
    try {
      const episodes = await call('getChildren', { serverId: sel.serverId, parentId: it.id });
      it.children = it.type === 'Series' ? buildSeasonNodes(episodes.map(wrapNode)) : episodes.map(wrapNode);
      it.size = episodes.reduce((n, e) => n + (e.size || 0), 0);
      it.episodeCount = episodes.length;
    } catch (err) {
      it.error = err.message;
    }
    it.loading = false;
  }
  renderItems();
}

async function collectEpisodes(it, serverId) {
  if (it.type === 'Episode') return [it];
  if (!it.children) {
    const children = await call('getChildren', { serverId, parentId: it.id });
    it.children = children.map((c) => ({ ...c, expanded: false, children: null, loading: false }));
  }
  const out = [];
  for (const child of it.children) {
    out.push(...await collectEpisodes(child, serverId));
  }
  return out;
}

async function downloadNode(serverId, node) {
  try {
    const episodes = await collectEpisodes(node, serverId);
    if (!episodes.length) {
      toast('该节点下没有可下载的剧集', 'error');
      return;
    }
    let ok = 0;
    let failed = 0;
    for (const ep of episodes) {
      try {
        const task = await call('startDownload', { serverId, item: ep });
        state.downloads.set(task.id, task);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    updateBadge();
    renderDownloads();
    if (!state.drawerOpen) toggleDrawer();
    toast(failed ? `已加入 ${ok} 个下载任务，${failed} 个失败` : `已加入 ${ok} 个下载任务`, failed ? 'error' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderItems(resetScroll = false) {
  const list = $('#item-list');
  const bc = $('#breadcrumb');

  if (!state.selected) {
    bc.textContent = 'Emby 下载器';
    $('#search-box').classList.add('hidden');
    list.innerHTML = `<div class="hero">
      <div class="logo">⬇</div>
      <h2>欢迎使用 Emby 下载器</h2>
      <p>点击左侧「添加服务器」连接到你的 Emby / Jellyfin 服务器<br>
      展开服务器查看媒体库分组，点击分组浏览内容<br>
      右键点击内容即可下载</p>
    </div>`;
    return;
  }

  $('#search-box').classList.remove('hidden');
  bc.innerHTML = `${esc(state.selected.serverName)} <span class="crumb-sep">/</span> ${esc(state.selected.viewName)}${state.search ? ` <span class="crumb-sep">/</span> <span class="crumb-query">搜索 “${esc(state.search)}”</span>` : ''}`;

  if (state.loadingItems) {
    list.innerHTML = `<div class="state-hint"><div class="spinner"></div>加载中…</div>`;
    return;
  }
  if (state.itemsError) {
    list.innerHTML = `<div class="state-hint error">加载失败：${esc(state.itemsError)}<br><button id="btn-retry-items" class="btn ghost small">重试</button></div>`;
    $('#btn-retry-items').addEventListener('click', loadItems);
    return;
  }
  if (!state.items.length) {
    list.innerHTML = `<div class="state-hint">${state.search ? `没有找到与「${esc(state.search)}」匹配的内容` : '该分组暂无可下载的内容'}</div>`;
    return;
  }

  const head = `<div class="item-row head">
    <div>名称</div><div>类型</div><div>添加时间</div><div class="num">大小</div>
  </div>`;
  state._visible = [];
  const retryMap = new Map();
  const rows = buildRows(state.items, 0, state._visible, retryMap);
  list.innerHTML = head + rows + buildFooter();
  list.querySelectorAll('[data-retry-id]').forEach((el) => {
    const node = retryMap.get(el.dataset.retryId);
    if (node) {
      el.addEventListener('click', () => {
        node.error = null;
        toggleNode(node);
      });
    }
  });
  const retryMore = list.querySelector('[data-retry-more]');
  if (retryMore) {
    retryMore.addEventListener('click', () => {
      state.moreError = null;
      loadMore();
    });
  }
  if (resetScroll) $('#list-container').scrollTop = 0;
  maybeAutoLoadMore();
}

async function loadItems() {
  const sel = state.selected;
  if (!sel) return;
  const searchTerm = state.search;
  state.loadingItems = true;
  state.itemsError = null;
  state.loadingMore = false;
  state.moreError = null;
  renderItems();
  try {
    const res = await call('getItems', {
      serverId: sel.serverId,
      viewId: sel.viewId,
      collectionType: sel.collectionType,
      startIndex: 0,
      limit: state.pageSize,
      searchTerm,
    });
    if (state.selected !== sel || state.search !== searchTerm) return; // 等待期间用户切换了分组或搜索词
    state.items = res.items.map(wrapNode);
    state.total = res.total;
    if (!res.items.length) state.total = 0;
  } catch (err) {
    if (state.selected !== sel || state.search !== searchTerm) return;
    state.itemsError = err.message;
  }
  state.loadingItems = false;
  renderItems(true);
  prefetchSeriesSizes();
  maybeAutoLoadMore();
}

// 无限滚动：滚动接近底部时追加下一批内容
async function loadMore() {
  const sel = state.selected;
  if (!sel || state.loadingItems || state.loadingMore || state.itemsError) return;
  if (state.items.length >= state.total) return;
  const searchTerm = state.search;
  const list = state.items;
  state.loadingMore = true;
  state.moreError = null;
  renderItems();
  try {
    const res = await call('getItems', {
      serverId: sel.serverId,
      viewId: sel.viewId,
      collectionType: sel.collectionType,
      startIndex: list.length,
      limit: state.pageSize,
      searchTerm,
    });
    if (state.selected !== sel || state.search !== searchTerm || state.items !== list) return;
    if (!res.items.length) {
      state.total = list.length; // 服务器没有返回更多，视为已全部加载
    } else {
      state.items.push(...res.items.map(wrapNode));
      state.total = res.total;
    }
  } catch (err) {
    if (state.selected !== sel || state.search !== searchTerm || state.items !== list) return;
    state.moreError = err.message;
  }
  state.loadingMore = false;
  renderItems();
  prefetchSeriesSizes();
  maybeAutoLoadMore();
}

/* ==================== 下载 ==================== */

async function startDownload(serverId, item) {
  try {
    const task = await call('startDownload', { serverId, item });
    state.downloads.set(task.id, task);
    updateBadge();
    renderDownloads();
    toast(`已加入下载队列：${task.fileName}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateBadge() {
  const n = [...state.downloads.values()]
    .filter((t) => ['queued', 'downloading', 'cancelling', 'retrying'].includes(t.status)).length;
  const b = $('#dl-badge');
  b.textContent = String(n);
  b.classList.toggle('hidden', n === 0);
}

function renderDownloads() {
  const box = $('#download-list');
  const rows = [...state.downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!rows.length) {
    box.innerHTML = `<div class="state-hint">暂无下载任务<br><span style="font-size:12px">在右侧列表中右键点击内容即可下载</span></div>`;
    return;
  }
  box.innerHTML = rows.map((t) => {
    const active = ['queued', 'downloading', 'cancelling', 'retrying'].includes(t.status);
    const canRetry = ['failed', 'cancelled'].includes(t.status);
    const pct = t.total ? Math.min(100, (t.received / t.total) * 100) : null;
    return `<div class="download-item">
      <div class="download-top">
        <span class="download-name" title="${esc(t.fileName)}">${esc(t.fileName)}</span>
        <span class="status-tag ${esc(t.status)}">${STATUS_LABEL[t.status] || t.status}</span>
      </div>
      <div class="bar${pct === null ? ' indeterminate' : ''}"><div class="bar-fill" style="width:${pct === null ? 100 : pct}%"></div></div>
      <div class="download-meta">
        <span>${fmtSize(t.received)}${t.total ? ` / ${fmtSize(t.total)}` : ''}</span>
        ${t.status === 'downloading' ? `<span>${fmtSize(t.speed)}/s</span>` : ''}
        ${t.error ? `<span class="${t.status === 'failed' ? 'err' : 'note'}" title="${esc(t.error)}">${esc(t.error)}</span>` : ''}
        ${active ? `<button class="btn ghost small cancel-btn" data-id="${esc(t.id)}">取消</button>` : ''}
        ${canRetry ? `<button class="btn ghost small retry-btn" data-id="${esc(t.id)}">重试</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function toggleDrawer() {
  state.drawerOpen = !state.drawerOpen;
  $('#downloads-drawer').classList.toggle('hidden', !state.drawerOpen);
  $('#btn-downloads').classList.toggle('active', state.drawerOpen);
  if (state.drawerOpen) renderDownloads();
}

/* ==================== 右键菜单 ==================== */

function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}

function openContextMenu(x, y, entries) {
  const menu = $('#context-menu');
  menu.innerHTML = entries.map((en, i) => `<div class="context-item" data-i="${i}">${esc(en.label)}</div>`).join('');
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  menu.onclick = (e) => {
    const item = e.target.closest('.context-item');
    if (!item) return;
    hideContextMenu();
    entries[Number(item.dataset.i)].action();
  };
}

/* ==================== 弹窗 ==================== */

function openAddServerModal() {
  $('#input-server-url').value = '';
  $('#input-username').value = '';
  $('#input-password').value = '';
  $('#add-server-error').classList.add('hidden');
  $('#add-server-modal').classList.remove('hidden');
  setTimeout(() => $('#input-server-url').focus(), 30);
}

function closeAddServerModal() {
  $('#add-server-modal').classList.add('hidden');
}

async function submitAddServer() {
  const url = $('#input-server-url').value.trim();
  const username = $('#input-username').value.trim();
  const password = $('#input-password').value;
  const errBox = $('#add-server-error');
  if (!url || !username) {
    errBox.textContent = '请填写服务器地址和用户名';
    errBox.classList.remove('hidden');
    return;
  }
  const btn = $('#add-server-submit');
  btn.disabled = true;
  btn.textContent = '连接中…';
  errBox.classList.add('hidden');
  try {
    const srv = await call('addServer', { url, username, password });
    const node = { ...srv, expanded: true, views: null, viewsLoading: false, error: null };
    state.servers = state.servers.filter((s) => s.id !== srv.id);
    state.servers.push(node);
    closeAddServerModal();
    renderSidebar();
    loadViews(node);
    toast(`已连接到 ${srv.name}`);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '连接并添加';
  }
}

async function openSettings() {
  $('#input-download-path').value = state.settings.downloadPath || '';
  $('#input-concurrency').value = state.settings.concurrency || 3;
  $('#settings-modal').classList.remove('hidden');
}

async function browseDownloadPath() {
  try {
    const p = await call('chooseDownloadPath');
    if (p) $('#input-download-path').value = p;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveSettings() {
  try {
    state.settings = await call('setSettings', {
      downloadPath: $('#input-download-path').value.trim(),
      concurrency: parseInt($('#input-concurrency').value, 10) || 3,
    });
    $('#settings-modal').classList.add('hidden');
    toast('设置已保存');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ==================== 事件绑定与初始化 ==================== */

function bindEvents() {
  $('#btn-add-server').addEventListener('click', openAddServerModal);
  $('#add-server-cancel').addEventListener('click', closeAddServerModal);
  $('#add-server-submit').addEventListener('click', submitAddServer);
  $('#add-server-modal').addEventListener('click', (e) => {
    if (e.target.id === 'add-server-modal') closeAddServerModal();
  });
  $('#input-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddServer();
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-cancel').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-browse').addEventListener('click', browseDownloadPath);
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') e.target.classList.add('hidden');
  });

  $('#btn-downloads').addEventListener('click', toggleDrawer);
  $('#drawer-close').addEventListener('click', toggleDrawer);
  $('#btn-clear-finished').addEventListener('click', async () => {
    try {
      await call('clearFinishedDownloads');
      for (const [id, t] of [...state.downloads]) {
        if (['completed', 'failed', 'cancelled'].includes(t.status)) state.downloads.delete(id);
      }
      renderDownloads();
      updateBadge();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-open-folder').addEventListener('click', () => {
    call('openDownloadFolder').catch((err) => toast(err.message, 'error'));
  });
  $('#download-list').addEventListener('click', async (e) => {
    const cancelBtn = e.target.closest('.cancel-btn');
    if (cancelBtn) {
      try {
        await call('cancelDownload', cancelBtn.dataset.id);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const retryBtn = e.target.closest('.retry-btn');
    if (retryBtn) {
      try {
        await call('retryDownload', retryBtn.dataset.id);
        toast('已重新加入下载队列');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  $('#list-container').addEventListener('scroll', () => {
    const el = $('#list-container');
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) loadMore();
  });

  const searchInput = $('#search-input');
  let searchTimer = null;
  const applySearch = () => {
    const v = searchInput.value.trim();
    if (v === state.search) return;
    state.search = v;
    loadItems();
  };
  searchInput.addEventListener('input', () => {
    $('#search-clear').classList.toggle('hidden', !searchInput.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 400);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      applySearch();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      clearSearch();
      searchInput.blur();
    }
  });
  $('#search-clear').addEventListener('click', () => {
    clearSearch();
    searchInput.focus();
  });

  const tree = $('#server-tree');
  tree.addEventListener('click', (e) => {
    const retry = e.target.closest('.retry-views');
    if (retry) {
      const s = serverById(retry.dataset.id);
      if (s) loadViews(s);
      return;
    }
    const view = e.target.closest('.view-item');
    if (view) {
      selectView(view.dataset.server, view.dataset.view);
      return;
    }
    const row = e.target.closest('.server-row');
    if (row) toggleServer(row.dataset.id);
  });
  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.server-row');
    if (!row) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: '移除服务器', action: () => removeServer(row.dataset.id) },
    ]);
  });

  const list = $('#item-list');
  const entryFromEvent = (e) => {
    const row = e.target.closest('.item-row');
    if (!row || row.classList.contains('head') || !state.selected || state.loadingItems) return null;
    return (state._visible || [])[Number(row.dataset.index)] || null;
  };
  list.addEventListener('click', (e) => {
    const entry = entryFromEvent(e);
    if (entry && isNodeItem(entry.item)) toggleNode(entry.item);
  });
  list.addEventListener('contextmenu', (e) => {
    const entry = entryFromEvent(e);
    if (!entry) return;
    e.preventDefault();
    const { item } = entry;
    const serverId = state.selected.serverId;
    if (isNodeItem(item)) {
      openContextMenu(e.clientX, e.clientY, [
        { label: '⬇ 下载全部剧集', action: () => downloadNode(serverId, item) },
      ]);
    } else {
      openContextMenu(e.clientX, e.clientY, [
        { label: '⬇ 下载', action: () => startDownload(serverId, item) },
      ]);
    }
  });
  list.addEventListener('dblclick', (e) => {
    const entry = entryFromEvent(e);
    if (!entry) return;
    if (isNodeItem(entry.item)) toggleNode(entry.item);
    else startDownload(state.selected.serverId, entry.item);
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      const box = $('#search-box');
      if (!box.classList.contains('hidden')) {
        e.preventDefault();
        $('#search-input').focus();
        $('#search-input').select();
      }
      return;
    }
    if (e.key === 'Escape') {
      hideContextMenu();
      $('#settings-modal').classList.add('hidden');
      if (!$('#add-server-modal').classList.contains('hidden')) closeAddServerModal();
      else if (state.drawerOpen) toggleDrawer();
    }
  });

  window.api.onDownloadChange((task) => {
    const prev = state.downloads.get(task.id);
    state.downloads.set(task.id, task);
    if (task.status === 'completed' && (!prev || prev.status !== 'completed')) {
      toast(`下载完成：${task.fileName}`);
    } else if (task.status === 'failed' && (!prev || prev.status !== 'failed')) {
      toast(`下载失败：${task.fileName}（${task.error || '未知错误'}）`, 'error');
    }
    updateBadge();
    if (state.drawerOpen) renderDownloads();
  });
}

async function init() {
  bindEvents();
  try {
    state.settings = await call('getSettings');
    const servers = await call('listServers');
    state.servers = servers.map((s) => ({ ...s, expanded: false, views: null, viewsLoading: false, error: null }));
    const downloads = await call('listDownloads');
    downloads.forEach((t) => state.downloads.set(t.id, t));
  } catch (err) {
    toast(err.message, 'error');
  }
  updateBadge();
  renderSidebar();
  renderItems();
  renderDownloads();
}

window.addEventListener('error', (e) => console.error(`[ui] error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  console.error(`[ui] rejection: ${(e.reason && e.reason.message) || String(e.reason)}`);
});

init();
