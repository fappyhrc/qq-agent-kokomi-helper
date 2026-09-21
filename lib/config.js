/**
 * kokomi-helper · 运行时配置读取
 * ==============================
 *
 * 两条原则（与 yuyuko 插件一致）：
 *
 * 1. **每次现读，绝不快照**。用户在控制台随时可能改设置（例如换服务地址），
 *    若在 `setup` 阶段取出来存成普通变量，之后改了就不生效。
 * 2. **取值即规整**。`configSchema` 只是写入白名单，不是类型保证：用户能填出空串、
 *    负数、超大数字。这里统一收敛，避免把 `NaN` 拼进 URL 或把 `0` 当成"无限超时"。
 *
 * 约定：`DEFAULTS` 必须与 `plugin.json` 的 `settings` 保持一致（自检会交叉校验）。
 *
 * ⚠️ 用户在设置页改的值存在 `data/config.json` 的 **`skills['kokomi-helper']`** 下
 *    （平台的 getSkillConfig 把 `config.skills[id]` 与 manifest 默认值合并后交给
 *    `api.config()`）。顶层没有 `plugins` 段；写到别处这里读到的就是 DEFAULTS。
 */

// 数据目录走**核心的唯一真源**，不自己拼路径。
//
// 为什么：DATA_DIR 由 QQ_AGENT_DATA_DIR（显式覆盖）> QQ_AGENT_PROFILE（多实例推导
// data-2/）> 默认 data/ 三层决定。插件若自己算一遍，多实例下会写错根目录 ——
// 表现为"实例 #2 的数据写进了 #1 的目录"，两边互相污染且极难发现。
//
// 同一做法见 plugins/情绪插件（0.4 12+版本）/lib/config.js；conversation-memory 等
// 既有插件也依赖核心导出。插件与本仓库同树部署，因此这个相对路径成立。
export { DATA_DIR, ROOT } from '../../../src/config.js';

/**
 * 兜底默认值（与 `plugin.json` 的 `settings` 逐项对应）。
 *
 * 只在 `api.config()` 取不到值时使用；正常路径下核心已合并 manifest 的默认值。
 */
export const DEFAULTS = {
  // 触发词**必须与 plugin.json 的 settings.triggerKeywords 一致**（自检会交叉校验）。
  // 本插件只认 kokomi；yuyuko 插件只认 yuyuko，两者互不认领。
  triggerKeywords: ['kokomi'],
  // 严格的 AND 判定：**既要 @ 机器人，又要触发词在开头**。
  requireAt: true,
  // Kokomi 服务根地址。末尾斜杠可有可无（拼 query 时会处理）。
  // 说明：这里是**官方/第三方托管的服务**，出图在服务端完成，插件不再本地渲染。
  botUrl: 'http://43.133.59.53:8000/bot/',
  // 访问口令。注意它是**查询参数** `?token=`，不是请求头。
  // 上游 v4 的默认凭据是 API_USERNAME=user，实测该服务认 user。
  token: 'user',
  requestTimeoutMs: 60000,
  autoSendImage: true,
  includeTextInContext: true,
  contextTextMaxChars: 1600,
  atTriggerUser: false,
  replyToTrigger: false,
  // 上报平台标识：服务端按 platform + user_id 记录绑定，换值会读不到原绑定。
  platform: 'qq_bot',
  // 发送给服务端的指令前缀。服务端认的是上游自己的触发词（wws），
  // 与本插件对外的 kokomi 是两回事，**一般不需要改**。
  upstreamKeyword: 'wws',
  serveImage: true,
  imageServerHost: '127.0.0.1',
  // 32802：与 yuyuko 插件的图片服务（32801）错开。
  imageServerPort: 32802,
  imageTtlSec: 600,
  maxImageMB: 12,
  downloadTimeoutMs: 60000,
  debug: false
};

/** `api.config` 的引用；未 bind 时为 `null`。 */
let configGetter = null;

/**
 * 绑定平台的配置读取函数（`setup(api)` 时调用一次）。
 * @param {() => object} getter 通常是 `api.config`。
 * @returns {void}
 */
export function bindConfig(getter) {
  configGetter = typeof getter === 'function' ? getter : null;
}

/** 取原始配置对象（读不到时返回空对象）。 */
function raw() {
  try {
    const value = configGetter ? configGetter() : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** 收敛为布尔值；未设置时用默认值。 */
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
  return fallback;
}

/** 收敛为字符串；trim 后为空则用默认值。 */
function str(value, fallback = '') {
  const s = value === undefined || value === null ? '' : String(value).trim();
  return s || fallback;
}

/** 收敛为整数并夹在 [min, max] 内。 */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 枚举取值：不在候选里就用默认值。 */
function oneOf(value, allowed, fallback) {
  const s = str(value, '');
  return allowed.includes(s) ? s : fallback;
}

/**
 * 取规整后的配置。
 *
 * @returns {{
 *   triggerKeywords: string[], requireAt: boolean, botUrl: string, token: string,
 *   requestTimeoutMs: number, downloadTimeoutMs: number, autoSendImage: boolean,
 *   includeTextInContext: boolean, contextTextMaxChars: number, atTriggerUser: boolean,
 *   replyToTrigger: boolean, platform: string, upstreamKeyword: string, serveImage: boolean,
 *   imageServerHost: string, imageServerPort: number, imageTtlSec: number,
 *   maxImageMB: number, debug: boolean
 * }}
 * @remarks `botUrl` 会去掉尾部斜杠：拼 query 时避免出现 `//`。
 *   触发词统一转小写并去掉可能的 `@` 前缀（供 `matchTrigger` 使用）。
 */
export function cfg() {
  const c = raw();
  const keywords = Array.isArray(c.triggerKeywords) ? c.triggerKeywords : DEFAULTS.triggerKeywords;
  const normalized = keywords
    .map((k) => String(k ?? '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);

  return {
    triggerKeywords: normalized.length ? normalized : [...DEFAULTS.triggerKeywords],
    requireAt: bool(c.requireAt, DEFAULTS.requireAt),
    botUrl: str(c.botUrl, DEFAULTS.botUrl).replace(/\/+$/, ''),
    token: str(c.token, DEFAULTS.token),
    requestTimeoutMs: num(c.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 3000, 300000),
    downloadTimeoutMs: num(c.downloadTimeoutMs, DEFAULTS.downloadTimeoutMs, 3000, 300000),
    autoSendImage: bool(c.autoSendImage, DEFAULTS.autoSendImage),
    includeTextInContext: bool(c.includeTextInContext, DEFAULTS.includeTextInContext),
    contextTextMaxChars: num(c.contextTextMaxChars, DEFAULTS.contextTextMaxChars, 200, 20000),
    atTriggerUser: bool(c.atTriggerUser, DEFAULTS.atTriggerUser),
    replyToTrigger: bool(c.replyToTrigger, DEFAULTS.replyToTrigger),
    platform: oneOf(c.platform, ['qq_bot', 'qq_group', 'qq_guild', 'discord'], DEFAULTS.platform),
    upstreamKeyword: str(c.upstreamKeyword, DEFAULTS.upstreamKeyword),
    serveImage: bool(c.serveImage, DEFAULTS.serveImage),
    imageServerHost: str(c.imageServerHost, DEFAULTS.imageServerHost),
    imageServerPort: num(c.imageServerPort, DEFAULTS.imageServerPort, 1, 65535),
    imageTtlSec: num(c.imageTtlSec, DEFAULTS.imageTtlSec, 30, 86400),
    maxImageMB: num(c.maxImageMB, DEFAULTS.maxImageMB, 1, 100),
    debug: bool(c.debug, DEFAULTS.debug)
  };
}
