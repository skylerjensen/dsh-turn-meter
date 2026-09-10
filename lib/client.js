/**
 * dsh-turn-meter — client side.
 *
 * Two always-visible readouts:
 *   per reply    conversation.chat.assistant-actions  (appended after the official time text)
 *   per session  conversation.composer.dock           (shadows the official stats row)
 *
 * Hovering either one opens a detail card with input / cache-read / output,
 * the cache-hit bar (solid = hit, dashed = miss) and the unit price in force.
 *
 * Data contract: every token figure comes from DSH's own projections
 * (turn-tail node data per reply, `tokenUsage` / `sessionStats` per session).
 * This plugin contributes pricing only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-meter',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    // ---------------------------------------------------------------- pricing

    let configCache = null
    let configPending = null
    const configSubs = new Set()

    function loadConfig() {
      if (configCache !== null) return Promise.resolve(configCache)
      if (configPending === null) {
        configPending = fetch('/turn-meter', { headers: { Accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => {
            configCache = d && d.pricing ? { pricing: d.pricing, debug: d.debug === true } : null
            return configCache
          })
          .catch(() => null)
          .then((v) => {
            configPending = null
            configSubs.forEach((f) => f(v))
            return v
          })
      }
      return configPending
    }

    function useConfig() {
      const [value, setValue] = react.useState(configCache)
      react.useEffect(() => {
        if (configCache !== null) return
        let alive = true
        loadConfig().then((p) => { if (alive && p !== null) setValue(p) })
        return () => { alive = false }
      }, [])
      react.useEffect(() => {
        const f = (p) => { if (p !== null) setValue(p) }
        configSubs.add(f)
        return () => { configSubs.delete(f) }
      }, [])
      return value
    }

    // ----------------------------------------------------------- calc (mirror)

    function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0 }

    function bandOf(pricing, timeMs) {
      const tz = Number.isFinite(pricing.timezoneOffsetMinutes) ? pricing.timezoneOffsetMinutes : 480
      const shifted = new Date(timeMs + tz * 60_000)
      const dow = shifted.getUTCDay()
      const weekendFrom = Date.parse(pricing.weekendOffPeakFrom)
      if (Number.isFinite(weekendFrom) && timeMs >= weekendFrom && (dow === 0 || dow === 6)) return 'off'
      const boundary = Date.parse(pricing.boundary)
      if (Number.isFinite(boundary) && timeMs < boundary) return 'before'
      const hour = shifted.getUTCHours()
      const inPeak = (pricing.peakWindows || []).some((w) => Array.isArray(w) && hour >= w[0] && hour < w[1])
      return inPeak ? 'peak' : 'off'
    }

    function computeCost(pricing, usage, timeMs, model) {
      const key = pricing.models[model] !== undefined ? model : pricing.defaultModel
      const entry = pricing.models[key]
      if (entry === undefined) return null
      const band = bandOf(pricing, timeMs)
      const rate = entry[band] !== undefined ? entry[band] : (entry.off ?? entry.peak ?? entry.before)
      if (rate === undefined) return null
      const cacheRead = num(usage.cacheReadTokens)
      const cacheWrite = num(usage.cacheWriteTokens)
      const uncached = num(usage.uncachedInputTokens)
      const output = num(usage.outputTokens)
      const input = uncached + cacheWrite
      const billed = input + cacheRead
      const cost = (cacheRead * rate.hit + input * rate.miss + output * rate.out) / 1e6
      return {
        model: key,
        band,
        rate,
        input,
        cacheRead,
        output,
        total: num(usage.totalTokens) || (billed + output),
        hitPct: billed > 0 ? (cacheRead / billed) * 100 : null,
        cost,
      }
    }

    // -------------------------------------------------------------- formatting

    function fmtTokens(n) {
      const v = num(n)
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
      return String(Math.round(v))
    }

    function fmtGroup(n) {
      return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtDuration(ms) {
      const v = num(ms)
      if (v <= 0) return '0秒'
      const s = Math.round(v / 1000)
      if (s < 60) return s + '秒'
      const m = Math.floor(s / 60)
      const rs = s % 60
      if (m < 60) return m + '分' + String(rs).padStart(2, '0') + '秒'
      return Math.floor(m / 60) + '小时' + String(m % 60).padStart(2, '0') + '分'
    }

    function fmtMoney(v) {
      const n = num(v)
      return n >= 100 ? n.toFixed(2) : n.toFixed(4)
    }

    function bandLabel(band) {
      return band === 'before' ? '调价前旧价' : band === 'peak' ? '高峰' : '空闲'
    }

    function fmtClock(ms) {
      const t = num(ms)
      if (t <= 0) return ''
      const d = new Date(t)
      const p = (x) => String(x).padStart(2, '0')
      return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    // ------------------------------------------------------------------ styles

    const S = {
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        marginLeft: '6px',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        flex: 'none',
      },
      sep: { opacity: 0.45 },
      money: { color: 'var(--dsw-alias-label-secondary, #b8bcc4)' },
      anchor: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      card: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: '8px',
        zIndex: 60,
        minWidth: '220px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-background-float, #1b1d21)',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.12))',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        color: 'var(--dsw-alias-label-secondary, #d6d9de)',
        fontSize: '11px',
        lineHeight: '1.7',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: '18px' },
      label: { opacity: 0.65 },
      value: { fontVariantNumeric: 'tabular-nums' },
      rule: {
        height: '1px',
        margin: '5px 0',
        background: 'var(--dsw-alias-border-subtle, rgba(255,255,255,0.12))',
      },
      track: {
        position: 'relative',
        display: 'inline-block',
        width: '72px',
        height: '6px',
        borderRadius: '3px',
        overflow: 'hidden',
        border: '1px solid currentColor',
        opacity: 0.85,
        verticalAlign: 'middle',
      },
      root: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
    }

    function Sep() { return h('span', { style: S.sep }, '·') }

    /** Cache-hit bar: solid = hit, dashed = miss. */
    function HitBar({ pct }) {
      const p = Math.max(0, Math.min(100, num(pct)))
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: S.track },
          h('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: p + '%', background: 'currentColor' } }),
          h('span', {
            style: {
              position: 'absolute', right: 0, top: 0, bottom: 0, width: (100 - p) + '%',
              backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 2px, transparent 2px 4px)',
              opacity: 0.45,
            },
          }),
        ),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, p.toFixed(1) + '%'),
      )
    }

    function Row({ label, value }) {
      return h('div', { style: S.row },
        h('span', { style: S.label }, label),
        h('span', { style: S.value }, value),
      )
    }

    /** Hover card anchored above the readout. */
    function Card({ readout, detail }) {
      const [open, setOpen] = react.useState(false)
      return h('span', {
        style: S.anchor,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
      }, readout, open ? h('span', { style: S.card }, detail) : null)
    }

    // -------------------------------------------------------- turn (per reply)

    /** Find the turn-tail node that closed with this messageId. */
    function findTurnTail(snapshot, messageId) {
      if (!messageId || !snapshot || typeof snapshot.nodes?.values !== 'function') return undefined
      const nodes = snapshot.nodes.values()
      for (let i = 0; i < nodes.length; i++) {
        const d = nodes[i]?.data
        if (!d) continue
        const mid = d.closing?.finalNode?.messageId
        if (mid !== undefined && mid === messageId) return nodes[i]
      }
      return undefined
    }

    /**
     * Flat string signature of a turn's usage, so the selector stays
     * referentially stable across snapshot publishes.
     */
    function turnSig(snapshot, messageId) {
      const node = findTurnTail(snapshot, messageId)
      if (!node) return ''
      const d = node.data
      const u = d.tokenUsage || {}
      const turn = node.location?.turn
      const route = Array.isArray(u.routes) && u.routes[0] ? u.routes[0] : {}
      return [
        num(u.totalTokens),
        num(u.uncachedInputTokens),
        num(u.cacheReadTokens),
        num(u.cacheWriteTokens),
        num(u.outputTokens),
        route.model || '',
        num(d.closing?.time || d.time),
        num(turn?.start?.time),
        num(turn?.end?.time),
      ].join('|')
    }

    /**
     * Fallback source: the session snapshot's AssistantMessageNode, which carries
     * `usage`, `requestConfig.model` and `timing` on the node itself.
     * Shapes differ between providers, so read defensively.
     */
    function readUsage(u) {
      if (!u || typeof u !== 'object') return null
      const pick = (...keys) => {
        for (const k of keys) {
          const v = u[k]
          if (typeof v === 'number' && Number.isFinite(v)) return v
        }
        return 0
      }
      const cacheRead = pick('cacheReadTokens', 'cache_read_tokens', 'prompt_cache_hit_tokens')
      const cacheWrite = pick('cacheWriteTokens', 'cache_write_tokens')
      const uncached = pick('uncachedInputTokens', 'inputTokens', 'prompt_cache_miss_tokens')
        || Math.max(0, pick('prompt_tokens', 'input_tokens') - cacheRead)
      const output = pick('outputTokens', 'completion_tokens', 'output_tokens')
      const total = pick('totalTokens', 'total_tokens') || (uncached + cacheRead + cacheWrite + output)
      if (total === 0 && output === 0) return null
      return {
        totalTokens: total,
        uncachedInputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
      }
    }

    function sessSig(snapshot, messageId) {
      const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : []
      for (const n of nodes) {
        if (!n || n.kind !== 'assistant' || n.messageId !== messageId) continue
        const u = readUsage(n.usage)
        if (!u) return ''
        const rc = n.requestConfig || {}
        const timing = n.timing || {}
        return [
          u.totalTokens, u.uncachedInputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.outputTokens,
          rc.model || rc.modelName || '',
          num(n.time),
          num(timing.stepStartTime),
          num(timing.completedTime),
        ].join('|')
      }
      return ''
    }

    const NOOP_HOOK = () => ''

    function TurnBadge(props) {
      const { messageId } = props
      const cfg = useConfig()
      const pricing = cfg === null ? null : cfg.pricing
      const debug = cfg !== null && cfg.debug === true
      // Wrap missing hooks in a noop so both are always called — hook order
      // must never change between renders.
      const chatHook = typeof props.useChat === 'function' ? props.useChat : NOOP_HOOK
      const sessHook = typeof props.useSession === 'function' ? props.useSession : NOOP_HOOK
      const chatSig = chatHook((s) => turnSig(s, messageId))
      const sSig = sessHook((s) => sessSig(s, messageId))
      const sig = chatSig || sSig

      if (debug) {
        return h('span', { 'data-turn-meter-debug': '', style: S.badge },
          `[tm C=${typeof props.useChat === 'function' ? 1 : 0} S=${typeof props.useSession === 'function' ? 1 : 0}`
          + ` chat=${chatSig ? 1 : 0} sess=${sSig ? 1 : 0}]`)
      }
      if (!sig) return null
      const p = sig.split('|')
      const usage = {
        totalTokens: +p[0],
        uncachedInputTokens: +p[1],
        cacheReadTokens: +p[2],
        cacheWriteTokens: +p[3],
        outputTokens: +p[4],
      }
      const model = p[5] || ''
      const timeMs = +p[6] || Date.now()
      const runMs = (+p[8] || 0) > 0 && (+p[7] || 0) > 0 ? +p[8] - +p[7] : 0
      if (usage.totalTokens === 0 && usage.outputTokens === 0) return null
      const c = pricing === null ? null : computeCost(pricing, usage, timeMs, model)
      if (c === null) return null

      return h(Card, {
        readout: h('span', { 'data-turn-meter-badge': '', style: S.badge },
          h(Sep, null),
          h('span', null, fmtTokens(c.total) + ' tokens'),
          h(Sep, null),
          h('span', { style: S.money }, '¥' + fmtMoney(c.cost)),
        ),
        detail: h('div', null,
          h(Row, { label: '模型', value: c.model }),
          h('div', { style: S.rule }),
          h(Row, { label: '输入', value: fmtGroup(c.input) }),
          h(Row, { label: '缓存读', value: fmtGroup(c.cacheRead) }),
          h(Row, { label: '输出', value: fmtGroup(c.output) }),
          h('div', { style: S.rule }),
          h('div', { style: S.row },
            h('span', { style: S.label }, '缓存命中'),
            h(HitBar, { pct: c.hitPct === null ? 0 : c.hitPct }),
          ),
          h('div', { style: S.rule }),
          h(Row, {
            label: '单价',
            value: `¥${c.rate.miss}/${c.rate.hit}/${c.rate.out}（${bandLabel(c.band)}）`,
          }),
          h(Row, { label: '本轮费用', value: '¥' + fmtMoney(c.cost) }),
          runMs > 0 ? h(Row, { label: '用时', value: fmtDuration(runMs) }) : null,
          h(Row, { label: '时刻', value: fmtClock(timeMs) }),
        ),
      })
    }

    // ------------------------------------------------------ session (composer)

    /**
     * Encode every completed turn as `model,cacheRead,input,output,time`.
     * A string signature keeps the selector referentially stable.
     */
    function sessionUsageSig(snapshot) {
      const nodes = snapshot && typeof snapshot.nodes?.values === 'function' ? snapshot.nodes.values() : []
      const items = []
      for (const n of nodes) {
        const d = n?.data
        if (!d) continue
        const u = d.tokenUsage
        const closing = d.closing
        if (!u || !closing) continue
        const route = Array.isArray(u.routes) && u.routes[0] ? u.routes[0] : {}
        items.push([
          route.model || '',
          num(u.cacheReadTokens),
          num(u.uncachedInputTokens) + num(u.cacheWriteTokens),
          num(u.outputTokens),
          num(closing.time || d.time),
        ].join(','))
      }
      return items.join(';')
    }

    function parseSessionSig(sig) {
      if (!sig) return []
      const out = []
      for (const s of sig.split(';')) {
        if (!s) continue
        const [m, cr, inp, outp, t] = s.split(',')
        out.push({ model: m, cacheRead: +cr, input: +inp, output: +outp, time: +t })
      }
      return out
    }

    /**
     * Price the session turn by turn, using each turn's own model and timestamp.
     * This is the only way to be correct for mixed-model sessions and for
     * sessions that straddle a peak/off-peak boundary.
     */
    function computeSession(pricing, turns) {
      let cost = 0
      let cacheRead = 0
      let input = 0
      let output = 0
      const byModel = {}
      for (const t of turns) {
        const model = pricing.models[t.model] !== undefined ? t.model : pricing.defaultModel
        const entry = pricing.models[model]
        if (entry === undefined) continue
        const band = bandOf(pricing, t.time)
        const rate = entry[band] !== undefined ? entry[band] : (entry.off ?? entry.peak ?? entry.before)
        if (rate === undefined) continue
        const c = (t.cacheRead * rate.hit + t.input * rate.miss + t.output * rate.out) / 1e6
        cost += c
        cacheRead += t.cacheRead
        input += t.input
        output += t.output
        const b = byModel[model] !== undefined ? byModel[model] : (byModel[model] = { cacheRead: 0, input: 0, output: 0, cost: 0 })
        b.cacheRead += t.cacheRead
        b.input += t.input
        b.output += t.output
        b.cost += c
      }
      const billed = input + cacheRead
      return {
        cost,
        cacheRead,
        input,
        output,
        total: billed + output,
        hitPct: billed > 0 ? (cacheRead / billed) * 100 : null,
        byModel,
        turns: turns.length,
      }
    }

    function SessionStats(props) {
      const { useProjection } = props
      const cfg = useConfig()
      const pricing = cfg === null ? null : cfg.pricing
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
      const stats = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined

      const groups = []
      if (stats && num(stats.steps) > 0) {
        groups.push(num(stats.turns) + ' 轮 · ' + num(stats.steps) + ' 步')
        const durs = []
        if (num(stats.llmMs) > 0) durs.push('LLM ' + fmtDuration(stats.llmMs))
        if (num(stats.toolMs) > 0) durs.push('工具调用 ' + fmtDuration(stats.toolMs))
        if (durs.length > 0) groups.push(durs.join(' · '))
      }

      // Prefer walking every turn: only that path knows each turn's real model.
      const chatHook = typeof props.useChat === 'function' ? props.useChat : NOOP_HOOK
      const turns = parseSessionSig(chatHook((s) => sessionUsageSig(s)))
      const walked = pricing !== null && turns.length > 0 ? computeSession(pricing, turns) : null
      // Fallback: the session projection has no model split → defaultModel.
      const c = walked !== null
        ? walked
        : (pricing !== null && usage ? computeCost(pricing, usage, Date.now(), pricing.defaultModel) : null)

      if (c !== null && c.input + c.cacheRead + c.output > 0) {
        groups.push(`输入 ${fmtTokens(c.input + c.cacheRead)} tok · 输出 ${fmtTokens(c.output)} tok`)
      } else if (usage) {
        const billed = num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
        if (billed + num(usage.outputTokens) > 0) {
          groups.push(`输入 ${fmtTokens(billed)} tok · 输出 ${fmtTokens(usage.outputTokens)} tok`)
        }
      }
      const hitPct = c !== null ? c.hitPct : null
      if (hitPct !== null) groups.push('缓存命中 ' + hitPct.toFixed(0) + '%')

      if (groups.length === 0 && c === null) return null

      const parts = []
      groups.forEach((g, i) => {
        if (i > 0) parts.push(h('span', { key: 's' + i, style: S.sep }, '|'), ' ')
        parts.push(h('span', { key: 'g' + i }, g))
      })
      if (c !== null) {
        if (parts.length > 0) parts.push(h('span', { key: 'sm', style: S.sep }, '|'), ' ')
        parts.push(h('span', { key: 'cost', style: S.money }, '¥' + fmtMoney(c.cost)))
      }

      return h(Card, {
        readout: h('span', { 'data-turn-meter-session': '', style: S.root }, parts),
        detail: h('div', null,
          stats ? h(Row, { label: '轮次', value: num(stats.turns) + ' 轮 · ' + num(stats.steps) + ' 步' }) : null,
          stats && num(stats.llmMs) > 0 ? h(Row, { label: 'LLM', value: fmtDuration(stats.llmMs) }) : null,
          stats && num(stats.toolMs) > 0 ? h(Row, { label: '工具调用', value: fmtDuration(stats.toolMs) }) : null,
          c ? h('div', { style: S.rule }) : null,
          c ? h(Row, { label: '输入', value: fmtGroup(c.input) }) : null,
          c ? h(Row, { label: '缓存读', value: fmtGroup(c.cacheRead) }) : null,
          c ? h(Row, { label: '输出', value: fmtGroup(c.output) }) : null,
          c ? h('div', { style: S.rule }) : null,
          c ? h('div', { style: S.row },
            h('span', { style: S.label }, '缓存命中'),
            h(HitBar, { pct: c.hitPct === null ? 0 : c.hitPct }),
          ) : null,
          // Per-model breakdown — only the walked path can produce this.
          walked ? h('div', { style: S.rule }) : null,
          walked
            ? Object.keys(walked.byModel).map((m, i) => {
                const b = walked.byModel[m]
                return h(Row, {
                  key: 'm' + i,
                  label: m,
                  value: `¥${fmtMoney(b.cost)} · ${fmtTokens(b.input + b.cacheRead)}→${fmtTokens(b.output)}`,
                })
              })
            : null,
          !walked && c ? h(Row, { label: '模型', value: c.model }) : null,
          !walked && c ? h(Row, {
            label: '单价',
            value: `¥${c.rate.miss}/${c.rate.hit}/${c.rate.out}（${bandLabel(c.band)}）`,
          }) : null,
          c ? h('div', { style: S.rule }) : null,
          c ? h(Row, { label: '会话费用', value: '¥' + fmtMoney(c.cost) }) : null,
        ),
      })
    }

    // ------------------------------------------------------------------- apply

    function apply(ctx) {
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'dsh-turn-meter-turn', order: 10 },
          TurnBadge,
        ),
      )
      // Shadow the official stats row: same id, lower priority (lowest renders).
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'stats', order: 0, priority: -1 },
          SessionStats,
        ),
      )
    }

    const exports = {}
    exports.inject = ['slots']
    exports.apply = apply
    return exports
  },
})
