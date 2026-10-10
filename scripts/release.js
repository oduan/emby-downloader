#!/usr/bin/env node
'use strict';

// 发布脚本：打版本 tag 并推送，触发 GitHub Actions 自动打包发布。
//
// 用法：
//   npm run release              → 取最新 v* tag 的补丁版本 +0.0.1（无 tag 时从 v0.0.1 开始）
//   npm run release -- 0.2.0     → 使用明确指定的版本（v 前缀可省略，必须为 x.y.z 三段式）
//   npm run release -- --dry-run → 只打印将要发布的版本，不实际打 tag

const { execSync } = require('child_process');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function trySh(cmd) {
  try {
    return sh(cmd);
  } catch {
    return '';
  }
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatVersion(v) {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

function bumpPatch(v) {
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function latestTag() {
  trySh('git fetch --tags --quiet origin');
  return trySh('git describe --tags --abbrev=0 --match "v*"');
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verArg = args.find((a) => a !== '--dry-run');

  let next;
  if (verArg != null) {
    const explicit = parseVersion(verArg);
    if (!explicit) {
      console.error(`错误：「${verArg}」不是合法的版本号，需要 x.y.z 三段式（如 0.2.0 或 v0.2.0）`);
      process.exit(1);
    }
    next = explicit;
  } else {
    const latest = latestTag();
    const cur = parseVersion(latest) || { major: 0, minor: 0, patch: 0 };
    next = bumpPatch(cur);
    if (latest) console.log(`当前最新 tag：${latest}`);
  }
  const tag = formatVersion(next);

  if (dryRun) {
    console.log(`[dry-run] 将发布版本：${tag}`);
    return;
  }

  if (trySh(`git rev-parse -q --verify refs/tags/${tag}`)) {
    console.error(`错误：tag ${tag} 已存在。如需指定其他版本：npm run release -- x.y.z`);
    process.exit(1);
  }
  if (sh('git status --porcelain')) {
    console.error('错误：工作区有未提交的改动，请先提交后再发布');
    process.exit(1);
  }

  sh(`git tag -a ${tag} -m "Release ${tag}"`);
  sh(`git push origin ${tag}`);
  console.log(`已推送 tag ${tag}，GitHub Actions 正在自动打包发布：`);
  console.log(`  https://github.com/${trySh('git remote get-url origin').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '')}/actions`);
}

if (require.main === module) {
  main();
}

module.exports = { parseVersion, formatVersion, bumpPatch };
