/**
 * 战舰世界助手（kokomi-helper）· 插件入口
 * ======================================
 *
 * 职责
 * ----
 * 让群里一句「@机器人 kokomi me」变成"查得到、画得出、发得出去"。
 *
 * 与 yuyuko 插件同构，但**出图方式完全不同**：
 *
 * * yuyuko：上游 `Hikari-core-v2` 在本机用浏览器渲染，插件需要一个 Python 桥接进程；
 * * kokomi（本插件）：**Kokomi 服务在服务端渲染好图片**，只把图片 URL 返回来，
 *   插件下载后交给发送队列。因此这里是**纯 Node 实现**，没有 Python、没有常驻进程。
 *
 * 链路分两段
 * ----------
 * 1. **确定性一段** —— `before-context` 钩子负责**认领**。判定条件能写成 if
 *    （「@ 了机器人本人」+「去掉 @提及 后第一个词是 kokomi」），漏认领就没有下文，
 *    因此必须走钩子、不经模型。
 * 2. **LLM 一段** —— 模型据此调用 `kokomi-query` 工具。工具是模型唯一能主动发起
 *    查询的入口；查到后由模型决定怎么接话。
 *
 * 为什么查询不放在钩子里
 * ----------------------
 * 钩子硬超时 5 秒（核心 `src/skills/manager.js` 的 `DEFAULT_HOOK_TIMEOUT_MS`），
 * 而一次查询要「服务端取数 + 渲染 + 插件下载图片」，实测数秒。因此钩子只认领。
 *
 * 为什么图片默认由插件直接发
 * --------------------------
 * 模型看不到图片内容。把"这张图要不要发"交给它判断，实测结果是"图躺在缓存里、
 * 群里什么都没有"。因此默认 `autoSendImage=true`：拿到图即走 `ctx.sender.sendImage`
 * （发送队列 → 限频 → 去重 → 留档），模型只负责接话。
 */
import { bindConfig, cfg } from './lib/config.js';
import {
  ApiError,
  apiPing,
  downloadImage,
  queryKokomi
} from './lib/api.js';
import { buildContextNote, formatResultText } from './lib/format.js';
import { extractMentions, isBotMentioned, matchTrigger } from './lib/trigger.js';
import * as imageStore from './lib/image-store.js';
import * as imageServer from './lib/image-server.js';

/** 平台注入的日志出口；未 `setup` 前为空操作。 */
let log = () => {};
/** 平台注入的警告出口。 */
let warn = () => {};

/** 最近一次触发消息的 id：`chatKey → messageId`（供 `replyToTrigger` 引用）。 */
const triggerMsg = new Map();

/**
 * 最近一次触发者：`chatKey → senderId`。
 *
 * 必须记录的原因：工具执行时拿到的 `ctx` 里**没有触发者 QQ 号**
 * （只有 `chatKey` / `chatId` / `selfId`），而 Kokomi 服务是按
 * `platform + user_id` 查绑定的 —— 传错人就查到别人的绑定。
 */
const triggerSender = new Map();

/** 最近一次查询结果：`chatKey → result`（供 `kokomi-send-image` 补发）。 */
const lastResult = new Map();

/**
 * 本轮"已认领 kokomi 指令"的会话标记：`chatKey → true`。
 *
 * 存在的唯一目的：把**指令表按需注入**提示词。核心在每次运行里先跑
 * `before-context` 钩子、再组装系统提示词（`orchestrator.js` 明确写了这个顺序），
 * 而插件可以导出 `promptSections(context)` 参与组装（`manager.js`）。
 * 于是钩子在这里做标记、`promptSections` 读取它，就能做到
 * **只有本轮真的是 kokomi 指令时**才把那张指令表塞进提示词。
 *
 * 为什么值得这么做：指令表（约 1 KB）只在触发时才有用，常驻会白占每一轮的提示词预算。
 *
 * ⚠️ 这是**单轮一次性标记**：`promptSections` 消费后立即删除，避免泄漏到后续轮次。
 */
const kokomiTurns = new Map();

/** 机器人自身身份缓存（用于判断"@ 的是不是我"）。 */
const selfInfo = { id: '', nickname: '', at: 0 };

/** 会话键上限：只保留最近这么多条，避免长跑进程里无界增长。 */
const MAX_TRACKED = 50;

/**
 * **触发时才注入**的提示词正文：指令表 + 翻译授权 + 防编造 + 兜底。
 *
 * 为什么不写进 `plugin.json` 的 prompt.sections：那是**常驻**片段，每一轮都会进提示词；
 * 而这一整段只在"本轮消息是 kokomi 指令"时才有用。放进这里由 `promptSections` 按需返回，
 * 常态下不占提示词预算。
 *
 * 三件事必须同时说清（少一件就会出问题）：
 *   1. **授权翻译** —— 不写，模型会倾向"原样转发"，自然语言直接变成服务端的「指令有误」；
 *   2. **禁止编造参数** —— 不写，模型可能为了把活干完而猜服务器/船名，等于输出错误战绩；
 *   3. **兜底路径** —— 听不懂时据实说查不了并引导看帮助图，而不是硬凑一个能跑的指令。
 */
const KOKOMI_PROMPT = [
  '本轮群友发的是 **Kokomi 战绩查询指令**。触发词后面的内容会交给 Kokomi 服务，服务把战绩渲染成图片返回；系统已自动附上真实结果。',
  '',
  '**你可以把自然语言翻译成 Kokomi 指令**（这是被允许的，不算"编造"）：群友不必背指令表。例如',
  '「帮我看看我最近的战绩」→ `me recent 7` ｜「查一下欧服的某人」→ `me eu <昵称>` ｜「大和这条船我打得怎么样」→ `me ship 大和`。',
  '拿不准时**先用最接近的写法调一次工具**，而不是反复追问。',
  '',
  '**但不许编造参数**：服务器、昵称、赛季、船名、筛选词都必须来自群友的原话，**绝不猜**。缺哪个就用一句话问清那一个（例如"哪个服？船名是？"），不要一次抛一堆问题。',
  '',
  '指令表（`<>` 必填，`[]` 可选）——服务端只认这些，翻译时要落到这张表上：',
  '- 查自己：`me` 总水表 ｜ `me info` 详细 ｜ `me oper` 行动 ｜ `me cw` 军团战 ｜ `me rank [赛季]` 排位 ｜ `me ship <船名>` 单船 ｜ `me ships <筛选词>` 船列表 ｜ `me [pvp/rank] recent [数量] [船名]` 近期（如 `me recent 7`、`me recent 30 大和`）｜ `me recents` 最近20场',
  '- 查别人：`me <服务器> <昵称>`（如 `me asia TestNotExist`），后面可接 `info` / `oper` / `cw` / `rank` / `ship <船名>` / `recent …`',
  '- 公会：`me clan [赛季]`、`me clan history`；公会历史等其他公会指令同上',
  '- 绑定与设置：`bind <服务器> <昵称>` 绑定 ｜ `me bind` 查绑定 ｜ `me lang <cn/en/ja>` 换语言 ｜ `me pr <hide/pr>` 开关评分 ｜ `me recent on` 启用近期记录',
  '- 服务器取值：`cn` `asia` `eu` `na` `ru`（服务端也认中文别名，但优先用英文）',
  '- 其它：`me online` 在线人数 ｜ `me stats` 服务端统计 ｜ `me search <筛选词>` 查可用筛选词 ｜ `help` 帮助图',
  '',
  '**指令表里没有的能力就别猜**：服务对不属于上表的写法会回「输入的指令或参数有误」。这种情况不要自己编一个能跑的指令，而是据实说"这条我可以帮你换成最接近的 X 来查"，或让群友发 `kokomi help` 看帮助图。',
  '',
  '服务返回文字时（例如未绑定：「请先绑定游戏账号，发送\'wws help\'可查询帮助文档」），注意那句里的 **wws 是上游服务自己的写法**，本插件里要换成 kokomi。你只需用一句话提醒他绑定（`kokomi bind <服务器> <昵称>`），不要原样照念含 wws 的整句。',
  '若同时出现 yuyuko 与 kokomi 两个数据源的结果，注意它们是**不同来源**，不要混在一起比较或相加。'
].join('\n');

/** 简单的 LRU 写入：超出上限时淘汰最旧的一条。 */
function remember(map, key, value) {
  if (!key) return;
  map.set(key, value);
  if (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/**
 * 从钩子/工具上下文里取会话键。
 *
 * @param {object} ctx 钩子上下文或工具 ctx。
 * @returns {string} 形如 `group:12345`；取不到时返回空串。
 * @remarks 钩子侧字段是 `chatKey`，工具侧是 `chatId` + `chatKey`；
 *   统一成一个函数，避免两处各写一套导致对不上。
 */
function sessionKeyOf(ctx) {
  const key = String(ctx?.chatKey ?? '').trim();
  if (key) return key;
  const chatId = String(ctx?.chatId ?? '').trim();
  return chatId ? `chat:${chatId}` : '';
}

/**
 * 从上下文中推断要上报给服务的标识。
 *
 * @param {object} ctx
 * @returns {{platformId: string, channelId: string}}
 */
function platformFor(ctx) {
  const chatId = String(ctx?.chatId ?? '').trim();
  const selfId = String(ctx?.selfId ?? selfInfo.id ?? '').trim();
  return { platformId: selfId || '0', channelId: chatId || '0' };
}

/**
 * 从一条消息里学习机器人自身身份（文本形如 `@昵称(QQ:机器人QQ)`）。
 *
 * **只学 QQ 号，绝不学昵称**：`@群友 kokomi me` 中同一位置是别人的名字，
 * 一旦记成机器人昵称，之后所有 `@那个群友` 都会被误判为"@ 了我"。
 *
 * @param {string} text 消息原文。
 * @param {string} [selfId] 调用方给的机器人 QQ（最可信）。
 * @returns {void}
 */
function learnSelfId(text, selfId) {
  const id = String(selfId ?? '').trim();
  if (id) {
    if (selfInfo.id !== id) selfInfo.id = id;
    selfInfo.at = Date.now();
    return;
  }
  if (selfInfo.id && Date.now() - selfInfo.at < 10 * 60 * 1000) return;
  if (!text) return;
  const parsed = extractMentions(String(text));
  const withQid = parsed.mentions.filter((m) => m.qid);
  if (withQid.length) {
    selfInfo.id = String(withQid[withQid.length - 1].qid);
    selfInfo.at = Date.now();
  }
}

/** 组装机器人自身可能的称呼，交给 `isBotMentioned` 判定。 */
function selfNames(ctx) {
  return [
    String(ctx?.selfId ?? ''),
    String(ctx?.selfNickname ?? ''),
    String(ctx?.botName ?? ''),
    selfInfo.id,
    selfInfo.nickname
  ].map((s) => String(s ?? '').trim()).filter(Boolean);
}

/**
 * 查询 Kokomi 服务并把图片下载好。
 *
 * @param {object} params
 * @param {string} params.command 触发词之后的正文。
 * @param {string} params.userId 触发者 ID。
 * @param {object} [params.ctx] 上下文（取 chatId / selfId）。
 * @returns {Promise<object>} 统一的查询结果对象。
 * @remarks 这里是**唯一**发起网络请求的地方：先拿结果，再按需下载图片。
 *   钩子路径与工具路径共用它，避免两处逻辑漂移。
 */
async function handleQuery({ command, userId, ctx = {} }) {
  const c = cfg();
  const { platformId, channelId } = platformFor(ctx);
  const started = Date.now();

  const result = {
    command,
    status: 'error',
    type: 'text',
    text: '',
    imageBase64: '',
    elapsedMs: 0,
    sent: false,
    sentInfo: null,
    image: null,
    oversized: false,
    upstreamKind: ''
  };

  try {
    const response = await queryKokomi({
      botUrl: c.botUrl,
      token: c.token,
      // 只传正文：`api.js` 负责拼上服务端认得的触发词前缀（upstreamKeyword）
      command,
      userId,
      platform: c.platform,
      platformId,
      channelId,
      upstreamKeyword: c.upstreamKeyword,
      timeoutMs: c.requestTimeoutMs
    });

    result.type = response.type;
    result.text = response.text;
    result.status = 'success';

    if (response.type === 'image' && response.imageUrl) {
      const { buffer, mime } = await downloadImage(response.imageUrl, {
        timeoutMs: c.downloadTimeoutMs,
        maxBytes: c.maxImageMB * 1048576
      });
      const image = await imageStore.saveImage(buffer, {
        mime,
        tag: `kokomi ${command}`,
        ttlSec: c.imageTtlSec
      });
      result.image = image;
    }
  } catch (error) {
    const kind = error instanceof ApiError ? error.kind : 'unknown';
    result.upstreamKind = kind;
    result.status = kind === 'timeout' ? 'error' : 'failed';
    // ApiError 的 message 已经是给用户看的中文说明
    result.text = error?.message ?? String(error);
    if (kind === 'image') {
      // 图出了但下载失败：服务端其实成功了，按失败告知并说明原因
      result.status = 'error';
    }
  }

  result.elapsedMs = Date.now() - started;
  if (c.debug) {
    // ⚠️ 日志里不要带 token：URL 会被拼进日志的话记得脱敏
    const size = result.image ? ` 图 ${Math.round(result.image.bytes / 1024)}KB` : ' 无图';
    log(`kokomi 查询完成："${command}" ${result.status} ${result.elapsedMs}ms${size}`);
  }
  return result;
}

/**
 * 把暂存图片接上本地图片服务（若启用），返回可直接交给发送队列的对象。
 *
 * @param {object} image `imageStore.saveImage` 的返回值。
 * @returns {object} 追加了 `url` 的图片对象。
 */
function attachImage(image) {
  if (!image) return image;
  if (cfg().serveImage && imageServer.currentBaseUrl()) {
    const url = imageServer.urlFor(image.token);
    if (url) imageStore.attachUrl(image.token, url);
  }
  return imageStore.getImage(image.token) || image;
}

/**
 * 自动发送渲染图（默认路径）。
 *
 * @param {object} ctx 工具/钩子上下文。
 * @param {object} image 图片对象（`attachImage` 之后）。
 * @returns {Promise<{ok: boolean, error?: string}|null>} 未发送时返回 `null`。
 * @remarks 必须走 `ctx.sender.sendImage` 而不是 `onebot.send*`：只有前者会经过
 *   发送队列的限频、去重与留档。三级回退顺序：本地文件 → 本地图片服务 URL → base64。
 */
async function autoSend(ctx, image) {
  const c = cfg();
  if (!c.autoSendImage || !image) return null;
  const sender = ctx?.sender;
  if (!sender || typeof sender.sendImage !== 'function') {
    warn('当前上下文没有 sender.sendImage，无法自动发图（已跳过）。');
    return { ok: false, error: 'no-sender' };
  }
  const chatKey = sessionKeyOf(ctx);
  const options = { note: 'kokomi 战绩图' };
  if (c.replyToTrigger && triggerMsg.has(chatKey)) options.replyToMessageId = triggerMsg.get(chatKey);
  if (c.atTriggerUser && triggerSender.has(chatKey)) options.atUserId = triggerSender.get(chatKey);

  const candidates = [];
  if (image.file) candidates.push({ file: image.file });
  if (image.url) candidates.push({ url: image.url });
  if (image.dataUrl) candidates.push({ dataUrl: image.dataUrl });

  for (const payload of candidates) {
    try {
      const info = await sender.sendImage(chatKey, payload, options);
      if (info && info.ok === false) return { ok: false, error: info.error || '发送失败' };
      return { ok: true, ...(info || {}) };
    } catch (error) {
      if (c.debug) log(`发图通道失败（${Object.keys(payload)[0]}）：${error?.message ?? error}`);
    }
  }
  return { ok: false, error: '所有发送通道都失败了' };
}

/**
 * 注册两个工具。
 *
 * @param {object} api 平台注入的 api 对象。
 * @returns {void}
 */
function registerTools(api) {
  api.registerTool({
    id: 'kokomi-query',
    name: 'Kokomi 战舰世界查询',
    // description 是模型判断"要不要调用"的唯一依据，必须同时写清"做什么"与"何时用"。
    // 这里明确授权"把自然语言翻译成指令"：群友不必背指令表，但参数（服务器/昵称/船名等）
    // 必须来自原话，不许猜。
    description:
      '查询战舰世界（World of Warships）玩家战绩，数据来自 Kokomi（与 yuyuko 不同的另一个数据源），'
      + '结果通常是一张渲染好的战绩长图。'
      + '【command 怎么填】填 Kokomi 指令（触发词之后的正文），不要带 kokomi 前缀。'
      + '群友用自然语言描述时，**由你翻译成正确指令**（这是允许的），例如'
      + '「小鲸鱼最近打得怎么样」→ command="me recent 7"；「查一下欧服的某人」→ command="me eu 某人"。'
      + '常用写法：command="me"（自己总水表，需先绑定）、"me info"/"me oper"/"me cw"/"me rank"、'
      + '"me ship 大和"（单船）、"me recent 7"（近期）、"me asia 昵称"（查别人）、'
      + '"me clan"（公会）、"bind asia 昵称"（绑定）、"help"（帮助图）。'
      + '【不许编造参数】服务器、昵称、赛季、船名必须来自群友原话；缺了就用一句话问清那一个，不要猜。'
      + '【什么时候用】群里有人用 kokomi 问战绩，或你判断需要 Kokomi 的数据来把话接下去。'
      + '返回的是真实结果，照它说即可，不要自己编。',
    category: 'query',
    icon: '🐟',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '触发词之后的正文（不含 kokomi 前缀），如 "me"、"recent"、"ship 大和"、"help"'
        },
        userId: {
          type: 'string',
          description: '可选：查询目标用户 ID。一般不用填，默认查触发者本人（服务端按 platform+user_id 查绑定）。'
        }
      },
      required: ['command']
    },
    /**
     * 执行查询。
     * @param {object} ctx 工具上下文（含 sender / chatKey）。
     * @param {{command?: string, userId?: string}} params
     * @returns {Promise<{content: string, isError?: boolean}>}
     */
    async execute(ctx, params = {}) {
      const command = String(params.command ?? '').trim();
      if (!command) {
        return { content: '缺少 command：请填 kokomi 后面的指令正文，例如 "me" 或 "help"。', isError: true };
      }
      const chatKey = sessionKeyOf(ctx);
      const userId = String(params.userId || triggerSender.get(chatKey) || ctx?.senderId || '').trim();
      if (!userId) {
        return {
          content: `拿不到查询目标 ID：请让群友直接发「@机器人 kokomi ${command}」，或显式传 userId。`,
          isError: true
        };
      }

      const result = await handleQuery({ command, userId, ctx });
      if (result.image) {
        attachImage(result.image);
        result.sentInfo = await autoSend(ctx, result.image);
        result.sent = result.sentInfo?.ok === true;
      }
      remember(lastResult, chatKey, result);
      return { content: formatResultText(result), isError: result.status === 'error' };
    }
  });

  api.registerTool({
    id: 'kokomi-send-image',
    name: '发送 Kokomi 战绩图',
    description:
      '把最近一次 Kokomi 查询得到的战绩图发到当前聊天。'
      + '只在结果里写着「渲染图尚未发送」时才需要调用；已自动发出时不要重复调用（会被去重拦下）。',
    category: 'media',
    icon: '🖼️',
    parameters: { type: 'object', properties: {} },
    /**
     * 补发最近一次查询的图片。
     * @param {object} ctx 工具上下文。
     * @returns {Promise<{content: string, isError?: boolean}>}
     */
    async execute(ctx) {
      const chatKey = sessionKeyOf(ctx);
      const last = lastResult.get(chatKey);
      if (!last?.image) {
        return { content: '还没有可发送的 Kokomi 战绩图 —— 先用 kokomi-query 查一次。', isError: true };
      }
      attachImage(last.image);
      const info = await autoSend(ctx, last.image);
      if (info?.ok) {
        last.sent = true;
        last.sentInfo = info;
        return { content: '战绩图已发出。' };
      }
      return { content: `战绩图发送失败：${info?.error || '未知原因'}`, isError: true };
    }
  });
}

/**
 * 插件入口：绑定配置、起图片服务、注册工具与钩子。
 *
 * @param {object} api 平台注入的 api 对象。
 * @returns {void}
 */
export function setup(api) {
  log = (...a) => api.log(...a);
  warn = (...a) => api.warn(...a);
  bindConfig(api.config);
  imageServer.setLog((m) => api.log(m));
  registerTools(api);

  api.log('已加载：@机器人 kokomi 指令将直接交给 Kokomi 服务查询出图（纯 Node，无需本地 Python）');

  const c = cfg();
  if (!c.botUrl) {
    api.warn('还没填「Kokomi 服务地址」—— 请在插件设置里填写。');
  }

  // 起本地图片服务（失败仅降级，不影响功能）
  if (c.serveImage) {
    imageServer.start({
      host: c.imageServerHost,
      port: c.imageServerPort,
      ttlSec: c.imageTtlSec
    }).then((url) => {
      if (!url) api.warn('图片服务未能启动，已退回文件/base64 通道（功能仍可用）。');
    }).catch(() => {});
  }

  // 探活：只影响提示语，不阻塞加载。
  // ⚠️ 这里用 help 而不是 me：me 需要绑定，探活不该依赖用户状态。
  apiPing({ botUrl: c.botUrl, token: c.token, timeoutMs: 15000 })
    .then((res) => {
      if (!res.ok) {
        if (res.kind === 'unconfigured') {
          api.warn(`Kokomi 服务拒绝了口令：${c.botUrl} —— 请核对设置里的「访问口令」。`);
        } else {
          api.warn(`Kokomi 服务探活失败：${res.error}（${c.botUrl}）`);
        }
      } else {
        api.log(`Kokomi 服务连接正常（探活返回 ${res.type}）。`);
      }
    })
    .catch(() => {});
}

/** 停用时的清理：关图片服务、清暂存，避免留下孤儿文件与端口。 */
export async function deactivate() {
  await imageServer.stop();
  imageStore.clearAll();
  triggerMsg.clear();
  triggerSender.clear();
  lastResult.clear();
  kokomiTurns.clear();
}

/**
 * 钩子导出的可用性判定。必须**同步**返回，这里乐观放行
 * （真正的门槛在认领逻辑里）。
 *
 * @returns {{ok: boolean}}
 */
export function available() {
  return { ok: true };
}

/**
 * 动态提示词片段：**只在本轮是 kokomi 指令时**注入指令表。
 *
 * 调用时机由核心决定：每次运行先跑 `before-context` 钩子、再组装系统提示词
 * （`src/orchestrator.js`），而这里由 `src/skills/manager.js` 的
 * `getPromptSections(context)` 调用。因此钩子里的标记对本函数可见。
 *
 * @param {{chatKey?: string, kind?: string}} [context] 核心传入的会话上下文。
 *   ⚠️ 它**不含** `triggerEntries`，所以不能靠读消息文本判断，只能靠钩子留的标记。
 * @returns {Array<{id: string, title: string, content: string, priority: number}>}
 *   命中时返回恰好一个片段；否则返回空数组（= 常态下不占提示词预算）。
 * @remarks 标记是**单轮一次性**的：这里消费后立即删除，避免泄漏到后续轮次。
 *   若同一轮有多条消息触发，钩子写同一个键，这里仍然只注入一次。
 */
export function promptSections(context = {}) {
  const key = String(context?.chatKey ?? '');
  if (!key) return [];
  if (!kokomiTurns.has(key)) return [];
  kokomiTurns.delete(key);   // 一次性：本轮注入过就不再重复
  return [{
    id: 'kokomi-helper-command-table',
    title: '战舰世界（kokomi）指令',
    content: KOKOMI_PROMPT,
    // 比常驻片段（61）略低：常驻的结论约束先讲，再讲怎么翻译
    priority: 58
  }];
}

/** 钩子集合：只提供一个 `before-context`，做确定性认领。 */
export const hooks = {
  /**
   * 在上下文组装前认领 kokomi 指令。
   *
   * 命中时**不替换原文**，只把「【kokomi 指令已认领】+ 发起人 + 指令 + 该调哪个工具」
   * 追加到该条消息后面；真正的查询由模型调用 `kokomi-query` 工具完成。
   *
   * @param {object} context 钩子上下文。
   * @returns {Promise<void>}
   */
  async 'before-context'(context) {
    const entries = Array.isArray(context?.triggerEntries) ? context.triggerEntries : [];
    if (!entries.length) return;
    const c = cfg();
    const chatKey = sessionKeyOf(context);

    for (const entry of entries) {
      const text = String(entry?.text ?? '');
      if (!text) continue;

      // 先学习机器人身份（判定"@ 的是不是我"要用它）
      learnSelfId(text, context?.selfId);

      const hit = matchTrigger(text, c.triggerKeywords, {
        requireAt: c.requireAt,
        selfNames: selfNames(context)
      });
      if (!hit.matched) {
        // 判定失败只在 debug 日志里记录：群里聊到 kokomi 是常态，
        // 每次不命中都打日志会把真正有用的信息淹掉。
        if (c.debug) log(`未认领（${hit.reason}）：${text.slice(0, 60)}`);
        continue;
      }

      const senderId = String(entry?.senderId ?? entry?.userId ?? '').trim();
      if (senderId) remember(triggerSender, chatKey, senderId);
      if (entry?.id !== undefined && entry?.id !== null) remember(triggerMsg, chatKey, entry.id);

      // 标记"本轮有 kokomi 指令"，供 promptSections 决定是否注入指令表。
      // 必须在钩子里做：promptSections 拿不到 triggerEntries，只有 chatKey。
      if (chatKey) remember(kokomiTurns, chatKey, true);

      const cmd = hit.command || '';
      const note = [
        '',
        '',
        '【kokomi 指令已认领】',
        senderId ? `发起人：${String(entry?.senderName ?? '') || '未知'}（QQ:${senderId}）` : '发起人：未知',
        `指令：kokomi ${cmd || 'help'}（Kokomi 数据源，与 yuyuko 不同）`,
        `请立刻调用 kokomi-helper__kokomi-query 工具执行它（command="${cmd || 'help'}"，不要带 kokomi 前缀），`,
        '必要时把 userId 传成上面的发起人 QQ。这个工具会真实查询并自动把战绩图发到群里，',
        '通常几秒；在它返回之前，不要凭印象说这条数据或结果。'
      ].join('\n');
      entry.text = `${text}${note}`;
      if (c.debug) log(`已认领：kokomi ${cmd || '(help)'}`);
    }
  }
};
