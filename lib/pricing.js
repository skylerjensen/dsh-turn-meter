/**
 * Pricing table: defaults (official DeepSeek rates) + config normalization.
 *
 * Units: CNY per 1M tokens.
 *   hit  = cache read  (缓存命中)
 *   miss = cache miss  (缓存未命中输入 = uncachedInput + cacheWrite)
 *   out  = output      (输出)
 *
 * Two independent time boundaries:
 *   boundary            price change      (2026-08-17)
 *   weekendOffPeakFrom  rule change       (2026-08-23, weekends count off-peak)
 */

/**
 * Rates below were read from https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * on 2026-09-11. Units: CNY per 1M tokens.
 *
 *   deepseek-flash  = DeepSeek-V4.1-Flash (official current name)
 *   deepseek-v4-flash = legacy alias, still routable; served by V4.1-Flash
 *   deepseek-v4-pro = V4 Pro; routed to V4.1-Flash after 2026-09-14 12:00 CST
 */
export const DEFAULT_PRICING = {
  currency: 'CNY',
  symbol: '¥',
  boundary: '2026-08-17T00:00:00+08:00',
  weekendOffPeakFrom: '2026-08-23T00:00:00+08:00',
  peakWindows: [[9, 12], [14, 18]],
  timezoneOffsetMinutes: 480,
  defaultModel: 'deepseek-flash',
  models: {
    'deepseek-flash': {
      before: { hit: 0.02, miss: 1, out: 2 },
      peak: { hit: 0.04, miss: 2, out: 8 },
      off: { hit: 0.02, miss: 1, out: 4 },
    },
    'deepseek-v4-flash': {
      before: { hit: 0.02, miss: 1, out: 2 },
      peak: { hit: 0.04, miss: 2, out: 8 },
      off: { hit: 0.02, miss: 1, out: 4 },
    },
    'deepseek-v4-pro': {
      before: { hit: 0.025, miss: 3, out: 6 },
      peak: { hit: 0.3, miss: 9, out: 27 },
      off: { hit: 0.15, miss: 4.5, out: 13.5 },
    },
  },
}

const BANDS = ['before', 'peak', 'off']

function fail(what) {
  throw new Error(`[dsh-turn-meter] pricing config error: ${what}`)
}

function num(v, what) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) fail(`${what} must be a non-negative number, got ${JSON.stringify(v)}`)
  return n
}

/**
 * Merge one model's bands over `base` (the built-in default for that model,
 * if any). Band-level merge, so overriding `peak` alone keeps the default
 * `off` / `before` rather than dropping them.
 */
function normalizeBands(raw, modelName, base) {
  const out = { ...(base && typeof base === 'object' ? base : {}) }
  let touched = 0
  for (const band of BANDS) {
    const r = raw?.[band]
    if (r === undefined) continue
    if (typeof r !== 'object' || r === null) fail(`models.${modelName}.${band} must be an object`)
    out[band] = {
      hit: num(r.hit, `models.${modelName}.${band}.hit`),
      miss: num(r.miss, `models.${modelName}.${band}.miss`),
      out: num(r.out, `models.${modelName}.${band}.out`),
    }
    touched++
  }
  if (Object.keys(out).length === 0) fail(`models.${modelName} has no pricing band (before/peak/off)`)
  if (touched === 0 && base === undefined) {
    // A brand-new model must come with at least one band explicitly.
    fail(`models.${modelName} is new but declares no band (before/peak/off)`)
  }
  return out
}

/**
 * Merge a user pricing override over the defaults.
 * Fails loudly on malformed input — a wrong price is worse than no display.
 */
export function normalizePricing(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const models = { ...DEFAULT_PRICING.models }
  if (src.models !== undefined) {
    if (typeof src.models !== 'object' || src.models === null) fail('models must be an object')
    for (const [name, bands] of Object.entries(src.models)) {
      models[name] = normalizeBands(bands, name, models[name])
    }
  }
  const pricing = {
    currency: typeof src.currency === 'string' ? src.currency : DEFAULT_PRICING.currency,
    symbol: typeof src.symbol === 'string' ? src.symbol : DEFAULT_PRICING.symbol,
    boundary: typeof src.boundary === 'string' ? src.boundary : DEFAULT_PRICING.boundary,
    weekendOffPeakFrom:
      typeof src.weekendOffPeakFrom === 'string' ? src.weekendOffPeakFrom : DEFAULT_PRICING.weekendOffPeakFrom,
    peakWindows: Array.isArray(src.peakWindows) && src.peakWindows.length > 0
      ? src.peakWindows.map((w, i) => {
          if (!Array.isArray(w) || w.length !== 2) fail(`peakWindows[${i}] must be [startHour, endHour]`)
          return [num(w[0], `peakWindows[${i}][0]`), num(w[1], `peakWindows[${i}][1]`)]
        })
      : DEFAULT_PRICING.peakWindows,
    timezoneOffsetMinutes: src.timezoneOffsetMinutes === undefined
      ? DEFAULT_PRICING.timezoneOffsetMinutes
      : num(src.timezoneOffsetMinutes, 'timezoneOffsetMinutes'),
    defaultModel: typeof src.defaultModel === 'string' ? src.defaultModel : DEFAULT_PRICING.defaultModel,
    models,
  }
  if (Date.parse(pricing.boundary) === Number.NaN) fail(`boundary is not a valid date: ${pricing.boundary}`)
  if (pricing.weekendOffPeakFrom !== '' && Number.isNaN(Date.parse(pricing.weekendOffPeakFrom))) {
    fail(`weekendOffPeakFrom is not a valid date: ${pricing.weekendOffPeakFrom}`)
  }
  if (pricing.models[pricing.defaultModel] === undefined) {
    fail(`defaultModel "${pricing.defaultModel}" has no pricing entry`)
  }
  return pricing
}

/**
 * @returns 'before' | 'peak' | 'off' — the band a given instant falls into.
 */
export function bandOf(pricing, timeMs) {
  const tz = Number.isFinite(pricing.timezoneOffsetMinutes) ? pricing.timezoneOffsetMinutes : 480
  const shifted = new Date(timeMs + tz * 60_000)
  const dow = shifted.getUTCDay()
  const weekendFrom = Date.parse(pricing.weekendOffPeakFrom)
  // Since 2026-08-23 weekends are off-peak all day; before that they billed as peak.
  if (Number.isFinite(weekendFrom) && timeMs >= weekendFrom && (dow === 0 || dow === 6)) return 'off'
  const boundary = Date.parse(pricing.boundary)
  if (Number.isFinite(boundary) && timeMs < boundary) return 'before'
  const hour = shifted.getUTCHours()
  const inPeak = (pricing.peakWindows || []).some(
    (w) => Array.isArray(w) && hour >= w[0] && hour < w[1],
  )
  return inPeak ? 'peak' : 'off'
}

/**
 * Cost one usage record.
 * @param usage - { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens }
 * @param model - resolved model id; falls back to pricing.defaultModel
 */
export function computeCost(pricing, usage, timeMs, model) {
  const key = pricing.models[model] !== undefined ? model : pricing.defaultModel
  const entry = pricing.models[key]
  if (entry === undefined) return null
  const band = bandOf(pricing, timeMs)
  const rate = entry[band] ?? entry.off ?? entry.peak ?? entry.before
  if (rate === undefined) return null

  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0
  const uncached = Number(usage.uncachedInputTokens) || 0
  const output = Number(usage.outputTokens) || 0
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
    total: Number(usage.totalTokens) || (billed + output),
    // Official口径: cacheRead / (totalTokens - outputTokens)
    hitPct: billed > 0 ? (cacheRead / billed) * 100 : null,
    cost,
  }
}
