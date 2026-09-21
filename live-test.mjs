// kokomi-helper · 对真实服务的端到端验证
// ======================================
//
// 用法：
//   node live-test.mjs                       # 只跑服务可达性验证（不需要绑定）
//   node live-test.mjs <已绑定的user_id>      # 额外验证真实查询与图片下载
//
// 为什么需要传 user_id：Kokomi 的绑定关系存在**服务端**，按 platform + user_id 索引。
// 用一个没绑定过的 ID 调 `me`，服务端只会回一句「请先绑定游戏账号…」——那不是故障，
// 所以第 3、4 项在未传 ID 时会跳过而不是判失败。
//
// 本文件不含任何真实账号：默认的 user_id 是占位符。
import {
  queryKokomi,
  downloadImage,
  apiPing,
  buildQueryUrl,
  sniffImageMime,
  ApiError
} from './lib/api.js';

const BOT_URL = process.env.KOKOMI_BOT_URL || 'http://43.133.59.53:8000/bot/';
const TOKEN = process.env.KOKOMI_TOKEN || 'user';
// 命令行参数优先；不传则跳过"需要绑定"的两项
const USER_ID = String(process.argv[2] || '').trim();

let pass = 0, fail = 0, skipped = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  [跳过] ${name}${why ? '  —— ' + why : ''}`); };

console.log(`服务地址：${BOT_URL}`);
console.log(`user_id ：${USER_ID || '(未提供，将跳过需要绑定的用例)'}\n`);

console.log('— 1. URL 拼装 —');
{
  const u = buildQueryUrl(BOT_URL, { token: TOKEN, message: 'wws me', platform: 'qq_bot', user_id: '1' });
  check(u.startsWith(`${BOT_URL}?`), '以 ? 开头拼查询串');
  check(u.includes('message=wws%20me'), 'message 被正确编码', u.slice(0, 80));
  check(u.includes(`token=${TOKEN}`), 'token 走查询参数（不是请求头）');
  const u2 = buildQueryUrl(BOT_URL, { a: '1', b: '', c: null, d: undefined });
  check(!u2.includes('b=') && !u2.includes('c=') && !u2.includes('d='), '空值参数被剔除');
}

console.log('\n— 2. 探活（help，不需要绑定）—');
{
  const res = await apiPing({ botUrl: BOT_URL, token: TOKEN, timeoutMs: 30000 });
  check(res.ok === true, '探活成功', JSON.stringify(res));
}

console.log('\n— 3. 真实查询 wws me —');
let imageUrl = '';
if (!USER_ID) {
  skip('真实查询', '未提供 user_id；用法：node live-test.mjs <已绑定的user_id>');
} else {
  try {
    const res = await queryKokomi({ botUrl: BOT_URL, token: TOKEN, command: 'me', userId: USER_ID, timeoutMs: 90000 });
    if (res.type === 'image') {
      check(!!res.imageUrl, '返回图片类型且带地址');
      imageUrl = res.imageUrl;
      console.log(`         图片地址: ${imageUrl}`);
    } else {
      // 服务端把"没绑定"也归为正常文字结果，这时不该判失败，而是提示换 ID
      skip('真实查询', `该 user_id 在服务端未绑定，返回文字：${res.text.slice(0, 40)}`);
    }
  } catch (e) {
    check(false, '查询 wws me', `${e.name}: ${e.message}`);
  }
}

console.log('\n— 4. 下载图片并验证是真实图片 —');
{
  if (!imageUrl) { skip('下载图片', '没有图片地址（见上一项）'); }
  else {
    try {
      const { buffer, mime } = await downloadImage(imageUrl, { timeoutMs: 60000, maxBytes: 12 * 1048576 });
      check(buffer.length > 10_000, '下载到非空图片', `${(buffer.length / 1024).toFixed(0)} KB`);
      check(mime === 'jpeg' || mime === 'png', '格式识别正确', mime);
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      check(isJpeg || isPng, '魔数确认为真实图片', isJpeg ? 'JPEG' : 'PNG');
      check(sniffImageMime(buffer, '') !== null, 'sniffImageMime 可用');
    } catch (e) {
      check(false, '下载图片', `${e.name}: ${e.message}`);
    }
  }
}

console.log('\n— 5. 文字结果路径（无效指令，不需要绑定）—');
{
  try {
    const res = await queryKokomi({
      botUrl: BOT_URL, token: TOKEN, command: '不存在的指令',
      userId: USER_ID || '1000000001', timeoutMs: 60000
    });
    check(res.type === 'text', '返回类型为 text', res.type);
    check(res.text.length > 0, '带文字内容', res.text.slice(0, 40));
    check(!res.imageUrl, '文字结果不带图片');
  } catch (e) {
    check(false, '文字结果路径', `${e.name}: ${e.message}`);
  }
}

console.log('\n— 6. 口令错误要能识别 —');
{
  try {
    await queryKokomi({
      botUrl: BOT_URL, token: 'definitely-wrong-token', command: 'help',
      userId: USER_ID || '1000000001', timeoutMs: 30000
    });
    check(false, '错口令应当抛错');
  } catch (e) {
    check(e instanceof ApiError, '抛出的是 ApiError', e.name);
    check(e.kind === 'unconfigured', '归类为 unconfigured（引导去改设置）', e.kind);
    check(/口令|Token/i.test(e.message), '提示语提到口令', e.message);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败${skipped ? `，${skipped} 跳过` : ''}`);
if (skipped) console.log('（跳过的项需要传入一个在服务端已绑定的 user_id）');
process.exit(fail ? 1 : 0);
