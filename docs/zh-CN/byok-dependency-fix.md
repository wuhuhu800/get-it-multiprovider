# BYOK 通道修复记录：undici 依赖缺失

> 2026-10-20 · 针对「配置 DeepSeek 时报 ERR_MODULE_NOT_FOUND」的修复

## 一、报错现象

在向导第 2 步（Bring your own key）填完 DeepSeek Key 点 Continue 后：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'undici' imported from
/Applications/Get It BYOK.app/Contents/Resources/app/electron/pi-bin/pi-cli/dist/core/http-dispatcher.js
```

## 二、根因

**不是补丁的问题，是这个打包版本从一开始就缺依赖。**

Get It 的 BYOK 通道走 `pi-cli`（npm 包名 `@earendil-works/pi-coding-agent` 0.79.1）：

```
Resources/app/electron/pi-bin/pi-cli/
├── dist/            ← 纯 tsc 输出，没有 bundle
├── package.json     ← 声明了 17 个 dependencies
└── node_modules/    ← ❌ 打包时压根没生成
```

而 `Resources/app/node_modules` 里只有 133 个 **Next.js 前端**依赖（react、three、pdfjs 等），
`@earendil-works/*`、`chalk`、`glob`、`yaml`、`undici` 一个都没有。

`dist/core/http-dispatcher.js` 第一行就是 `import * as undici from "undici"`，
Node 的 ESM 解析从该文件向上找 `node_modules`，一路找到 `/` 都没找到，于是抛 `ERR_MODULE_NOT_FOUND`。

> 结论：**这个打包版的 BYOK 从来没跑通过**。跟新增五个引擎的补丁无关——补丁只是让你走到了这一步。

## 三、修复（三步）

### 第 1 步：装齐 pi-cli 的生产依赖

```bash
mkdir -p /tmp/pi-deps
cp "/Applications/Get It BYOK.app/Contents/Resources/app/electron/pi-bin/pi-cli/package.json" \
   "/Applications/Get It BYOK.app/Contents/Resources/app/electron/pi-bin/pi-cli/npm-shrinkwrap.json" \
   /tmp/pi-deps/
cd /tmp/pi-deps && npm install --omit=dev --no-audit --no-fund
```

结果：**129 个包 / 90 个顶层目录 / 131 MB**，版本由 `npm-shrinkwrap.json` 锁定，不会漂移。

关键检查：

```bash
ls /tmp/pi-deps/node_modules/undici                      # 存在
node -p "require('/tmp/pi-deps/node_modules/undici/package.json').version"   # 8.3.0
ls /tmp/pi-deps/node_modules/@earendil-works             # pi-agent-core pi-ai pi-tui
find /tmp/pi-deps/node_modules -name "*.node"            # 确认含 darwin-x64 预编译
```

原生模块必须匹配架构。本机是 Intel（x86_64），装出来的正好是 `darwin-x64`。
如果是 Apple Silicon，需要 `npm install --cpu=x64 --os=darwin` 或改用 arm64 版 app。

### 第 2 步：拷进 app，位置很关键

```bash
PI="/Applications/Get It BYOK.app/Contents/Resources/app/electron/pi-bin/pi-cli"
rm -rf "$PI/node_modules"
ditto /tmp/pi-deps/node_modules "$PI/node_modules"
```

为什么放 `pi-cli/node_modules`：ESM 解析从 `pi-cli/dist/core/` 向上逐级找
`node_modules`，第一站就是 `pi-cli/node_modules`。放这里最稳，也不会污染
`app/node_modules` 里那套 Next.js 依赖。

### 第 3 步：修 undici 与 Electron 的 Node 版本冲突

装完 undici 后会出现第二个错：

```
TypeError: webidl.util.markAsUncloneable is not a function
```

原因：undici 8.x 用了 `worker_threads.markAsUncloneable`，这个 API 是 **Node 22.10** 才加的，
而 **Electron 33 内置的是 Node 20**。

`electron/setup.js` 里已经写了一个 `pi-undici-shim.cjs` 想解决这事，但它只 patch 了
`require("node:worker_threads")` 导出的对象，**管不到 undici 内部解构出来的局部变量**：

```js
// undici/lib/web/webidl/index.js 第 5 行
const { markAsUncloneable } = require('node:worker_threads')   // Node 20 → undefined
// 第 161 行
webidl.util.markAsUncloneable = markAsUncloneable              // → undefined
// 调用处 → TypeError
```

修法：给这一行加 fallback。

```js
const { markAsUncloneable: _markAsUncloneable } = require('node:worker_threads')
// Electron 33 ships Node 20, which lacks worker_threads.markAsUncloneable
// (added in Node 22.10). Fall back to a no-op so undici 8.x can load.
const markAsUncloneable = typeof _markAsUncloneable === 'function' ? _markAsUncloneable : (obj) => obj
```

`markAsUncloneable` 的作用只是把对象标记为不可结构化克隆（一个优化 + 保护），
降级成 no-op 不影响功能。

## 四、验证

用 Electron 自带的 Node 跑 pi-cli，完全模拟 `setup.js` 的 `verifyPi()`：

```bash
APP="/Applications/Get It BYOK.app"
PI="$APP/Contents/Resources/app/electron/pi-bin/pi-cli"
D="$HOME/Library/Application Support/get-it"

env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 PI_OFFLINE=1 PI_TELEMETRY=0 \
  PI_CODING_AGENT_DIR="$D/pi-agent" OPENAI_API_KEY="<你的Key>" \
  "$APP/Contents/MacOS/Get It" \
  --require "$D/pi-undici-shim.cjs" \
  "$PI/dist/cli.js" --mode json --print "Reply with the single word ok." \
  --provider getit_byok --model deepseek-flash --no-tools
```

期望输出（节选）：

```json
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],
 "api":"openai-completions","provider":"getit_byok","model":"deepseek-flash",
 "usage":{"input":434,"output":2,"totalTokens":436},"responseId":"5a28576c-..."}}
```

看到 `"text":"ok"` + `provider: getit_byok` + 非零 usage，就是真的通了。

## 五、副作用：必须重签名

往 `Contents/` 里加 131 MB 文件，等于把代码签名的 seal 全破坏了。
不重签的话 `spctl -a` 会变成 `a sealed resource is missing or invalid`，双击又被拦。

用 `resign-getit-v2.py`（同目录）：

```bash
python3 resign-getit-v2.py "/Applications/Get It BYOK.app"
```

它做的事：

1. 按**文件头魔数**（`0xCAFEBABE` / `0xFEEDFACF` 等）扫描全包所有 Mach-O，
   比 `file` 命令快两个数量级
2. 按路径深度降序逐个签名（由内向外，绝不 `--deep`）
3. **签 `Contents/Frameworks/*.framework`**（先 `Versions/A` 再目录本身）
   —— 这一步 v1 漏了，导致 `libEGL.dylib` 等被签后 framework 的 seal 失效
4. 签 4 个 Helper.app（带 entitlements）
5. 签主可执行 + 主 .app（带 entitlements）

> 为什么不能 `codesign --deep`：它会从外向内一把梭，破坏 Electron 的 dyld 链，
> 症状是进程起来但只有 32 KB RSS、永远不出窗口。

## 六、复发处置

| 症状 | 原因 | 处理 |
|---|---|---|
| `ERR_MODULE_NOT_FOUND: undici` | `pi-cli/node_modules` 没了 | 重跑第 1、2 步 |
| `markAsUncloneable is not a function` | undici 被重新安装覆盖了补丁 | 重做第 3 步 |
| `sealed resource is missing or invalid` | 改了包内文件没重签 | 跑 `resign-getit-v2.py` |
| `rejected` / `CERT_REVOKED` | 证书信任丢了 | 重跑 `信任本地证书.command` |
| `accepted` 但双击弹窗 | syspolicyd 的 inode 缓存 | `ditto` 一份新副本再启动 |
