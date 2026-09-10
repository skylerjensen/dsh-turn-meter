# dsh-turn-meter

> **先记着需求是什么**：JXP 用 DeepSeek Harness 时想知道自己跑会话花了多少钱，
> 而且希望像 CodeBuddy 那样**每条回复下面就直接看到这一轮花了多少**，
> 不用去翻面板、不用点开。
>
> 调研了 6 个社区插件后确认：**没有一家做轮次级**，全是会话级汇总。
> 于是自己写，定位是唯一一个做「每轮」的。

## 它做一件事

**把 token 用量和费用显示出来。** 两个位置，都常驻，鼠标悬停看明细。

```
9月1日 04:35 · 用时 5秒 · 首 token 1.3秒 · 133 tok/s · 1.5M tokens · ¥0.0247
                                              └────────── 本插件 ──────────┘
```

```
2 轮 · 78 步 | 缓存命中 98% | 输入 6.3M tok · 输出 48.4K tok | ¥0.0556
                                                              └─ 本插件 ─┘
```

悬停展开明细（以会话为例）：

```
轮次        2 轮 · 78 步
──────────────────────────────
输入        6.3M
缓存读      4.1M
输出        48.4K
──────────────────────────────
缓存命中    [█████████░]  98%
            └实线命中┘└虚线未命中┘
──────────────────────────────
deepseek-flash   ¥0.0556 · 6.3M→48.4K     ← 按真实模型拆分
会话费用    ¥0.0556
```

**不做**：预算、配额告警、官方余额查询、CSV/JSON 导出、趋势图、价格在线同步。
这些属于另一个插件，或使用者自己接。一个插件只做一件事。

## 安装

```bash
dsh plugin --profile web add github:skylerjensen/dsh-turn-meter
```

安装后**必须重启 DSH**（客户端 bundle 在启动时做服务发现），再硬刷浏览器
（`Ctrl+Shift+R`）。

> dsh 0.1.5+ 启用了 token 认证，访问 URL 形如
> `http://127.0.0.1:3080/?token=xxx`，从启动日志里取。

## 数据来源：只补充 DSH 没有的那一项

| 显示项 | 来源 |
|---|---|
| tokens 四桶、时刻、用时 | DSH 官方 projection，本插件不重算 |
| 缓存命中率 | 官方口径 `cacheRead / (total - output)` |
| **费用** | **本插件唯一自算的部分**：四桶 × 价格表 |

插件不采集、不存储任何数据，宿主端只做一件事：把价格表通过 `GET /turn-meter`
发给浏览器。

## 计价

单位：元 / 百万 tokens。`hit`=缓存命中，`miss`=缓存未命中输入，`out`=输出。

**会话费用是逐轮求和**，不是整段按一个模型算——因此混合模型会话、跨峰谷会话
都能各自按真实情况计价。

两个独立时间边界：

| 边界 | 含义 |
|---|---|
| `2026-08-17` | 调价：此前用旧价，此后峰谷分时 |
| `2026-08-23` | 规则变更：此后周末全天按空闲计（此前周末按高峰计） |

高峰 9:00–12:00、14:00–18:00（北京时间），空闲价为高峰价的一半。

内置价格取自官方页（2026-09-11 核对）：
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>

- `deepseek-flash` 是官方现用名；`deepseek-v4-flash` 是旧别名，同价
- `deepseek-v4-pro` **2026-09-14 12:00 后将路由到 Flash 并按 Flash 计价**，
  但价格表仍按 pro 算，届时会话费用会偏高（见「已知限制」）

## 配置

### 默认价格只有一处

内置默认**只定义在 `lib/pricing.js` 的 `DEFAULT_PRICING`**，没有副本。
插件自带的 `cordis.patch.yml` 只负责把插件挂进 profile，**不含价格**。

### 改价格只写差异

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**只写要改的字段**，其余沿用默认：

```yaml
- insert:
    - id: turn-meter
      name: 'dsh-turn-meter'
      config:
        pricing:
          # 例1：只调 flash 高峰价（off / before 保持默认）
          models:
            deepseek-flash:
              peak: { hit: 0.04, miss: 2, out: 8 }
          # 例2：只改兜底模型
          # defaultModel: 'deepseek-v4-pro'
          # 例3：改峰谷时段
          # peakWindows: [[10, 12], [15, 18]]
```

合并是**逐层增量**的：模型 → 档位（`before`/`peak`/`off`）→ 字段。
改 `peak` 不会丢 `off`；改一个模型不影响其他模型；不写的全局字段保留默认。

- 配置格式错误 → **加载时报错**，不静默按零价计费
- 模型没匹配价格 → **该读数不显示**，不显示 `¥0`
- `defaultModel`：兜底模型，仅当某轮取不到模型名（`routes` 缺失）时才用

改完**重启 dsh**。

## 排障

配置里设 `debug: true`，每轮回复尾部会显示数据源诊断串：

```
[tm C=1 S=0 chat=0 sess=1]
```

`C`/`S` = `useChat`/`useSession` 钩子是否存在；`chat`/`sess` = 对应数据源是否取到数据。
两者只要有其一为 1 就正常。

## 已知限制

1. **fork 会话未处理**
   会话费用会**包含 fork 之前的父会话轮次**。规则本应是「有 fork 从 fork 点
   开始累加」，但快照未暴露 `seedLength`，无法定位边界。尚未实现。

2. **`deepseek-v4-pro` 下线后的计价**
   2026-09-14 12:00 后该模型请求路由到 Flash 并按 Flash 计价，
   但价格表仍按 pro 算，届时会高估（约 6 倍）。官方调价时需手动改配置。

3. **会话行的 `useProjection('sessionStats')`**
   若该 projection 不可用，会话行只显示 token 与费用，不显示轮次/步数/耗时。

## 实现要点

| 槽位 | order | priority | 说明 |
|---|---|---|---|
| `conversation.chat.assistant-actions` | 10 | 0 | 每轮追加，`list` 可并存 |
| `conversation.composer.dock` | 0 | **-1** | 遮蔽官方 `stats` 行 |

> `order` 只管渲染顺序，`priority` 才是遮蔽判定键（lowest renders）。
> 两者是独立字段，改 `order` 无法替换官方同 id 条目。

**为什么不用 `conversation.chat.turnTail`**：它是 `chain` 类型且官方用 `select`
占据，**只接受「本轮产出了文件」的轮次**，绝大多数对话轮次会被跳过。

## 文件

```
lib/pricing.js      内置价格、配置校验、峰谷判定、计价
lib/index.js        宿主端：读配置，暴露 GET /turn-meter
lib/client.js       客户端：两个徽章 + 悬停明细
cordis.patch.yml    bundle patch（不含价格，见上）
NOTES.md            10 条 DSH 插件机制踩坑记录（文档里没有的）
```

## 相关

- 需求与竞品评估：`../dsh-cost-meter/REQUIREMENTS.md`、`EVAL-*.md`
- 踩坑记录：[NOTES.md](NOTES.md)

## License

MIT
