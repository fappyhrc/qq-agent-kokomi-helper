/**
 * kokomi-helper · 面向模型的文本组装
 * ==================================
 *
 * 与 yuyuko 插件的同类模块原则一致，但结果形状不同：Kokomi 的产物**主要是一张图**，
 * 文字只在"业务失败/需要引导"时出现。因此这里的重点是：
 *
 * 1. **图片状态必须说清**：模型看不到图片内容。若不告诉它"已发出 / 未发送"，
 *    它要么重复发送，要么对图片只字不提。
 * 2. **区分业务提示与真失败**：Kokomi 未绑定时会回一张"请先绑定"的提示图，
 *    这属于正常业务返回，措辞要引导用户按图绑定，而不是报"查询失败"。
 * 3. **长度必须有上限**：上游偶发长文本，按 `contextTextMaxChars` 截断并留可见标记。
 */

/**
 * 安全截断：超长时截断并附上可见标记。
 *
 * @param {string} text 原始文本。
 * @param {number} max 最大字符数（内部下限 50）。
 * @returns {string} 截断后的文本；未超长时原样返回。
 * @remarks 截断标记不可省：否则模型会以为"内容就这么多"，进而给出错误结论。
 */
export function clip(text, max) {
  const s = String(text ?? '');
  const n = Math.max(50, Number(max) || 1600);
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…（内容过长已截断）`;
}

/**
 * 把一次查询结果写成注入上下文的块。
 *
 * 输出形如：
 *   【kokomi 查询结果】
 *   指令：kokomi me ｜ 状态：查询成功
 *   渲染图已由插件自动发出（不要在正文里说"我没看到图"，也不要用发送工具重复发送）。
 *
 * @param {object} params
 * @param {string} params.command 触发词之后的正文。
 * @param {object} params.result `handleQuery` 的返回值。
 * @param {boolean} [params.autoSendImage=true] 是否已自动发图。
 * @param {number} [params.maxChars=1600] 注入文字上限。
 * @param {boolean} [params.includeText=true] 是否注入文字。
 * @returns {string} 形如 `【kokomi 查询结果】…` 的纯文本块。
 */
export function buildContextNote({
  command,
  result,
  autoSendImage = true,
  maxChars = 1600,
  includeText = true
} = {}) {
  const status = String(result?.status ?? 'error');
  const cmd = String(command ?? '').trim();
  const lines = ['【kokomi 查询结果】', `指令：kokomi ${cmd || '帮助'} ｜ 状态：${statusHint(status)}`];
  // 标明"查的是谁"。图是自动发的、图上不写归属，不标的话"查错水表"在群里看不出来。
  // 也用一句话把"查的是别人"和"查的是自己"区分开，避免模型把两者的数据说混。
  const who = String(result?.queriedUserId ?? '').trim();
  if (who) {
    lines.push(result?.queriedFromTrigger === false
      ? `查询主体：QQ ${who}（不是触发者本人，请别当成"你/他"自己的数据）`
      : `查询主体：触发者本人（QQ ${who}）`);
  }

  if (status === 'success' && result?.type === 'image') {
    lines.push('本次结果是**图片**（战绩长图），图上已有全部数字。');
    if (result?.sent || result?.sentInfo?.ok) {
      lines.push('渲染图已由插件自动发出（走的是发送队列）。不要再调用 kokomi-send-image '
        + '重复发送同一张图，也不要说"我看不到图"。');
    } else if (result?.oversized) {
      lines.push('渲染图超过体积上限，本次没有发送。据实说明即可。');
    } else if (result?.sentInfo && result.sentInfo.ok === false) {
      lines.push(`渲染图发送失败：${result.sentInfo.error}。可以再调一次 kokomi-send-image 重试。`);
    } else {
      lines.push('渲染图尚未发送。需要发图就调用 kokomi-helper__kokomi-send-image 工具'
        + '（同一张图只会发一次，重复调用会被去重拦下）。');
    }
    lines.push('接话要求：可以只点评一两句，也可以只发图；不要逐行念图上数字。');
    return lines.join('\n');
  }

  // 文字结果：Kokomi 的业务提示（未绑定、查不到玩家）与真失败都走这里
  const text = String(result?.text ?? '').trim();
  if (status === 'success') {
    lines.push('上游没有出图，返回的是文字提示（属正常业务结果）：');
    lines.push(includeText && text ? clip(text, maxChars) : '（按设置本次不注入文字内容）');
    lines.push('据实转达即可；若提示需要绑定，就用一句话告诉群友按图/按提示里的写法绑定。');
    return lines.join('\n');
  }

  lines.push(`结果：${clip(text || '上游没有给出说明', 800)}`);
  if (result?.upstreamKind === 'timeout') {
    lines.push('这次是超时。可以告诉群友稍后再试，不要编造成绩。');
  } else {
    lines.push('这条指令这次没查到东西。据实说明即可，不要编造成绩。');
  }
  return lines.join('\n');
}

/**
 * 把一次查询结果写成工具返回文本（比上下文块多了"下一步该做什么"）。
 *
 * @param {object} result `handleQuery` 的返回值。
 * @returns {string}
 */
export function formatResultText(result) {
  const status = String(result?.status ?? 'error');
  const command = String(result?.command ?? '').trim();
  const lines = [`【kokomi 查询结果】`, `指令：kokomi ${command || '帮助'} ｜ 状态：${statusHint(status)}`];
  const who = String(result?.queriedUserId ?? '').trim();
  if (who) {
    lines.push(result?.queriedFromTrigger === false
      ? `查询主体：QQ ${who}（不是触发者本人）`
      : `查询主体：触发者本人（QQ ${who}）`);
  }

  if (status === 'success' && result?.type === 'image') {
    lines.push('本次结果是图片（战绩长图），图上已有全部数字。');
    if (result?.sent || result?.sentInfo?.ok) {
      lines.push('渲染图已发给当前聊天（发送队列已留档）。不需要再发一次。');
    } else if (result?.oversized) {
      lines.push(`渲染图 ${((Number(result?.image?.bytes) || 0) / 1048576).toFixed(1)}MB 超过体积上限，本次没有发送。`);
    } else if (result?.sentInfo && result.sentInfo.ok === false) {
      lines.push(`渲染图发送失败：${result.sentInfo.error}。可以再调一次 kokomi-send-image 重试。`);
    } else {
      lines.push('渲染图尚未发送。需要发图就调用 kokomi-helper__kokomi-send-image 工具。');
    }
    return lines.join('\n');
  }

  if (status === 'success') {
    const text = String(result?.text ?? '').trim();
    lines.push('上游返回的是文字提示（属正常业务结果）：');
    lines.push(text || '（没有内容）');
    return lines.join('\n');
  }

  lines.push(`结果：${clip(String(result?.text ?? '') || '上游没有给出说明', 800)}`);
  lines.push('（这次没查到，据实说明，不要编造成绩。）');
  return lines.join('\n');
}

/** 状态码的中文说明。 */
function statusHint(status) {
  switch (String(status ?? '')) {
    case 'success': return '查询成功';
    case 'failed': return '上游未返回数据';
    case 'error': return '查询失败';
    default: return String(status ?? '未知状态');
  }
}
