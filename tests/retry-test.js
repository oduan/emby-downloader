// 下载器断点续传 + 自动重试的端到端测试：node tests/retry-test.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Downloader } = require('../lib/downloader');

// 1 MB 伪随机数据
const DATA = Buffer.alloc(1024 * 1024);
for (let i = 0; i < DATA.length; i++) DATA[i] = (i * 31 + 7) % 256;

let dropCount = 2; // 前两次请求：发送部分数据后掐断连接

const server = http.createServer((req, res) => {
  const range = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = range ? parseInt(range[1], 10) : 0;

  if (dropCount > 0) {
    dropCount--;
    res.writeHead(200, { 'Content-Length': DATA.length, 'Content-Type': 'application/octet-stream' });
    res.write(DATA.slice(start, start + 120 * 1024));
    setTimeout(() => res.destroy(), 30);
    return;
  }
  if (range) {
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
      'Content-Length': DATA.length - start,
      'Accept-Ranges': 'bytes',
    });
    res.end(DATA.slice(start));
  } else {
    res.writeHead(200, { 'Content-Length': DATA.length });
    res.end(DATA);
  }
});

server.listen(0, async () => {
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  const dl = new Downloader({ concurrency: 1 });
  const firstFailAt = new Promise((resolve) => {
    dl.on('change', (t) => {
      if (t.status === 'retrying') resolve(t);
      console.log(`[${t.status}] received=${t.received} attempts=${t.attempts} ${t.error || ''}`);
    });
  });
  const finalDone = new Promise((resolve) => {
    dl.on('change', (t) => {
      if (t.status === 'completed' || t.status === 'failed') resolve(t);
    });
  });

  dl.add({ url: `http://127.0.0.1:${port}/file.bin`, fileName: 'file.bin', directory: dir });

  const retried = await firstFailAt;
  console.log('auto-retry triggered:', retried.status === 'retrying', '| attempts:', retried.attempts);
  const final = await finalDone;

  const finalPath = path.join(dir, 'file.bin');
  const partGone = !fs.existsSync(finalPath + '.part');
  const contentOk = fs.existsSync(finalPath) && DATA.equals(fs.readFileSync(finalPath));
  const pass = final.status === 'completed' && contentOk && partGone;
  console.log(pass ? 'TEST PASS' : 'TEST FAIL',
    `| status=${final.status} attempts=${final.attempts} contentOk=${contentOk} partRenamed=${partGone}`);
  server.close();
  process.exit(pass ? 0 : 1);
});
