/**
 * kokomi-helper · 本地逻辑自检（不碰网络、不起外部服务）
 * ====================================================
 *
 * 用法：node selfcheck.mjs
 *
 * 覆盖四块最容易悄悄坏掉的地方：
 *   1. 触发判定（@机器人 + 触发词在最前，两个条件缺一不可）
 *   2. 与 yuyuko 插件的隔离（互不认领）
 *   3. 服务调用契约（URL 拼装、响应归一化、口令被拒的识别）
 *   4. 清单与默认值的一致性（plugin.json ↔ lib/config.js）
 *
 * 为什么不在这里打真网络：本文件要求"随时可跑、不需要服务"。
 * 真服务的连通性验证放在 `live-test.mjs`（可选，会访问网络）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractMentions, isBotMentioned, matchTrigger } from './lib/trigger.js';
import { DEFAULTS, bindConfig, cfg } from './lib/config.js';
import { buildContextNote, clip, formatResultText } from './lib/format.js';
import {
  ApiError,
  buildQueryUrl,
  isTokenRejected,
  queryKokomi,
  sniffImageMime
} from './lib/api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(HERE, 'plugin.json'), 'utf8'));

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  try {
    assert.deepEqual(actual, expected);
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}
function ok(cond, name) {
  eq(!!cond, true, name);
}

const BOT = { selfNames: ['机器人', '小鲸鱼', '1'] };
const KW = DEFAULTS.triggerKeywords;

console.log('— @提及 解析 —');
eq(extractMentions('@机器人(QQ:1) kokomi me').mentions, [{ name: '机器人', qid: '1', raw: '@机器人(QQ:1)' }], '带 QQ 后缀');
eq(extractMentions('@老八(开黑) kokomi me').mentions[0].qid, null, '括号群名片不算 QQ 后缀');
eq(extractMentions('@A @B kokomi me').mentions.length, 2, '连续 @ 多人');

console.log('\n— 是否 @ 了机器人 —');
ok(isBotMentioned('@机器人(QQ:1) kokomi me', BOT.selfNames), '按 QQ 号命中');
ok(isBotMentioned('@小鲸鱼 kokomi me', BOT.selfNames), '按人设名命中（无 QQ 后缀）');
ok(!isBotMentioned('@老八(QQ:123) kokomi me', BOT.selfNames), '别人的 QQ 不算');
ok(!isBotMentioned('@机器人(QQ:999) kokomi me', BOT.selfNames), '同名但 QQ 不同 → 不算');
ok(isBotMentioned('[CQ:at,qq=1] kokomi me', BOT.selfNames), 'CQ 码兜底');

console.log('\n— 触发判定：@ + 触发词两个条件（AND）—');
eq(matchTrigger('@机器人(QQ:1) kokomi me', KW, BOT).matched, true, '@机器人 + kokomi → 认领');
eq(matchTrigger('@机器人(QQ:1) kokomi me', KW, BOT).command, 'me', '提取指令正文');
eq(matchTrigger('@机器人(QQ:1) kokomi ship 大和 recent 30', KW, BOT).command, 'ship 大和 recent 30', '多词指令完整保留');
eq(matchTrigger('kokomi me', KW, BOT).matched, false, '没 @ 机器人 → 严格不认领');
eq(matchTrigger('kokomi me', KW, BOT).reason, '没有 @ 机器人', '给出"没 @ 机器人"的原因');
eq(matchTrigger('@老八(QQ:123) kokomi me', KW, BOT).matched, false, '@ 的是别人 → 不认领');
eq(matchTrigger('@机器人(QQ:1) 用 kokomi 查一下', KW, BOT).matched, false, '触发词不在最前 → 不认领（宁可不触发）');
eq(matchTrigger('@机器人(QQ:1) KOKOMI me', KW, BOT).command, 'me', '大小写不敏感');
eq(matchTrigger('@机器人(QQ:1) kokomi：大和', KW, BOT).command, '大和', '中文冒号分隔');
eq(matchTrigger('@机器人(QQ:1) kokomi', KW, BOT).command, '', '只有触发词 → 空指令（走帮助）');

console.log('\n— 与 yuyuko 插件的隔离（互不认领）—');
eq(matchTrigger('@机器人(QQ:1) yuyuko me', KW, BOT).matched, false, 'yuyuko 不被本插件认领');
eq(matchTrigger('@机器人(QQ:1) wws me', KW, BOT).matched, false, 'wws 不被本插件认领');
eq(matchTrigger('@机器人(QQ:1) kokomi me', ['yuyuko'], BOT).matched, false, 'kokomi 不会被 yuyuko 的触发词认领');

console.log('\n— requireAt 关闭时的行为 —');
eq(matchTrigger('kokomi me', KW, { requireAt: false }).matched, true, '无需 @ 也能认领');
eq(matchTrigger('@队友 kokomi me', KW, { requireAt: false }).command, 'me', '关闭后不看 @ 的是谁');

console.log('\n— 服务调用：URL 拼装 —');
{
  const base = 'http://host:8000/bot/';
  const u = buildQueryUrl(base, { token: 'user', message: 'wws me', platform: 'qq_bot', user_id: '1' });
  ok(u.startsWith(`${base}?`), '用 ? 拼查询串');
  ok(u.includes('message=wws%20me'), '空格被编码为 %20（不能是 + 或裸空格）');
  ok(u.includes('token=user'), 'token 走查询参数');
  const u2 = buildQueryUrl(base, { a: '1', b: '', c: null, d: undefined });
  eq(u2, `${base}?a=1`, '空值/未定义参数被剔除');
  const u3 = buildQueryUrl('http://h/bot', { a: '1' });
  eq(u3, 'http://h/bot?a=1', '无尾斜杠时也能正确拼接');
  ok(buildQueryUrl('http://h/bot?x=1', { a: '2' }).includes('?x=1&a=2'), '已有 query 时用 & 续接');
  ok(buildQueryUrl(base, { m: '大和' }).includes('m=%E5%A4%A7%E5%92%8C'), '中文被正确编码');
}

console.log('\n— 服务调用：口令被拒的识别 —');
ok(isTokenRejected({ type: 'msg', msg: 'Token unavailable' }), '识别 Token unavailable');
ok(!isTokenRejected({ type: 'msg', msg: '请先绑定游戏账号' }), '正常文字不被误判');
ok(!isTokenRejected({ type: 'img', img: 'http://x/y.jpg' }), '图片响应不被误判');
ok(!isTokenRejected(null), '空响应不抛异常');

console.log('\n— 服务调用：未配置地址直接报错（不打网络）—');
{
  let threw = null;
  try {
    await queryKokomi({ botUrl: '', token: 'x', command: 'me', userId: '1' });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof ApiError, '抛出 ApiError');
  eq(threw?.kind, 'unconfigured', '归类为 unconfigured');
  ok(/服务地址/.test(threw?.message ?? ''), '提示语提到服务地址');
}

console.log('\n— 图片格式嗅探 —');
eq(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ''), 'jpeg', 'JPEG 魔数');
eq(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]), ''), 'png', 'PNG 魔数');
eq(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38]), ''), 'gif', 'GIF 魔数');
eq(sniffImageMime(Buffer.from('RIFF....WEBP', 'ascii'), ''), 'webp', 'WEBP 魔数');
eq(sniffImageMime(Buffer.from([1, 2, 3]), ''), 'jpeg', '无法判定时回退 jpeg');
eq(sniffImageMime(Buffer.from([1]), 'image/png'), 'png', 'content-type 优先');

console.log('\n— 清单与默认值一致性 —');
eq(manifest.id, 'kokomi-helper', 'plugin.json id');
eq(manifest.settings.triggerKeywords, DEFAULTS.triggerKeywords, 'config.js 与 plugin.json 的 triggerKeywords 一致');
{
  const a = Object.keys(DEFAULTS).sort();
  const b = Object.keys(manifest.settings).sort();
  eq(a, b, 'DEFAULTS 与 settings 键集合完全相同');
  const missingSchema = Object.keys(manifest.settings).filter((k) => !(k in manifest.configSchema));
  eq(missingSchema, [], '每个设置项都有 configSchema');
  const extraSchema = Object.keys(manifest.configSchema).filter((k) => !(k in manifest.settings));
  eq(extraSchema, [], 'configSchema 里没有多余项');
}
eq(manifest.settings.triggerKeywords, ['kokomi'], '触发词只有 kokomi');
eq(manifest.settings.imageServerPort, 32802, '图片服务端口与 yuyuko 插件（32801）错开');
eq(manifest.settings.platform, 'qq_bot', '默认平台');
eq(manifest.settings.upstreamKeyword, 'wws', '发给服务的触发词前缀（上游写法）');
ok(!('bridgeUrl' in manifest.settings), '纯 Node 化后不再有「桥接服务地址」设置');
ok(!('kokomiApiUsername' in manifest.settings), '不再有 v4 的接口用户名设置');

console.log('\n— 自然语言 → 指令 的翻译能力（触发时才注入）—');
{
  // 这条能力靠三处共同实现，缺一处就失效：
  //   ① plugin.json 的常驻片段：只留"结论约束"（哪块是真的 / 别重复发图）
  //   ② index.js 的 KOKOMI_PROMPT：完整指令表 + 翻译授权 + 防编造 + 兜底（触发时才注入）
  //   ③ 工具 description：模型选工具时只读它，必须有翻译提示
  const staticSection = manifest.prompt.sections[0].content;
  const src = readFileSync(path.join(HERE, 'index.js'), 'utf8');

  // ① 常驻片段应当"瘦"：指令表不该常驻
  ok(staticSection.length < 600, `常驻片段足够短（${staticSection.length} 字符）`);
  ok(!staticSection.includes('me recent'), '常驻片段不再包含指令表');
  ok(staticSection.includes('kokomi'), '常驻片段仍说明触发词含义');
  ok(/只有【kokomi 查询结果】/.test(staticSection), '常驻片段保留"数字照抄"硬规则');

  // ② 动态片段（在 index.js 里）必须包含完整的翻译要素
  for (const k of ['me info', 'me oper', 'me cw', 'me rank', 'me ship', 'me recent', 'me recents', 'me clan', 'bind']) {
    ok(src.includes(`\`${k}`), `动态指令表含分支：${k}`);
  }
  ok(src.includes('me <服务器> <昵称>'), '含"查别人"的写法');
  ok(src.includes('服务器取值'), '含服务器取值说明');
  ok(/翻译成 Kokomi 指令/.test(src), '明确授权翻译');
  ok(/绝不猜/.test(src), '明确禁止编造参数');
  ok(src.includes('帮助图'), '给出"看帮助图"的兜底路径');
  ok(/不要自己编一个能跑的指令/.test(src), '要求听不懂时据实说而非硬凑');

  // ③ 工具描述
  ok(/由你翻译成正确指令/.test(src), '工具描述里说明了可翻译');
  ok(/command="me recent 7"/.test(src), '工具描述给出了翻译示例');
  ok(/不许编造参数/.test(src), '工具描述里有防编造约束');
}

console.log('\n— 动态提示词片段：只在触发那一轮注入 —');
{
  const plugin = await import(pathToFileURL(path.join(HERE, 'index.js')).href);
  const tools = new Map();
  const settings = { ...manifest.settings };
  const api = {
    config: () => ({ ...settings }),
    registerTool: (d) => { tools.set(d.id, d); return d.id; },
    log: () => {}, warn: () => {}, error: () => {}
  };
  plugin.setup(api);
  const ctxKey = 'group:selftest-dyn';

  // 没触发 → 不该注入（这是省提示词预算的关键）
  eq(plugin.promptSections({ chatKey: ctxKey }), [], '未触发时不注入任何片段');
  eq(plugin.promptSections({}), [], '没有 chatKey 时安全返回空');

  // 触发 → 注入一段，且内容是指令表
  const entry = { id: 1, senderId: '1000000001', senderName: '老八', text: '@机器人(QQ:2) kokomi me recent' };
  await plugin.hooks['before-context']({
    triggerEntries: [entry], store: {}, memory: {},
    chatKey: ctxKey, chatId: '1', selfId: '2', selfNickname: '机器人'
  });
  ok(entry.text.includes('【kokomi 指令已认领】'), '钩子已认领');

  const dyn = plugin.promptSections({ chatKey: ctxKey });
  eq(dyn.length, 1, '触发后注入恰好一个片段');
  ok(dyn[0]?.id === 'kokomi-helper-command-table', '片段 id 正确', dyn[0]?.id);
  ok(String(dyn[0]?.content ?? '').includes('me recent'), '注入的片段含指令表');
  ok(/绝不猜/.test(String(dyn[0]?.content ?? '')), '注入的片段含防编造约束');
  ok(Number(dyn[0]?.priority) > 0 && Number(dyn[0]?.priority) < 99, 'priority 在安全上限内');

  // 一次性：消费后不应再注入（避免泄漏到后续轮次）
  eq(plugin.promptSections({ chatKey: ctxKey }), [], '同一会话第二次调用不再注入（单轮一次性）');

  // 未触发的会话始终为空
  eq(plugin.promptSections({ chatKey: 'group:other' }), [], '其他会话不受影响');

  // 未命中触发判定时也不该注入
  const noAt = { id: 2, senderId: '1000000001', senderName: '老八', text: 'kokomi me' };
  await plugin.hooks['before-context']({
    triggerEntries: [noAt], store: {}, memory: {},
    chatKey: 'group:noat', chatId: '1', selfId: '2', selfNickname: '机器人'
  });
  eq(plugin.promptSections({ chatKey: 'group:noat' }), [], '没 @ 机器人时不注入片段');

  await plugin.deactivate?.();
}

console.log('\n— 配置读取与规整 —');
bindConfig(() => ({
  triggerKeywords: ['@Kokomi ', ''],
  botUrl: 'http://127.0.0.1:9999/bot///',
  requestTimeoutMs: 99999999,
  downloadTimeoutMs: -5,
  imageServerPort: -5,
  platform: '不存在的平台',
  autoSendImage: 'false'
}));
{
  const c = cfg();
  eq(c.triggerKeywords, ['kokomi'], '触发词去掉 @ 与空白、转小写、剔空');
  eq(c.botUrl, 'http://127.0.0.1:9999/bot', 'botUrl 去掉尾部斜杠');
  eq(c.requestTimeoutMs, 300000, '超时被夹到上限');
  eq(c.downloadTimeoutMs, 3000, '下载超时被夹到下限');
  eq(c.imageServerPort, 1, '端口被夹到下限');
  eq(c.platform, 'qq_bot', '非法平台回退默认');
  eq(c.autoSendImage, false, '字符串 false 被识别为布尔 false');
}
bindConfig(() => ({}));
// 注意：cfg() 会去掉尾部斜杠，所以这里不能直接和 DEFAULTS.botUrl 比字符串
eq(cfg().botUrl, DEFAULTS.botUrl.replace(/\/+$/, ''), '配置为空时回退 DEFAULTS（已规整）');
ok(!cfg().botUrl.endsWith('/'), '规整后不带尾部斜杠');
ok(DEFAULTS.botUrl.endsWith('/'), 'DEFAULTS 里的地址保留斜杠（对用户更直观）');
ok(manifest.settings.botUrl === DEFAULTS.botUrl, 'manifest 与 DEFAULTS 的 botUrl 完全一致');
bindConfig(null);
eq(cfg().token, 'user', '未绑定配置时仍可用（回退 DEFAULTS）');

console.log('\n— 文本组装：图片结果 —');
{
  const note = buildContextNote({ command: 'me', result: { status: 'success', type: 'image', sent: true } });
  ok(note.includes('【kokomi 查询结果】'), '带结果抬头');
  ok(note.includes('渲染图已由插件自动发出'), '说明图已发出');
  // 注意：已发出时那句话本身会提到 kokomi-send-image（"不要再调用…"），
  // 所以必须检查**带插件前缀的工具全名**，否则断言恒真、等于没测。
  ok(!note.includes('kokomi-helper__kokomi-send-image'), '已自动发出时不指向发送工具');
}
{
  const note = buildContextNote({
    command: 'me',
    result: { status: 'success', type: 'image', sent: false },
    autoSendImage: false
  });
  ok(note.includes('渲染图尚未发送'), '未发送时明确告知');
  ok(note.includes('kokomi-helper__kokomi-send-image'), '未发送时给出工具名');
}
{
  const note = buildContextNote({ command: 'me', result: { status: 'success', type: 'image', oversized: true } });
  ok(note.includes('超过体积上限'), '超限时说明原因');
}

console.log('\n— 文本组装：文字结果与失败 —');
{
  const note = buildContextNote({ command: 'me', result: { status: 'success', type: 'text', text: '请先绑定账号' } });
  ok(note.includes('请先绑定账号'), '业务提示被注入');
  ok(note.includes('正常业务结果'), '标记为正常业务结果（不是失败）');
}
{
  const note = buildContextNote({
    command: 'me',
    result: { status: 'error', type: 'text', text: '连不上服务', upstreamKind: 'offline' }
  });
  ok(note.includes('连不上服务'), '失败原因透传');
  ok(note.includes('不要编造成绩'), '提示不要编造');
}
{
  const note = buildContextNote({
    command: 'recent',
    result: { status: 'error', type: 'text', text: '超时', upstreamKind: 'timeout' }
  });
  ok(note.includes('超时'), '超时被识别');
}
{
  const long = 'x'.repeat(5000);
  const note = buildContextNote({
    command: 'me',
    result: { status: 'success', type: 'text', text: long },
    maxChars: 100
  });
  ok(note.includes('已截断'), '超长文字被截断并留标记');
  ok(note.length < 500, '截断确实生效');
}

console.log('\n— 截断工具与工具返回文本 —');
eq(clip('abc', 100), 'abc', '未超长时原样返回');
ok(clip('x'.repeat(3000), 100).includes('已截断'), '超长时加截断标记');
ok(formatResultText({ command: 'me', status: 'success', type: 'image', sent: true }).includes('已发给当前聊天'), '工具文本说明已发送');
ok(formatResultText({ command: 'me', status: 'failed', type: 'text', text: '查不到该玩家' }).includes('查不到该玩家'), '失败文案透传');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
