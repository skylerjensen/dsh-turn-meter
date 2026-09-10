/**
 * dsh-turn-meter — host side.
 *
 * Sole job: serve the pricing table to the client bundle.
 * Every number the UI shows comes from DSH's own projections; this plugin
 * only adds the one thing DSH does not have — money.
 */
import { normalizePricing } from './pricing.js'

export default {
  name: 'turn-meter',
  inject: ['webServer'],
  apply(ctx, config) {
    const { webServer } = ctx
    // cordis delivers row config as the second apply argument; fall back to
    // ctx.config for runtimes that seat it there instead.
    const row = (config && typeof config === 'object') ? config
      : (ctx.config && typeof ctx.config === 'object') ? ctx.config
      : {}
    const pricing = normalizePricing(row.pricing)

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/turn-meter',
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ pricing, debug: row.debug === true }))
      },
    }), 'turn-meter: pricing route')
  },
}
