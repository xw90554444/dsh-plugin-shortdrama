/**
 * Plugin configuration: load, validate, persist.
 *
 * Stored as JSON under the DSH home directory rather than inside the installed
 * package, so reinstalling or upgrading the plugin never destroys user settings.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
// Pure module, no I/O: safe to depend on, and it keeps the clip-length range
// defined in exactly one place.
import { clampClipSeconds } from './pipeline/compile.js'

/** `DSH_HOME` is set by the harness; the fallbacks only matter outside it. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function pluginRootDir() {
  return join(dshHome(), 'shortdrama')
}

export function configPath() {
  return join(pluginRootDir(), 'config.json')
}

export function projectsDir() {
  return join(pluginRootDir(), 'projects')
}

export function exportsDir() {
  return join(pluginRootDir(), 'exports')
}

export const DEFAULT_CONFIG = Object.freeze({
  comfy: {
    baseUrl: 'http://127.0.0.1:8188',
    /** 'fl2va' pins identity with a keyframe; 'ref2va' keeps it from reference images. */
    mode: 'fl2va',
    preset: 'standard',
    /**
     * REF2VA reference sizing. 'match' scales each reference to the generation's
     * pixel area; 'max' uses the reference pipeline's 2048px short edge for the
     * best identity fidelity at several times the sampling cost.
     */
    refImageSize: 'match',
    /**
     * Output budget for the image stages, in megapixels.
     *
     * Qwen-Image 2.1's own guidance is ~1 MP by default and up to 4 MP for native
     * 2K. Below ~1 MP the model visibly loses detail, which is why this is not the
     * H3 video canvas size.
     */
    imageMegapixels: 2,
    /** Explicit ffmpeg path; null means "find it" (ComfyUI bundles one). */
    ffmpegPath: null,
    /** ComfyUI install root, searched for a bundled ffmpeg. */
    comfyRoot: null,
    /**
     * 「单次出片时长」— how long one H3 generation runs.
     *
     * This is the unit the storyboard is written against: shots are packed to fill
     * this window and each clip is rendered in one submission, so changing it
     * changes how the board is split AND what the compiled timeline covers.
     * H3's trained span is 5–15s.
     */
    clipSeconds: 10,
    /** Explicit model overrides; null means "auto-resolve from what is installed". */
    models: {
      diffusionModel: null,
      textEncoder: null,
      vae: null,
      audioVae: null,
      lora: null,
      imageDiffusionModel: null,
      imageTextEncoder: null,
      imageVae: null,
      imageLora: null,
    },
  },
  /** Which model the script/cast/storyboard stages call. Null = follow the session default. */
  llm: {
    provider: null,
    model: null,
  },
  prompt: {
    /** Structural labels, overridable so the compiled prompt can read in Chinese. */
    labels: {
      timeline: 'Timeline:',
      audio: 'Audio:',
      continuity: 'Continuity:',
      negative: 'Avoid:',
      cutRule: 'Hard cuts only, each transition landing on a beat; no dissolves, no push-ins.',
    },
  },
  ui: {
    activeProjectId: null,
  },
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shallow-per-section merge that keeps unknown keys out and fills every default. */
export function mergeConfig(base, patch) {
  const out = {}
  for (const [key, value] of Object.entries(base)) {
    if (isPlainObject(value)) out[key] = mergeConfig(value, isPlainObject(patch?.[key]) ? patch[key] : {})
    else out[key] = patch && key in patch ? patch[key] : value
  }
  return out
}

/**
 * Coerce anything read from disk into a usable config.
 * A corrupt or hand-edited file must not brick the plugin, so bad fields fall
 * back to defaults instead of throwing.
 */
export function normaliseConfig(raw) {
  const merged = mergeConfig(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {})
  const baseUrl = typeof merged.comfy.baseUrl === 'string' && merged.comfy.baseUrl.trim()
    ? merged.comfy.baseUrl.trim()
    : DEFAULT_CONFIG.comfy.baseUrl
  const mode = merged.comfy.mode === 'ref2va' ? 'ref2va' : 'fl2va'
  const preset = ['draft', 'standard', 'quality'].includes(merged.comfy.preset) ? merged.comfy.preset : 'standard'
  const refImageSize = merged.comfy.refImageSize === 'max' ? 'max' : 'match'
  const imageMegapixels = Number.isFinite(Number(merged.comfy.imageMegapixels))
    ? Math.min(8, Math.max(0.5, Number(merged.comfy.imageMegapixels)))
    : DEFAULT_CONFIG.comfy.imageMegapixels
  const clipSeconds = clampClipSeconds(merged.comfy.clipSeconds)
  const ffmpegPath = typeof merged.comfy.ffmpegPath === 'string' && merged.comfy.ffmpegPath.trim() ? merged.comfy.ffmpegPath.trim() : null
  const comfyRoot = typeof merged.comfy.comfyRoot === 'string' && merged.comfy.comfyRoot.trim() ? merged.comfy.comfyRoot.trim() : null
  const models = {}
  for (const key of Object.keys(DEFAULT_CONFIG.comfy.models)) {
    const value = merged.comfy.models?.[key]
    models[key] = typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const labels = { ...DEFAULT_CONFIG.prompt.labels }
  for (const key of Object.keys(labels)) {
    const value = merged.prompt?.labels?.[key]
    if (typeof value === 'string' && value.length > 0) labels[key] = value
  }
  return {
    comfy: { baseUrl, mode, preset, refImageSize, imageMegapixels, clipSeconds, ffmpegPath, comfyRoot, models },
    llm: {
      provider: typeof merged.llm?.provider === 'string' && merged.llm.provider.trim() ? merged.llm.provider.trim() : null,
      model: typeof merged.llm?.model === 'string' && merged.llm.model.trim() ? merged.llm.model.trim() : null,
    },
    prompt: { labels },
    ui: {
      activeProjectId: typeof merged.ui?.activeProjectId === 'string' ? merged.ui.activeProjectId : null,
    },
  }
}

export async function readConfig() {
  try {
    const text = await readFile(configPath(), 'utf8')
    return normaliseConfig(JSON.parse(text))
  } catch {
    return normaliseConfig(null)
  }
}

/** Write via a temp file + rename so a crash mid-write cannot truncate the config. */
export async function writeConfig(config) {
  const normalised = normaliseConfig(config)
  const target = configPath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return normalised
}

/** Apply a partial patch and persist. */
export async function patchConfig(patch) {
  const current = await readConfig()
  return writeConfig(mergeConfig(current, patch ?? {}))
}
