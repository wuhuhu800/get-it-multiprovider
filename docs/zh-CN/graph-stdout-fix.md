# 生成图谱报错 `stdout maxBuffer length exceeded` — 根因与修复

> 2026-10-20 20:00 ｜ 针对 `/Applications/Get It BYOK.app`（1.4.1 + 五引擎补丁）

---

## 一、现象

- **对话（Chat）正常**，能正常收发。
- 点「Generate quiz / 生成图谱」等按钮时，右上角红色徽标：

```
Graph error   Failed
Knowledge-graph agent — PI CLI runJson failed: stdout maxBuffer length exceeded
```

配置：BYOK / DeepSeek / `deepseek-flash` / Base URL `https://api.deepseek.com`

**注意：跟 API Key、网络、签名、模型名都没有关系。** Key 是好的，对话已经证明通了。

---

## 二、根因：pi-cli 的 JSON 事件流是 O(N²) 的

Get It 的后台 agent（图谱、标签、测验、闪卡、费曼）不走对话通道，而是走：

```
Next.js chunk  w()  = PiProvider.runJson()
  └─ child_process.execFile(pi-cli, ["--mode","json","--print",...], { maxBuffer: 0xa00000 })
       └─ print-mode.js: session.subscribe(event => writeRawStdout(JSON.stringify(event) + "\n"))
```

问题就在最后一行：**每一个事件都完整序列化一次**。

而 `message_update`（流式增量事件）每次携带**两份完整累计消息快照**：

```json
{
  "type": "message_update",
  "assistantMessageEvent": { "type": "text_delta", "delta": "买", "partial": { <完整消息> } },
  "message": { <完整消息> }
}
```

第 i 个 delta 的字节数 ≈ `700 + 2 × 累计已输出字符数 × 3`（中文 UTF-8 三字节）。
对 C 个 delta 求和 ⇒ **总体积 ∝ N²**（N = 回答字符数）。

### 实测数据（deepseek-flash，prompt：写一段约 1500 字中文）

| | stdout 体积 | 行数 |
|---|---|---|
| 修复前 `--mode json` | **88,891,776 字节（84.8 MB）** | 4,383 |
| 修复后 `--mode json` | **39,585 字节（38.6 KB）** | 9 |
| `--mode text`（对照） | 输出本身（"ok" = 3 字节） | — |

体积构成（修复前）：

```
message_update      48,180,908 bytes   99.9%   ← 元凶
message_end              9,882 bytes    0.0%
agent_end                9,868 bytes    0.0%
turn_end                 9,749 bytes    0.0%
```

Get It 的 `maxBuffer` 是 `0xa00000` = **10 MB**。
⇒ 回答只要超过约 500 字，就有超限风险；1500 字直接 8.5 倍超标。

### 为什么对话没事

对话回答短（几百字），体积约 1~3 MB，侥幸没撞上 10 MB 天花板。
**这不是「图谱特有」的 bug，是回答长度问题**——对话一旦输出长文同样会爆。

---

## 三、修法

改 `pi-cli` 的 print mode：**跳过流式快照事件，只输出结构化结果事件**。

文件：`Contents/Resources/app/electron/pi-bin/pi-cli/dist/modes/print-mode.js`

```js
unsubscribe = session.subscribe((event) => {
    if (mode === "json") {
        // [GetIt patch] Skip streaming snapshot events. ...
        const t = event?.type;
        if (t === "message_update" || t === "tool_execution_update")
            return;
        writeRawStdout(`${JSON.stringify(event)}\n`);
    }
});
```

**为什么零影响**：Get It 侧解析函数（chunk 里的 `f()`）只读两种事件：

- `agent_end` → 取 `messages[last]` 的 `text` 和 `usage`
- `message_end` → 取 `message.content` 里的 `text` 和 `usage`

`message_update` 从来没被消费过，它纯粹是给 TUI 用的流式渲染。跳过它之后：

- ✅ 回答内容完整（从 `message_end` 取）
- ✅ usage 统计完整（input / output / cacheRead 都在）
- ✅ 对话与后台 agent 同时受益（同一条 print mode 路径）

---

## 四、验证

### 4.1 体积（已实测）

```
修复前：88,891,776 字节
修复后：    39,585 字节
```

### 4.2 解析正确性（复刻 chunk 里的 f() 逻辑跑一遍）

```
提取到文本长度: 1379 字符
usage: {"input":191,"output":2805,"cacheRead":256,"totalTokens":3252}
errorMessage: (无)
开头: 买电动车，最怕的不是花钱多，而是花了钱却买错……
结尾: ……再花半小时认真试骑一圈，基本就能选到一辆省心的车。
```

### 4.3 事件结构（修复后）

```
  0 session          151
  1 agent_start       23
  2 turn_start        22
  3 message_start    149
  4 message_end      147
  5 message_start    336
  6 message_end     5576   ← 完整回答
  7 turn_end        5590
  8 agent_end       5709   ← 完整回答 + usage
```

---

## 五、复现步骤（换机器 / 重装后）

```bash
python3 patch-pi-stdout.py "/Applications/Get It BYOK.app"
python3 resign-getit-v2.py "/Applications/Get It BYOK.app"
```

改包内文件必然破坏签名封印，**必须重签**。重签不会触发 Gatekeeper 弹窗
（拒绝缓存绑 inode，重签不改目录 inode）。

---

## 六、附带说明

- 图谱 / 标签 / 测验这些后台 agent 走 `PiProvider.runJson`，用的是 **`piModelFast`**
  （设置里的 Fast Model），不是 Smart Model。所以 Fast Model 选太弱的模型会影响抽取质量。
- 外层还有 **300 秒硬超时**（chunk 里的 `setTimeout(..., 3e5)`）。如果图谱任务特别大，
  可能先撞超时。届时考虑拆分文档或换更快的模型。
- 前端 `maxRetries` 现在是 **10**。修好之后一次就能过；如果仍反复重试，
  说明是别的问题（Key 额度 / 模型名 / 网络），不是这个 bug。
