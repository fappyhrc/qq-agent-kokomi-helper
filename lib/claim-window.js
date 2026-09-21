/**
 * kokomi-helper · 会话级"本轮确实有 kokomi 触发"凭据
 * =================================================
 *
 * 为什么需要它：`kokomi-query` 是全局工具，模型在任何一轮都可能调它。
 * 早期实现只靠工具描述里的"什么时候用"，结果出现**没喊 kokomi 也去查**的行为
 * （模型把"或你判断需要 Kokomi 的数据来把话接下去"当成了授权）。
 *
 * 因此这里做一道**硬闸**：只有本轮消息真的命中了 kokomi 触发（钩子认领过），
 * 工具才允许执行。凭据按会话键存，带 TTL（默认 10 分钟）：
 *
 * * 为什么带 TTL 而不是"单轮一次性"：模型可能先调 `kokomi-query`，再调
 *   `kokomi-send-image`，甚至在同一话题里连查两次；单轮一次性会把正常续查也拦掉。
 *   10 分钟足够覆盖一次对话，又不会让凭据长期挂着。
 * * 为什么落盘：插件热重载会**重建模块实例**（`plugin-loader.js` 用
 *   `import(url + '?t=…')`），内存凭据在重载后会丢，导致"刚认领完就查不了"。
 *   落盘到 `DATA_DIR/kokomi-claim.json` 可跨重载，代价只是一个小文件。
 *
 * 失败一律静默：凭据读写出问题**不应该**让插件不可用 —— 最坏退化成"窗口内不限制"，
 * 也就是回到加闸之前的行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** 凭据存活时间：覆盖一次对话里的连续查询。 */
const TTL_MS = 10 * 60 * 1000;

/** 最多记住多少个会话（防止长时间运行后无界增长）。 */
const MAX_ENTRIES = 200;

/** 内存表：`chatKey → 上次认领时间戳`。 */
const claims = new Map();

/** 落盘文件（延迟解析：DATA_DIR 由核心提供，测试环境可能存在）。 */
function claimFile() {
  return path.join(DATA_DIR, 'kokomi-claim.json');
}

let loaded = false;

/** 首次访问时从磁盘读取；文件缺失或损坏都当作"没有凭据"。 */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(claimFile(), 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    const now = Date.now();
    for (const [key, at] of Object.entries(json || {})) {
      const ts = Number(at);
      if (key && Number.isFinite(ts) && now - ts < TTL_MS) claims.set(key, ts);
    }
  } catch {
    /* 文件不存在/损坏：当作空表，不影响功能 */
  }
}

/** 尽力落盘（失败静默：凭据只在内存里也能工作，只是抗不住热重载）。 */
function persist() {
  try {
    const obj = {};
    for (const [key, at] of claims) obj[key] = at;
    // 先写临时文件再改名：避免写一半被读到半个 JSON
    const target = claimFile();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    /* 静默 */
  }
}

/** 淘汰过期与超量条目。 */
function prune() {
  const now = Date.now();
  for (const [key, at] of claims) {
    if (now - at >= TTL_MS) claims.delete(key);
  }
  if (claims.size <= MAX_ENTRIES) return;
  const ordered = [...claims.entries()].sort((a, b) => a[1] - b[1]);
  while (ordered.length && claims.size > MAX_ENTRIES) {
    claims.delete(ordered.shift()[0]);
  }
}

/**
 * 记录一次认领（由 `before-context` 钩子在命中触发时调用）。
 *
 * @param {string} chatKey 会话键。
 * @returns {void}
 */
export function markClaim(chatKey) {
  const key = String(chatKey || '');
  if (!key) return;
  ensureLoaded();
  prune();
  claims.set(key, Date.now());
  persist();
}

/**
 * 判断该会话在本窗口内是否真的触发过 kokomi。
 *
 * @param {string} chatKey 会话键。
 * @returns {boolean}
 */
export function hasClaim(chatKey) {
  const key = String(chatKey || '');
  if (!key) return false;
  ensureLoaded();
  const at = claims.get(key);
  if (!at) return false;
  if (Date.now() - at >= TTL_MS) {
    claims.delete(key);
    persist();
    return false;
  }
  return true;
}

/** 距离凭据过期还有多少毫秒（0 = 没有凭据）。用于结果里给人话提示。 */
export function claimAge(chatKey) {
  const key = String(chatKey || '');
  if (!key) return 0;
  ensureLoaded();
  const at = claims.get(key);
  if (!at) return 0;
  return Math.max(0, TTL_MS - (Date.now() - at));
}

/** 清空全部凭据（停用时调用）。 */
export function clearClaims() {
  claims.clear();
  loaded = true;
  persist();
}
