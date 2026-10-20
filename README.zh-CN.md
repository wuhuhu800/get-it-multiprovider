<div align="center">

# Get It. — 多引擎中文版

### Read it. See it. Get it.

**这是 [Get It.](https://github.com/beltromatti/get-it) 的下游改良版：给 BYOK 通道新增五家国内模型引擎，并修掉三个导致该通道在打包版里从未跑通过的上游 Bug。**

[![上游](https://img.shields.io/badge/upstream-beltromatti%2Fget--it-1a1a2e?style=for-the-badge&logo=github)](https://github.com/beltromatti/get-it)
[![基线](https://img.shields.io/badge/baseline-v1.4.0-5b66f1?style=for-the-badge)](https://github.com/beltromatti/get-it/releases/tag/v1.4.0)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge)](LICENSE)

**新增引擎：** DeepSeek · 智谱 GLM · 小米 MiMo · MiniMax · Moonshot Kimi

**English: [README.md](README.md)**

<br />

</div>

---

## 先说这个项目是什么

Get It. 是一个把 PDF 变成「可测量的掌握度地图」的学习工具：导入教材，页面上自动长出概念标签，点标签右侧渲染三维场景 / 二维动画 / 公式推导 / 函数图像；同时后台建出知识图谱，再用对话、闪卡、测验、费曼四种方式练，练完由评估 agent 给每个概念节点打四个维度的分（记忆 / 理解 / 结构 / 应用）。

它的 AI 侧**只有一个通道**：`lib/pi-coder.ts` 生成 `pi-agent/models.json`，全部 agent 都走这一个 `chat/completions` 风格的传输层。所以任何兼容该协议的厂商，理论上都只需要**描述**它，而不需要写新的 provider 类。

上游在这个通道里给了五个预设：Ollama、OpenAI、Anthropic、Gemini、Custom。

**这个分支加了五个，并且在加的过程中发现：这个通道在打包版里其实从来没跑通过。**

## 四个问题（全部已修）

| # | 问题 | 现象 | 根因 |
|---|---|---|---|
| 1 | 缺引擎预设 | 下拉只有 5 项 | 上游未实现 |
| 2 | `ERR_MODULE_NOT_FOUND: undici` | 向导「验证」步骤对**任何** BYOK 引擎都报红 | `pi-cli` 打包时没带自己的 `node_modules`；npm 把它的依赖提升到了 electron-builder 根本不会复制的那棵树 |
| 3 | `webidl.util.markAsUncloneable is not a function` | 修完 (2) 后每次请求都抛 | undici 8.x 需要 Node 22.10 的 `worker_threads.markAsUncloneable`，Electron 33 内置 Node 20 |
| 4 | `stdout maxBuffer length exceeded` | 对话正常，但知识图谱 / 标签 / 测验全报红 | `--mode json` 每个流式增量都把累计消息完整序列化**两份** → stdout 随回答长度 **O(N²)** 增长 |

除了这四处，**界面、交互、文档流水线、存储结构全部保持上游原样**。

## 改了什么

### 1. 用预设表替掉 switch

`lib/provider-presets.ts`（新增，246 行）是唯一事实源：id、显示名、Base URL、协议类型、两个默认模型 id、是否需要 Key、Key 占位文案、申请地址、可选的 `compat` 覆盖。

其他文件全部改成读这张表：

| 文件 | 改动 |
|---|---|
| `lib/provider-presets.ts` | **新增** — `BYOK_PRESETS`、`BYOK_PRESET_ORDER`、`resolvePreset()`、`detectPresetFromUrl()` |
| `lib/pi-coder.ts` | 生成 `models.json` 时合并 `preset.compat` |
| `lib/settings-store.ts` | `piProvider` 类型放宽为 `ByokPresetId`；按 URL 反查引擎，老配置不再被显示成 Custom |
| `components/SettingsButton.tsx` | 40 行 `switch` → 查表；`<option>` 由 `BYOK_PRESET_ORDER` 生成 |
| `app/api/settings/route.ts`、`app/api/provider/status/route.ts` | 接受新 id |
| `electron/wizard/index.html`、`electron/wizard/renderer.js` | 向导预设表同步（纯 JS 渲染进程，无法 import TS 模块） |
| `scripts/electron-prepare.mjs` | **新增构建期修复** — 见第 3 节 |

**加第六个引擎现在只要加一行。** 类型系统会强制向导那张表跟着改。

### 2. 五个新引擎

| 引擎 | Base URL | 快速模型 | 智能模型 | 备注 |
|---|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-flash` | `deepseek-v4-pro` | `deepseek-flash` 现在指向 V4.1-Flash；老的 `deepseek-v4-flash` 已下线 |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash` | `glm-5.3` | `/v4` 路径段是必须的，光填域名会 404 |
| **小米 MiMo** | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-flash` | `mimo-v2.6-pro` | Token Plan 用户改用 `https://token-plan-cn.xiaomimimo.com/v1` + `tp-`/`ttp-` 开头的 Key，需手动改 URL 框 |
| **MiniMax** | `https://api.minimax.io/v1` | `MiniMax-M2.7-highspeed` | `MiniMax-M3` | 国内 Key 要用 `https://api.minimaxi.com/v1`；必须带 `compat: { supportsDeveloperRole: false }`，否则 pi 会发 `developer` 角色直接 400 |
| **Moonshot Kimi** | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `kimi-k3` | `kimi-k2.5` 已于 2026-08-31 下线 |

端点和模型 id 都在 2026-10-19 对着各家官方文档核过。**模型 id 变化很快**，所以这两个字段在设置里始终可改——这不是偷懒，是设计。

### 3. 打包版的三处构建期修复

`scripts/electron-prepare.mjs` 在把 CLI 拷进包之后会顺手修三件事：

- **给 `pi-cli` 装自己的依赖树**：用包内自带的 `npm-shrinkwrap.json` 锁版本，`npm install --omit=dev` 装到 `pi-cli/node_modules`，让 ESM 解析在这里就停住，不再向上跑到包里不存在的目录；
- **修 undici 的 `markAsUncloneable`**：加 `typeof` 判断 + no-op 兜底。`electron/setup.js` 里那个 `--require` shim 只能改模块的 exports 对象，管不到 undici 加载时解构出来的局部变量；
- **丢掉流式快照事件**：改 `print-mode.js`，1500 字回答的 stdout 从 **84.8 MB 降到 38.6 KB（2245 倍）**，知识图谱再也不会撞 10 MB 的 `maxBuffer`。

任何一步如果因为上游改动匹配不上，脚本会**大声警告**而不是静默跳过——静默失败比报错难查一百倍。

### 4. 校验与本地签名

- `scripts/verify-byok-engines.ts`（`npm run verify:byok`）——`--self-test` 离线校验十个预设（id 唯一、协议与 URL 匹配、Key 与占位文案一致、该带 `compat` 的带了）；不带参数则联网对每个引擎打一次 `GET /models`。
- `scripts/sign-adhoc.py`——把未签名的本地构建由内向外签（35 个 Mach-O → 嵌套 framework → Helper → 主 app），带 Electron 必需的 4 项 entitlements。只用 `codesign --deep` 会做出一个 32 MB RSS、永远不弹窗的残废进程。
- `scripts/resign-app.py`——同一套遍历逻辑的通用工具：`--identity`、`--keychain`、`--entitlements` 全部可选，主可执行文件名从 `Info.plist` 的 `CFBundleExecutable` 读，不写死。动过 `Contents/` 里任何东西之后用它重签。
- `scripts/fix-gatekeeper-inode.sh`——签名正确却仍被拒时的修复工具，靠换 inode 绕过缓存。改任何东西之前先打印它测到的现状，且**从不全局关闭 Gatekeeper**。
- `scripts/patch-pi-stdout.py`——stdout 修复的独立幂等版本，用来就地修补已安装的 app（构建脚本会自动应用同一修复）。


## 安装

**已编译版（Intel x64 / macOS）**：直接从 [Releases](https://github.com/wuhuhu800/get-it-multiprovider/releases/latest) 下载 dmg。包内已含三处构建期修复，装完即用，不需要再补 `node_modules` 或重新签名。

Apple Silicon 或想从源码构建：

```bash
git clone https://github.com/wuhuhu800/get-it-multiprovider.git
cd get-it-multiprovider
npm install
npm run build
npm run electron:prepare
node scripts/build-electron.mjs --target=mac-x64    # 或 mac-arm64 / win-x64 / linux-x64 / --all
```

产物在 `dist-electron/`。没有配 Developer ID 的话构建出来是未签名的，见下面「Gatekeeper」。

只想起个网页版（不走 Electron、不打包）：

```bash
npm run browser:dev    # http://localhost:3000
```

> 上游有个已知问题：Electron 内部 HMR 在 Next 16.2.6 + Turbopack + Chromium 130 下会有 hydration 抖动。所以「浏览器开发」或「改完重新构建再测」仍是更顺的内环。

## 配置一个引擎

1. 启动应用，向导里选 **Bring Your Own Key (BYOK)**。（第 2 步的「Sign in with ChatGPT」是 Codex 引擎用的，选 BYOK 后会跳过。）
2. 打开右上角**齿轮** → **Model Engine** 那一行 → **`⇄ Switch`** → **Bring your own key (BYOK)**。
3. **Provider** 下拉里选一个引擎，Base URL 和两个模型名会自动填好，**你只需要粘 API Key**。
4. 拿东西试：导入一篇 PDF 生成标签，或打开文档建知识图谱。

下拉共十项，顺序是：Ollama、OpenAI、Anthropic、Gemini、**DeepSeek、智谱、小米 MiMo、MiniMax、Kimi**、Custom。

**后台 agent（标签、知识图谱、测验）读的是「快速模型」，不是智能模型。** 觉得抽出来的概念质量一般，去改**快速**那一栏——只改智能模型对它们没有任何影响。

配置和密钥都在一个目录下：

| 系统 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/get-it/` |
| Windows | `%APPDATA%\get-it\` |
| Linux | `~/.local/share/get-it/` |

`settings.json` 存引擎选择；`pi-agent/models.json` 存生成的 provider 配置，**API Key 是明文**——这点与上游一致。把那个文件当密钥对待。

## Gatekeeper（macOS）

上游正式发布版用付费 Apple Developer ID 签名并公证过，双击不弹窗。你自己构建的没有，会落到三种状态之一：

| `spctl -a -vvv --type execute "<app>"` | 含义 | 处理 |
|---|---|---|
| `accepted` | 正常 | — |
| `rejected` | 签名不完整，通常是包内还有裸 Mach-O 没签 | 重跑 `python3 scripts/sign-adhoc.py "<app>"` |
| `CSSMERR_TP_CERT_REVOKED` | ad-hoc 签名被直接拒 | 换真证书签，或用浏览器版 |

**一个必须知道的坑**：Gatekeeper 把拒绝结论缓存在 **`.app` 目录的 inode** 上，不是路径，也不是签名。所以你在原地重签、弹窗照样弹——因为杀掉进程的是那条缓存，`spctl` 还会乐呵呵地报 `accepted`。日志里 `log show --predicate 'process == "syspolicyd"'` 的 `objid` 等于 `stat -f "%i" "<app>"`。换个 inode 就会重新评估：

```bash
scripts/fix-gatekeeper-inode.sh "/Applications/Get It BYOK.app"
```

脚本会先打印 inode、签名主体、隔离属性、当前评估结果，然后用 `ditto` 复制出新 inode，再检查新副本、启动它，并确认进程是否真的活下来了。想手工做也可以：

```bash
ditto "/Applications/Get It.app" "/Applications/Get It Fresh.app"
```


浏览器版是完全绕开签名的兜底方案——Next.js standalone 服务用系统 node 就能跑，前端从不碰 `electronAPI`：

```bash
cd "/Applications/Get It.app/Contents/Resources/app/.next/standalone"
PORT=3210 node server.js
```

## 验证补丁

```bash
npm run verify:byok -- --self-test     # 离线：十个预设 + 全部不变式
npm run verify:byok                    # 联网：对每个引擎 GET /models
npx tsc --noEmit                       # 类型
```

`--self-test` 不需要网络也不需要 Key。联网那步只检查你填了 Key 的引擎，没填的记为 skipped，不算失败。

## 详细文档

排查过程写在 `docs/zh-CN/` 下。commit message 只写了结论，这些文件里有支撑结论的实测数据。

| 文件 | 内容 |
|---|---|
| [`docs/zh-CN/integration-notes.md`](docs/zh-CN/integration-notes.md) | 完整接入方案：补丁结构、逐文件改动、构建步骤、六层验证 |
| [`docs/zh-CN/byok-dependency-fix.md`](docs/zh-CN/byok-dependency-fix.md) | 打包版为什么报 `ERR_MODULE_NOT_FOUND: undici`，以及 undici 与 Node 20 的冲突 |
| [`docs/zh-CN/graph-stdout-fix.md`](docs/zh-CN/graph-stdout-fix.md) | stdout 的 O(N²) 问题：按事件类型拆解的字节数，修复前后对比 |
| [`docs/zh-CN/gatekeeper-troubleshooting.md`](docs/zh-CN/gatekeeper-troubleshooting.md) | 签名正确却仍被拒的完整排查：inode 缓存证据链与分支处置 |

设置面板的实际截图在 `docs/images/`。

## 架构（与上游一致）

```
上传 ─► 质量闸门（不调模型）─► pdfjs-dist 逐页抽文本 + 字形包围盒
      │
      ├──► 可视化流水线
      │     ├─ 批量概念检测 agent  →  DetectedConcept[]（带锚点字符串、页码）
      │     └─ 每个标签的渲染规格 agent →  3d / 2d-anim / formula / graph / 2d-text
      │
      └──► 知识图谱流水线
            ├─ kg-build agent（一次）      →  6–25 个概念节点 + 带类型的边 + 全局评语
            └─ kg-evaluate agent（增量）   →  每节点 {记忆, 理解, 结构, 应用} 0–100
```

所有提示词和 schema 都跑在同一个 provider 路由后面——这就是为什么加引擎只是加一行表格，而不是加一条代码路径。上游的设计思路（四维评分、评估队列、LLM 代码沙箱、桌面打包）在 [`technical-writeup.md`](technical-writeup.md)。

## 上游、署名与许可

这是独立的下游改良版。**Get It. 是在 2026 米兰 GDG AI Hack 上 24 小时做出来的**，为 Braynr 赛道，作者：

- **Mattia Beltrami**，米兰理工
- **Matteo Impieri**，米兰理工
- **Filippo Difronzo**，米兰理工
- **Luca Feggi**，帕多瓦大学

基线是上游 [`v1.4.0`](https://github.com/beltromatti/get-it/releases/tag/v1.4.0)（commit `ae0fa99`）。产品、设计、agent 流水线的全部功劳归他们。本分支只贡献了五个引擎预设、上面那几处构建期修复，以及校验脚本。未改动的上游 README 保留在 [`README.upstream.md`](README.upstream.md)。

采用 **Apache License 2.0**，与上游一致。见 [`LICENSE`](LICENSE)。

**商标。** Get It. 与 OpenAI、Anthropic、Google、DeepSeek、智谱、小米、MiniMax、月之暗面均无隶属、背书或赞助关系。每个引擎都只通过该厂商自己文档里的 HTTP 端点访问，用终端用户自己的 API Key 认证。所有产品名归各自所有者，这里仅用于说明本构建能与什么互通。

**你的数据。** 文档、日志、图谱、密钥都在你自己磁盘上。对外流量只有你主动指向的端点，以及上游 README 里说明的匿名启动 ping——设 `GETIT_DISABLE_ANALYTICS=1` 可以关掉它。
