# Get It. v1.4.0 多引擎接入补丁

> 目标：在 `Get.It-1.4.0.dmg` 对应的源码版本上，新增 **DeepSeek / 智谱 GLM / 小米 MiMo / MiniMax / Kimi(Moonshot)** 五个 AI 引擎。
> 约束：原有功能、界面、交互保持不变；用户只需填 **API Key + 模型名** 即可用。
>
> 补丁文件：`get-it-多引擎补丁.patch`（990 行 diff / +675 −75，`git apply` 直接可用）
> 基线：`beltromatti/get-it` tag `v1.4.0`（commit `ae0fa99`）
> **已编译产物**：`GetIt-1.4.1-BYOK-x64.dmg`（590 MB，macOS Intel x64，可直接安装）——打包过程与签名坑见第十一节

---

## 一、先说结论

**这五个引擎不需要新写 provider 类，也不需要改 agent 管线。**

v1.4.0 里已经有一条完整的 **BYOK 通道**：`pi` coding agent 作为统一运行时，通过一个动态生成的 `models.json` 接收「Base URL + 协议 + 模型 ID + Key」，然后走标准 HTTP。也就是说——

> 只要目标端点兼容 **OpenAI `/chat/completions` 协议**，接入一个引擎 = 在预设表里加一行。

我逐家核对了官方文档（2026-10-19）：**五家全部兼容 OpenAI 协议**，所以这个方案成立。

因此补丁的真实内容不是「新增五套接入代码」，而是两件事：

1. **把散落的引擎定义收敛成一张表**（原来硬编码在 3 个地方，加一个引擎要改 3 处，还容易漏）
2. **在表里加五行**，顺带处理两家端点的协议差异

改动量：10 个文件修改 + 3 个文件新增，**0 行改动现有引擎的行为**。

---

## 二、v1.4.0 的引擎架构（读源码得出，不是推测）

```
┌─ UI（SettingsButton.tsx 设置面板 / electron/wizard 首启向导）
│     用户选引擎 → 写入 settings.json
│       piProvider / piUrl / piApiType / piApiKey / piModelFast / piModelSmart
└─ lib/pi-coder.ts  buildEnvAndProvider()
      ↓ 把上面六个字段拼成 pi 的 models.json，provider 名固定为 "getit_byok"
      ↓
   ~/Library/Application Support/get-it/pi-agent/models.json
      ↓
   pi CLI（@earendil-works/pi-coding-agent）→ HTTPS → 厂商端点
```

关键事实（决定了补丁形态）：

| 事实 | 出处 | 影响 |
|---|---|---|
| provider 名恒为 `getit_byok`，`api` 字段由 `piApiType` 决定 | `lib/pi-coder.ts:82-108` | 不需要为每家建 provider |
| 引擎差异只体现在 `(url, apiType, model)` 三个值 | 同上 | 预设表足够表达 |
| 设置面板里引擎的 url/model 是 `switch` 硬编码 | `components/SettingsButton.tsx`（原 296-340 行） | 加引擎要改 switch |
| 首启向导另有一份预设表 | `electron/wizard/renderer.js:60-72` | 两份表必须手工同步 |
| pi 会按 `baseUrl` 子串自动探测协议差异 | `pi-ai/dist/providers/openai-completions.js` 的 `detectCompat()` | 部分厂商不用配置 |

最后一条是本次最关键的技术发现，详见第五节。

---

## 三、改动清单

| # | 文件 | 模块 | 改了什么 | 为什么 |
|---|---|---|---|---|
| 1 | `lib/provider-presets.ts` | **新增** | 全部引擎的唯一事实源：id / 标签 / URL / 协议 / 快慢模型 / Key 提示 / 文档地址 / `compat` 覆盖；外加 `resolvePreset()`、`detectPresetFromUrl()`、`isByokPresetId()` | 消除三处重复定义；新增引擎从「改 3 个文件」变成「加 1 个对象」 |
| 2 | `components/SettingsButton.tsx` | 设置面板 | ① `handlePiProviderChange` 的 40 行 `switch` 换成查表；② 下拉 `<option>` 改为 `BYOK_PRESET_ORDER.map()`；③ Key 占位符改查 `keyHint`；④ `piProvider` 类型放宽为 `ByokPresetId` | 新增引擎自动出现在下拉里，不需要再动 UI 代码 |
| 3 | `lib/settings-store.ts` | 设置持久化 | ① 类型放宽为 `ByokPresetId`；② 旧配置（只有 URL 没有 provider）改用 `detectPresetFromUrl()` 反查 | 老用户的 settings.json 不会因为这次改动被误标成 "Custom" |
| 4 | `app/api/settings/route.ts` | 设置写入 API | 入参 `piProvider` 由「任意字符串」改为 `isByokPresetId()` 校验 | 防止脏值写进 settings.json 导致 UI 下拉空白 |
| 5 | `app/api/provider/status/route.ts` | 账户状态 API | 账户面板的 `planType` 从 `settings.piProvider` 原样透出改为 `resolvePreset(...).label` | 否则面板显示 `minimax` 这种内部 id，现在显示 "MiniMax" |
| 6 | `lib/pi-coder.ts` | **运行时装配** | ① 生成 `models.json` 时把 `preset.compat` 合并进每个 model 条目；② 给 `buildEnvAndProvider` 加 `export`（仅为可测试，不改行为） | MiniMax 等端点需要显式协议覆盖，见第五节 |
| 7 | `electron/wizard/index.html` | 首启向导 UI | 下拉里在 "Custom endpoint" 前插入五个 `<option>` | 首启就能选新引擎 |
| 8 | `electron/wizard/renderer.js` | 首启向导逻辑 | 预设表补五条（镜像 TS 表，向导是裸 JS 无法 import） | 向导需要 url/model 才能预填 |
| 9 | `scripts/verify-byok-engines.ts` | **新增** | ① `--self-test`：无网络校验预设表一致性；② 带 key 时逐个端点发真实请求 | 把「配置对不对」和「代码对不对」分开验证 |
| 10 | `package.json` | 脚本 | 加 `"verify:byok": "tsx scripts/verify-byok-engines.ts"` | 一条命令跑验证 |

**没有改动的部分**：所有 agent（概念检测 / 知识图谱 / 评估 / 费曼 / 测验）、数据库 schema、PDF 解析、可视化渲染器、IndexedDB、Electron 主进程 —— 一行都没碰。

---

## 四、五家引擎的参数（已逐条核对官方文档）

| 引擎 | Base URL | 快模型（`piModelFast`） | 强模型（`piModelSmart`） | 备注 |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash` | `deepseek-v4-pro` | V4-Flash 已下线，旧名 `deepseek-v4-flash` 只是被转发到 V4.1-Flash |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash` | `glm-5.3` | **`/v4` 路径段不能省**，裸域名 404 |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-flash` | `mimo-v2.6-pro` | Token Plan 订阅用户要用 `https://token-plan-cn.xiaomimimo.com/v1` + `tp-`/`ttp-` 开头的 Key |
| MiniMax | `https://api.minimax.io/v1` | `MiniMax-M2.7-highspeed` | `MiniMax-M3` | **国内 Key 必须换 `https://api.minimaxi.com/v1`**，两套 Key 与域名互不通用 |
| Kimi | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `kimi-k3` | `kimi-k2.5` 与 `moonshot-v1-*` 已于 2026-08-31 下线（现在返回 404） |

> 模型 ID 是默认值不是契约。两家的模型字段在设置面板里都可直接改写，改完保存即生效。

---

## 五、两个必须处理的协议差异（这是补丁里唯一有技术含量的部分）

pi 的 `openai-completions` 实现里有一个 `detectCompat(model)`，按 **baseUrl 子串**决定要不要做厂商适配：

```js
// pi-ai/dist/providers/openai-completions.js（节选，原文）
const isZai     = baseUrl.includes("open.bigmodel.cn");
const isMoonshot= baseUrl.includes("api.moonshot.");
const isDeepSeek= baseUrl.includes("deepseek.com");
...
supportsDeveloperRole: !isNonStandard && !isOpenRouter,   // 智谱/DeepSeek/Kimi 已是 false
maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
thinkingFormat: isDeepSeek ? "deepseek" : isZai ? "zai" : "openai",
```

### 结论

| 引擎 | 自动探测结果 | 是否需要干预 |
|---|---|---|
| DeepSeek | ✅ 命中 `deepseek.com`，走 `thinkingFormat: "deepseek"` + `requiresReasoningContentOnAssistantMessages` | 不需要 |
| 智谱 GLM | ✅ 命中 `open.bigmodel.cn`，走 `thinkingFormat: "zai"`（发 `thinking: {type: "enabled"}`） | 不需要 |
| Kimi | ✅ 命中 `api.moonshot.`，`maxTokensField` 自动切成 `max_tokens` | 不需要 |
| 小米 MiMo | ❌ 不认 `api.xiaomimimo.com` → 落到默认值 | 默认值恰好都对（MiMo 支持 `developer` 角色、支持 `max_completion_tokens`），**不改** |
| MiniMax | ❌ 不认 `api.minimax.*` → 落到默认值 | **必须改**：MiniMax 只接受 `system/user/assistant/tool` 四种角色，默认值会发 `developer`，直接 400 |

所以补丁里只给 MiniMax 一条覆盖：

```ts
minimax: {
  ...
  // MiniMax only accepts the roles system/user/assistant/tool — pi would
  // otherwise send `developer` for the system prompt and get a 400.
  compat: { supportsDeveloperRole: false },
}
```

并让 `pi-coder.ts` 把它写进 models.json：

```ts
const compat = resolvePreset(settings.piProvider).compat;
const modelEntry = (id: string) => ({
  id,
  reasoning: true,
  ...(compat ? { compat } : {}),
});
```

已确认 pi 的 `models.json` schema 接受 model 级 `compat`（`ModelDefinitionSchema` 里有该字段，且 `getCompat()` 会把显式值覆盖到自动探测结果之上）。

**只有 MiniMax 带 `compat`，其余为 `undefined`** —— 这样自动探测逻辑对原有引擎完全不变，符合「不改动原功能」的约束。

---

## 六、配置步骤

### 6.1 前置：必须从源码编译，不能只换 dmg

已安装的 `Get It.app` 里是 Next.js standalone 打包产物（编译后的 JS chunk），补丁改的是 `.ts/.tsx` 源码，**无法热替换**。所以要重编一次。

```bash
# 1. 取源码（与已装 dmg 同版本）
git clone https://github.com/beltromatti/get-it.git
cd get-it
git checkout v1.4.0          # commit ae0fa99

# 2. 打补丁
git apply /path/to/get-it-多引擎补丁.patch

# 3. 装依赖
npm install

# 4. 先验证（见第七节），再编译
node scripts/build-electron.mjs --target=mac-x64   # Intel；Apple Silicon 用 mac-arm64
# 产物在 dist-electron/

# 5. 替换
mv /Applications/"Get It.app" ~/.Trash/
cp -R dist-electron/mac/Get\ It.app /Applications/
```

> ⚠️ 一个容易被误判成「安装坏了」的环境坑：在 WorkBuddy / CodeBuddy 这类 agent 宿主里执行命令时，
> 宿主会注入 `ELECTRON_RUN_AS_NODE=1`，它让任何 Electron 应用被当成 Node 进程启动后立刻退出。
> 跑应用或编译前先清掉：
> ```bash
> unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_EXTRA_CA_CERTS
> ```

### 6.2 应用内配置（设置面板）

`右上角设置 → AI Provider → BYOK / Own Key`

1. **Provider 下拉**：现在有 10 项，新增的在 `Gemini` 之后、`Custom Endpoint` 之前
   `Ollama (Local) / OpenAI / Anthropic / Gemini / DeepSeek / Zhipu GLM (智谱) / Xiaomi MiMo (小米) / MiniMax / Moonshot Kimi / Custom Endpoint`
2. 选中引擎 → **Base URL 与两个模型名自动填好**，通常不用改
3. **API Key** 填入对应平台的 Key（占位符会提示格式，如 `sk-…`）
4. 点保存。设置立即生效，无需重启

需要改的只有一个字段：**API Key**。模型名想换（比如 DeepSeek 想用 `deepseek-v4-pro` 当快模型）直接改文本框。

### 6.3 首启向导配置

全新安装首次启动会弹向导，选 **"Your own key (BYOK)"** → 下拉里同样有五家 → 填 Key → 点 "Verify" 通过后进主界面。

### 6.4 无 UI 方式（环境变量）

```bash
export PI_PROVIDER=deepseek
export PI_URL=https://api.deepseek.com/v1
export PI_API_KEY=sk-xxxx
export PI_MODEL_FAST=deepseek-flash
export PI_MODEL_SMART=deepseek-v4-pro
```

`settings-store.ts` 的 `defaultsFromEnv()` 会读取；即使只给了 `PI_URL`，`detectPresetFromUrl()` 也能反查出对应引擎。

---

## 七、验证方法

### 第 1 层：静态（不需要 Key）

```bash
npx tsc --noEmit
```
**实测结果**：0 error（补丁后干净树，TypeScript 5.x，Next 16.2.6）。

### 第 2 层：预设表自检（不需要 Key、不需要网络）

```bash
npx tsx scripts/verify-byok-engines.ts --self-test
```
**实测输出**：
```
self-test OK — 10 presets, 5 added by this patch, no duplicate endpoints
  deepseek  deepseek-flash         deepseek-v4-pro        https://api.deepseek.com/v1
  zhipu     glm-5.3-flash          glm-5.3                https://open.bigmodel.cn/api/paas/v4
  mimo      mimo-v2.6-flash        mimo-v2.6-pro          https://api.xiaomimimo.com/v1
  minimax   MiniMax-M2.7-highspeed MiniMax-M3             https://api.minimax.io/v1
  kimi      kimi-k2.6              kimi-k3                https://api.moonshot.cn/v1
```

它会检查：下拉顺序与表是否一致、有没有重复端点、模型名是否为空、URL 能否被 `detectPresetFromUrl` 反查回同一个引擎、五个新增引擎是否都在 `ADDED_ENGINE_IDS` 里。

### 第 3 层：生产构建（不需要 Key）

```bash
npm run build
```
**实测结果**：`✓ Compiled successfully`，17 条路由全部生成，无 warning（`next build` 会把客户端/服务端边界也检一遍，比 `tsc` 更严）。

### 第 4 层：真实界面（不需要 Key）

用 Playwright 打开编译后的界面，切到 BYOK，读下拉的真实 DOM：

```
PROVIDER_SELECTS = [
  "Ollama (Local)", "OpenAI (ChatGPT/Codex)", "Anthropic (Claude)",
  "Google Gemini (AI Studio)",
  "DeepSeek", "Zhipu GLM (智谱)", "Xiaomi MiMo (小米)", "MiniMax", "Moonshot Kimi",
  "Custom Endpoint"
]
AFTER_SWITCH_MINIMAX_URL = https://api.minimax.io/v1
PAGE_ERRORS = []
```

选中 MiniMax 后，Base URL / 两个模型名 / Key 占位符全部自动填好（见目录里的两张截图）。
**注意**：v1.4.0 的「Switch」按钮走的是 Electron 原生接口 `window.getit.runCodexSetup()`，浏览器里点不动——验证时是直接写 `settings.json` 的 `provider: "pi"` 让它进 BYOK 面板的。

### 第 5 层：models.json 装配结果（不需要 Key）

这是最能证明「补丁真的生效」的一层。直接调 `buildEnvAndProvider()`，读它写出的文件：

```
=== minimax ===
{ "providers": { "getit_byok": {
    "baseUrl": "https://api.minimax.io/v1",
    "api": "openai-completions",
    "models": [
      { "id": "MiniMax-M2.7-highspeed", "reasoning": true,
        "compat": { "supportsDeveloperRole": false } },
      { "id": "MiniMax-M3", "reasoning": true,
        "compat": { "supportsDeveloperRole": false } } ] } } }

=== deepseek ===
{ "providers": { "getit_byok": {
    "baseUrl": "https://api.deepseek.com/v1",
    "api": "openai-completions",
    "models": [
      { "id": "deepseek-flash",   "reasoning": true },
      { "id": "deepseek-v4-pro",  "reasoning": true } ] } } }
```

**MiniMax 有 `compat`、DeepSeek 没有** —— 正好是第五节设计的意图：只有需要干预的引擎才覆盖，其余交给 pi 的自动探测，原引擎行为零变化。

### 第 6 层：端点连通（需要真 Key）

```bash
export DEEPSEEK_API_KEY=sk-xxxx
npx tsx scripts/verify-byok-engines.ts deepseek
# 或一次跑完所有已设 Key 的引擎
npx tsx scripts/verify-byok-engines.ts all
```

输出形如：
```
probing deepseek (deepseek-v4-pro) … ok
── results ─────────────────────────────
PASS  deepseek  200   1832ms · model=deepseek-v4-pro · reply=ok
1/1 passed
```

**这一步是「Key 对不对 / URL 对不对 / 模型 ID 在不在」的唯一可靠判据。** 如果它 PASS 但应用里失败，问题在应用传输层；如果它 FAIL，先看状态码：401=Key 错、404=URL 或模型 ID 错、429=限流。

### 第 7 层：应用内端到端

1. **看装配结果**：`cat ~/Library/Application\ Support/get-it/pi-agent/models.json`，对照第 5 层的形状。
2. **账户面板**：设置里应显示引擎名（"MiniMax"），不是内部 id（`minimax`）。
3. **跑一遍管线**：导入 PDF → 概念标签生成 → 知识图谱出节点 → 做一次闪卡 → 评估分出现。这四步覆盖 agent 管线的全部调用点。

---

## 八、加第 6 个引擎有多容易

以后想加（比如通义千问、文心、SiliconFlow），只需在 `lib/provider-presets.ts` 里加一个对象 + 在 `BYOK_PRESET_ORDER` 里加一个 id：

```ts
qwen: {
  id: "qwen",
  label: "Qwen (DashScope)",
  url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiType: "openai-completions",
  modelFast: "qwen-flash",
  modelSmart: "qwen-max",
  needsKey: true,
  keyHint: "Enter DashScope API Key (sk-…)",
  docsUrl: "https://bailian.console.aliyun.com/",
},
```

UI 下拉、向导预填、Key 占位符、账户面板标签、自检脚本全部自动跟上。**注意**：首启向导（`electron/wizard/renderer.js`）是裸 JS 无法 import TS，仍需手工镜像一行——这是唯一残留的重复，已在两处代码注释里标注 `⚠️ Keep in sync`。

---

## 九、已知边界与不做的事

| 项 | 说明 |
|---|---|
| **未打出新 dmg** | `next build` 已实测通过，但 `electron-builder` 打包未做——它要额外下载 Electron 33 二进制（约 200MB）和四家 AI CLI 的二进制（`electron:prepare`，又几百 MB），下载耗时取决于网络。需要安装包时按 6.1 自行跑一条命令即可。 |
| **模型 ID 会漂移** | 本次核对到 2026-10-19。`deepseek-v4-flash`、`kimi-k2.5`、`moonshot-v1-*` 都已在近期下线，说明这些 ID 生命周期很短。UI 里两个模型字段保持可编辑就是为此。 |
| **`reasoning: true` 对所有模型硬编码** | 这是 v1.4.0 原有行为（`pi-coder.ts`），本次**原样保留**。非推理模型收到 `reasoning_effort` 一般被忽略，不报错。若某家因此 400，才需要改成按 preset 声明。 |
| **不接各家专有能力** | Kimi 的内置工具（Web Search / Code-Runner）、MiMo 的 TTS/ASR、MiniMax 的视频生成 —— 都不在 OpenAI chat 协议里，本补丁不涉及。 |
| **两套 MiniMax 域名不能自动切换** | 无法从 Key 前缀可靠判断区域（`sk-api-…` 两边都可能出现），所以只填国际站默认值，国内用户在 UI 里改 Base URL。 |
| **`docsUrl` 字段当前只作文档用** | 未在 UI 里渲染「去申请 Key」链接——因为你要求界面不变。想加的话是 `SettingsButton.tsx` 里一行 `<a>`。 |

---

## 十、补丁内容速查

```
app/api/provider/status/route.ts   |   3 +-     账户面板显示引擎真名
app/api/settings/route.ts          |   3 +-     入参校验
components/SettingsButton.tsx      |  78 +---    switch → 查表，下拉从表生成
electron/wizard/index.html         |   5 +      向导下拉加 5 项
electron/wizard/renderer.js        |   7 +      向导预设表同步
lib/pi-coder.ts                    |  17 +-     写 compat 进 models.json
lib/settings-store.ts              |  27 +-     类型放宽 + 按 URL 反查引擎
package.json                       |   1 +      verify:byok 脚本
scripts/build-electron.mjs         |  10 +-     ad-hoc 分支改走 sign-adhoc.py
scripts/electron-after-sign.cjs    |  40 +-     去掉 --deep，委托逐层签名
lib/provider-presets.ts            | 新增 246 行  唯一事实源
scripts/verify-byok-engines.ts     | 新增 218 行  自检 + 连通性探测
scripts/sign-adhoc.py              | 新增  95 行  由内向外逐层 ad-hoc 签名
```
合计 **13 个文件，+675 / −75 行**。

验证状态（全部实测）：

| 检查 | 结果 |
|---|---|
| `git apply --check` 在纯净 v1.4.0 上 | ✅ 通过 |
| `tsc --noEmit`（补丁后干净树） | ✅ 0 error |
| `npm run build` | ✅ 17 路由全生成 |
| `verify-byok-engines.ts --self-test` | ✅ 10 presets / 5 added / 无重复端点 |
| 真实界面下拉 | ✅ 10 项，顺序正确，无 console error |
| `models.json` 装配 | ✅ MiniMax 带 compat，其余不带 |
| 打包成 dmg | ✅ 590 MB / x86_64 / 签名 `verify --deep --strict` PASS |
| 五家端点编入产物 | ✅ 每家命中 6 个 server chunk |

---

## 十一、打包成 dmg 的完整实录（含一个必踩的签名坑）

产物：`GetIt-1.4.1-BYOK-x64.dmg`（590 MB）。安装方式就是标准的拖进 Applications。

### 11.1 编译命令

```bash
cd get-it
git apply get-it-多引擎补丁.patch
npm install                                   # 必须清掉 ELECTRON_RUN_AS_NODE，见下
npm run build                                 # next build → .next/standalone
node scripts/electron-prepare.mjs --target=darwin-x64
node scripts/build-electron.mjs --target=mac-x64
```

`electron-prepare` 会把 codex / claude / gemini / pi 四家 CLI 二进制 stage 进 `electron/*-bin/`。本次这四家平台包本来就在 `node_modules` 里（`@openai/codex-darwin-x64`、`@anthropic-ai/claude-code-darwin-x64`），所以**零下载**。

`build-electron.mjs` 会探测 keychain：没有 Developer ID 证书就走 ad-hoc 分支。

### 11.2 三个环境坑（本机实测，按踩到的顺序）

**坑 1：`ELECTRON_RUN_AS_NODE=1` 会让打包工具和 Electron 自己都失灵**

WorkBuddy / 某些 Node 宿主会注入这个变量。它会让任何 Electron 二进制退化成一个纯 Node 进程——GUI 应用启动后不开窗口、不写日志、RSS 停在 32 KB。所有命令前都加：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_EXTRA_CA_CERTS <command>
```

**坑 2：Electron 二进制版本要重下，缓存里的不算**

`~/Library/Caches/electron` 里可能躺着别的版本（本机是 v40.10.2），而项目锁的是 **33.4.11**。直接走镜像重下，1 分钟搞定：

```bash
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" \
  node node_modules/electron/install.js
```

**坑 3（最坑）：`codesign --deep` 会把 app 签成「能安装、打不开」**

原仓库的 `scripts/electron-after-sign.cjs` 在 ad-hoc 分支里做的是：

```bash
codesign --force --deep --sign - --timestamp=none "Get It.app"
```

这条命令有两个问题，缺一个都复现不出来：

1. **没带 `--entitlements`** → Electron 的 V8 拿不到 `com.apple.security.cs.allow-jit`，无法分配可执行内存；
2. **带了 `--deep`** → 它会把同一份 entitlements 盖到 `Electron Framework` 里的每个 dylib 上，破坏 dyld 的信任链。

症状极具误导性：dmg 能装、图标正常、双击后**什么都不发生**。`sample <pid>` 显示 RSS 只有 32 KB、栈无法符号化、`lsof -p` 只看到主可执行和 dyld——连一个 framework 都没加载。

**正确做法**：由内向外逐层签，entitlements 只给 app 和 helper，framework 一律不带。补丁里新增了 `scripts/sign-adhoc.py` 做这件事：

```
[1/5] Electron Framework 内部 helper（chrome_crashpad_handler）  不带 entitlements
[2/5] Electron Framework 本体                                    不带 entitlements
[3/5] Mantle / ReactiveObjC / Squirrel                           不带 entitlements
[4/5] 四个 Helper.app                                            带 entitlements
[5/5] 外层 Get It.app                                            带 entitlements
```

自检输出应该是：

```
verify --deep --strict: PASS
allow-jit present: yes
```

顺带一个反直觉的事实：**electron-builder 不支持 `identity: "-"` 做 ad-hoc 签名**。它会把 `-` 当成 keychain 里的证书名去查，查不到就整包跳过签名（日志里是 `skipped macOS application code signing`）。所以必须 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过它，再让 afterSign 钩子接管。

### 11.3 首次打开需要手动放行

本机 keychain 里 **0 个有效签名身份**，所以只能 ad-hoc 签名，没有 Apple 公证。`spctl --assess` 会返回 `CSSMERR_TP_CERT_REVOKED`——这是 ad-hoc 的正常结果，不代表包坏了。

macOS 12 上首次打开的处理：

1. 把 app 拖进 Applications；
2. **右键 → 打开**（不是双击），弹窗里点「打开」；
3. 之后就能正常双击了。

如果右键打开仍被拦，清一次隔离属性：

```bash
xattr -cr "/Applications/Get It.app"
```

要彻底消除这个提示，需要 Apple Developer ID 证书（$99/年）+ 公证，那是仓库 CI 里做的事，本地无法绕过。

### 11.4 关于验证的诚实说明

已实测：签名链 `verify --deep --strict` PASS、`allow-jit` 存在、dmg 可挂载且结构标准、补丁代码确实编进了产物（五家端点各命中 6 个 server chunk）、内嵌 standalone 服务能独立启动到 `✓ Ready`。

**没能实测的**：GUI 端到端。这台机器的执行环境对 GUI 启动有额外限制——连**未改动的上游 Electron**从同一个 shell 启动也开不出窗口，所以「窗口没出现」不能用来判定包的好坏。请在 Finder 里右键打开做最终确认。


