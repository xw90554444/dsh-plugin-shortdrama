/**
 * Minimal ComfyUI HTTP/WebSocket client for the ShortDrama host half.
 *
 * Only the routes this plugin needs (verified against ComfyUI v0.38.2):
 *   GET  /system_stats          version, devices, VRAM
 *   GET  /object_info[/<class>] node contracts and the enum lists of installed models
 *   POST /prompt                enqueue an API-format graph -> { prompt_id, number }
 *   GET  /history/<prompt_id>   execution result
 *   GET  /view                  fetch one output file's bytes
 *   POST /upload/image          send bytes into ComfyUI's input dir
 *   GET  /queue                 pending + running
 *   POST /interrupt             cancel the running job
 *   WS   /ws?clientId=...       progress / executing / executed
 *
 * Deliberately no UI->API conversion: `/prompt` accepts only API-format graphs,
 * and the shipped templates are UI format with subgraphs. Conversion is fragile,
 * so callers import API-format JSON exported from the ComfyUI UI, and
 * {@link ComfyClient.validate} catches mismatches before anything is queued.
 */

/** Node classes whose enum inputs enumerate installed model files. */
export const MODEL_SOURCE_CLASSES = [
  'CheckpointLoaderSimple',
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'LoraLoader',
  'LoraLoaderModelOnly',
  'DualCLIPLoader',
]

/** Maps a model category to the loader class + input that lists it. */
export const MODEL_CATEGORIES = {
  checkpoint: { classType: 'CheckpointLoaderSimple', input: 'ckpt_name' },
  diffusionModel: { classType: 'UNETLoader', input: 'unet_name' },
  textEncoder: { classType: 'CLIPLoader', input: 'clip_name' },
  vae: { classType: 'VAELoader', input: 'vae_name' },
  // H3 needs a second VAE for its audio stream. It is the same loader and the
  // same file list, so this is a separate *selection* over identical options
  // rather than a separate source.
  audioVae: { classType: 'VAELoader', input: 'vae_name' },
  lora: { classType: 'LoraLoaderModelOnly', input: 'lora_name' },
}

export class ComfyError extends Error {
  /** @param {string} message @param {{code?:string, status?:number, detail?:unknown}} [info] */
  constructor(message, info = {}) {
    super(message)
    this.name = 'ComfyError'
    this.code = info.code ?? 'comfy-error'
    this.status = info.status
    this.detail = info.detail
  }
}

/**
 * @param {string} baseUrl
 * @returns {string} normalised, no trailing slash
 */
export function normaliseBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : 'http://127.0.0.1:8188'
  return raw.replace(/\/+$/, '')
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {URLSearchParams|Record<string,string>} [query]
 */
export function buildUrl(baseUrl, path, query) {
  const url = new URL(`${normaliseBaseUrl(baseUrl)}${path}`)
  if (query) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query)
    for (const [k, v] of params) url.searchParams.set(k, v)
  }
  return url.toString()
}

export class ComfyClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeoutMs] per-request timeout
   */
  constructor(options = {}) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
    /** @type {Map<string, unknown>} short-lived object_info cache */
    this.cache = new Map()
  }

  /** @param {string} baseUrl */
  withBaseUrl(baseUrl) {
    return new ComfyClient({ baseUrl, timeoutMs: this.timeoutMs })
  }

  /**
   * @param {string} path
   * @param {RequestInit & {query?: Record<string,string>, timeoutMs?: number}} [init]
   */
  async request(path, init = {}) {
    const { query, timeoutMs, ...rest } = init
    const url = buildUrl(this.baseUrl, path, query)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
    if (rest.signal) {
      if (rest.signal.aborted) controller.abort()
      else rest.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const response = await fetch(url, { ...rest, signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ComfyError(`ComfyUI ${rest.method ?? 'GET'} ${path} failed: HTTP ${response.status}`, {
          code: 'http-error',
          status: response.status,
          detail: text.slice(0, 2000),
        })
      }
      return response
    } catch (error) {
      if (error instanceof ComfyError) throw error
      if (error?.name === 'AbortError') {
        throw new ComfyError(`ComfyUI ${path} timed out after ${timeoutMs ?? this.timeoutMs}ms`, { code: 'timeout' })
      }
      throw new ComfyError(`ComfyUI ${path} unreachable at ${this.baseUrl}: ${error?.message ?? error}`, {
        code: 'unreachable',
        detail: error,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async getJson(path, init) {
    return (await this.request(path, init)).json()
  }

  async postJson(path, body, init = {}) {
    return (await this.request(path, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    })).json()
  }

  // -- diagnostics ---------------------------------------------------------

  /**
   * Connection test used by the settings page. Reports what the design doc's
   * P0 acceptance criteria ask for: version, GPU, VRAM.
   */
  async health() {
    const started = Date.now()
    const stats = await this.getJson('/system_stats', { timeoutMs: 8000 })
    const devices = Array.isArray(stats?.devices) ? stats.devices : []
    const primary = devices[0] ?? {}
    return {
      ok: true,
      baseUrl: this.baseUrl,
      latencyMs: Date.now() - started,
      version: stats?.system?.comfyui_version ?? null,
      python: stats?.system?.python_version ?? null,
      torch: stats?.system?.pytorch_version ?? null,
      os: stats?.system?.os ?? null,
      ramTotalBytes: stats?.system?.ram_total ?? null,
      ramFreeBytes: stats?.system?.ram_free ?? null,
      devices: devices.map((d) => ({
        name: d.name,
        type: d.type,
        vramTotalBytes: d.vram_total ?? null,
        vramFreeBytes: d.vram_free ?? null,
      })),
      argv: stats?.system?.argv ?? [],
    }
  }

  // -- object_info ---------------------------------------------------------

  /** @param {string} [classType] omit for the full (large) catalog */
  async objectInfo(classType, options = {}) {
    const key = classType ?? '*'
    if (!options.fresh && this.cache.has(key)) return this.cache.get(key)
    const data = await this.getJson(classType ? `/object_info/${classType}` : '/object_info', {
      timeoutMs: options.timeoutMs ?? 30000,
    })
    this.cache.set(key, data)
    return data
  }

  clearCache() { this.cache.clear() }

  /**
   * The enum options of one node input, e.g. every installed UNET file.
   *
   * Two shapes have to be handled, because ComfyUI changed the wire format and both are live in
   * the same process:
   *
   *   legacy  `"vae_name": [["a.safetensors", "b.safetensors"], {}]`      options in slot 0
   *   current `"model_name": ["COMBO", { "options": ["a.pth"] }]`         options in slot 1
   *
   * Reading only the legacy shape does not fail loudly — it returns an empty list, which looks
   * exactly like "nothing is installed". `VAELoader` and `UpscaleModelLoader` come from different
   * code paths in one ComfyUI build, so the image models resolved fine while the upscale model
   * list came back empty and the upscale stage had nothing to load.
   *
   * @returns {Promise<string[]>}
   */
  async inputOptions(classType, inputName) {
    const info = await this.objectInfo(classType)
    const node = info?.[classType]
    const spec = node?.input?.required?.[inputName] ?? node?.input?.optional?.[inputName]
    if (!Array.isArray(spec)) return []
    for (const candidate of [spec[0], spec[1]?.options]) {
      if (Array.isArray(candidate)) return candidate.filter((v) => typeof v === 'string')
    }
    return []
  }

  /**
   * Every model list the pipeline binds against. Categories sharing one loader
   * (vae / audioVae) are fetched once and share the result.
   * @returns {Promise<Record<string, string[]>>}
   */
  async modelLists() {
    const entries = Object.entries(MODEL_CATEGORIES)
    const bySource = new Map()
    await Promise.all(
      [...new Set(entries.map(([, spec]) => `${spec.classType}\u0000${spec.input}`))].map(async (key) => {
        const [classType, input] = key.split('\u0000')
        try {
          bySource.set(key, await this.inputOptions(classType, input))
        } catch {
          bySource.set(key, [])
        }
      }),
    )
    return Object.fromEntries(entries.map(([category, spec]) => [
      category,
      bySource.get(`${spec.classType}\u0000${spec.input}`) ?? [],
    ]))
  }

  /**
   * Pick, for a bound workflow, which installed file each slot should use.
   * Prefers an explicit override, then a name matching `preferred` patterns,
   * then the first installed file.
   *
   * LoRA is the exception: it never falls back to "whatever is installed".
   * A LoRA is optional by nature and strongly model-specific, so picking an
   * arbitrary one would silently graft, say, a Wan Animate adapter onto a
   * Qwen-Image model. No match means no LoRA, which is always safe.
   *
   * @param {Record<string,string[]>} lists from {@link modelLists}
   * @param {Record<string,string|undefined>} overrides
   * @param {Record<string,string[]>} [preferred] substring hints per category
   */
  static resolveModels(lists, overrides = {}, preferred = {}) {
    const picked = {}
    for (const category of Object.keys(MODEL_CATEGORIES)) {
      const available = lists?.[category] ?? []
      const override = overrides[category]
      if (override && available.includes(override)) { picked[category] = override; continue }
      const hints = preferred[category] ?? []
      let match
      for (const hint of hints) {
        match = available.find((name) => name.toLowerCase().includes(hint.toLowerCase()))
        if (match) break
      }
      if (match) { picked[category] = match; continue }
      picked[category] = category === 'lora' ? null : (available[0] ?? null)
    }

    // A second LoRA slot. It resolves from the same file list as `lora` but is a
    // DIFFERENT file — the identity LoRA rides alongside the speed one instead of
    // replacing it. MODEL_CATEGORIES has no such model type, so this is derived here
    // rather than by inventing a category that no loader would understand.
    if (Array.isArray(preferred.faceLora)) {
      const available = lists?.lora ?? []
      const override = overrides.faceLora
      let match = override && available.includes(override) ? override : undefined
      if (!match) {
        for (const hint of preferred.faceLora) {
          match = available.find((name) => name.toLowerCase().includes(hint.toLowerCase()))
          if (match) break
        }
      }
      // Never chain a file onto itself: it would apply the same weights twice and
      // silently double the strength.
      picked.faceLora = match && match !== picked.lora ? match : null
    }

    return picked
  }

  // -- graph validation ----------------------------------------------------

  /**
   * Pre-flight an API-format graph against the live server.
   *
   * Catches the two failure modes that otherwise only surface after queueing:
   * a node class this ComfyUI does not have (usually a missing custom node), and
   * an enum widget naming a model file that is not installed.
   *
   * @param {Record<string, {class_type:string, inputs:Record<string,unknown>}>} graph
   * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], knownClasses:number}>}
   */
  async validate(graph) {
    const errors = []
    const warnings = []

    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
      return { ok: false, errors: ['graph must be an API-format object keyed by node id'], warnings, knownClasses: 0 }
    }
    const nodes = Object.entries(graph)
    if (nodes.length === 0) {
      return { ok: false, errors: ['graph has no nodes'], warnings, knownClasses: 0 }
    }

    const info = await this.objectInfo(undefined, { timeoutMs: 60000 })
    const knownClasses = Object.keys(info ?? {}).length
    if (knownClasses === 0) {
      return { ok: false, errors: ['ComfyUI returned an empty object_info catalog'], warnings, knownClasses }
    }

    const classCache = new Map()
    const readSpec = (classType) => {
      const node = info?.[classType]
      if (!node) return undefined
      if (classCache.has(classType)) return classCache.get(classType)
      const spec = { required: node.input?.required ?? {}, optional: node.input?.optional ?? {} }
      classCache.set(classType, spec)
      return spec
    }

    for (const [id, node] of nodes) {
      const classType = node?.class_type
      if (typeof classType !== 'string' || !classType) {
        errors.push(`node ${id}: missing class_type`)
        continue
      }
      const spec = readSpec(classType)
      if (!spec) {
        errors.push(`node ${id} (${classType}): class not installed — a required custom node is probably missing`)
        continue
      }
      const inputs = node.inputs ?? {}
      for (const [group, table] of [['required', spec.required], ['optional', spec.optional]]) {
        for (const [name, definition] of Object.entries(table)) {
          const declared = Array.isArray(definition) ? definition[0] : undefined
          const isEnum = Array.isArray(declared)
          const value = inputs[name]
          const connected = Array.isArray(value) // [nodeId, slot] link

          // Autogrow groups (`COMFY_AUTOGROW_V3`) live under a single input NAME
          // but are wired through dotted sub-slots — `images.image_1` and so on.
          // They count as satisfied when any sub-slot is set, and one with `min: 0`
          // is legitimately empty. Treating the bare name as a required scalar
          // flagged every valid autogrow node.
          const isAutogrow = declared === 'COMFY_AUTOGROW_V3'
          const autogrowMin = isAutogrow ? (definition[1]?.min ?? 0) : 0
          const autogrowFilled = isAutogrow && Object.keys(inputs).some((key) => key.startsWith(`${name}.`))

          if (group === 'required' && value === undefined && !connected && !autogrowFilled && !(isAutogrow && autogrowMin === 0)) {
            errors.push(`node ${id} (${classType}): required input "${name}" is not set`)
            continue
          }
          if (value === undefined || connected) continue
          if (isEnum && typeof value === 'string' && !declared.includes(value)) {
            errors.push(`node ${id} (${classType}): input "${name}" = "${value}" is not among the ${declared.length} installed option(s)`)
          } else if (isEnum && declared.length === 0) {
            warnings.push(`node ${id} (${classType}): input "${name}" has no installed options`)
          }
        }
      }
    }

    return { ok: errors.length === 0, errors, warnings, knownClasses }
  }

  // -- workflow binding ----------------------------------------------------

  /**
   * Find the nodes a pipeline stage should write into.
   *
   * Auto-binding keys off node class contracts rather than titles, so an
   * exported workflow binds without hand-labelling. An explicit
   * `_meta.shortdrama` block always wins, which is the escape hatch for
   * work flows that route the prompt through text-concat nodes.
   *
   * @param {Record<string, {class_type:string, inputs:Record<string,unknown>, _meta?:object}>} graph
   * @param {'h3'|'image'} [kind]
   */
  static detectBindings(graph, kind = 'h3') {
    const nodes = Object.entries(graph ?? {})
    const explicit = {}
    for (const [, node] of nodes) {
      const meta = node?._meta?.shortdrama
      if (meta && typeof meta === 'object') Object.assign(explicit, meta)
    }
    if (Object.keys(explicit).length > 0) return { ...explicit, source: 'explicit' }

    const byClass = (classType) => nodes.filter(([, n]) => n?.class_type === classType).map(([id]) => id)
    const isLinked = (node) => Object.values(node?.inputs ?? {}).some((v) => Array.isArray(v))

    if (kind === 'h3') {
      const h3 = byClass('MiniMaxH3ImageToVideo')[0]
      if (!h3) return null
      const loadImage = byClass('LoadImage')[0] ?? null
      return {
        source: 'auto',
        promptNode: h3,
        widthNode: h3,
        heightNode: h3,
        lengthNode: h3,
        seedNode: byClass('RandomNoise')[0] ?? byClass('KSampler')[0] ?? null,
        firstFrameNode: loadImage,
        loadImageNode: loadImage,
      }
    }

    // Image graph: the positive encoder is the CLIPTextEncode with no inbound link.
    const encoders = byClass('CLIPTextEncode')
    const positive = encoders.find((id) => !isLinked(graph[id]))
    const negative = encoders.filter((id) => id !== positive)[0] ?? null
    const emptyLatent = byClass('EmptyLatentImage')[0] ?? byClass('EmptySD3LatentImage')[0] ?? null
    return {
      source: 'auto',
      positiveNode: positive ?? null,
      negativeNode: negative,
      widthNode: emptyLatent,
      heightNode: emptyLatent,
      seedNode: byClass('KSampler')[0] ?? null,
    }
  }

  // -- execution -----------------------------------------------------------

  /**
   * Enqueue an API-format graph.
   * @param {object} graph
   * @param {string} [clientId]
   * @returns {Promise<{promptId:string, number:number, nodeErrors:object}>}
   */
  async submit(graph, clientId) {
    const body = { prompt: graph, client_id: clientId ?? crypto.randomUUID() }
    const data = await this.postJson('/prompt', body, { timeoutMs: 30000 })
    if (data?.error) {
      throw new ComfyError(`ComfyUI rejected the graph: ${JSON.stringify(data.error)}`, {
        code: 'graph-rejected',
        detail: data,
      })
    }
    if (!data?.prompt_id) {
      throw new ComfyError('ComfyUI accepted the request but returned no prompt_id', { code: 'no-prompt-id', detail: data })
    }
    return { promptId: data.prompt_id, number: data.number ?? -1, nodeErrors: data.node_errors ?? {} }
  }

  /** @param {string} promptId */
  async history(promptId) {
    return this.getJson(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 15000 })
  }

  /** Pending and running entries. */
  async queue() {
    return this.getJson('/queue', { timeoutMs: 10000 })
  }

  /** Ask the running job to stop. */
  async interrupt() {
    await this.request('/interrupt', { method: 'POST', timeoutMs: 10000 })
    return true
  }

  /**
   * Stop ONE prompt, whether it is executing or still queued.
   *
   * Cancelling the wait is not cancelling the work. The plugin used to abort its own
   * poll and report the run cancelled while ComfyUI carried on sampling — a GPU
   * minute-long render nobody was waiting for any more, and the queue slot stayed
   * occupied.
   *
   * The two cases need different calls and neither covers the other: /interrupt
   * takes no prompt id and stops whatever is executing right now, which would be
   * someone else's job if ours has not started; a queued prompt is removed only by
   * deleting it from the queue.
   */
  async cancelPrompt(promptId) {
    const result = { running: false, pending: false }
    if (!promptId) return result
    try {
      const q = await this.queue()
      result.running = (q?.queue_running ?? []).some((it) => it?.[1] === promptId)
      result.pending = (q?.queue_pending ?? []).some((it) => it?.[1] === promptId)
    } catch { /* the queue is advisory; fall through and try both */ }

    if (result.running) {
      try { await this.interrupt() } catch { /* best effort */ }
    }
    if (result.pending) {
      try { await this.postJson('/queue', { delete: [promptId] }, { timeoutMs: 10000 }) } catch { /* best effort */ }
    }
    return result
  }

  /**
   * Poll one prompt until it settles.
   *
   * @param {string} promptId
   * @param {object} [options]
   * @param {(info:{elapsedMs:number, queuePosition:number|null})=>void} [options.onProgress]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.intervalMs]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{status:'completed'|'failed', outputs:object[], raw:object, elapsedMs:number}>}
   */
  /**
   * Rough seconds one queued job will take, judged from what it actually is.
   *
   * A position number alone is useless when the queue holds a video: "queue #1"
   * reads as "next" and the operator waits thirteen minutes for it. Estimating from
   * the graph is what turns a position into a wait.
   *
   * Fitted to measured runs on a 4070 Ti SUPER — 124 frames took 228s and 328 took
   * 1700s. That is superlinear (exponent ~2.07), so a linear extrapolation badly
   * understates a 10s clip, which is exactly the case that hurts.
   */
  estimateJobSeconds(graph) {
    const nodes = Object.values(graph ?? {})
    if (nodes.length === 0) return 45
    const h3 = nodes.find((n) => /^MiniMaxH3/.test(n.class_type ?? ''))
    if (h3) {
      const frames = Number(h3.inputs?.length) || 124
      return Math.max(30, Math.round(0.0108 * frames ** 2.065))
    }
    if (nodes.some((n) => n.class_type === 'SaveImage')) return 40
    return 30
  }

  async waitFor(promptId, options = {}) {
    const interval = options.intervalMs ?? 1500
    const timeout = options.timeoutMs ?? 30 * 60 * 1000
    const started = Date.now()

    // A prompt that appears in NEITHER the queue NOR history has been lost —
    // ComfyUI was restarted, or its history was cleared, while the job was in
    // flight. Without this check the poll ran to the full timeout, so a job that
    // had already died kept the panel showing "working" for up to 45 minutes and
    // its output never arrived. Bounded and generous: ComfyUI needs a moment
    // between accepting a prompt and listing it in the queue, and a single
    // transient queue response should not condemn a healthy job.
    const lostAfterMs = options.lostAfterMs ?? 90 * 1000
    let missingSince = null

    for (;;) {
      if (options.signal?.aborted) {
        throw new ComfyError('wait cancelled', { code: 'aborted' })
      }
      const elapsed = Date.now() - started
      if (elapsed > timeout) {
        throw new ComfyError(`prompt ${promptId} did not settle within ${timeout}ms`, { code: 'timeout' })
      }

      const entry = (await this.history(promptId))?.[promptId]
      if (entry) {
        const status = entry?.status ?? {}
        const outputs = collectOutputs(entry)
        const failed = status.status_str === 'error' || status.completed === false
        return { status: failed ? 'failed' : 'completed', outputs, raw: entry, elapsedMs: elapsed }
      }

      let queuePosition = null
      let etaSeconds = 0
      try {
        const q = await this.queue()
        const running = Array.isArray(q?.queue_running) ? q.queue_running : []
        const pending = Array.isArray(q?.queue_pending) ? q.queue_pending : []
        if (!running.some((it) => it?.[1] === promptId)) {
          const idx = pending.findIndex((it) => it?.[1] === promptId)
          queuePosition = idx >= 0 ? idx + 1 : null
          if (idx >= 0) {
            // What is executing now, plus the pending ones ahead. Their graphs ride
            // the same queue payload, so this costs no extra request.
            for (const item of [...running, ...pending.slice(0, idx)]) {
              etaSeconds += this.estimateJobSeconds(item?.[2])
            }
          }
        } else {
          queuePosition = 0
        }
      } catch { /* queue is advisory; history remains the source of truth */ }

      if (queuePosition !== null) {
        missingSince = null
      } else {
        // Only trust this after the queue has been readable — a failed queue fetch
        // also leaves the position null, and that is not evidence of anything.
        if (!missingSince) missingSince = Date.now()
        else if (Date.now() - missingSince > lostAfterMs) {
          throw new ComfyError(
            `prompt ${promptId} is in neither the queue nor history after ${Math.round((Date.now() - missingSince) / 1000)}s — `
            + 'ComfyUI was probably restarted or its history cleared, so this job no longer exists',
            { code: 'lost' },
          )
        }
      }

      options.onProgress?.({ elapsedMs: elapsed, queuePosition, etaSeconds: queuePosition ? etaSeconds : 0 })
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  /**
   * Fetch one output file's bytes.
   * @param {{filename:string, subfolder?:string, type?:string}} ref
   * @returns {Promise<{bytes:Uint8Array, contentType:string}>}
   */
  async view(ref) {
    const response = await this.request('/view', {
      query: {
        filename: ref.filename,
        subfolder: ref.subfolder ?? '',
        type: ref.type ?? 'output',
      },
      timeoutMs: 120000,
    })
    const buffer = new Uint8Array(await response.arrayBuffer())
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /**
   * Put bytes into ComfyUI's input directory, for keyframe chaining.
   *
   * Invalidates the object_info cache on success: `LoadImage.image` is an enum of
   * the files currently in that directory, so a cached catalog would not list the
   * file just uploaded and {@link validate} would reject a perfectly valid graph.
   *
   * @param {Uint8Array} bytes
   * @param {string} filename
   * @param {{subfolder?:string, overwrite?:boolean}} [options]
   * @returns {Promise<{name:string, subfolder:string, type:string}>}
   */
  async uploadImage(bytes, filename, options = {}) {
    const form = new FormData()
    form.append('image', new Blob([bytes]), filename)
    form.append('overwrite', String(options.overwrite ?? true))
    if (options.subfolder) form.append('subfolder', options.subfolder)
    const data = await (await this.request('/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
    })).json()
    this.clearCache()
    return { name: data?.name ?? filename, subfolder: data?.subfolder ?? '', type: data?.type ?? 'input' }
  }

  /**
   * Subscribe to execution events. Resolves to an unsubscribe function; silently
   * does nothing when the runtime has no WebSocket, because polling still works.
   *
   * @param {string} clientId
   * @param {(event:{type:string, data:any}) => void} onEvent
   * @returns {() => void}
   */
  watch(clientId, onEvent) {
    const WebSocketImpl = globalThis.WebSocket
    if (typeof WebSocketImpl !== 'function') return () => {}
    let socket
    let closed = false
    try {
      const wsUrl = buildUrl(this.baseUrl, '/ws', { clientId })
      socket = new WebSocketImpl(wsUrl.replace(/^http/, 'ws'))
      socket.addEventListener('message', (message) => {
        try {
          const parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')
          onEvent({ type: parsed?.type ?? 'unknown', data: parsed?.data })
        } catch { /* non-JSON frames are progress noise */ }
      })
      socket.addEventListener('error', () => { /* polling covers it */ })
    } catch {
      return () => {}
    }
    return () => {
      if (closed) return
      closed = true
      try { socket?.close() } catch { /* already closed */ }
    }
  }
}

/**
 * Flatten a history entry into a list of produced files.
 *
 * @param {object} entry
 * @returns {{nodeId:string, kind:'image'|'video'|'audio'|'file', filename:string, subfolder:string, type:string}[]}
 */
export function collectOutputs(entry) {
  const out = []
  const outputs = entry?.outputs ?? {}
  for (const [nodeId, node] of Object.entries(outputs)) {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (!item || typeof item !== 'object' || typeof item.filename !== 'string') continue
        out.push({
          nodeId,
          kind: kindFromFilename(item.filename, key),
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output',
        })
      }
    }
  }
  return out
}

function kindFromFilename(filename, key) {
  const ext = String(filename).toLowerCase().split('.').pop() ?? ''
  if (['mp4', 'webm', 'mkv', 'mov', 'gif'].includes(ext)) return 'video'
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image'
  if (['flac', 'wav', 'mp3', 'ogg', 'm4a'].includes(ext)) return 'audio'
  if (String(key).toLowerCase().includes('video')) return 'video'
  return 'file'
}

export default ComfyClient
