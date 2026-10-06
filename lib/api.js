/**
 * The single implementation behind both front doors.
 *
 * Every capability is a method here; `index.js` exposes them over the web route
 * for the studio UI, and `tools.js` exposes them as agent tools. One
 * implementation means the UI and the agent can never drift apart.
 *
 * Nothing long-running happens inline. LLM stages and renders start a tracked run
 * and return its id immediately; callers poll `runStatus`.
 */
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises'
// Synchronous file access is used ONLY for the run registry, which must be read
// before createApi returns and written from inside non-async callbacks.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { ComfyClient, MODEL_CATEGORIES } from './comfy/client.js'
import { buildQwenImageGraph } from './comfy/graph.js'
import { resolveFfmpeg, concatVideos, probeDuration } from './ffmpeg.js'
import { H3_FL2VA_PREFERRED, H3_REF2VA_PREFERRED, IMAGE_PREFERRED, assessCapacity } from './comfy/preferred.js'
import {
  compileH3Prompt, compileImagePrompt, compileKeyframePrompt, groupIntoClips, lintStoryboard,
  snapFrames, framesToSeconds, resolutionFor, resolutionForMegapixels, scriptFingerprint,
  RESOLUTION_TIERS, tierForMegapixels, RATIOS, } from './pipeline/compile.js'
import { runScriptStage } from './pipeline/script.js'
import { runCastStage } from './pipeline/cast.js'
import { runStoryboardStage } from './pipeline/storyboard.js'
import { runShotDirectionStage } from './pipeline/shotdirection.js'
import { renderClips, renderKeyframes, renderReferences } from './pipeline/render.js'
import { VOCAB, STYLE_PRESETS } from './prompts.js'
import { reverseVocab } from './pipeline/compile.js'
import { readConfig, writeConfig, mergeConfig, exportsDir, projectsDir, pluginRootDir } from './config.js'
import { createRunRegistry } from './runs.js'
import * as store from './store.js'
import * as assets from './assets.js'

/**
 * Open a folder — optionally with one file selected — in the OS file manager.
 *
 * Two deliberate choices:
 *
 *  - `execFile` with an argument ARRAY, never a shell string. A generated filename
 *    can contain characters a shell would interpret, and "open a folder" must not
 *    be able to become "run a command".
 *  - The caller passes a path this module already derived from stored ids; it is
 *    never a path taken from a request. See `revealAsset`.
 *
 * @param {string} target absolute path
 * @param {boolean} select true to highlight the file rather than just open its folder
 * @returns {Promise<{ok:boolean, opened?:string, error?:object}>}
 */
async function revealPath(target, select) {
  if (select) {
    try {
      await stat(target)
    } catch {
      return { ok: false, error: { code: 'missing', message: '这个文件还不存在' } }
    }
  } else {
    // Creating it means the button works on a project that has not rendered yet,
    // which is exactly when someone looks for where the output will land.
    try {
      await mkdir(target, { recursive: true })
    } catch {
      return { ok: false, error: { code: 'missing', message: '目录无法创建' } }
    }
  }

  let bin
  let args
  if (process.platform === 'win32') {
    bin = 'explorer.exe'
    args = select ? [`/select,${target}`] : [target]
  } else if (process.platform === 'darwin') {
    bin = 'open'
    args = select ? ['-R', target] : [target]
  } else {
    bin = 'xdg-open'
    args = [select ? dirname(target) : target]
  }

  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true }, (error) => {
      // explorer.exe reports a non-zero exit even on success, so its status is not
      // a verdict. Only failing to launch it at all is.
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        resolve({ ok: false, error: { code: 'no-file-manager', message: `找不到可用的文件管理器（${bin}）` } })
        return
      }
      resolve({ ok: true, opened: target })
    })
  })
}

/** Total bytes under a directory, 0 when it does not exist. */
async function treeSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await treeSize(full)
    else {
      try {
        total += (await stat(full)).size
      } catch { /* a file removed mid-walk simply does not count */ }
    }
  }
  return total
}

/** Size of one file, 0 when it does not exist. */
async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * Render presets. Image and video want different step counts, so they are kept
 * separate rather than pretending one number covers both.
 */
/**
 * Pair the speed LoRA with the step count it was distilled for.
 *
 * The two are matched by name — `_4step_` and `_8step_` — but the preference list
 * resolves ONE LoRA for every preset. So `standard` (8 steps) was handed the 4-step
 * weights: a schedule the distillation was never trained on, which is what made its
 * video look soft next to a shorter `draft` run that used the same file at its
 * intended four steps.
 *
 * Shared rather than inlined in the render path because `status` reports the resolved
 * models too, and a status that names the file the renderer will NOT use is worse
 * than no status at all — it makes a correct pairing look like a bug.
 *
 * @param {object} resolved output of `resolveFor`, mutated in place
 * @param {object} preset entry from {@link PRESETS}
 * @param {object} lists installed model file names
 */
export function pairSpeedLora(resolved, preset, lists) {
  if (!resolved?.lora || !preset?.turbo || !Number.isFinite(preset.h3Steps)) return resolved
  const wanted = preset.h3Steps <= 4 ? '4step' : '8step'
  if (resolved.lora.toLowerCase().includes(wanted)) return resolved
  const alt = (lists?.lora ?? []).find(
    (name) => /turbo/i.test(name) && name.toLowerCase().includes(wanted),
  )
  // Absent means the user has only one of the pair; keeping what resolved is better
  // than falling back to null and dropping the LoRA entirely.
  if (alt) resolved.lora = alt
  return resolved
}

export const PRESETS = {
  // Image and video need independent knobs, not one shared `turbo`. The image
  // Lightning LoRA is a 4-step distillation: keeping it on for a final render is
  // one of the ways output comes out soft, so `standard` runs the official path
  // (25 steps, no LoRA) and only `draft` takes the shortcut.
  draft: {
    label: '草稿', imageSteps: 8, imageTurbo: true, imageCfg: 1.0,
    h3Steps: 4, turbo: true, samplerName: 'euler',
  },
  standard: {
    label: '标准', imageSteps: 25, imageTurbo: false, imageCfg: 1.0,
    h3Steps: 8, turbo: true, samplerName: 'euler',
  },
  quality: {
    label: '精细', imageSteps: 40, imageTurbo: false, imageCfg: 1.0,
    h3Steps: 20, turbo: false, samplerName: 'euler',
  },
}

/**
 * Fold one LLM call's token usage into a project's running totals.
 *
 * Providers disagree on field names — DSH's adapters use `inputTokens`, an
 * OpenAI-compatible endpoint returns `prompt_tokens` — and a missing counter must
 * not poison the tally, so every read is tried against both spellings and defaults
 * to zero. The stage is recorded separately because a storyboard that retried
 * three times is a different problem from a script that retried once, and the
 * totals alone cannot tell them apart.
 *
 * @param {object} project
 * @param {string} stage 'script' | 'cast' | 'storyboard'
 * @param {object|null} usage provider-reported counters
 * @param {number} [attempts] how many model calls this stage took
 * @returns {object} the new usage block, ready to assign
 */
export function accumulateLlmUsage(project, stage, usage, attempts) {
  const current = project?.usage ?? {}
  const calls = Math.max(1, Number(attempts) || 1)
  const read = (...keys) => {
    for (const key of keys) {
      if (Number.isFinite(Number(usage?.[key]))) return Number(usage[key])
    }
    return 0
  }
  const input = read('inputTokens', 'prompt_tokens', 'promptTokens')
  const output = read('outputTokens', 'completion_tokens', 'completionTokens')
  const total = read('totalTokens', 'total_tokens') || (input + output)

  const llm = current.llm ?? {}
  const byStage = { ...(llm.byStage ?? {}) }
  const prev = byStage[stage] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
  byStage[stage] = {
    inputTokens: (Number(prev.inputTokens) || 0) + input,
    outputTokens: (Number(prev.outputTokens) || 0) + output,
    calls: (Number(prev.calls) || 0) + calls,
  }

  return {
    ...current,
    llm: {
      inputTokens: (Number(llm.inputTokens) || 0) + input,
      outputTokens: (Number(llm.outputTokens) || 0) + output,
      totalTokens: (Number(llm.totalTokens) || 0) + total,
      calls: (Number(llm.calls) || 0) + calls,
      byStage,
      updatedAt: new Date().toISOString(),
    },
  }
}

/** @param {object} ctx the cordis context */
/**
 * The run queue lives beside the config rather than inside a project, because a run
 * can span projects (a batch render) and because the queue is global state.
 */
function runsPath() {
  return join(pluginRootDir(), 'runs.json')
}

/** Never throws: an unreadable or corrupt queue must not stop the plugin loading. */
function readRuns() {
  try {
    const parsed = JSON.parse(readFileSync(runsPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Written to a temp file and renamed. A queue file truncated by a crash would fail
 * to parse on the next start, and the whole history would be silently discarded —
 * which is the exact failure this persistence exists to prevent.
 */
function writeRuns(records) {
  try {
    mkdirSync(pluginRootDir(), { recursive: true })
    const target = runsPath()
    const temp = `${target}.tmp`
    writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8')
    renameSync(temp, target)
  } catch {
    // Best-effort. Losing the queue is bad; failing a render over it is worse.
  }
}

export function createApi(ctx) {
  let cached = null
  let modelCache = { at: 0, lists: null }
  // Restored, with anything left mid-flight marked interrupted rather than dropped
  // or left claiming to run.
  const runs = createRunRegistry({ initial: readRuns(), onChange: writeRuns })

  const llm = () => ctx.get('llm')

  async function config() {
    if (!cached) cached = await readConfig()
    return cached
  }

  function clientFor(cfg) {
    return new ComfyClient({ baseUrl: cfg.comfy.baseUrl })
  }

  async function installedModels({ fresh = false } = {}) {
    const cfg = await config()
    const ttl = 5 * 60 * 1000
    if (!fresh && modelCache.lists && Date.now() - modelCache.at < ttl) return modelCache.lists
    const lists = await clientFor(cfg).modelLists()
    modelCache = { at: Date.now(), lists }
    return lists
  }

  /** Merge explicit user overrides with the recommended hints for one mode. */
  function resolveFor(cfg, lists, mode) {
    const preferences = mode === 'ref2va' ? H3_REF2VA_PREFERRED : H3_FL2VA_PREFERRED
    const h3 = ComfyClient.resolveModels(lists, {
      diffusionModel: cfg.comfy.models.diffusionModel,
      textEncoder: cfg.comfy.models.textEncoder,
      vae: cfg.comfy.models.vae,
      audioVae: cfg.comfy.models.audioVae,
      lora: cfg.comfy.models.lora,
    }, preferences)
    const image = ComfyClient.resolveModels(lists, {
      diffusionModel: cfg.comfy.models.imageDiffusionModel,
      textEncoder: cfg.comfy.models.imageTextEncoder,
      vae: cfg.comfy.models.imageVae,
      lora: cfg.comfy.models.imageLora,
    }, IMAGE_PREFERRED)
    return { h3, image }
  }

  /**
   * Resolve which model the LLM stages call. An explicit config entry wins;
   * otherwise the session default is used, so generation follows whatever model
   * the user already selected for the agent.
   */
  async function llmSelection() {
    const cfg = await config()
    if (cfg.llm?.provider && cfg.llm?.model) {
      return { provider: cfg.llm.provider, model: cfg.llm.model, source: 'config' }
    }
    const service = ctx.get('agentDefaultModel')
    try {
      const current = service?.currentSelection?.()
      if (current?.provider && current?.model) {
        return { provider: current.provider, model: current.model, source: 'agent-default' }
      }
    } catch { /* fall through to the error below */ }
    return null
  }

  async function llmDeps() {
    const selection = await llmSelection()
    if (!selection) {
      const error = new Error('no model available for generation; set one in the studio settings')
      error.code = 'no-model'
      throw error
    }
    return { llm: llm(), provider: selection.provider, model: selection.model, selection }
  }

  /**
   * Resolve the model for a generation run, reporting failure as a typed result
   * rather than a throw.
   *
   * The `start*Run` methods are called from two places that both expect the
   * `{ ok, error }` contract: the web route (which would otherwise answer 500
   * instead of a structured error) and the agent tools. Throwing here would make
   * "no model configured" — an ordinary, fixable user state — look like a fault.
   */
  async function resolveLlmDeps() {
    try {
      return { deps: await llmDeps() }
    } catch (error) {
      return { error: { code: error?.code ?? 'no-model', message: String(error?.message ?? error) } }
    }
  }

  /** Build the context object the render stages expect. */
  async function renderContext(project) {
    const cfg = await config()
    const lists = await installedModels()
    const resolved = resolveFor(cfg, lists, cfg.comfy.mode)
    const preset = PRESETS[cfg.comfy.preset] ?? PRESETS.standard

    pairSpeedLora(resolved, preset, lists)

    // A mutable working copy: render stages annotate entities and shots, and the
    // caller persists after each item so a long batch cannot lose everything.
    return {
      project,
      comfy: clientFor(cfg),
      models: resolved,
      preset,
      labels: cfg.prompt.labels,
      /** Which H3 wiring the video stage builds. */
      mode: cfg.comfy.mode,
      /** REF2VA reference sizing: 'max' favours identity at several times the cost. */
      refImageSize: cfg.comfy.refImageSize,
      /**
       * Image output budget. Also written onto the project copy below, because the
       * prompt compilers read `project.imageMegapixels` directly.
       */
      imageMegapixels: cfg.comfy.imageMegapixels,
      /**
       * One H3 submission covers one clip. This is that clip's frame budget, and
       * it is the SAME budget the storyboard was written against — if the two
       * disagreed, the rendered segmentation would not match the compiled prompts.
       */
      clipFrames: snapFrames(cfg.comfy.clipSeconds),
      clipSeconds: cfg.comfy.clipSeconds,
      async putAsset(kind, bytes, ext, extra) {
        const id = assets.newAssetId(kind)
        const meta = {
          id,
          kind,
          ext,
          createdAt: new Date().toISOString(),
          ...extra,
        }
        // Keep writeAsset's return value, not the input: it is the stored record
        // carrying the resolved byte size. Storing the input left every asset
        // indexed with no size in the project document.
        const { path, ...stored } = await assets.writeAsset(project.id, meta, bytes)
        void path
        project.assets[id] = stored

        // Consumption ledger for RENDER TIME only.
        //
        // Bytes are deliberately not tallied here: three paths write assets without
        // passing through putAsset (upload, restyle, merge), so a counter would
        // under-report exactly the expensive items. Disk is measured from the
        // directory instead by the summary endpoint, which cannot drift.
        const ledger = project.usage ?? {}
        const render = ledger.render ?? {}
        const stage = typeof extra?.stage === 'string' ? extra.stage : (kind === 'video' ? 'video' : 'image')
        const spent = Number(extra?.elapsedMs) || 0
        const byKind = { ...(render.byKind ?? {}) }
        const previous = byKind[stage] ?? { count: 0, ms: 0 }
        byKind[stage] = {
          count: (Number(previous.count) || 0) + 1,
          ms: (Number(previous.ms) || 0) + spent,
        }
        const isVideo = kind === 'video'
        project.usage = {
          ...ledger,
          render: {
            images: (Number(render.images) || 0) + (isVideo ? 0 : 1),
            videos: (Number(render.videos) || 0) + (isVideo ? 1 : 0),
            totalMs: (Number(render.totalMs) || 0) + spent,
            byKind,
            updatedAt: new Date().toISOString(),
          },
        }
        return stored
      },
      async readAsset(meta) {
        return assets.readAsset(project.id, meta)
      },
      async persist() {
        await store.saveProject(project)
      },
    }
  }

  /** Wrap a render stage in the run registry and persist the outcome. */
  function startRenderRun({ kind, label, projectId, stage }) {
    return runs.start({
      kind,
      label,
      projectId,
      async work({ progress, signal }) {
        const project = await store.getProject(projectId)
        if (!project) {
          const error = new Error(`no project "${projectId}"`)
          error.code = 'not-found'
          throw error
        }
        const context = await renderContext(project)
        context.signal = signal
        context.progress = progress
        const result = await stage(context)
        await store.saveProject(context.project)
        return result
      },
    })
  }

  const api = {
    // ---------------------------------------------------------------- config

    async getConfig() {
      return structuredClone(await config())
    },

    async saveConfig(patch) {
      const next = mergeConfig(await config(), patch ?? {})
      cached = await writeConfig(next)
      modelCache = { at: 0, lists: null }
      return structuredClone(cached)
    },

    // -------------------------------------------------------- model picking

    async llmInfo() {
      const selection = await llmSelection()
      const service = llm()
      let providers = []
      try {
        providers = service?.listProviders?.() ?? []
      } catch { /* provider directory is advisory */ }

      // Models per provider, so the settings page can offer a real choice rather
      // than asking the user to type a model id from memory. A provider with no
      // reachable endpoint is the ordinary case for one you have not configured,
      // so a failure here degrades to "no models listed" and never sinks status.
      const catalogue = []
      for (const provider of providers) {
        let models = []
        try {
          models = (await service.listModels(provider.id)) ?? []
        } catch { /* offline or unconfigured*/ }
        catalogue.push({
          id: provider.id,
          name: provider.name ?? provider.id,
          // A hosted provider can advertise hundreds; the list is for choosing,
          // not for scrolling, and an unbounded payload would bloat every poll.
          models: models.slice(0, 80).map((m) => ({ id: m.id, name: m.name ?? m.id })),
          total: models.length,
        })
      }
      return { selection, providers, catalogue, presets: PRESETS }
    },

    /**
     * What the studio has consumed, per project and in total.
     *
     * Two different kinds of number, measured two different ways:
     *
     *  - Disk is MEASURED by walking the directories. A tally would drift, because
     *    uploads, restyles and merges write assets without going through the render
     *    ledger — and those are the large files.
     *  - Tokens and render time are TALLIED, because they cannot be re-derived
     *    after the fact. They live on the project document so a restart does not
     *    erase them.
     *
     * @param {{projectId?:string}} [request]
     */
    async consumption(request = {}) {
      const cfg = await config()
      const list = await store.listProjects()
      const wanted = request.projectId
        ? list.filter((p) => p.id === request.projectId)
        : list

      const projects = []
      for (const summary of wanted) {
        const full = await store.getProject(summary.id)
        if (!full) continue
        const usage = full.usage ?? {}
        const llm = usage.llm ?? {}
        const render = usage.render ?? {}
        projects.push({
          id: full.id,
          title: full.title,
          llm: {
            inputTokens: llm.inputTokens ?? 0,
            outputTokens: llm.outputTokens ?? 0,
            totalTokens: llm.totalTokens ?? 0,
            calls: llm.calls ?? 0,
            byStage: llm.byStage ?? {},
            updatedAt: llm.updatedAt ?? null,
          },
          render: {
            images: render.images ?? 0,
            videos: render.videos ?? 0,
            totalMs: render.totalMs ?? 0,
            byKind: render.byKind ?? {},
            updatedAt: render.updatedAt ?? null,
          },
          disk: {
            assets: await treeSize(assets.assetsDir(full.id)),
            document: await fileSize(join(projectsDir(), `${full.id}.json`)),
            exports: await treeSize(join(exportsDir(), full.id)),
            assetsOnDisk: Object.keys(full.assets ?? {}).length,
          },
        })
      }

      const sum = (pick) => projects.reduce((n, p) => n + (Number(pick(p)) || 0), 0)
      return {
        ok: true,
        projects,
        totals: {
          projects: projects.length,
          inputTokens: sum((p) => p.llm.inputTokens),
          outputTokens: sum((p) => p.llm.outputTokens),
          totalTokens: sum((p) => p.llm.totalTokens),
          llmCalls: sum((p) => p.llm.calls),
          images: sum((p) => p.render.images),
          videos: sum((p) => p.render.videos),
          renderMs: sum((p) => p.render.totalMs),
          diskBytes: sum((p) => p.disk.assets + p.disk.document + p.disk.exports),
        },
        // Stated in the payload rather than implied, so the UI cannot accidentally
        // present a local render as if it were a metered charge.
        billing: {
          llmMetered: Boolean(cfg.llm?.provider) || null,
          note: '云端 token 由 DSH 会话计费；本地出图出片不产生费用，只有电费与时间。',
        },
      }
    },

    // ----------------------------------------------------------- diagnostics

    async status({ fresh = false } = {}) {
      const cfg = await config()
      const out = {
        config: structuredClone(cfg),
        presets: PRESETS,
        health: null,
        capacity: null,
        models: null,
        resolved: null,
        llm: null,
        error: null,
      }
      try {
        out.llm = await api.llmInfo()
      } catch { /* reported through the generation path instead */ }
      try {
        const client = clientFor(cfg)
        out.health = await client.health()
        out.capacity = assessCapacity(out.health)
        const lists = await installedModels({ fresh })
        out.models = lists
        out.resolved = pairSpeedLora(
      resolveFor(cfg, lists, cfg.comfy.mode),
      PRESETS[cfg.comfy.preset] ?? PRESETS.standard,
      lists,
    )
      } catch (error) {
        out.error = { code: error?.code ?? 'error', message: String(error?.message ?? error) }
      }
      return out
    },

    async testConnection(baseUrl) {
      const url = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : (await config()).comfy.baseUrl
      try {
        const health = await new ComfyClient({ baseUrl: url }).health()
        return { ok: true, baseUrl: url, health, capacity: assessCapacity(health) }
      } catch (error) {
        return { ok: false, baseUrl: url, error: { code: error?.code ?? 'error', message: String(error?.message ?? error) } }
      }
    },

    async models({ fresh = false } = {}) {
      const cfg = await config()
      const lists = await installedModels({ fresh })
      return { lists, categories: MODEL_CATEGORIES, resolved: resolveFor(cfg, lists, cfg.comfy.mode) }
    },

    // -------------------------------------------------------------- projects

    listProjects: () => store.listProjectSummaries(),
    getProject: (id) => store.getProject(id),
    createProject: (input) => store.createProject(input ?? {}),
    updateProject: (id, patch) => store.updateProject(id, patch),

    async removeProject(id) {
      const removed = await store.removeProject(id)
      if (removed) await assets.removeProjectAssets(id)
      return removed
    },

    // -------------------------------------------------------------- assets

    /** @returns {Promise<{bytes:Buffer, contentType:string}|null>} */
    /**
     * Reveal a project's artifacts, or one artifact, in the file manager.
     *
     * The path is DERIVED from stored ids and never read from the request. Handing a
     * caller-supplied path to the shell would let any request open — and on Windows
     * potentially launch — an arbitrary location, so the request can only name
     * something this project already owns.
     *
     * @param {object} request { projectId, assetId? }
     */
    async revealAsset(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: 'no such project' } }

      if (request.assetId) {
        const meta = project.assets?.[request.assetId]
        if (!meta) return { ok: false, error: { code: 'not-found', message: 'no such asset' } }
        return revealPath(assets.assetFilePath(project.id, meta), true)
      }
      // The export folder is a third destination, not the asset one. Reporting the
      // path in a line of text was not enough: "written to <path>" tells you where a
      // file went without helping you get there, and the export folder is not
      // somewhere the operator chose or would think to look.
      if (request.kind === 'exports') return revealPath(join(exportsDir(), project.id), false)
      return revealPath(assets.assetsDir(project.id), false)
    },

    async assetBytes(projectId, assetId) {
      const project = await store.getProject(projectId)
      const meta = project?.assets?.[assetId]
      if (!meta) return null
      try {
        return { bytes: await assets.readAsset(projectId, meta), contentType: assets.mediaTypeFor(meta.kind, meta.ext) }
      } catch {
        return null
      }
    },

    async removeAsset(projectId, assetId) {
      const project = await store.getProject(projectId)
      const meta = project?.assets?.[assetId]
      if (!meta) return { ok: false, error: { code: 'not-found', message: `no asset "${assetId}"` } }
      await assets.removeAsset(projectId, meta)
      delete project.assets[assetId]
      for (const entity of [...project.characters, ...project.scenes]) {
        if (entity.refAssetId === assetId) { entity.refAssetId = null }
      }
      for (const shot of project.shots) {
        if (shot.keyframeAssetId === assetId) shot.keyframeAssetId = null
        if (shot.videoAssetId === assetId) { shot.videoAssetId = null; shot.status = 'draft' }
      }
      await store.saveProject(project)
      return { ok: true }
    },

    /**
     * Join several rendered clips into one film.
     *
     * A stream copy: the clips already share codec, size and frame rate, so this
     * is lossless and takes about a tenth of a second. It is deliberately not a
     * generation — rendering the whole film in one pass is precisely what the
     * 5-15s clip limit forbids.
     *
     * @param {object} request { projectId, assetIds, label }
     */
    async mergeClips(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: 'no such project' } }

      const ids = (Array.isArray(request.assetIds) ? request.assetIds : []).filter((id) => project.assets[id])
      if (ids.length < 2) {
        return { ok: false, error: { code: 'too-few', message: '至少选择两个片段才能合并' } }
      }

      const cfg = await config()
      const located = await resolveFfmpeg({
        explicit: cfg.comfy.ffmpegPath,
        comfyRoot: cfg.comfy.comfyRoot,
      })
      if (!located.path) {
        return {
          ok: false,
          error: {
            code: 'no-ffmpeg',
            message: '找不到 ffmpeg。可在设置里指定路径，或安装 ffmpeg 后重试。',
            detail: located.tried,
          },
        }
      }

      // Ordered by the request, so the user controls the cut order — not by asset
      // id, which is a uuid and carries no sequence.
      const inputs = []
      for (const id of ids) {
        const meta = project.assets[id]
        if (meta.kind !== 'video') {
          return { ok: false, error: { code: 'not-video', message: '只能合并视频片段' } }
        }
        inputs.push(assets.assetFilePath(project.id, meta))
      }

      const outId = assets.newAssetId('video')
      const outPath = assets.assetFilePath(project.id, { id: outId, ext: 'mp4' })
      const result = await concatVideos({
        bin: located.path,
        inputs,
        output: outPath,
        workDir: assets.assetsDir(project.id),
      })
      if (!result.ok) {
        return { ok: false, error: { code: result.error, message: 'ffmpeg 合并失败', detail: result.stderr } }
      }

      const { size } = await stat(outPath)
      const seconds = await probeDuration(located.path, outPath)
      const meta = {
        id: outId,
        kind: 'video',
        ext: 'mp4',
        bytes: size,
        createdAt: new Date().toISOString(),
        label: String(request.label ?? `合辑 · ${ids.length} 段`).slice(0, 120),
        origin: 'merge',
        sourceAssetIds: ids,
        seconds: seconds ?? null,
        mode: result.mode,
      }
      project.assets[outId] = meta
      await store.saveProject(project)
      return { ok: true, asset: meta, project }
    },

    /**
     * Store a user-supplied image and attach it to an entity as its reference.
     *
     * Accepts a data URL because the browser already has the bytes and this avoids
     * a multipart route. The image is kept byte-for-byte: an upload is usually a
     * photo of a real actor or location, and re-encoding it would lose detail the
     * whole point of supplying it was to keep.
     *
     * @param {object} request { projectId, entityId, dataUrl, filename }
     */
    async uploadReference(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: 'no such project' } }

      // Character classes avoid \w so no escaping layer can strip a backslash out of it.
      const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,(.+)$/s.exec(String(request.dataUrl ?? ''))
      if (!match) return { ok: false, error: { code: 'bad-image', message: 'expected a base64 data URL' } }

      const mime = match[1]
      if (!mime.startsWith('image/')) return { ok: false, error: { code: 'bad-image', message: 'only images can be uploaded' } }
      const bytes = Buffer.from(match[2], 'base64')
      if (bytes.byteLength === 0) return { ok: false, error: { code: 'bad-image', message: 'empty image' } }
      // ComfyUI's /upload/image and the browser both handle this comfortably; far
      // larger files are almost certainly a mistake rather than an intent.
      if (bytes.byteLength > 24 * 1024 * 1024) {
        return { ok: false, error: { code: 'too-large', message: 'image exceeds 24 MB' } }
      }

      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp' }[mime] ?? 'png'
      const id = assets.newAssetId('image')
      const meta = {
        id,
        kind: 'image',
        ext,
        createdAt: new Date().toISOString(),
        label: String(request.filename ?? '本地图片').slice(0, 120),
        origin: 'upload',
      }
      const { path, ...stored } = await assets.writeAsset(project.id, meta, bytes)
      void path
      project.assets[id] = stored

      const entity = [...project.characters, ...project.scenes].find((e) => e.id === request.entityId)
      if (entity) entity.refAssetId = id
      await store.saveProject(project)

      return { ok: true, asset: stored, project, attachedTo: entity?.id ?? null }
    },

    /**
     * Re-render an entity's reference from its current one.
     *
     * Uses Qwen-Image 2.1's reference-image path rather than plain img2img: the
     * source image is fed to the text encoder AND spliced in as latents, so the
     * subject survives a background swap or a style change that a low-denoise
     * img2img pass would smear.
     *
     * @param {object} request { projectId, entityId, instruction, keepSource }
     */
    async startRestyleRun(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: 'no such project' } }
      const entity = [...project.characters, ...project.scenes].find((e) => e.id === request.entityId)
      if (!entity) return { ok: false, error: { code: 'not-found', message: 'no such entity' } }
      const sourceMeta = project.assets[entity.refAssetId]
      if (!sourceMeta) return { ok: false, error: { code: 'no-source', message: 'this entity has no reference image to work from' } }

      const runId = runs.start({
        kind: 'restyle',
        label: '重绘 · ' + entity.name,
        projectId: project.id,
        async work({ progress, signal }) {
          const cfg = await config()
          const lists = await installedModels()
          const resolved = resolveFor(cfg, lists, cfg.comfy.mode)
          const preset = PRESETS[cfg.comfy.preset] ?? PRESETS.standard
          const comfy = clientFor(cfg)

          const kind = project.characters.includes(entity) ? 'character' : 'scene'
          const base = compileImagePrompt(entity, kind, project)
          const instruction = String(request.instruction ?? '').trim()
            || (kind === 'character'
              ? 'keep the same person and the same face, replace the background with a plain neutral studio backdrop, unify the lighting and colour grade to the described look'
              : 'keep the same place and framing, unify the lighting and colour grade to the described look')

          progress({ phase: 'restyle', message: '上传原图到 ComfyUI' })
          const bytes = await assets.readAsset(project.id, sourceMeta)
          const uploaded = await comfy.uploadImage(bytes, project.id + '-src-' + entity.id + '.' + sourceMeta.ext, { overwrite: true })
          const sourceName = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name

          const resolution = base.params
          const graph = buildQwenImageGraph({
            models: resolved.image,
            // The instruction leads; the entity's own description keeps identity.
            positive: instruction + '. ' + base.positive,
            negative: base.negative,
            width: resolution.width,
            height: resolution.height,
            seed: Math.floor(Math.random() * 2 ** 31),
            steps: preset.imageSteps,
            cfg: preset.imageCfg,
            samplerName: preset.samplerName,
            turbo: preset.imageTurbo,
            referenceImages: [sourceName],
            filenamePrefix: 'shortdrama/' + project.id + '/restyle-' + entity.id,
          })

          const validation = await comfy.validate(graph)
          if (!validation.ok) {
            const error = new Error('图被拒绝：' + validation.errors.slice(0, 3).join('；'))
            error.code = 'graph-invalid'
            throw error
          }
          const { promptId } = await comfy.submit(graph)
          const settled = await comfy.waitFor(promptId, {
            signal,
            timeoutMs: 30 * 60 * 1000,
            onProgress: ({ elapsedMs }) => progress({ phase: 'restyle', message: '渲染中 ' + Math.round(elapsedMs / 1000) + 's' }),
          })
          if (settled.status !== 'completed') throw Object.assign(new Error('渲染失败'), { code: 'render-failed' })
          const output = settled.outputs.find((o) => o.kind === 'image')
          if (!output) throw Object.assign(new Error('没有产出图片'), { code: 'no-output' })
          const view = await comfy.view(output)
          const ext = String(output.filename).toLowerCase().match(/\.([a-z0-9]{2,5})$/) ?.[1] ?? 'png'

          const id = assets.newAssetId('image')
          const meta = {
            id, kind: 'image', ext, createdAt: new Date().toISOString(),
            label: entity.name + ' · 重绘',
            origin: 'restyle',
            sourceAssetId: entity.refAssetId,
            prompt: graph[Object.keys(graph).find((k) => graph[k].class_type === 'TextEncodeQwenImage21')].inputs.prompt,
          }
          const written = await assets.writeAsset(project.id, meta, new Uint8Array(view.bytes))
          const { path, ...stored } = written
          void path

          const fresh = await store.getProject(project.id)
          fresh.assets[id] = stored
          const target = [...fresh.characters, ...fresh.scenes].find((e) => e.id === entity.id)
          // Keeping the old bytes would leave an orphan file; the source id stays
          // recorded on the new asset so the chain is still traceable.
          if (target) target.refAssetId = id
          await store.saveProject(fresh)
          return { entityId: entity.id, assetId: id }
        },
      })
      return { ok: true, runId }
    },

    // ---------------------------------------------------- P2 generation runs

    /** @param {{projectId:string, brief?:string, instruction?:string, targetSec?:number, revise?:boolean}} request */
    async startScriptRun(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }
      const resolvedDeps = await resolveLlmDeps()
      if (resolvedDeps.error) return { ok: false, error: resolvedDeps.error }
      const deps = resolvedDeps.deps
      const runId = runs.start({
        kind: 'script',
        label: `剧本 · ${project.title}`,
        projectId: project.id,
        async work({ progress, signal }) {
          const result = await runScriptStage(deps, {
            project,
            brief: request.brief,
            instruction: request.instruction,
            reviseFrom: request.revise ? project.script : undefined,
            targetSec: request.targetSec,
            signal,
            onProgress: (info) => progress({
              phase: `script:${info.phase}`,
              text: info.text,
              reasoning: info.reasoning,
              problems: info.problems,
              message: info.phase === 'retrying' ? '格式校验未通过，正在重试' : '生成中',
            }),
          })
          const updated = {
            ...project,
            ...result.meta,
            // Belt and braces. The prompt now tells the model to echo the style, but
            // the schema still REQUIRES a style field, and a model that ignores the
            // instruction would replace an operator's preset on the first run.
            // Downstream stages all read project.style, so the preset wins.
            ...(project.style ? { style: project.style } : {}),
            script: result.script,
            // The target belongs ON THE PROJECT, not only in the request that produced
            // the script. It used to live in this one call and nowhere else, so asking
            // for 30s wrote a 30s script while targetTotalSec stayed at the project
            // default of 60 — and the storyboard, the H3 prompts and the clip split all
            // planned a 60s film. The script and the board disagreed about the runtime
            // and nothing surfaced the disagreement.
            ...(Number.isFinite(Number(request.targetSec)) && Number(request.targetSec) > 0
              ? { targetTotalSec: Number(request.targetSec) }
              : {}),
            usage: accumulateLlmUsage(project, 'script', result.usage, result.attempts),
          }
          await store.saveProject(updated)
          return { project: updated, attempts: result.attempts, usage: result.usage, model: deps.selection }
        },
      })
      return { ok: true, runId }
    },

    /**
     * Expand each shot into a full frame prompt.
     *
     * The action says what happens in the beat; an image model needs the whole frame described. Keyframes
     * built from the action alone come out as staged tableaux — the gap is not one an
     * operator will close by hand across twenty shots.
     *
     * @param {{projectId:string, shotIds?:string[]}} request
     */
    async startShotPromptRun(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }
      const all = Array.isArray(project.shots) ? project.shots : []
      const wanted = Array.isArray(request.shotIds) && request.shotIds.length > 0
        ? all.filter((s) => request.shotIds.includes(s.id))
        : all
      if (wanted.length === 0) {
        return { ok: false, error: { code: 'no-shots', message: '这个项目还没有镜头，先拆分镜' } }
      }
      const resolvedDeps = await resolveLlmDeps()
      if (resolvedDeps.error) return { ok: false, error: resolvedDeps.error }
      const deps = resolvedDeps.deps
      const runId = runs.start({
        kind: 'shotprompts',
        label: `画面提示词 · ${project.title}`,
        projectId: project.id,
        async work({ progress, signal }) {
          const result = await runShotDirectionStage(deps, {
            project,
            shots: wanted,
            signal,
            onProgress: (info) => progress({
              phase: `direction:${info.phase}`,
              text: info.text,
              reasoning: info.reasoning,
              problems: info.problems,
              message: info.phase === 'retrying' ? '格式校验未通过，正在重试' : '生成中',
            }),
          })
          // Merge by id into the FULL list, so shots that were not asked for are
          // untouched rather than replaced by a shorter array.
          const byId = new Map(result.shots.map((s) => [s.id, s]))
          const updated = {
            ...project,
            shots: all.map((s) => byId.get(s.id) ?? s),
            usage: accumulateLlmUsage(project, 'shotprompts', result.usage, result.attempts),
          }
          await store.saveProject(updated)
          return {
            project: updated,
            written: result.written,
            total: result.total,
            missing: result.missing,
            usage: result.usage,
            model: deps.selection,
          }
        },
      })
      return { ok: true, runId }
    },

    async startCastRun(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }
      const resolvedDeps = await resolveLlmDeps()
      if (resolvedDeps.error) return { ok: false, error: resolvedDeps.error }
      const deps = resolvedDeps.deps
      const runId = runs.start({
        kind: 'cast',
        label: `人物与场景 · ${project.title}`,
        projectId: project.id,
        async work({ progress, signal }) {
          const result = await runCastStage(deps, {
            project,
            signal,
            onProgress: (info) => progress({
              phase: `cast:${info.phase}`,
              text: info.text,
              reasoning: info.reasoning,
              problems: info.problems,
              message: info.phase === 'retrying' ? '格式校验未通过，正在重试' : '生成中',
            }),
          })
          // Keep any reference art already rendered for a same-named entity.
          const previousCharacters = new Map(project.characters.map((c) => [c.name, c]))
          const previousScenes = new Map(project.scenes.map((s) => [s.name, s]))
          const characters = result.characters.map((entity) => {
            const previous = previousCharacters.get(entity.name)
            return previous ? { ...entity, refAssetId: previous.refAssetId, refSeed: previous.refSeed } : entity
          })
          const scenes = result.scenes.map((entity) => {
            const previous = previousScenes.get(entity.name)
            return previous ? { ...entity, refAssetId: previous.refAssetId, refSeed: previous.refSeed } : entity
          })
          const updated = {
            ...project,
            characters,
            scenes,
            usage: accumulateLlmUsage(project, 'cast', result.usage, result.attempts),
          }
          await store.saveProject(updated)
          return { project: updated, attempts: result.attempts, usage: result.usage, model: deps.selection }
        },
      })
      return { ok: true, runId }
    },

    async startStoryboardRun(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }
      const resolvedDeps = await resolveLlmDeps()
      if (resolvedDeps.error) return { ok: false, error: resolvedDeps.error }
      const deps = resolvedDeps.deps
      const cfgForStoryboard = await config()
      const runId = runs.start({
        kind: 'storyboard',
        label: `分镜头 · ${project.title}`,
        projectId: project.id,
        async work({ progress, signal }) {
          const result = await runStoryboardStage(deps, {
            project,
            instruction: request.instruction,
            targetSec: request.targetSec,
            // Defaults to the configured render window so the board is always
            // written against the length one H3 submission actually produces.
            clipSeconds: request.clipSeconds ?? cfgForStoryboard.comfy.clipSeconds,
            signal,
            onProgress: (info) => progress({
              phase: `storyboard:${info.phase}`,
              text: info.text,
              reasoning: info.reasoning,
              problems: info.problems,
              message: info.phase === 'retrying' ? '分镜校验未通过，正在重写' : '生成中',
            }),
          })
          const updated = {
            ...project,
            shots: result.shots,
            // Same reason as the script stage: an explicitly requested target must
            // outlive the request that asked for it, or the next stage invents one.
            ...(Number.isFinite(Number(request.targetSec)) && Number(request.targetSec) > 0
              ? { targetTotalSec: Number(request.targetSec) }
              : {}),
            // Record which script this board came from, so a later script change
            // can be reported as staleness instead of silently misleading.
            shotsFromScript: scriptFingerprint(project.script),
            usage: accumulateLlmUsage(project, 'storyboard', result.usage, result.attempts),
          }
          await store.saveProject(updated)

          // Chain the frame-prompt pass straight after the board. It is always
          // wanted, and a step that exists only to be remembered is a step that gets
          // forgotten — which is exactly what happened when it had its own button.
          //
          // A failure here must NOT undo the board: the shots are already saved and
          // usable, so the error is reported and the operator can retry the pass
          // alone, per shot if they prefer.
          let withPrompts = updated
          try {
            progress({ phase: 'direction:start', message: '分镜已生成，正在写画面提示词…' })
            const direction = await runShotDirectionStage(deps, {
              project: updated,
              shots: updated.shots,
              signal,
              onProgress: (info) => progress({
                phase: `direction:${info.phase}`,
                text: info.text,
                reasoning: info.reasoning,
                problems: info.problems,
                message: '正在写画面提示词',
              }),
            })
            const promptById = new Map(direction.shots.map((s) => [s.id, s]))
            withPrompts = {
              ...updated,
              shots: updated.shots.map((s) => promptById.get(s.id) ?? s),
              usage: accumulateLlmUsage(updated, 'shotprompts', direction.usage, direction.attempts),
            }
            await store.saveProject(withPrompts)
          } catch (error) {
            progress({ message: `画面提示词生成失败：${error?.message ?? error}（分镜已保存，可在分镜页单独重试）` })
          }

          return {
            project: withPrompts,
            attempts: result.attempts,
            usage: result.usage,
            repairs: result.repairs,
            summary: result.summary,
            lint: lintStoryboard(result.shots, updated),
            model: deps.selection,
          }
        },
      })
      return { ok: true, runId }
    },

    // ------------------------------------------------------- P3/P4 render runs

    startReferenceRun(request = {}) {
      return api.startTypedRender('reference', request, `参考图 · ${request.projectId}`)
    },

    startKeyframeRun(request = {}) {
      return api.startTypedRender('keyframe', request, `关键帧 · ${request.projectId}`)
    },

    startVideoRun(request = {}) {
      return api.startTypedRender('video', request, `出片 · ${request.projectId}`)
    },

    async startTypedRender(kind, request, label) {
      if (!request?.projectId) return { ok: false, error: { code: 'bad-args', message: 'projectId is required' } }
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }

      const stage = kind === 'reference'
        ? (context) => renderReferences(context, request)
        : kind === 'keyframe'
          ? (context) => renderKeyframes(context, request)
          : (context) => renderClips(context, request)

      const runId = startRenderRun({ kind, label, projectId: project.id, stage })
      return { ok: true, runId }
    },

    // ------------------------------------------------------------------- runs

    runStatus: (id) => runs.get(id),
    runList: (options) => runs.list(options),
    runCancel: (id) => runs.cancel(id),
    disposeRuns: () => runs.dispose(),

    // --------------------------------------------------------------- compile

    async compile(request = {}) {
      const cfg = await config()
      const project = await store.getProject(request.projectId)
      if (!project) return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }

      const wanted = Array.isArray(request.shotIds) && request.shotIds.length > 0
        ? project.shots.filter((s) => request.shotIds.includes(s.id))
        : project.shots

      if (wanted.length === 0) {
        return { ok: false, error: { code: 'no-shots', message: 'the project has no shots to compile' } }
      }

      const labels = cfg.prompt.labels
      const byId = new Map(wanted.map((s) => [s.id, s]))

      const clips = groupIntoClips(wanted, { maxFrames: snapFrames(cfg.comfy.clipSeconds) }).map((clip, index) => {
        const shots = clip.shotIds.map((id) => byId.get(id)).filter(Boolean)
        const compiled = compileH3Prompt(shots, project, { labels })
        return {
          index,
          shotIds: clip.shotIds,
          frames: compiled.frames,
          seconds: compiled.seconds,
          targetSeconds: Math.round(shots.reduce((n, s) => n + (Number(s.durationSec) || 0), 0) * 10) / 10,
          prompt: compiled.prompt,
          apiRequest: compiled.apiRequest,
          warnings: compiled.warnings,
          resolution: resolutionFor(project.ratio),
          rendered: shots.every((s) => s.videoAssetId),
          videoAssetId: shots.find((s) => s.videoAssetId)?.videoAssetId ?? null,
        }
      })

      const shots = wanted.map((shot) => {
        const single = compileH3Prompt([shot], project, { labels })
        const keyframe = compileKeyframePrompt(shot, project)
        return {
          id: shot.id,
          no: shot.no,
          sceneId: shot.sceneId,
          durationSec: shot.durationSec,
          frames: snapFrames(shot.durationSec),
          actualSeconds: framesToSeconds(snapFrames(shot.durationSec)),
          promptH3: single.prompt,
          promptComfy: single.prompt,
          keyframe: { positive: keyframe.positive, negative: keyframe.negative, params: keyframe.params },
          warnings: [...single.warnings, ...keyframe.warnings],
          keyframeAssetId: shot.keyframeAssetId,
          videoAssetId: shot.videoAssetId,
          status: shot.status,
        }
      })

      const cast = project.characters.map((entity) => ({
        id: entity.id,
        name: entity.name,
        refAssetId: entity.refAssetId,
        refSeed: entity.refSeed,
        ...compileImagePrompt(entity, 'character', project),
      }))
      const scenes = project.scenes.map((entity) => ({
        id: entity.id,
        name: entity.name,
        refAssetId: entity.refAssetId,
        refSeed: entity.refSeed,
        ...compileImagePrompt(entity, 'scene', project),
      }))

      return {
        ok: true,
        projectId: project.id,
        project: {
          title: project.title, ratio: project.ratio, style: project.style,
          mode: cfg.comfy.mode, preset: cfg.comfy.preset,
        },
        /**
         * Whether the board these prompts came from still matches the script.
         *
         * The prompts are compiled from SHOTS, not from the script, so replacing
         * the script leaves them describing the previous story until the board is
         * rebuilt. Nothing about the output would reveal that, which is exactly why
         * the flag is returned with the result rather than left for the operator to
         * infer.
         */
        scriptStale: Boolean(
          project.script
          && project.shotsFromScript
          && project.shotsFromScript !== scriptFingerprint(project.script),
        ),
        /** True when the board predates fingerprinting, so staleness is unknown. */
        scriptStaleUnknown: Boolean(project.script && !project.shotsFromScript),
        resolution: resolutionFor(project.ratio),
        clips,
        shots,
        cast,
        scenes,
        lint: lintStoryboard(project.shots, project),
        /**
         * The closed vocabularies the compiler normalises, so the UI can offer them —
         * plus the English -> Chinese map, because a stored board holds the English
         * form and a <select> of Chinese options cannot display it without it.
         */
        vocabulary: { ...VOCAB, reverse: reverseVocab(VOCAB) },
        /** The tier the project's current budget corresponds to, for the selector. */
        currentTier: tierForMegapixels(project?.imageMegapixels ?? 2).key,
        /** One-click style lines. A preset writes project.style; it is not a mode. */
        stylePresets: STYLE_PRESETS,
        /** Output tiers and the ratios the compiler can actually resolve. */
        resolutionTiers: RESOLUTION_TIERS,
        ratios: Object.keys(RATIOS),
      }
    },

    // ----------------------------------------------------------------- export

    /**
     * Write the production bundle for a project.
     *
     * Degrades rather than refusing. The script and the cast bible are worth
     * exporting on their own, so a board that has no shots yet — or a project
     * still at the script stage — exports what exists and reports what it could
     * not write, instead of failing the whole action with `no-shots`.
     *
     * @param {{projectId:string, formats?:string[]}} request
     */
    async exportPrompts(request = {}) {
      const project = await store.getProject(request.projectId)
      if (!project) {
        return { ok: false, error: { code: 'not-found', message: `no project "${request.projectId}"` } }
      }

      const skipped = []
      const result = await api.compile(request)
      const compiled = result.ok ? result : null
      if (!compiled) {
        skipped.push(result.error?.code === 'no-shots' ? '还没有分镜表，提示词相关文件已跳过' : `编译失败：${result.error?.message}`)
      }

      const dir = join(exportsDir(), project.id)
      await mkdir(dir, { recursive: true })
      const written = []

      const formats = Array.isArray(request.formats) && request.formats.length > 0
        ? request.formats
        : ['h3', 'json', 'csv', 'script', 'cloud']

      if (compiled && formats.includes('h3')) {
        const body = compiled.clips.map((clip) => (
          `# Clip ${clip.index + 1} — ${clip.seconds}s (${clip.frames} frames)\n`
          + `# shots: ${clip.shotIds.join(', ')}\n`
          + `${clip.prompt}\n`
        )).join('\n---\n\n')
        const path = join(dir, 'h3-prompts.md')
        await writeFile(path, `${body}\n`, 'utf8')
        written.push(path)
      }

      if (compiled && formats.includes('json')) {
        const path = join(dir, 'prompts.json')
        await writeFile(path, `${JSON.stringify(compiled, null, 2)}\n`, 'utf8')
        written.push(path)
      }

      if (compiled && formats.includes('csv')) {
        const header = 'no,id,sceneId,durationSec,frames,shotSize,camera,movement,action,dialogue,h3Prompt'
        const escape = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`
        const rows = compiled.shots.map((s) => {
          const shot = project.shots.find((x) => x.id === s.id) ?? {}
          return [
            shot.no, s.id, s.sceneId ?? '', s.durationSec, s.frames,
            shot.shotSize ?? '', shot.camera ?? '', shot.movement ?? '', shot.action ?? '',
            (shot.dialogue ?? []).map((d) => `${d.who}: ${d.line}`).join(' | '),
            s.promptH3,
          ].map(escape).join(',')
        })
        const path = join(dir, 'shot-list.csv')
        // BOM so Excel opens the Chinese columns correctly.
        await writeFile(path, `\uFEFF${header}\n${rows.join('\n')}\n`, 'utf8')
        written.push(path)
      }

      if (formats.includes('script')) {
        const lines = [
          `# ${project.title}`,
          '',
          project.logline ? `> ${project.logline}` : '',
          '',
          project.script?.synopsis ? `## 梗概\n\n${project.script.synopsis}\n` : '',
        ]
        for (const beat of project.script?.beats ?? []) {
          lines.push(`## ${beat.id} · ${beat.summary}`)
          if (beat.emotion) lines.push(`_情绪：${beat.emotion}_`)
          lines.push('')
          for (const scene of (project.script?.scenes ?? []).filter((s) => s.beatId === beat.id)) {
            lines.push(`### ${scene.id} ${scene.slug}`)
            for (const line of scene.dialogue ?? []) lines.push(`- **${line.who}**：${line.line}`)
            lines.push('')
          }
        }
        if (project.characters.length > 0) {
          lines.push('## 人物设定', '')
          for (const c of project.characters) {
            lines.push(`### ${c.name}（${c.role || '角色'}）`, '', `- 一致性锚点：\`${c.lockToken}\``)
            const a = c.appearance ?? {}
            for (const [key, label] of [['hair', '发型'], ['build', '体型'], ['outfit', '服装'], ['mark', '标志物']]) {
              if (a[key]) lines.push(`- ${label}：${a[key]}`)
            }
            lines.push('')
          }
        }
        if (project.scenes.length > 0) {
          lines.push('## 场景设定', '')
          for (const s of project.scenes) {
            lines.push(`### ${s.name}`, '', `- ${[s.location, s.timeOfDay, s.lighting].filter(Boolean).join(' · ')}`, `- 一致性锚点：\`${s.lockToken}\``, '')
          }
        }
        const path = join(dir, 'script.md')
        await writeFile(path, `${lines.filter((l) => l !== undefined).join('\n')}\n`, 'utf8')
        written.push(path)
      }

      if (compiled && formats.includes('cloud')) {
        // The verified cloud shape, for anyone who wants to render on MiniMax's
        // API instead of locally. One request per clip.
        const requests = compiled.clips.map((clip) => ({
          endpoint: 'POST https://api.minimax.io/v2/video_generation',
          body: clip.apiRequest,
        }))
        const path = join(dir, 'cloud-requests.json')
        await writeFile(path, `${JSON.stringify(requests, null, 2)}\n`, 'utf8')
        written.push(path)
      }

      if (compiled && formats.includes('shotlist-json')) {
        const path = join(dir, 'shot-list.json')
        await writeFile(path, `${JSON.stringify({
          projectId: project.id,
          title: project.title,
          ratio: project.ratio,
          summary: { shots: project.shots.length, seconds: compiled.clips.reduce((n, c) => n + c.seconds, 0), clips: compiled.clips.length },
          shots: project.shots,
          clips: compiled.clips.map((c) => ({ index: c.index, shotIds: c.shotIds, frames: c.frames, seconds: c.seconds })),
        }, null, 2)}\n`, 'utf8')
        written.push(path)
      }

      // Succeeds even when there is no board yet: the script and cast bible are
      // worth exporting on their own, and `skipped` says what was left out.
      return {
        ok: true,
        ...(compiled ?? { projectId: project.id, clips: [], shots: [], cast: [], scenes: [], lint: [] }),
        export: { dir, written, skipped },
      }
    },

    /** Pure helpers surfaced so the UI can show the same math the compiler uses. */
    math: { snapFrames, framesToSeconds, resolutionFor, groupIntoClips, lintStoryboard },
  }

  return api
}

export default createApi
