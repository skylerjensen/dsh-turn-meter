# 开发踩坑记录

DSH 插件机制文档缺失，这些都是真机试错或读源码得到的。按"能不能用"而非
"好不好"排序，每一条都对应一次实际失败。

## 1. `cordis.patch.yml` 不能是空数组

写成 `[]` 时，bundle 不产生任何 layer，插件**完全不生效且不报任何错**。

```yaml
# ✗ 静默失效
[]

# ✓ 必须把自己插进 layer stack
- insert:
    - id: turn-meter
      name: 'dsh-turn-meter'
```

`id` 要包特定（如 `turn-meter`）；用 `stats` 这类通用名会和官方条目撞车。

判定方法：`dsh web --dump-config | grep 插件名` 有输出才算真的加载了。

## 2. `order` 与 `priority` 是两个独立字段

```ts
// packages/client/ui-slots/src/index.ts:557
options: { key?, id?, order?, label?, priority? }
// :794
const priority = options.priority ?? 0
```

| 字段 | 作用 | 默认 |
|---|---|---|
| `order` | 渲染顺序（list 内排列先后） | 0 |
| `priority` | **遮蔽（shadow）判定键**：`id + priority`，**lowest renders** | 0 |

**替换官方同 id 条目必须改 `priority`；改 `order` 无效。**
重复 `id + priority` 会直接 throw：

```
list slot "..." already has an entry with id "stats" at priority 0 (registered by x6)
— register at a different priority to shadow it (lowest renders)
```

曾把报错里的 "priority" 当作 `order` 的别名，连续两次改 `order: -1` 均无效。

## 3. 客户端 bundle 不在 boot 清单里 = 完全没加载

生效链路必须全部走通，缺一段就静默失效：

```
dsh.bundle.patch → reconcile 进 dsh.profile.bundles
  → 主进程扫描 dsh.client → 进 boot 清单 __DSH_BOOT__.entries
    → 浏览器 fetch /plugins/<pkg>/client.js
```

**改了 client.js 必须重启 DSH**，运行中的进程不会重新扫描。

## 4. 卸载后必须重启，否则浏览器报错

卸载会删掉 `node_modules/`，但已打开的页面仍按缓存的 boot 清单请求
`/plugins/<pkg>/client.js?rev=xxx`，文件已不在 → 页面顶部
`Failed to load plugins`。

**这不是插件坏了，是卸载流程缺了重启。** 固化在
`../dsh-cost-meter/scripts/plugin-cycle.sh` 里（卸 → 清残留 → 重启 → 验证）。

## 5. `turnTail` 槽位不是"每轮回复尾部"的通用入口

```ts
// ui-deliverables/src/client/index.ts:73
select: selectProducedFiles,
```

`conversation.chat.turnTail` 是 `chain` 类型（first-match-wins），
官方用 `select` 占据，**只接受"本轮产出了文件"的轮次**。
90% 的对话轮次不产文件，注册上去会被跳过。

要做"每轮都显示"，用 `conversation.chat.assistant-actions`（`list`，可并存）。

同理，看到槽位名先读 `select`，别凭名字猜语义。

## 6. 本地探活必须 `--noproxy`

```
http_proxy=http://127.0.0.1:7897   ← curl 把 127.0.0.1 的请求也发给代理
```

```bash
curl -s --noproxy '*' http://127.0.0.1:3080/    # ✓
curl -s http://127.0.0.1:3080/                  # ✗ 返回 000，假故障
```

曾因此误判服务挂了。

## 7. dsh 0.1.5+ 启用 token 认证

裸首页返回 **401**；`/turn-meter` 这类 `webServer.register` 的端点
**不在认证范围内**（不带 cookie 也 200）。

启动时日志给出带 token 的 URL，用浏览器打开一次即种下 cookie，
之后靠 cookie 访问：

```
http://127.0.0.1:3080/?token=<随机>
```

`__DSH_BOOT__` 也从 `window.` 改成 `globalThis["..."]`，
自己写的抓取脚本要跟着改。

## 8. 语法检查不要和会失败的命令串联

```bash
node -e "$(cat f.js)" && node --check f.js   # ✗ 前者报错会淹没后者输出
node --check f.js                             # ✓ 单独跑
```

曾因串联把真实的 `SyntaxError` 误判为通过，
导致插件上线后报 `loaded without registering`。

**查的是 served 版本，不是本地文件：**

```bash
curl -s --noproxy '*' http://127.0.0.1:3080/plugins/<pkg>/client.js -o /tmp/s.js
node --check /tmp/s.js
```

## 9. `dsh.bundle` 是硬门槛

`package.json` 缺 `dsh.bundle` 时，安装会警告并**只当普通依赖**，
永不加载：

```
dsh: warning: dsh-cost declares no dsh.bundle — installed as a plain dependency
```

npm 上有包 ≠ 能装。`npm view <pkg> dsh` 先看这个字段。

## 10. 参考实现

社区插件里 `dsh-usage` 是唯一实现过"每轮尾部"的，它用
`assistant-actions` + `useSession`；`dsh-usage-billing` 的 host
用 `webServer.register({ kind: 'exact', path })` + client `fetch` 传配置。
这两条路都验证可行，本插件沿用。

评估结论见 `../dsh-cost-meter/EVAL-*.md`。
