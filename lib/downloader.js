'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const SOCKET_IDLE_TIMEOUT = 30000; // 连接空闲超过该时间视为断开
const MAX_AUTO_RETRIES = 4;
const RETRY_DELAYS = [2000, 4000, 8000, 15000];

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET',
]);

function isRetriable(err, statusCode) {
  if (statusCode) return statusCode >= 500 || statusCode === 429 || statusCode === 408;
  if (err && RETRYABLE_CODES.has(err.code)) return true;
  return /超时|中断|timeout|timed out|hang up|reset|ECONN|socket/i.test(String((err && err.message) || ''));
}

function sanitizeFileName(name) {
  const cleaned = String(name || '未命名')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || '未命名').slice(0, 180);
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

class Downloader extends EventEmitter {
  constructor({ concurrency = 3 } = {}) {
    super();
    this.concurrency = Math.min(6, Math.max(1, concurrency | 0 || 1));
    this.tasks = new Map();
    this.reqs = new Map();
    this.streams = new Map();
    this.retryTimers = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.counter = 0;
  }

  setConcurrency(n) {
    this.concurrency = Math.min(6, Math.max(1, n | 0 || 1));
    this.pump();
  }

  snapshot(task) {
    const { _done, _active, cancelRequested, ...rest } = task;
    return rest;
  }

  emitChange(task) {
    this.emit('change', this.snapshot(task));
  }

  add({ url, headers = {}, fileName, directory }) {
    const id = `dl_${Date.now().toString(36)}_${++this.counter}`;
    const filePath = uniquePath(directory, sanitizeFileName(fileName));
    const task = {
      id,
      url,
      fileName: path.basename(filePath),
      filePath,
      partPath: `${filePath}.part`,
      total: 0,
      received: 0,
      speed: 0,
      status: 'queued', // queued | downloading | cancelling | retrying | completed | failed | cancelled
      error: null,
      attempts: 0,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.emitChange(task);
    this.pump();
    return this.snapshot(task);
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this.snapshot(t));
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      this.emitChange(task);
      return true;
    }
    if (task.status === 'retrying') {
      const timer = this.retryTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(id);
      }
      task.status = 'cancelled';
      task.error = null;
      task.finishedAt = Date.now();
      this.emitChange(task);
      return true;
    }
    if (task.status === 'downloading') {
      task.status = 'cancelling';
      task.cancelRequested = true;
      this.emitChange(task);
      const req = this.reqs.get(id);
      if (req) req.destroy();
      // 兜底：请求销毁事件未触发时保证状态收敛
      setTimeout(() => {
        if (task.status === 'cancelling') {
          const st = this.streams.get(id);
          if (st) st.destroy();
          this.finish(task, 'cancelled');
        }
      }, 2000);
      return true;
    }
    return false;
  }

  retry(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (!['failed', 'cancelled'].includes(task.status)) {
      throw new Error('只能重试失败或已取消的任务');
    }
    task.attempts = 0;
    task.error = null;
    task.cancelRequested = false;
    task.status = 'queued';
    task._done = false;
    this.queue.push(id);
    this.emitChange(task);
    this.pump();
    return true;
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return true;
    if (['queued', 'downloading', 'cancelling', 'retrying'].includes(task.status)) {
      throw new Error('任务仍在进行中，请先取消');
    }
    this.tasks.delete(id);
    this.deletePart(task);
    return true;
  }

  clearFinished() {
    for (const [id, t] of [...this.tasks]) {
      if (['completed', 'failed', 'cancelled'].includes(t.status)) {
        this.tasks.delete(id);
        this.deletePart(t);
      }
    }
  }

  deletePart(task) {
    fs.promises.unlink(task.partPath).catch(() => {});
  }

  pump() {
    while (this.activeCount < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue;
      this.activeCount += 1;
      task._active = true;
      task.status = 'downloading';
      task.error = null;
      this.emitChange(task);
      this.start(task, 0);
    }
  }

  finish(task, status, error, statusCode) {
    if (task._done) return;
    task._done = true;
    if (task._active) {
      task._active = false;
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
    this.reqs.delete(task.id);
    const stream = this.streams.get(task.id);
    if (stream) {
      stream.destroy();
      this.streams.delete(task.id);
    }
    task.speed = 0;

    // 可重试的瞬时错误（网络中断、服务器抖动等）自动退避重试，从 .part 断点续传
    if (status === 'failed' && !task.cancelRequested
      && task.attempts < MAX_AUTO_RETRIES && isRetriable(error, statusCode)) {
      task.attempts += 1;
      const delay = RETRY_DELAYS[Math.min(task.attempts - 1, RETRY_DELAYS.length - 1)];
      task.status = 'retrying';
      task.error = `${error ? error.message : '未知错误'}，${Math.round(delay / 1000)} 秒后自动重试（${task.attempts}/${MAX_AUTO_RETRIES}）`;
      this.emitChange(task);
      const timer = setTimeout(() => {
        this.retryTimers.delete(task.id);
        if (task.status !== 'retrying') return;
        task.status = 'queued';
        task._done = false;
        task.error = null;
        task.received = 0; // start() 会从 .part 重新推算
        this.queue.push(task.id);
        this.emitChange(task);
        this.pump();
      }, delay);
      this.retryTimers.set(task.id, timer);
      return;
    }

    task.status = status;
    task.finishedAt = Date.now();
    if (error) task.error = error.message || String(error);
    if (status === 'completed' && fs.existsSync(task.partPath)) {
      fs.promises.rename(task.partPath, task.filePath).catch(() => {});
    }
    this.emitChange(task);
    this.pump();
  }

  start(task, redirectCount) {
    if (task.status !== 'downloading') return;
    let u;
    try {
      u = new URL(task.url);
    } catch {
      return this.finish(task, 'failed', new Error('下载地址无效'));
    }

    // 断点续传：从 .part 文件现有长度处继续
    let offset = 0;
    try {
      if (fs.existsSync(task.partPath)) offset = fs.statSync(task.partPath).size;
    } catch {
      offset = 0;
    }
    if (task.total && offset > task.total) offset = 0; // 异常残留，重新下载
    if (offset > 0 && task.total && offset >= task.total) {
      return this.finish(task, 'completed'); // 上次实际已下完，只差收尾
    }
    task.received = offset;

    const headers = { ...task.headers };
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { headers, timeout: SOCKET_IDLE_TIMEOUT });
    this.reqs.set(task.id, req);

    req.on('timeout', () => req.destroy(new Error('连接超时（数据中断过久）')));
    req.on('error', (err) => {
      if (task.status === 'cancelling') this.finish(task, 'cancelled');
      else if (task.status === 'downloading') this.finish(task, 'failed', err);
    });

    req.on('response', (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.removeAllListeners('error');
        req.on('error', () => {});
        res.removeAllListeners();
        res.resume();
        if (redirectCount >= 5) return this.finish(task, 'failed', new Error('重定向次数过多'));
        task.url = new URL(res.headers.location, u).toString();
        return this.start(task, redirectCount + 1);
      }

      const statusCode = res.statusCode;
      if (statusCode !== 200 && statusCode !== 206) {
        const chunks = [];
        res.on('data', (c) => {
          if (chunks.reduce((n, b) => n + b.length, 0) < 4096) chunks.push(c);
        });
        res.on('end', () => {
          let detail = Buffer.concat(chunks).toString('utf8').slice(0, 200);
          try {
            const j = JSON.parse(detail);
            detail = j.Message || j.error || detail;
          } catch {
            // 非 JSON 错误体，原样展示
          }
          this.finish(task, 'failed', new Error(`服务器返回 HTTP ${statusCode}${detail ? `：${detail}` : ''}`), statusCode);
        });
        res.on('error', () => {});
        return;
      }

      // 206 = 续传成功；200 = 服务器不支持 Range，从头下载
      let append = false;
      if (statusCode === 206 && offset > 0) {
        append = true;
        const cr = /bytes\s+\d+-\d+\/(\d+)/i.exec(res.headers['content-range'] || '');
        if (cr) task.total = parseInt(cr[1], 10);
        else if (Number.isFinite(parseInt(res.headers['content-length'], 10))) {
          task.total = offset + parseInt(res.headers['content-length'], 10);
        }
      } else {
        offset = 0;
        task.received = 0;
        const total = parseInt(res.headers['content-length'], 10);
        task.total = Number.isFinite(total) ? total : 0;
      }

      const stream = fs.createWriteStream(task.partPath, { flags: append ? 'a' : 'w' });
      this.streams.set(task.id, stream);
      let lastTime = Date.now();
      let lastBytes = task.received;
      let lastEmit = 0;

      const tick = (force) => {
        const now = Date.now();
        if (!force && now - lastEmit < 300) return;
        lastEmit = now;
        const dt = (now - lastTime) / 1000;
        if (dt > 0) task.speed = (task.received - lastBytes) / dt;
        lastTime = now;
        lastBytes = task.received;
        this.emitChange(task);
      };

      res.on('data', (chunk) => {
        if (task.status !== 'downloading') return;
        task.received += chunk.length;
        if (!stream.write(chunk)) {
          res.pause();
          stream.once('drain', () => res.resume());
        }
        tick(false);
      });
      res.on('end', () => {
        stream.end(() => {
          if (task.status !== 'downloading') return;
          if (task.total && task.received < task.total) {
            this.finish(task, 'failed', new Error('连接提前中断'));
          } else {
            this.finish(task, 'completed');
          }
        });
      });
      res.on('error', (err) => {
        if (task.status === 'downloading') this.finish(task, 'failed', err);
      });
    });

    req.end();
  }
}

module.exports = { Downloader, sanitizeFileName };
