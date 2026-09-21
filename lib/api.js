/**
 * kokomi-helper · 直接对接 Kokomi 服务的 HTTP 客户端
 * ================================================
 *
 * 本插件**不再需要本地 Python**：出图完全由 Kokomi 服务端完成，服务返回的是
 * **一张渲染好的图片 URL**，我们只需把它下载成字节交给发送队列。
 *
 * 服务契约（实测自 http://43.133.59.53:8000/bot/ 的 OpenAPI 文档）
 * ---------------------------------------------------------------
 *
 *     GET  <botUrl>?token=<token>&message=<指令>&platform=<平台>
 *                  &user_id=<用户ID>&platform_id=<机器人ID>&channel_id=<频道ID>
 *
 *     → {"type":"img","msg":null,"img":"http://<图片服务器>/wws_image/xxx.jpg"}
 *     → {"type":"msg","msg":"请先绑定游戏账号，发送'wws help'可查询帮助文档","img":null}
 *
 * 两个必须记住的坑（都踩过）：
 *
 * 1. **token 是查询参数，不是请求头**。形状是 `?token=user`，不是
 *    `Authorization: Bearer user123456`。用后者服务端会回
 *    `{"type":"msg","msg":"Token unavailable"}`。
 * 2. **图片 URL 在另一个 host 上**（不带端口，走 80）。不能拿 `botUrl` 去拼，
 *    必须用响应里给出的完整 URL。
 */

/** 直连调用失败时抛出的错误；`kind` 用于生成给用户看的提示。 */
export class ApiError extends Error {
  /**
   * @param {'offline'|'timeout'|'http'|'bad_response'|'image'|'unconfigured'} kind
   * @param {string} message 面向用户的中文说明。
   * @param {object} [detail] 排查用的附加信息。
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** `kind → 中文提示`：调用方只需展示 `error.message`。 */
export function friendlyApiError(error) {
  if (!(error instanceof ApiError)) return String(error?.message ?? error);
  return error.message;
}

/**
 * 判断响应体是不是"口令不对"。
 *
 * @param {object} body 服务响应体。
 * @returns {boolean}
 * @remarks 服务端把口令错误伪装成了一条普通文字消息（`Token unavailable`），
 *   HTTP 状态码仍是 200，所以只能靠内容识别。
 */
export function isTokenRejected(body) {
  const msg = String(body?.msg ?? '').trim().toLowerCase();
  return msg === 'token unavailable';
}

/**
 * 把任意异常归一化成 ApiError。
 *
 * @param {unknown} error
 * @param {string} what 描述"在做什么"，用于拼提示语。
 * @returns {ApiError}
 */
function toApiError(error, what) {
  if (error instanceof ApiError) return error;
  if (error?.name === 'AbortError') {
    return new ApiError('timeout', `${what}超时了，稍后再试。`, { cause: 'abort' });
  }
  return new ApiError('offline', `${what}失败：连不上服务（网络错误）。`, {
    cause: error?.message ?? String(error)
  });
}

/**
 * 带超时的 fetch。
 *
 * @param {string} url
 * @param {{timeoutMs?: number, responseType?: 'json'|'buffer'}} [options]
 * @returns {Promise<{status: number, json: object|null, buffer: Buffer|null, contentType: string}>}
 * @throws {ApiError}
 */
async function request(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const status = response.status;
    const contentType = String(response.headers.get('content-type') || '');
    if (options.responseType === 'buffer') {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status, json: null, buffer, contentType };
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError('bad_response', '服务返回了非 JSON 内容。', {
        status,
        body: text.slice(0, 300)
      });
    }
    return { status, json, buffer: null, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拼接查询串。服务端要求所有参数走 query（含 token）。
 *
 * @param {string} botUrl 服务根地址（如 `http://host:8000/bot/`）。
 * @param {Record<string, string>} params
 * @returns {string} 完整 URL。
 */
export function buildQueryUrl(botUrl, params) {
  const base = String(botUrl || '').trim();
  const sep = base.includes('?') ? '&' : '?';
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return query ? `${base}${sep}${query}` : base;
}

/**
 * 调一次服务，把指令交给它。
 *
 * @param {object} params
 * @param {string} params.botUrl 服务根地址。
 * @param {string} params.token 访问口令（查询参数 `token`）。
 * @param {string} params.command 触发词之后的正文（如 `me`）。
 * @param {string} params.userId 触发者 ID（服务端按它查绑定）。
 * @param {string} [params.platform] 平台标识，默认 `qq_bot`。
 * @param {string} [params.platformId] 机器人/频道标识。
 * @param {string} [params.channelId] 频道 ID。
 * @param {string} [params.upstreamKeyword='wws'] 服务端认得的触发词前缀。
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{type: 'image'|'text', text: string, imageUrl: string}>}
 * @throws {ApiError} 网络/协议层失败，或口令被拒。
 * @remarks `message` 参数要带上服务端认得的触发词（默认 `wws`）——这是上游的写法，
 *   与本插件对外的 `kokomi` 是两回事。见 DEVELOPMENT.md。
 */
export async function queryKokomi({
  botUrl,
  token,
  command,
  userId,
  platform = 'qq_bot',
  platformId = '',
  channelId = '',
  upstreamKeyword = 'wws',
  timeoutMs = 60000
} = {}) {
  if (!botUrl) {
    throw new ApiError('unconfigured', '还没有配置 Kokomi 服务地址。');
  }
  const keyword = String(upstreamKeyword || 'wws').trim() || 'wws';
  const body_ = String(command || '').trim() || 'help';
  const url = buildQueryUrl(botUrl, {
    token,
    message: `${keyword} ${body_}`,
    platform,
    user_id: userId,
    platform_id: platformId,
    channel_id: channelId
  });

  let result;
  try {
    result = await request(url, { timeoutMs });
  } catch (error) {
    throw toApiError(error, '查询 Kokomi 服务');
  }

  if (result.status === 403) {
    throw new ApiError('unconfigured', 'Kokomi 服务拒绝了这次请求（口令可能不对）。', {
      status: result.status
    });
  }
  if (result.status !== 200) {
    throw new ApiError('http', `Kokomi 服务返回 HTTP ${result.status}。`, {
      status: result.status
    });
  }

  const body = result.json ?? {};
  if (isTokenRejected(body)) {
    throw new ApiError(
      'unconfigured',
      'Kokomi 服务提示 Token 不可用 —— 请核对插件设置里的「访问口令」。',
      { body }
    );
  }

  const type = String(body.type || '').trim().toLowerCase();
  if (type === 'img') {
    const imageUrl = String(body.img || '').trim();
    if (!imageUrl) {
      // 有 img 类型但没有地址：上游偶发，按文字提示处理更稳妥
      return { type: 'text', text: '服务没有返回图片地址，稍后再试。', imageUrl: '' };
    }
    return { type: 'image', text: '', imageUrl };
  }
  if (type === 'msg') {
    return { type: 'text', text: String(body.msg ?? '').trim(), imageUrl: '' };
  }
  return {
    type: 'text',
    text: 'Kokomi 服务返回了无法识别的结果格式。',
    imageUrl: ''
  };
}

/**
 * 下载服务给出的图片。
 *
 * @param {string} imageUrl 完整地址（响应里的 `img` 字段）。
 * @param {{timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 * @throws {ApiError}
 * @remarks 图片在**另一个 host** 上（不带端口），所以这里用的是响应给的绝对地址，
 *   不做任何重写；超出 `maxBytes` 直接拒绝，避免把超大图读进内存。
 */
export async function downloadImage(imageUrl, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes) || 12 * 1048576);
  if (!imageUrl) throw new ApiError('image', '图片地址为空。');
  let result;
  try {
    result = await request(imageUrl, {
      timeoutMs: Number(options.timeoutMs) || 60000,
      responseType: 'buffer'
    });
  } catch (error) {
    throw toApiError(error, '下载战绩图');
  }
  if (result.status !== 200) {
    throw new ApiError('image', `下载战绩图失败（HTTP ${result.status}）。`, {
      status: result.status,
      url: imageUrl
    });
  }
  const buffer = result.buffer ?? Buffer.alloc(0);
  if (!buffer.length) {
    throw new ApiError('image', '下载到的战绩图是空的。', { url: imageUrl });
  }
  if (buffer.length > maxBytes) {
    throw new ApiError('image', `战绩图 ${(buffer.length / 1048576).toFixed(1)}MB 超过体积上限。`, {
      bytes: buffer.length
    });
  }
  return { buffer, mime: sniffImageMime(buffer, result.contentType) };
}

/**
 * 从内容嗅探图片格式（服务返回的是 jpg，但不写死）。
 *
 * @param {Buffer} buffer
 * @param {string} [contentType]
 * @returns {'jpeg'|'png'|'gif'|'webp'}
 */
export function sniffImageMime(buffer, contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (buffer.length > 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp';
  }
  return 'jpeg';
}

/**
 * 探活：调一次最轻的 `help`。
 *
 * @param {{botUrl: string, token: string, timeoutMs?: number}} params
 * @returns {Promise<{ok: boolean, kind?: string, error?: string}>} 永不抛错。
 */
export async function apiPing({ botUrl, token, timeoutMs = 15000 } = {}) {
  try {
    const res = await queryKokomi({
      botUrl,
      token,
      command: 'help',
      userId: '0',
      timeoutMs
    });
    return { ok: true, type: res.type };
  } catch (error) {
    return {
      ok: false,
      kind: error?.kind ?? 'unknown',
      error: error?.message ?? String(error)
    };
  }
}
