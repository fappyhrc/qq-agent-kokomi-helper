# kokomi-helper 开发文档

> **这是开发文档**（架构、上游调研结论、踩过的坑、自检脚本）。
> 只想把插件用起来的话，请看面向使用者的 [`README.md`](README.md)。

| 项目 | 说明 |
|---|---|
| 类型 | 确定性型插件（`before-context` 钩子）+ 2 个 LLM 工具 |
| 放置位置 | `plugins/kokomi-helper/` |
| 运行形态 | **纯 Node**：无 Python、无桥接进程、无常驻服务 |
| 数据/渲染方 | Kokomi 服务端（默认 `http://43.133.59.53:8000/bot/`） |
| 默认状态 | **关闭**（`enabledByDefault: false`） |
| 体积 | 约 0.1 MB（13 个文件） |

---

## 0. 与 yuyuko 插件的对照

两者**零共享**，可同时运行。关键差异是**出图在哪一侧**：

| | yuyuko-helper | **kokomi-helper** |
|---|---|---|
| 出图位置 | 本机（上游 `Hikari-core-v2` + 浏览器渲染） | **服务端**（上游渲染好，只返回图片 URL） |
| 需要 Python 吗 | 需要（`.hikari-deps`，pip --target） | **不需要** |
| 需要桥接进程吗 | 需要（`hikari_bridge.py` : 8788） | **不需要**（Node 直接 HTTPS 调用） |
| 上游源码 | `.hikari-src`（GPL） | 无（不 vendored，规避 CC BY-NC 分发问题） |
| 体积 | 约 889 MB | **约 0.1 MB** |
| 触发词 | `yuyuko` | `kokomi` |
| 图片服务端口 | 32801 | 32802 |

自检里钉了三条隔离断言：`yuyuko`/`wws` 不被本插件认领、`kokomi` 不被 yuyuko 的触发词认领。

---

## 1. 架构

```
QQ Agent 核心
   │  ① before-context 钩子（硬超时 5s）：只做确定性「认领」
   │     判定 = @ 了机器人本人 AND 去掉 @提及 后第一个词是 kokomi
   │     命中 → 往该条消息追加【kokomi 指令已认领】+ 发起人 QQ + 该调哪个工具
   ▼
模型（LLM）
   │  ② 调 kokomi-query 工具（没有 5s 限制）
   ▼
index.js  handleQuery()
   │  ③ GET <botUrl>?token=…&message=wws%20me&platform=…&user_id=…
   ▼
Kokomi 服务（第三方，服务端渲染）
   │  ④ 返回 {"type":"img","img":"http://<图床>/wws_image/xxx.jpg"}
   ▼
lib/api.js  downloadImage()
   │  ⑤ 下载图片字节（注意：图片在**另一个 host** 上）
   ▼
lib/image-store.js → lib/image-server.js
   │  ⑥ 暂存（内存+磁盘）→ 挂本地 URL（:32802）
   ▼
autoSend（file → URL → base64 三级回退）
   │  ⑦ 走 ctx.sender.sendImage（发送队列：限频 → 去重 → 留档）
   ▼
群里出现战绩图 + 模型接的一句话
```

### 1.1 自然语言 → 指令：由模型翻译，插件不做解析

群友不必背指令表。设计上**刻意不让插件解析指令**：

| 环节 | 是否解析指令 | 原因 |
|---|---|---|
| `before-context` 钩子 | **不解析** | 只要 `@机器人` + `kokomi` 在最前就认领，命中面尽可能宽；钩子有 5 秒硬超时，也不适合做多轮澄清 |
| `kokomi-query` 工具 | **不解析** | `command` 是自由文本，模型可把自然语言翻译后填入 |
| 提示词 + 工具描述 | **承载"目标语言"** | 这里放权威指令表，模型据此翻译 |
| Kokomi 服务 | 只认标准指令 | 认不出会回「输入的指令或参数有误」 |

所以"自主判定"实际上是**提示词工程**，不是代码分支。两点必须同时存在，缺一不可：

1. **显式授权翻译**（`你可以把自然语言翻译成 Kokomi 指令`）——
   不写这句，模型会倾向"原样转发"，自然语言就直接变成服务端的「指令有误」；
2. **显式禁止编造参数**（`服务器、昵称、赛季、船名必须来自群友原话`）——
   否则模型可能为了"把活干完"而猜一个服务器或船名，在战绩查询里等于输出错误数据。

第 3 条兜底：听不懂时**据实说查不了并引导发 `kokomi help`**，而不是硬凑一个能跑的指令。

指令表来源：服务端 `help` 图（实测下载后逐条核对）。`selfcheck.mjs` 里有 20 条断言钉住
"指令表 + 授权 + 防编造 + 兜底路径"四件事——改动提示词时若有断言挂掉，
先确认是不是把这张表删了。

### 1.2 为什么查询不放在钩子里

钩子硬超时 5 秒（核心 `src/skills/manager.js` 的 `DEFAULT_HOOK_TIMEOUT_MS`），
而一次查询是「服务端取数 + 渲染 + 插件下载图片」，实测数秒。因此钩子只认领，
查询交给没有时限的工具。

### 1.3 为什么不需要桥接

桥接只在一种情况下必需：**出图必须在一台能起 Python 进程的机器上完成**
（Node 跑不了 Pillow/OpenCV，而且上游用相对导入、配置写死在类属性上）。

本插件的服务端**已经把图渲染好了**，插件只做两件 Node 擅长的事：发 HTTP、下载图片。
于是桥接、venv、365 MB 的上游源码全部不需要。

> 这段历史值得记下来：插件最初是按"本机渲染"建的（vendored `Kokomi_Bot` v4.1.1 +
> 私有 venv + Python 桥接），因为当时实测**公开数据服务全部失效**
> （`www.wows-coral.com` DNS 不存在、`43.134.96.105` 不可达）。
> 后来找到可用服务后，才改成直连。被删掉的 Python 侧实现见 git 历史。

---

## 2. 服务契约（实测确认）

```
GET  <botUrl>?token=<口令>&message=<指令>&platform=<平台>
              &user_id=<用户ID>&platform_id=<机器人ID>&channel_id=<频道ID>

→ {"type":"img","msg":null,"img":"http://<图床>/wws_image/1790008706131.667.jpg"}
→ {"type":"msg","msg":"输入的指令或参数有误","img":null}
→ {"type":"msg","msg":"Token unavailable","img":null}          ← 口令错
```

| 参数 | 说明 |
|---|---|
| `token` | **查询参数**，不是请求头。实测该服务认 `user` |
| `message` | 完整指令，**要带上服务端认的触发词**（默认 `wws`），如 `wws me` |
| `platform` | `qq_bot` / `qq_group` / `qq_guild` / `discord`（服务端 OpenAPI 里的枚举） |
| `user_id` | 触发者 ID；服务端按它查绑定 |
| `platform_id` / `channel_id` | 透传，默认 `123456` |

响应只有三种形态，插件据此归一化：

| 形态 | 处理 |
|---|---|
| `type=img` + `img` 有值 | 下载图片 → 暂存 → 自动发送 |
| `type=msg` | 作为文字结果注入上下文（例如未绑定的提示） |
| `msg = "Token unavailable"` | 判定为**口令错误**，提示改设置（HTTP 仍是 200） |

**图片地址在另一个 host 上**（`http://43.133.59.53/…`，不带 `:8000`），
必须用响应里给的绝对地址，不能拿 `botUrl` 去拼。

---

## 3. 踩过的坑（都是实测）

### 3.1 token 是查询参数，且值是 `user`

最初把它当请求头试了 `Authorization: Bearer user123456`、`X-Token`、`Access-Token`，
全部得到 `Token unavailable`；又只裸调 `/bot/`，于是误判"它只是个状态端点、不可用"。

真相：参数在 **query** 里，而且值只要 **`user`**（上游 v4 的 `API_USERNAME`，
不是 `USERNAME+PASSWORD`）。`/bot/` 也不是状态端点，它接受完整指令参数。

翻案的依据是 `openapi.json` 的**原始文本**（用 PowerShell 解析时被引号转义弄坏了，
只看到端点名；直接读原文才看到 `token`/`message`/`platform`/`user_id` 这些参数定义）。

### 3.2 `openapi.json` 里的参数默认值会误导

它的 `token` 默认值写的是 `123456789`，`user_id` 默认 `1000000002` —— 这些是**文档占位符**，
不是可用口令。别拿默认值当凭据。

### 3.3 图片下载偶发 502

首次下载图片得到 502，重试即成功（628 KB）。所以图片下载失败**不一定**是地址问题，
值得重试；插件目前把它归类为 `image` 类错误并给出可读提示。

### 3.4 上游（v4.1.1）自身的缺陷：未绑定时报错

在被删掉的本地渲染实现里发现：`command_select.py:67` 在绑定查询失败的分支里引用了
**尚未赋值**的 `lang`，抛 `UnboundLocalError`，把"网络不可达"伪装成"程序错误"。
（现在直连模式下不经过这段代码，但结论值得留档：上游的健壮性一般。）

### 3.5 服务端返回的文字里写着自己的触发词

未绑定时返回「请先绑定游戏账号，发送'wws help'可查询帮助文档」——其中 `wws` 是
服务端的写法。提示词片段已明确要求模型**换成 `kokomi`**，不要原样照念。

### 3.6 日志里不能出现完整 URL

`token` 在 query 里，所以完整 URL **含凭据**。`debug` 日志只打印指令与耗时，
不打印 URL。改动这里时务必保持。

---

## 4. 自检

```bash
# 离线自检（103 项）：触发判定 / 隔离断言 / URL 拼装 / 响应归一化 / 翻译能力 / 配置规整 / 文本组装
node selfcheck.mjs

# 真服务端到端验证（会访问网络）
node live-test.mjs                  # 只验证服务可达性，不需要绑定
node live-test.mjs 1000000001       # 额外验证真实查询与图片下载（该 ID 需已在服务端绑定）
# 两项环境变量可覆盖默认服务：KOKOMI_BOT_URL / KOKOMI_TOKEN
```

实测结果：

| 自检 | 结果 |
|---|---|
| `selfcheck.mjs` | **103 通过 / 0 失败** |
| `live-test.mjs`（不带参数） | **11 通过 / 0 失败 / 2 跳过** |
| `live-test.mjs <已绑定user_id>` | **17 通过 / 0 失败**（真实查询 → 真实 JPEG） |

第 3、4 项（真实查询、图片下载）需要传一个**已在服务端绑定过的 user_id**：
Kokomi 的绑定存在服务端，用一个没绑定过的 ID 调 `me`，服务端只会回
「请先绑定游戏账号…」——那不是故障，所以脚本把它处理成"跳过"而不是"失败"。

---

## 5. 已知限制

- **依赖第三方服务**：默认地址是 IP 直连的第三方服务（无域名、无 SLA）。
  它长期不可用时需要换成自建实例（`Kokomi_Bot` + `Kokomi_Backend`）。
- **不含上游代码**：上游 `Kokomi_Bot` 是 CC BY-NC 4.0，因此本插件**不 vendored 任何上游
  源码与素材**——这也是直连模式的一个附带好处（早期 vendored 版本有 365 MB 且不能随仓库分发）。
- **图片样式不可控**：由服务端模板决定。
- **绑定存在服务端**：换服务地址后需重新绑定。
- **图片地址必须可访问**：图片在另一个 host 上；若插件所在网络访问不到图床，
  会表现为"下载战绩图失败（HTTP xxx）"。

---

## 6. 文件结构

```
plugins/kokomi-helper/
├── plugin.json          清单：19 项设置 + configSchema + 提示词片段
├── index.js             入口：钩子（确定性认领）+ 2 个工具
├── selfcheck.mjs        离线自检（103 项）
├── live-test.mjs        真服务端到端验证（可选，访问真实服务）
├── lib/
│   ├── api.js           直连 Kokomi 服务（URL 拼装 / 响应归一化 / 图片下载）
│   ├── config.js        配置读取（每次现读 + 边界收敛）
│   ├── trigger.js       @提及解析、触发判定（纯函数，可单测）
│   ├── format.js        面向模型的文本组装（图片状态 / 文字注入 / 截断）
│   ├── image-store.js   战绩图暂存（内存 + 磁盘 + TTL + 容量上限）
│   └── image-server.js  本地只读图片服务（127.0.0.1:32802 / token 路径 / TTL）
├── README.md            用户手册
└── DEVELOPMENT.md       本文件
```

---

## 7. 参考

- [Kokomi_Bot](https://github.com/SangonomiyaKoko/Kokomi_Bot) —— 指令解析与图片渲染
- [Kokomi_Backend](https://github.com/SangonomiyaKoko/Kokomi_Backend) —— 数据服务端
- [QQ Agent 确定性型插件开发文档](../../doc/extend_development/plugin-development.md)
- 默认服务的接口文档：`http://43.133.59.53:8000/docs`（Swagger UI）
