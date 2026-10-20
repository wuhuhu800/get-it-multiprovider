#!/usr/bin/env python3
"""
修复 Get It 的 "PI CLI runJson failed: stdout maxBuffer length exceeded"
================================================================================

现象
----
对话（Chat）正常，但生成知识图谱 / 标签 / 测验等后台 agent 时右上角报红：
    Graph error — Knowledge-graph agent
    PI CLI runJson failed: stdout maxBuffer length exceeded

根因
----
pi-cli 在 `--mode json` 下会把 agent 的**每一个事件**序列化后打到 stdout。
其中 `message_update` 事件（流式增量）每次携带**两份完整累计消息快照**：

    { type: "message_update",
      assistantMessageEvent: { partial: <完整消息> },   // 第一份
      message: <完整消息> }                            // 第二份

所以 stdout 体积随回答长度呈 **O(N²)** 增长。实测（deepseek-flash，1500 字中文）：

    修改前 stdout = 88,891,776 字节 (84.8 MB)   ← 其中 message_update 占 99.9%
    修改后 stdout =     39,585 字节 (38.6 KB)   ← 缩小 2245 倍

而 Get It 用 child_process.execFile 抓 stdout，`maxBuffer: 0xa00000`（10 MB）。
图谱输出通常 3000~8000 字 ⇒ 体积几百 MB 到数 GB ⇒ 必然超限。

为什么对话没事：对话回答短（几百字），体积约 1~3 MB，侥幸没到 10 MB。
1500 字就 85 MB 了，所以这不是「图谱特有」的 bug，是长度问题。

修法
----
在 pi-cli 的 print mode 里跳过流式快照事件，只保留结构化结果事件。
Get It 侧的解析函数（chunk 里的 f()）只读 `message_end` 和 `agent_end`，
所以跳过 `message_update` 对功能零影响，usage 统计也完整保留。

用法
----
    python3 patch-pi-stdout.py "/Applications/Get It BYOK.app"

幂等：已打过补丁会直接跳过。改完必须重签名（见 resign-getit-v2.py）。
"""
import os
import re
import sys

APP = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Get It BYOK.app"
TARGET = os.path.join(
    APP,
    "Contents/Resources/app/electron/pi-bin/pi-cli/dist/modes/print-mode.js",
)

MARK = "[GetIt patch] Skip streaming snapshot events"

OLD_RE = re.compile(
    r"unsubscribe = session\.subscribe\(\(event\) => \{\s*"
    r'if \(mode === "json"\) \{\s*'
    r"writeRawStdout\(`\$\{JSON\.stringify\(event\)\}\\n`\);\s*"
    r"\}\s*\}\);"
)

NEW = """unsubscribe = session.subscribe((event) => {
            if (mode === "json") {
                // [GetIt patch] Skip streaming snapshot events. Every `message_update`
                // carries TWO full copies of the cumulative message (assistantMessageEvent.partial
                // + message), so total stdout grows O(N^2) with answer length — a 1.5k-char reply
                // already produces ~89 MB, blowing child_process maxBuffer (10 MB in Get It).
                // Consumers of --mode json (Get It's parseJsonl) only read message_end/agent_end.
                const t = event?.type;
                if (t === "message_update" || t === "tool_execution_update")
                    return;
                writeRawStdout(`${JSON.stringify(event)}\\n`);
            }
        });"""


def main() -> int:
    if not os.path.isfile(TARGET):
        print(f"❌ 找不到目标文件：{TARGET}")
        return 2

    src = open(TARGET, encoding="utf-8").read()

    if MARK in src:
        print("✅ 补丁已存在，跳过。")
        return 0

    new_src, n = OLD_RE.subn(NEW, src)
    if n != 1:
        print(f"❌ 未匹配到目标代码块（匹配 {n} 处），文件可能已被改动。")
        print("   请检查 print-mode.js 里的 session.subscribe 部分。")
        return 3

    backup = TARGET + ".pre-getit-patch"
    if not os.path.exists(backup):
        open(backup, "w", encoding="utf-8").write(src)
        print(f"   备份原始文件 → {backup}")

    open(TARGET, "w", encoding="utf-8").write(new_src)
    print("✅ 补丁已应用。")
    print("⚠️  下一步必须重签名，否则应用签名封印失效：")
    print(f'   python3 resign-getit-v2.py "{APP}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
