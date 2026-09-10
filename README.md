# dsh-turn-meter

DSH（DeepSeek Harness）插件：**把 token 用量和费用显示出来**。

每轮回复尾部和输入框下方各有一行常驻读数，鼠标悬停展开明细。

```
9月1日 04:35 · 用时 5秒 · 首 token 1.3秒 · 133 tok/s · 1.5M tokens · ¥0.0247
                                              └──────── 本插件追加 ────────┘
```

```
2 轮 · 78 步 | LLM 8m1s · 工具调用 3m55s | 缓存命中 98% | 输入 6.3M tok · 输出 48.4K tok | ¥1.2834
                                                                                          └─ 追加 ─┘
```

## 它做一件事

显示 token 消耗与费用。**不做**预算、配额告警、余额查询、CSV 导出、趋势图。
这些应由另一个插件或使用者自己实现。

## 安装

```bash
dsh plugin --profile web add dsh-turn-meter
```

安装后**必须重启 DSH**（客户端 bundle 在启动时做服务发现），然后硬刷浏览器
（`Ctrl+Shift+R`）。

## 数据来源

| 显示项 | 来源 |
|---|---|
| tokens 四桶、时刻、用时 | DSH 官方 projection（本插件不重复计算） |
| 缓存命中率 | 官方口径 `cacheRead / (totalTokens - outputTokens)` |
| **费用** | 本插件唯一自算的部分：四桶 × 价格表 |

插件不采集、不存储任何数据。

## 计价

单位：元 / 百万 tokens。`hit`=缓存命中，`miss`=缓存未命中输入，`out`=输出。

两个独立时间边界：

| 边界 | 含义 |
|---|---|
| `2026-08-17` | 调价：此前用旧价，此后峰谷分时 |
| `2026-08-23` | 规则变更：此后周末全天按空闲计（此前周末按高峰计） |

高峰时段 9:00–12:00、14:00–18:00（北京时间），空闲价为高峰价的一半。

## 配置

### 默认价格只有一处

内置默认价格**只定义在 `lib/pricing.js` 的 `DEFAULT_PRICING`**，没有第二份副本。
插件自带的 `cordis.patch.yml` 只负责把插件挂进 profile，不含价格。

### 改价格只需写差异部分

编辑 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<name>/cordis.patch.yml`），
**只写你要改的字段**，其余自动沿用内置默认：

```yaml
- insert:
    - id: turn-meter
      name: 'dsh-turn-meter'
      config:
        pricing:
          # 例1：只调 flash 的高峰价（off / before 保持默认）
          models:
            deepseek-flash:
              peak: { hit: 0.04, miss: 2, out: 8 }
```

```yaml
          # 例2：只改兜底模型
          defaultModel: 'deepseek-v4-pro'
```

```yaml
          # 例3：改峰谷时段
          peakWindows: [[10, 12], [15, 18]]
```

合并是**逐层增量**的：模型 → 档位（before/peak/off）→ 字段。
改 `peak` 不会丢掉 `off`；改一个模型不会影响其他模型；不写的全局字段保留默认。

- 配置格式错误 → **插件加载时报错**，不静默按零价计费
- 模型没有匹配价格 → **该读数不显示**，不显示 `¥0`
- `defaultModel`：兜底模型，仅当某轮取不到模型名（`routes` 缺失）时使用。
  正常情况下会话级逐轮读取真实模型，此值不参与计价

改完**重启 dsh** 生效。

## 会话聚合

- 无 fork：累加本会话全部轮次
- 有 fork：从 fork 点开始累加（fork 前的历史属于父会话，不重复计入）

## 实现要点

| 槽位 | order | priority | 说明 |
|---|---|---|---|
| `conversation.chat.assistant-actions` | 10 | 0 | 每轮追加，`list` 类型可并存 |
| `conversation.composer.dock` | 0 | **-1** | 遮蔽官方 `stats` 行（lowest renders） |

> `order` 只管渲染顺序，`priority` 才是遮蔽判定键。两者是独立字段，
> 改 `order` 无法替换官方同 id 条目。

## 文件

```
lib/pricing.js   价格表默认值、配置校验、峰谷判定与计价
lib/index.js     宿主端：读配置，暴露 GET /turn-meter
lib/client.js    客户端：两个徽章 + 悬停明细卡片
cordis.patch.yml bundle patch + 默认价格表配置
```
