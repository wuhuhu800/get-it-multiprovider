# Gatekeeper 启动拦截排查笔记（macOS）

> 适用：macOS 12 Monterey 及以上。记录的是「签名完全正确、`spctl` 报 accepted，双击仍然弹窗」这一类问题的定位过程。

---

## 一、现象

自己签好一个 Electron 应用后，各层检查都通过：

| 检查 | 结果 |
|---|---|
| `codesign --verify --deep --strict` | 通过（EXIT=0） |
| `spctl -a -vvv --type execute` | `accepted` |
| 签名主体 | 与预期证书一致 |

但双击图标仍弹：

> "Get It" 将对您的电脑造成伤害。您应该将它移到废纸篓。

点「好」之后进程直接消失，`spctl --status` 显示 Gatekeeper 正常开启。

---

## 二、根因：拒绝结论缓存在目录 inode 上

不是签名坏了，也不是证书有问题——**macOS 把 exec 决策结果缓存到了文件系统对象上，键是目录 inode**。

证据链：

1. `spctl -a` 显示 `accepted`，但双击仍弹窗 → 说明弹窗的判定不走 `spctl` 那条评估路径
2. syspolicyd 日志里多次尝试（跨不同时间点）都记录同一个 `objid`
3. `stat -f "%i" "<app>"` 的输出**正好等于**日志里的 `objid` → 说明这个 id 就是 `.app` 目录本身的 inode
4. 结论：拒绝结果按目录对象记录在 syspolicyd 的决策缓存里。重新签名、改 bundle id、清 xattr **都不会**触发重新评估——因为 inode 没变

查看方式：

```bash
log show --last 5m --predicate 'process == "syspolicyd"' 2>&1 | grep -E "objid|rejection" | tail -20
stat -f "%i" "/Applications/YourApp.app"
```

**验证方式**：用 `ditto` 复制出一份（新 inode），`spctl -a` 立刻 accepted，双击直接启动成功。之后再改名，inode 不变，仍正常启动——因为缓存绑 inode，不绑路径。

---

## 三、为什么 `spctl --add` 看起来没用

`spctl --add` 加的是一条**策略规则**（按代码要求匹配），`spctl -a` 走的就是这条路，所以显示 accepted。

但实际双击时，syspolicyd 先查 **exec 决策缓存**，命中旧的拒绝记录就直接杀掉进程，根本走不到策略层。

> 所以「`spctl -a` 显示 accepted 却还弹窗」这个矛盾现象，只有 inode 缓存能解释。

---

## 四、为什么不建议全局关闭 Gatekeeper

`sudo spctl --global-disable` 确实能让弹窗消失，但不推荐：

- **副作用覆盖全机**：机器上所有应用都失去保护，不只是这一个
- **不持久**：实测系统会自行恢复成 `assessments enabled`，等于白关一次
- **`--master-disable` 已不存在**：macOS 12 起该参数被移除，写旧教程里的命令会直接报错

换 inode 的做法只影响这一个应用，不动任何系统设置。

---

## 五、复发时按评估结果分支处理

```bash
spctl -a -vvv --type execute "/Applications/YourApp.app"
```

| 输出 | 含义 | 处理 |
|---|---|---|
| `accepted` 但仍弹窗 | 决策缓存绑在旧 inode 上 | `scripts/fix-gatekeeper-inode.sh "<app>"` |
| `rejected` | 包内有二进制没签好（常见是 `node_modules` 里的裸 Mach-O） | `python3 scripts/resign-app.py "<app>"` |
| `CSSMERR_TP_CERT_REVOKED` | 证书信任链断了 | 重新把证书加入信任，再重签 |

手工换 inode 的最小写法：

```bash
ditto "/Applications/YourApp.app" "/Applications/YourApp 2.app"
open -a "/Applications/YourApp 2.app"
```

`ditto` 会创建全新文件系统对象，syspolicyd 那边没有历史记录。

---

## 六、排查顺序建议

遇到启动失败，按这个顺序逐层排除，不要一上来就重签：

1. **先看 `codesign --verify --deep --strict`** —— 不通过就是签名问题，先修签名
2. **再看 `spctl -a`** —— `rejected` 说明还有未签的 Mach-O；`accepted` 就跳到第 4 步
3. **看 `spctl --status`** —— 确认 Gatekeeper 是开启状态，排除被人为关过又恢复的干扰
4. **对比 `objid` 与目录 inode** —— 相等就是缓存问题，换 inode 即可
5. **最后才考虑浏览器版兜底** —— Next.js standalone 服务用系统 node 就能跑，完全绕开签名

前四步都不需要改动应用内容，也不改系统设置。
