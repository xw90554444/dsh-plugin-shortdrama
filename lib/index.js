/**
 * ShortDrama Studio — host half.
 *
 * Responsibilities:
 *  - own the plugin config and the project store on disk
 *  - talk to the local ComfyUI (the browser cannot: a different port is a
 *    different origin, and ComfyUI does not send CORS headers)
 *  - run the LLM stages and the renders, tracked as pollable runs
 *  - expose one JSON API to the studio UI over a web route
 *  - expose the same capabilities to the agent as tools
 */

import { createApi } from './api.js'
import { createToolsPlugin } from './tools.js'
import { compileH3Prompt, snapFrames, resolutionFor } from './pipeline/compile.js'

export const name = 'shortDrama'
/** `tools` is required; the web route is optional so headless profiles still work. */
export const inject = ['tools']

const ROUTE_PREFIX = '/shortdrama-api'
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`)
      error.code = 'body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.code = 'bad-json'
    throw error
  }
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx) {
  const api = createApi(ctx)

  ctx.provide(name, api)

  ctx.effect(() => {
    const plugin = createToolsPlugin(api)
    /** @type {Array<() => void>} */
    const disposers = []
    const scoped = {
      effect(callback) { disposers.push(callback()) },
      tools: ctx.tools,
    }
    plugin.apply(scoped)
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* a failed unregister must not block the rest */ }
      }
    }
  }, 'shortdrama.tools')

  // Runs outlive no fiber: cancel in-flight LLM calls and renders on unload.
  ctx.effect(() => () => api.disposeRuns(), 'shortdrama.runs')

  // The web half is a CHILD plugin that declares `webServer` as a hard dependency.
  //
  // Querying `ctx.get('webServer')` here instead would be a race: `ctx.get` never
  // waits, so if the carrier had not been provided yet the plugin would silently
  // skip its route and its index tap — tools working while the whole UI is dead,
  // with nothing in the logs to explain it. Declaring the dependency on a child
  // gets both behaviours right: absent carrier, the child simply stays PENDING and
  // the agent tools still work; present carrier, the child waits for it.
  ctx.plugin(webUiPlugin(api))
}

/**
 * The web-dependent half, as a child plugin.
 *
 * `inject: ['webServer']` is what makes this correct rather than lucky: the child
 * waits for the carrier, so its route and index tap are always registered when a
 * web composition exists, and it simply never activates in a headless one.
 *
 * @param {object} api the shared implementation
 */
export function webUiPlugin(api) {
  return {
    name: 'shortDramaWebUi',
    inject: ['webServer'],
    apply(ctx) {
      const webServer = ctx.webServer

      // A per-process token, injected into the shell page. Without it any local
      // process could read this API; with it, only a page the harness actually
      // served can. This is defence in depth on top of the loopback binding.
      const token = globalThis.crypto.randomUUID()

      // Hand the token to the page. Two mechanisms, deliberately:
      //
      // 1. The structured `webserver/index-inject` row is the first-class path the
      //    harness itself uses for boot data. It renders regardless of the exact
      //    markup, so it never depends on finding a `</head>` to splice into.
      // 2. `tapIndex` stays as a fallback for a composition whose SPA fallback
      //    renders raw HTML without collecting the structured table.
      //
      // Both write the same global, so whichever runs last wins with an identical
      // value. Neither can help a page that was loaded before they were
      // registered — reconnecting a WebSocket does not re-fetch index.html, which
      // is exactly why the client says "token missing" instead of failing mutely.
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__SHORTDRAMA__', value: { token, prefix: ROUTE_PREFIX } })
      })

      ctx.effect(() => webServer.tapIndex((html) => {
        const boot = `<script>globalThis.__SHORTDRAMA__=${JSON.stringify({ token, prefix: ROUTE_PREFIX })}</script>`
        if (html.includes('</head>')) return html.replace('</head>', `${boot}</head>`)
        // No head element to splice into: still deliver the token.
        return boot + html
      }), 'shortdrama.index-injection')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const seg = route.split('/').filter(Boolean)
      const method = req.method === 'POST' ? 'POST' : 'GET'

      // Media is fetched by <img>/<video> tags, which cannot set headers, so the
      // token is also accepted from the query string for asset reads only.
      const presented = req.headers['x-shortdrama-token'] ?? (seg[0] === 'asset' ? url.searchParams.get('t') : null)
      if (presented !== token) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'missing or invalid plugin token' } })
        return
      }

      try {
        // ------------------------------------------------------------ config
        if (seg[0] === 'config' && method === 'GET') return sendJson(res, 200, { ok: true, config: await api.getConfig() })
        if (seg[0] === 'config' && method === 'POST') {
          const body = await readJson(req)
          return sendJson(res, 200, { ok: true, config: await api.saveConfig(body?.patch ?? body) })
        }

        // -------------------------------------------------------- diagnostics
        if (seg[0] === 'status') {
          return sendJson(res, 200, { ok: true, status: await api.status({ fresh: url.searchParams.get('fresh') === '1' }) })
        }
        if (seg[0] === 'models') {
          return sendJson(res, 200, { ok: true, ...(await api.models({ fresh: url.searchParams.get('fresh') === '1' })) })
        }
        if (seg[0] === 'test' && method === 'POST') {
          const body = await readJson(req)
          return sendJson(res, 200, await api.testConnection(body?.baseUrl))
        }

        // ----------------------------------------------------------- projects
        if (seg[0] === 'projects' && seg.length === 1 && method === 'GET') {
          return sendJson(res, 200, { ok: true, projects: await api.listProjects() })
        }
        if (seg[0] === 'projects' && seg.length === 1 && method === 'POST') {
          return sendJson(res, 200, { ok: true, project: await api.createProject(await readJson(req)) })
        }
        if (seg[0] === 'projects' && seg[1]) {
          const id = decodeURIComponent(seg[1])
          if (method === 'GET') {
            const project = await api.getProject(id)
            return project
              ? sendJson(res, 200, { ok: true, project })
              : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no project "${id}"` } })
          }
          if (method === 'POST' && seg[2] === 'delete') {
            const removed = await api.removeProject(id)
            return sendJson(res, removed ? 200 : 404, { ok: removed, removed: removed ? id : null })
          }
          if (method === 'POST') {
            const project = await api.updateProject(id, await readJson(req))
            return project
              ? sendJson(res, 200, { ok: true, project })
              : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no project "${id}"` } })
          }
        }

        // --------------------------------------------------------- generation
        if (seg[0] === 'generate' && method === 'POST') {
          const body = await readJson(req)
          if (seg[1] === 'script') return sendJson(res, 200, await api.startScriptRun(body))
          if (seg[1] === 'cast') return sendJson(res, 200, await api.startCastRun(body))
          if (seg[1] === 'storyboard') return sendJson(res, 200, await api.startStoryboardRun(body))
          if (seg[1] === 'shotprompts') return sendJson(res, 200, await api.startShotPromptRun(body))
        }

        // ------------------------------------------------------------- render
        if (seg[0] === 'render' && method === 'POST') {
          const body = await readJson(req)
          if (seg[1] === 'reference') return sendJson(res, 200, await api.startReferenceRun(body))
          if (seg[1] === 'keyframe') return sendJson(res, 200, await api.startKeyframeRun(body))
          if (seg[1] === 'video') return sendJson(res, 200, await api.startVideoRun(body))
        }

        // --------------------------------------------------------------- runs
        if (seg[0] === 'runs' && seg.length === 1 && method === 'GET') {
          return sendJson(res, 200, { ok: true, runs: api.runList({ limit: 30 }) })
        }
        if (seg[0] === 'runs' && seg[1]) {
          const id = decodeURIComponent(seg[1])
          if (method === 'POST' && seg[2] === 'cancel') return sendJson(res, 200, { ok: true, ...api.runCancel(id) })
          const run = api.runStatus(id)
          return run
            ? sendJson(res, 200, { ok: true, run })
            : sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no run "${id}"` } })
        }

        // -------------------------------------------------- upload / restyle
        if (seg[0] === 'consumption' && method === 'GET') {
          return sendJson(res, 200, await api.consumption({ projectId: url.searchParams.get('projectId') ?? undefined }))
        }
        if (seg[0] === 'upload' && method === 'POST') {
          return sendJson(res, 200, await api.uploadReference(await readJson(req, 40 * 1024 * 1024)))
        }
        if (seg[0] === 'reveal' && method === 'POST') {
          return sendJson(res, 200, await api.revealAsset(await readJson(req)))
        }
        if (seg[0] === 'merge' && method === 'POST') {
          return sendJson(res, 200, await api.mergeClips(await readJson(req)))
        }
        if (seg[0] === 'restyle' && method === 'POST') {
          return sendJson(res, 200, await api.startRestyleRun(await readJson(req)))
        }

        // ------------------------------------------------------------- assets
        if (seg[0] === 'asset' && seg[1] && seg[2]) {
          const projectId = decodeURIComponent(seg[1])
          const assetId = decodeURIComponent(seg[2])
          if (method === 'POST' && seg[3] === 'delete') {
            return sendJson(res, 200, await api.removeAsset(projectId, assetId))
          }
          const found = await api.assetBytes(projectId, assetId)
          if (!found) return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'asset not found' } })
          res.writeHead(200, {
            'content-type': found.contentType,
            'content-length': found.bytes.byteLength,
            // Artifacts are immutable once written; the id changes when re-rendered.
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(found.bytes)
          return undefined
        }

        // ------------------------------------------------------------ compile
        if (seg[0] === 'compile' && method === 'POST') {
          const body = await readJson(req)
          return sendJson(res, 200, await api.compile(body))
        }
        if (seg[0] === 'export' && method === 'POST') {
          const body = await readJson(req)
          return sendJson(res, 200, await api.exportPrompts(body))
        }

        return sendJson(res, 404, { ok: false, error: { code: 'no-route', message: `unknown route ${method} ${route}` } })
      } catch (error) {
        const code = error?.code ?? 'failed'
        const status = code === 'bad-json' || code === 'body-too-large' ? 400 : 500
        sendJson(res, status, {
          ok: false,
          error: { code, message: String(error?.message ?? error), problems: error?.problems ?? undefined },
        })
      }
    },
  }), 'shortdrama.web-route')

      ctx.logger?.info?.(`shortdrama: studio API mounted at ${ROUTE_PREFIX}`)
    },
  }
}

/** Re-exported so tests and other plugins can reuse the pure compiler. */
export { compileH3Prompt, snapFrames, resolutionFor }

export default { name, inject, apply }
