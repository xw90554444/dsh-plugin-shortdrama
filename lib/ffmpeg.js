/**
 * Video concatenation via ffmpeg.
 *
 * H3 writes each clip as a standalone MP4, so "make the film" is a matter of
 * joining them. That is a stream copy — the clips already share a codec, size and
 * frame rate — so it costs a few seconds and re-encodes nothing. Joining is
 * deliberately NOT done through the sampler: re-rendering the whole film as one
 * generation is exactly what the 5–15s clip limit forbids.
 *
 * ffmpeg is not assumed to be on PATH. ComfyUI ships one inside `imageio-ffmpeg`,
 * and a ComfyUI installation is already required by this plugin, so that bundle is
 * searched first — it is the copy most likely to exist on a machine like this one.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, writeFile, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Where a ComfyUI install keeps the bundled ffmpeg, in the order worth trying. */
const BUNDLED_PATTERNS = [
  (root) => join(root, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
  (root) => join(root, 'venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
  (root) => join(root, 'python_embeded', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
]

let cached = null

async function exists(path) {
  try {
    await access(path, FS.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate an ffmpeg binary.
 *
 * @param {object} [options]
 * @param {string} [options.explicit] user override from config, used verbatim
 * @param {string} [options.comfyRoot] the ComfyUI installation root
 * @param {string} [options.baseUrl] used to derive a root when comfyRoot is absent
 * @returns {Promise<{path:string|null, source:string, tried:string[]}>}
 */
export async function resolveFfmpeg(options = {}) {
  if (cached && !options.explicit) return cached
  const tried = []

  const candidates = []
  if (options.explicit) candidates.push({ path: options.explicit, source: 'config' })

  // PATH, via where.exe — avoids depending on shell resolution rules.
  candidates.push({ path: 'ffmpeg', source: 'PATH' })

  // A configured root wins; otherwise the usual install locations are probed.
  // Without this fallback the bundled ffmpeg is never found, which is exactly how
  // an unconfigured install ends up reporting "no ffmpeg" while one sits on disk.
  const roots = []
  if (options.comfyRoot) roots.push(options.comfyRoot)
  if (options.searchDefaults !== false) roots.push(...guessComfyRoots())

  for (const root of roots) {
    for (const pattern of BUNDLED_PATTERNS) {
      const dir = pattern(root)
      if (await exists(dir)) {
        try {
          const { readdir } = await import('node:fs/promises')
          for (const entry of await readdir(dir)) {
            if (/^ffmpeg.*\.exe$/i.test(entry) || entry === 'ffmpeg') {
              candidates.push({ path: join(dir, entry), source: 'comfyui-bundle' })
            }
          }
        } catch { /* unreadable directory is not fatal */ }
      }
    }
  }

  for (const candidate of candidates) {
    tried.push(candidate.path)
    if (candidate.source === 'PATH') {
      const found = await new Promise((resolve) => {
        execFile('where', ['ffmpeg'], { windowsHide: true }, (error, stdout) => {
          if (error) return resolve(null)
          const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
          return resolve(first ?? null)
        })
      })
      if (found && await exists(found)) {
        cached = { path: found, source: 'PATH', tried }
        return cached
      }
      continue
    }
    if (await exists(candidate.path)) {
      cached = { path: candidate.path, source: candidate.source, tried }
      return cached
    }
  }

  cached = { path: null, source: 'none', tried }
  return cached
}

/** Reset the memoised lookup; used after the config changes. */
export function clearFfmpegCache() {
  cached = null
}

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        // The useful diagnostics are always on stderr.
        stderr: String(stderr ?? '').slice(-4000),
      })
    })
  })
}

/** @returns {Promise<{path:string|null, version:string}>} */
export async function ffmpegVersion(bin) {
  if (!bin) return { path: null, version: '' }
  const result = await run(bin, ['-version'])
  if (!result.ok) return { path: bin, version: '' }
  return { path: bin, version: result.stdout.split(/\r?\n/)[0] ?? '' }
}

/**
 * Concatenate videos into one file without re-encoding.
 *
 * Stream copy is tried first because it is lossless and near-instant. It requires
 * every input to share codec, resolution and frame rate — true for clips from one
 * H3 configuration, false the moment a clip came from a different model or size.
 * Rather than fail there, the re-encode path is attempted once, which always
 * works at the cost of time.
 *
 * @param {object} options
 * @param {string} options.bin ffmpeg path
 * @param {string[]} options.inputs absolute paths, in the desired order
 * @param {string} options.output absolute output path
 * @param {string} [options.workDir] where to put the concat list
 * @returns {Promise<{ok:boolean, mode?:'copy'|'reencode', error?:string, stderr?:string}>}
 */
export async function concatVideos({ bin, inputs, output, workDir }) {
  if (!bin) return { ok: false, error: 'no-ffmpeg' }
  if (!Array.isArray(inputs) || inputs.length === 0) return { ok: false, error: 'no-inputs' }
  if (inputs.length === 1) {
    return { ok: false, error: 'single-input' }
  }

  const dir = workDir ?? dirname(output)
  await mkdir(dir, { recursive: true })
  const listPath = join(dir, `concat-${Date.now()}.txt`)
  // The concat demuxer needs single quotes escaped, and paths must be absolute.
  const body = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listPath, `${body}\n`, 'utf8')

  const copy = await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart',
    output,
  ])
  if (copy.ok && await exists(output) && (await stat(output)).size > 1024) {
    return { ok: true, mode: 'copy' }
  }

  const reencode = await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    // Scale to an even height and a common timebase; odd dimensions break h264.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ])
  if (reencode.ok && await exists(output) && (await stat(output)).size > 1024) {
    return { ok: true, mode: 'reencode' }
  }

  return {
    ok: false,
    error: 'ffmpeg-failed',
    stderr: (reencode.stderr || copy.stderr).trim().split(/\r?\n/).slice(-6).join('\n'),
  }
}

/** Human-readable duration of one video, via ffprobe if present, else ffmpeg. */
export async function probeDuration(bin, file) {
  if (!bin) return null
  const result = await run(bin, ['-hide_banner', '-i', file])
  const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(result.stderr)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** The default root for a ComfyUI install on this machine, used only as a hint. */
export function guessComfyRoots() {
  const home = homedir()
  return [
    'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI (1)\\ComfyUI',
    join(home, 'ComfyUI'),
  ]
}

export default { resolveFfmpeg, clearFfmpegCache, ffmpegVersion, concatVideos, probeDuration, guessComfyRoots }
