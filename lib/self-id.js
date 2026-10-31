/**
 * kokomi-helper · 机器人自身身份（QQ 号）
 * ======================================
 *
 * 为什么需要这个模块（真实故障，务必看完）：
 *   判定"这条消息 @ 的是不是我"依赖 `selfNames` 里的 **QQ 号**；而原来这个 QQ 号只能
 *   「从消息里的 @ 提及学习」，规则是**取最后一条带 `(QQ:n)` 的提及**。于是：
 *
 *     `@机器人(QQ:2054294369) @另一个机器人(QQ:2540725941) 记老梁账上`
 *
 *   钩子把 **2540725941** 学成了自己，之后 10 分钟内所有 `@机器人(QQ:2054294369) kokomi me`
 *   都判定为「没有 @ 机器人」，`kokomi-query` 全被凭据闸门拒绝。
 *   现场证据（2026-10-31 16:50~16:53 同一群）：这一轮之后连续 3 次正确的 koromi 指令
 *   全部未认领；用 `matchTrigger` 直接复现，reason 正是 `没有 @ 机器人`。
 *
 * 所以身份来源按可靠性分级，**高优先级永远不被低优先级覆盖**：
 *   ① `ctx.selfId`       —— 平台直接给的，最权威（rank 3）
 *   ② SnowLuma 账号文件  —— `onebot_<QQ>.json` 的令牌与 QQ-Agent 配置里的
 *                           `snowluma.httpAccessToken` 对上，就是当前账号（rank 2）
 *   ③ 消息里的 @ 提及    —— 最后的兜底，且只在**没有歧义**时才学（rank 1）：
 *                           · 消息必须以 `@` 开头（排除 `[拍一拍] 楼(QQ:1) 拍了拍 我` 这类系统行）
 *                           · 全句只有一个不同的 QQ 号（多个被 @ 时无法判断谁是机器人）
 *
 * 本模块**只读** QQ-Agent / SnowLuma 的配置，绝不写。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractMentions } from './trigger.js';

/** 本文件所在目录（`lib/`）。不用 `import.meta.dirname`：应用内实测为 undefined。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 身份来源的优先级：数字越大越可信。 */
const RANK = { mention: 1, snowluma: 2, ctx: 3 };

/** 一个"从 @ 提及学来的"身份最多信任多久（超过就允许重新学）。 */
const MENTION_TTL_MS = 10 * 60 * 1000;

/** 依次尝试的数据目录候选（去重）。 */
function dataDirCandidates() {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(process.env.QQ_AGENT_DATA_DIR);
  let dir = HERE;
  for (let i = 0; i < 7 && dir; i += 1) {
    push(path.join(dir, 'data'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let envDir = process.env.QQ_AGENT_DATA_DIR;
  for (let i = 0; i < 3 && envDir; i += 1) {
    const parent = path.dirname(envDir);
    if (parent === envDir) break;
    push(path.join(parent, 'data'));
    envDir = parent;
  }
  return out;
}

/** 找一个真实存在 `config.json` 的数据目录。 */
function findDataDir() {
  for (const dir of dataDirCandidates()) {
    try {
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir;
    } catch {
      /* 试下一个 */
    }
  }
  return '';
}

/** 读 QQ-Agent 配置（只读）；读不到返回 null。 */
export function readAppConfig() {
  const dir = findDataDir();
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 找 SnowLuma 的 config 目录（放 `onebot_<QQ>.json` 的地方）。 */
export function snowlumaConfigDir() {
  const dataDir = findDataDir();
  if (!dataDir) return '';
  for (const root of [path.dirname(dataDir), dataDir]) {
    const cand = path.join(root, 'resources', 'app', 'snowluma', 'config');
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {
      /* 继续 */
    }
  }
  return '';
}

/**
 * 从 SnowLuma 的账号配置推断机器人 QQ 号。
 *
 * 原理：SnowLuma 按账号存配置（`onebot_<QQ>.json`），里面记着该账号 HTTP 服务的
 * 端口与访问令牌；QQ-Agent 配置里也记着当前连的令牌（`snowluma.httpAccessToken`）。
 * 拿令牌逐个比对，匹配上的那个账号才是当前账号。
 *
 * ⚠️ 不能"取第一个文件"：本机就有两个账号配置（`onebot_2054294369.json` 令牌匹配、
 *    `onebot_3930779767.json` 令牌为空）。
 *
 * @param {{snowlumaDir?:string, appConfig?:object}} [options] 仅供测试注入，正式调用留空
 * @returns {string} QQ 号；推断不出返回空串
 */
export function selfIdFromSnowLuma(options = {}) {
  try {
    const dir = options.snowlumaDir || snowlumaConfigDir();
    if (!dir) return '';
    const cfg = options.appConfig !== undefined ? options.appConfig : readAppConfig() || {};
    const ob = cfg.snowluma || cfg.onebot || {};
    const token = String(ob.httpAccessToken || ob.accessToken || '').trim();
    const files = fs.readdirSync(dir).filter((f) => /^onebot_\d{5,12}\.json$/i.test(f));
    if (!files.length) return '';
    const qqOf = (f) => (f.match(/(\d{5,12})/) || [])[1] || '';
    const serversOf = (f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return Array.isArray(data?.networks?.httpServers) ? data.networks.httpServers : [];
      } catch {
        return [];
      }
    };

    // ① 令牌精确匹配（最可靠）
    if (token) {
      for (const f of files) {
        if (serversOf(f).some((x) => String(x?.accessToken || '').trim() === token)) return qqOf(f);
      }
    }
    // ② 退一步：用 httpUrl 的端口匹配
    const port = (String(ob.httpUrl || '').match(/:(\d+)/) || [])[1];
    if (port) {
      for (const f of files) {
        if (serversOf(f).some((x) => String(x?.port) === port)) return qqOf(f);
      }
    }
    // ③ 只有一个账号文件时，用它总比没有好
    return files.length === 1 ? qqOf(files[0]) : '';
  } catch {
    return '';
  }
}

/**
 * 创建一份"机器人自身身份"状态机（纯逻辑，可单测）。
 *
 * @param {{infer?:()=>string, now?:()=>number, ttlMs?:number}} [deps]
 *   infer: 权威来源推断函数（默认 `selfIdFromSnowLuma`，测试可注入假实现）
 * @returns {{
 *   id:string, source:string,
 *   set:(id:string, source:string)=>boolean,
 *   learn:(text:string, ctxSelfId?:string)=>string,
 *   names:(ctx?:object)=>string[]
 * }}
 */
export function createSelfIdentity(deps = {}) {
  const infer = typeof deps.infer === 'function' ? deps.infer : selfIdFromSnowLuma;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const ttlMs = Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : MENTION_TTL_MS;

  const state = { id: '', source: '', at: 0 };

  /**
   * 写入身份；低优先级永远不能覆盖高优先级。
   * @returns {boolean} 是否真的写入了
   */
  function set(id, source) {
    const value = String(id ?? '').trim();
    const src = String(source ?? '').trim();
    if (!value) return false;
    if (!RANK[src]) return false;
    if (state.id === value && state.source === src) {
      state.at = now();
      return false;
    }
    if (state.id && (RANK[state.source] || 0) > RANK[src]) return false;
    state.id = value;
    state.source = src;
    state.at = now();
    return true;
  }

  /**
   * 学习身份（钩子每条消息都调用一次）。
   *
   * @param {string} text 消息原文
   * @param {string} [ctxSelfId] 平台给的机器人 QQ
   * @returns {string} 当前身份（可能是空串）
   */
  function learn(text, ctxSelfId) {
    // ① 平台给的 QQ：最权威
    const fromCtx = String(ctxSelfId ?? '').trim();
    if (fromCtx) {
      set(fromCtx, 'ctx');
      return state.id;
    }
    // ② 已有权威来源（ctx / snowluma）就不要再猜
    if (state.id && state.source !== 'mention') return state.id;
    // ③ SnowLuma 账号文件推断（拿不到就继续走兜底，允许下次再试）
    const inferred = String(infer() || '').trim();
    if (inferred) {
      set(inferred, 'snowluma');
      return state.id;
    }
    // ④ 提及时效内不重复学
    if (state.id && now() - state.at < ttlMs) return state.id;
    // ⑤ 兜底：只在没有歧义时才从 @ 提及学习
    const raw = String(text ?? '');
    if (!/^[\s\u200b\u200e\u200f\ufeff]*@/.test(raw)) return state.id;
    const qids = [...new Set(extractMentions(raw).mentions.map((m) => m.qid).filter(Boolean))];
    if (qids.length !== 1) return state.id;
    set(qids[0], 'mention');
    return state.id;
  }

  /**
   * 组装"机器人可能的称呼"，交给 `isBotMentioned` 判定。
   *
   * @param {object} [ctx] 钩子/工具上下文
   * @returns {string[]}
   */
  function names(ctx) {
    return [
      String(ctx?.selfId ?? ''),
      String(ctx?.selfNickname ?? ''),
      String(ctx?.botName ?? ''),
      state.id
    ].map((s) => String(s ?? '').trim()).filter(Boolean);
  }

  return {
    get id() {
      return state.id;
    },
    get source() {
      return state.source;
    },
    get at() {
      return state.at;
    },
    set,
    learn,
    names
  };
}
