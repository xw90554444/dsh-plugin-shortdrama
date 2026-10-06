/**
 * Render orchestration for P3 and P4.
 *
 * Each stage follows the same four steps per item: build the graph, pre-flight it
 * against the live server, submit, then wait and collect. Pre-flighting matters
 * because a rejected graph that is already queued costs a full queue cycle to
 * discover, and on H3 that cycle is minutes long.
 */
import {
  buildImageGraph, buildImageToImageGraph, buildH3Graph, buildH3ReferenceGraph,
  buildQwenImageGraph, isQwenImage, H3_MAX_REFERENCE_IMAGES,
} from '../comfy/graph.js'
import {
  compileImagePrompt, compileKeyframePrompt, compileH3Prompt, groupIntoClips, resolutionFor,
  detectFastMotion,
} from './compile.js'

/**
 * Fail the run when NOTHING rendered.
 *
 * A batch in which every item failed used to return normally, so the run settled
 * as `done` with an empty result: no error surfaced, no artifact appeared, and the
 * one action the operator took looked like it had done nothing at all. Reporting
 * success for zero output is never the truthful answer — and it is the worst
 * possible failure mode, because it hides every real cause behind silence.
 *
 * A PARTIAL success is a different case and is deliberately left alone: the result
 * lists exactly which items failed, the UI shows them, and the operator can retry
 * only those instead of paying for the whole batch again.
 *
 * @param {string} kind for the message
 * @param {object[]} done
 * @param {object[]} failed
 */
function assertSomethingRendered(kind, done, failed) {
  if (done.length > 0 || failed.length === 0) return
  const first = failed[0]
  const error = new Error(`全部 ${failed.length} 项${kind}都失败了：${first.message ?? first.code}`)
  // The first code drives the typed error the UI keys on; the detail keeps every
  // reason, because one bad model name can fail a whole batch identically.
  error.code = first.code ?? 'render-failed'
  error.detail = failed.map((f) => `${f.label ?? f.id}: ${f.message ?? f.code}`).join('；')
  throw error
}

/**
 * Text-to-image for the current image model, using that family's own graph.
 *
 * Qwen-Image gets its dedicated path (`TextEncodeQwenImage21` plus the MAIN text
 * encoder). Everything else falls back to the generic UNET + CLIPTextEncode
 * chain. Getting this wrong is not a subtle quality difference: feeding Qwen
 * through a generic encoder, off a prompt-enhancer checkpoint, produced visibly
 * soft images.
 */
function buildStageImageGraph(ctx, spec) {
  const params = {
    steps: ctx.preset.imageSteps,
    cfg: ctx.preset.imageCfg,
    samplerName: ctx.preset.samplerName,
    turbo: ctx.preset.imageTurbo,
    ...spec,
  }
  return isQwenImage(ctx.models.image)
    ? buildQwenImageGraph({ hasCacheNode: ctx.hasQwenCacheNode !== false, ...params })
    : buildImageGraph(params)
}

/** First collected output of the wanted media kind. */
function pickOutput(outputs, kind) {
  return outputs.find((o) => o.kind === kind) ?? null
}

/**
 * Submit one graph and collect its media.
 * @returns {Promise<{outputs:object[], bytes:Uint8Array, output:object, contentType:string, elapsedMs:number, promptId:string}>}
 */
async function runGraph(ctx, graph, { kind, label, index, total, timeoutMs }) {
  const validation = await ctx.comfy.validate(graph)
  if (!validation.ok) {
    const error = new Error(`${label}: graph rejected before submit — ${validation.errors.slice(0, 4).join('; ')}`)
    error.code = 'graph-invalid'
    error.problems = validation.errors
    throw error
  }
  for (const warning of validation.warnings.slice(0, 3)) {
    ctx.progress({ message: `${label}: ${warning}` })
  }

  const { promptId } = await ctx.comfy.submit(graph)
  ctx.progress({ phase: kind, message: `${label}: queued`, current: index, total })

  let settled
  try {
    settled = await ctx.comfy.waitFor(promptId, {
    signal: ctx.signal,
    timeoutMs: timeoutMs ?? 45 * 60 * 1000,
    onProgress: ({ elapsedMs, queuePosition, etaSeconds }) => {
      const waited = Math.round(elapsedMs / 1000)
      // "queue #1" told the operator nothing about whether that meant seconds or a
      // quarter of an hour. A video clip in front of a keyframe is the difference
      // between 35s and 14 minutes, and only the estimate conveys it.
      const where = queuePosition === 0
        ? '渲染中'
        : queuePosition === null
          ? '等待中'
          : `排队第 ${queuePosition} 位`
      const eta = etaSeconds > 0
        ? `，前面约需 ${etaSeconds >= 60 ? `${Math.round(etaSeconds / 60)} 分钟` : `${etaSeconds} 秒`}`
        : ''
      ctx.progress({
        phase: kind,
        message: `${label}: ${where}${eta}（已等 ${waited}s）`,
        current: index,
        total,
      })
    },
  })

  } catch (error) {
    // Cancelling the WAIT is not cancelling the WORK. Without this the run showed as
    // cancelled while ComfyUI kept sampling to the end — burning the GPU for output
    // nobody would collect, and holding the queue slot the next shot needed.
    if (error?.code === 'aborted' || ctx.signal?.aborted) {
      try {
        const stopped = await ctx.comfy.cancelPrompt(promptId)
        ctx.progress({ message: `${label}: 已请求停止（${stopped.running ? '中断正在执行的任务' : stopped.pending ? '从队列移除' : '任务已不在队列'}）` })
      } catch { /* stopping is best-effort; the cancel itself already succeeded */ }
    }
    throw error
  }

  if (settled.status !== 'completed') {
    const error = new Error(`${label}: ComfyUI reported a failed execution`)
    error.code = 'render-failed'
    error.detail = settled.raw
    throw error
  }

  const output = pickOutput(settled.outputs, kind === 'video' ? 'video' : 'image')
  if (!output) {
    const error = new Error(`${label}: execution completed but produced no ${kind}`)
    error.code = 'no-output'
    error.detail = settled.outputs
    throw error
  }

  const { bytes, contentType } = await ctx.comfy.view(output)
  return { outputs: settled.outputs, bytes: new Uint8Array(bytes), output, contentType, elapsedMs: settled.elapsedMs, promptId }
}

const thumbExt = (output, contentType) => String(output.filename ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1]
  ?? (contentType.includes('webm') ? 'webm' : contentType.includes('mp4') ? 'mp4' : 'png')

// ---------------------------------------------------------------------------
// P3a — character and location reference art
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx see module doc
 * @param {object} request { entityIds?: string[], kinds?: ('character'|'scene')[], force?: boolean, seed?: number }
 */
export async function renderReferences(ctx, request = {}) {
  const project = ctx.project
  const wantKinds = request.kinds ?? ['character', 'scene']
  const wantIds = Array.isArray(request.entityIds) && request.entityIds.length > 0 ? new Set(request.entityIds) : null

  const targets = []
  if (wantKinds.includes('character')) {
    for (const entity of project.characters) {
      if (wantIds && !wantIds.has(entity.id)) continue
      // Two assets per character, because they answer different questions: the
      // turnaround states the silhouette (what stops deformation), the hero shot
      // is the img2img source (a panel sheet would leak its borders into keyframes).
      targets.push({ entity, kind: 'character', view: 'turnaround' })
      targets.push({ entity, kind: 'character', view: 'hero' })
    }
  }
  if (wantKinds.includes('scenes') || wantKinds.includes('scene')) {
    for (const entity of project.scenes) if (!wantIds || wantIds.has(entity.id)) targets.push({ entity, kind: 'scene' })
  }
  const pending = targets.filter((t) => {
    if (request.force) return true
    return t.view === 'hero' ? !t.entity.heroAssetId : !t.entity.refAssetId
  })

  const done = []
  const failed = []
  ctx.progress({ phase: 'reference', total: pending.length, current: 0, message: `0/${pending.length}` })

  for (let i = 0; i < pending.length; i += 1) {
    if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'aborted' })
    const { entity, kind, view } = pending[i]
    const label = `${kind === 'character' ? (view === 'hero' ? '全身' : '三视图') : '场景'} ${entity.name}`
    try {
      // Two passes per character: a turnaround for identity, a hero shot for
      // img2img. Scenes need only one.
      const prompt = compileImagePrompt(entity, kind, project, { view })
      const seed = Number.isFinite(request.seed) ? request.seed + i
        : Number.isInteger(entity.refSeed) ? entity.refSeed
          : Math.floor(Math.random() * 2 ** 31)
      const resolution = prompt.params
      // The HERO shot is a source image, not a finished picture.
      //
      // The keyframe stage feeds it to img2img at denoise 0.55, so whatever it looks
      // like gets re-rendered anyway: its quality ceiling is the KEYFRAME's, not its
      // own. Paying full price for it is paying for detail that is about to be painted
      // over. The turnaround keeps the full preset because it IS the identity
      // reference, and nothing downstream restores what it lost.
      //
      // Measured on a 4070 Ti SUPER: the hero drops from ~55s to ~39s this way.
      const isHero = view === 'hero'
      const graph = buildStageImageGraph(ctx, {
        models: ctx.models.image,
        positive: prompt.positive,
        negative: prompt.negative,
        width: resolution.width,
        height: resolution.height,
        seed,
        ...(isHero ? { steps: 8, turbo: true } : {}),
        filenamePrefix: `shortdrama/${project.id}/${isHero ? 'hero' : 'ref'}-${entity.id}`,
      })

      const result = await runGraph(ctx, graph, { kind: 'reference', label, index: i + 1, total: pending.length })
      const ext = thumbExt(result.output, result.contentType)
      const asset = await ctx.putAsset('image', result.bytes, ext, {
        label,
        stage: 'reference',
        elapsedMs: result.elapsedMs,
        comfy: {
          filename: result.output.filename,
          subfolder: result.output.subfolder,
          type: result.output.type,
        },
        prompt: prompt.positive,
      })
      if (view === 'hero') {
        entity.heroAssetId = asset.id
      } else {
        entity.refAssetId = asset.id
        // The seed belongs to the turnaround: it is the asset a re-roll reproduces.
        entity.refSeed = seed
      }
      done.push({ id: entity.id, kind, assetId: asset.id, seed, elapsedMs: result.elapsedMs })
      await ctx.persist()
      ctx.progress({ phase: 'reference', current: i + 1, total: pending.length, message: `${label}: done` })
    } catch (error) {
      failed.push({ id: entity.id, kind, label, code: error?.code ?? 'error', message: String(error?.message ?? error) })
      ctx.progress({ phase: 'reference', current: i + 1, total: pending.length, message: `${label}: FAILED — ${error?.message ?? error}` })
      // One bad entity must not abandon the rest of the batch.
    }
  }

  assertSomethingRendered('参考图', done, failed)
  return { kind: 'reference', rendered: done, failed, total: pending.length }
}

// ---------------------------------------------------------------------------
// P3b — per-shot keyframes
// ---------------------------------------------------------------------------

/**
 * Render one keyframe per shot.
 *
 * When a shot names exactly one character who already has reference art, the
 * keyframe is an image-to-image pass over that reference at a moderate denoise:
 * enough freedom to place the subject in the shot, little enough to keep the
 * face. Multi-character shots fall back to text-to-image, because blending two
 * references reliably is a different problem than this stage should pretend to
 * solve.
 *
 * @param {object} request { shotIds?: string[], force?: boolean, mode?: 'auto'|'t2i'|'i2i', denoise?: number }
 */
export async function renderKeyframes(ctx, request = {}) {
  const project = ctx.project
  const wantIds = Array.isArray(request.shotIds) && request.shotIds.length > 0 ? new Set(request.shotIds) : null
  const pending = project.shots.filter((shot) => (!wantIds || wantIds.has(shot.id)) && (request.force || !shot.keyframeAssetId))
  const characterById = new Map(project.characters.map((c) => [c.id, c]))
  const mode = request.mode ?? 'auto'
  const denoise = Number.isFinite(request.denoise) ? request.denoise : 0.55

  const done = []
  const failed = []
  ctx.progress({ phase: 'keyframe', total: pending.length, current: 0, message: `0/${pending.length}` })

  for (let i = 0; i < pending.length; i += 1) {
    if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'aborted' })
    const shot = pending[i]
    const label = `镜头 ${shot.no}`
    try {
      const keyframe = compileKeyframePrompt(shot, project)
      const seed = Number.isInteger(shot.seed) ? shot.seed : Math.floor(Math.random() * 2 ** 31)
      const { width, height } = keyframe.params

      const cast = shot.characters.map((id) => characterById.get(id)).filter(Boolean)

      // One reference per character IN THIS SHOT, and none that are not in it —
      // a reference the model can see is a person it tends to draw. The hero shot is
      // preferred over the turnaround because a three-panel sheet leaks its panel
      // edges and repeated figures into anything derived from it.
      const referenceAssetIds = []
      for (const character of cast) {
        const assetId = character.heroAssetId ?? character.refAssetId
        if (assetId && project.assets[assetId] && !referenceAssetIds.includes(assetId)) referenceAssetIds.push(assetId)
      }

      let graph
      // Two ways to hold a face, and they are NOT equivalent.
      //
      // img2img at partial denoise locks the whole FRAME, not just the person: the
      // source's pose, crop and background survive. Starting from a studio character
      // portrait therefore produced studio character portraits regardless of what the
      // shot described — the action and the location were in the prompt and never
      // reached the pixels.
      //
      // Reference images are the mechanism meant for this. Qwen sees the person and
      // samples at FULL denoise, so identity comes from the reference while pose,
      // location and lighting come from the prompt. `i2i` remains available as an
      // explicit request, because sometimes locking the frame is exactly the point.
      const uploadedNames = []
      for (const assetId of referenceAssetIds) {
        const meta = project.assets[assetId]
        const bytes = await ctx.readAsset(meta)
        // Upload to the input ROOT, never a subfolder: `LoadImage.image` is an enum
        // of files directly under the input directory, so a subfolder upload is
        // invisible to pre-flight validation.
        const uploaded = await ctx.comfy.uploadImage(bytes, `${project.id}-${assetId}.${meta.ext}`, { overwrite: true })
        uploadedNames.push(uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name)
      }

      if (mode === 'i2i' && uploadedNames.length === 1) {
        graph = buildImageToImageGraph({
          models: ctx.models.image,
          positive: keyframe.positive,
          negative: keyframe.negative,
          inputImage: uploadedNames[0],
          denoise,
          seed,
          steps: ctx.preset.imageSteps,
          cfg: ctx.preset.imageCfg,
          samplerName: ctx.preset.samplerName,
          turbo: ctx.preset.imageTurbo,
          targetMegapixels: Math.round((width * height) / 1e6 * 100) / 100,
          filenamePrefix: `shortdrama/${project.id}/key-${shot.id}`,
        })
      } else {
        graph = buildStageImageGraph(ctx, {
          models: ctx.models.image,
          positive: keyframe.positive,
          negative: keyframe.negative,
          width,
          height,
          seed,
          // Capped at 4. The encoder accepts more, but every extra reference is
          // another full figure spliced into the sequence, and cast lists this long
          // are rare enough that the cost is not worth paying by default.
          referenceImages: uploadedNames.slice(0, 4),
          filenamePrefix: `shortdrama/${project.id}/key-${shot.id}`,
        })
      }

      const result = await runGraph(ctx, graph, { kind: 'keyframe', label, index: i + 1, total: pending.length })
      const ext = thumbExt(result.output, result.contentType)
      const asset = await ctx.putAsset('image', result.bytes, ext, {
        label,
        shotId: shot.id,
        stage: 'keyframe',
        elapsedMs: result.elapsedMs,
        mode: uploadedNames.length > 0 ? 'reference' : 't2i',
        // The images this frame was generated FROM.
        //
        // `i2i` puts the first one through LoadImage; `reference` hands the first
        // four to the text encoder. Either way they are the "originals" a comparison
        // needs, and they cannot be recovered afterwards: the upload loop keeps the
        // ComfyUI FILE names, which are derived from the asset id but cannot be turned
        // back into one. Recording the ids here is the only point where both are known.
        sourceAssetIds: referenceAssetIds.slice(0, 4),
        comfy: { filename: result.output.filename, subfolder: result.output.subfolder, type: result.output.type },
        prompt: keyframe.positive,
      })
      shot.keyframeAssetId = asset.id
      shot.seed = seed
      shot.status = shot.videoAssetId ? shot.status : 'keyframed'
      done.push({ id: shot.id, assetId: asset.id, mode: uploadedNames.length > 0 ? 'reference' : 't2i', elapsedMs: result.elapsedMs })
      await ctx.persist()
      ctx.progress({ phase: 'keyframe', current: i + 1, total: pending.length, message: `${label}: done` })
    } catch (error) {
      failed.push({ id: shot.id, label, code: error?.code ?? 'error', message: String(error?.message ?? error) })
      ctx.progress({ phase: 'keyframe', current: i + 1, total: pending.length, message: `${label}: FAILED — ${error?.message ?? error}` })
    }
  }

  assertSomethingRendered('关键帧', done, failed)
  return { kind: 'keyframe', rendered: done, failed, total: pending.length }
}

// ---------------------------------------------------------------------------
// P4 — MiniMax-H3 clips
// ---------------------------------------------------------------------------

/**
 * Render each clip with MiniMax-H3, including its native audio.
 *
 * Continuity between clips comes from keyframes rather than from extracting the
 * previous clip's last frame: every shot already has a keyframe, so the next
 * clip's `first_frame` is simply the keyframe of its own first shot. That keeps
 * the chain honest without a frame-extraction step that would have to decode the
 * previous video.
 *
 * @param {object} request { clipIndexes?: number[], shotIds?: string[], force?: boolean }
 */
export async function renderClips(ctx, request = {}) {
  const project = ctx.project
  // Group with the SAME clip budget the storyboard and prompts were compiled
  // against, so the rendered segmentation matches the compiled timeline. If the
  // two disagreed, clip N's prompt would not describe clip N's footage.
  //
  // `clipFrames` is the CEILING of one band and `clipFramesMin` its floor, so a clip ends where the
  // material wants to end instead of on a fixed multiple of the render window. Falling back to the
  // ceiling as the floor reproduces the old exact-length behaviour for any caller that supplies only
  // the one value.
  const clips = groupIntoClips(project.shots, ctx.clipFrames
    ? { maxFrames: ctx.clipFrames, minFrames: ctx.clipFramesMin ?? ctx.clipFrames }
    : {})
  const byId = new Map(project.shots.map((s) => [s.id, s]))

  const selected = clips.filter((clip) => {
    if (Array.isArray(request.clipIndexes) && request.clipIndexes.length > 0 && !request.clipIndexes.includes(clip.index)) return false
    if (Array.isArray(request.shotIds) && request.shotIds.length > 0 && !clip.shotIds.some((id) => request.shotIds.includes(id))) return false
    if (request.force) return true
    return clip.shotIds.some((id) => !byId.get(id)?.videoAssetId)
  })

  const done = []
  const failed = []
  ctx.progress({ phase: 'video', total: selected.length, current: 0, message: `0/${selected.length}` })

  for (let i = 0; i < selected.length; i += 1) {
    if (ctx.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'aborted' })
    const clip = selected[i]
    const label = `片段 ${clip.index + 1} (${clip.seconds}s)`
    try {
      const shots = clip.shotIds.map((id) => byId.get(id)).filter(Boolean)
      const compiled = compileH3Prompt(shots, project, { labels: ctx.labels })

      const { width, height } = resolutionFor(project.ratio)
      const seed = Number.isInteger(request.seed) ? request.seed + i : Math.floor(Math.random() * 2 ** 31)
      const filenamePrefix = `shortdrama/${project.id}/clip-${clip.index}`

      // Continuity: the next clip starts from its own first keyframe. Even in
      // REF2VA mode this is worth having, as the fallback when no reference art
      // exists yet.
      let firstFrame = null
      const firstShot = shots[0]
      if (firstShot?.keyframeAssetId && project.assets[firstShot.keyframeAssetId]) {
        const meta = project.assets[firstShot.keyframeAssetId]
        const bytes = await ctx.readAsset(meta)
        // Root upload: `LoadImage.image` only lists files directly under the input
        // directory, so a subfolder upload never appears in its option enum.
        const uploaded = await ctx.comfy.uploadImage(bytes, `${project.id}-clip${clip.index}-first.${meta.ext}`, {
          overwrite: true,
        })
        firstFrame = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
      }

      // Anchor the clip at BOTH ends.
      //
      // The graph has always accepted a last frame; it was simply never supplied,
      // so the model was free to finish anywhere. Two things change by wiring it:
      //
      //  - the last shot's keyframe stops being dead weight. A clip of N shots used
      //    to consume one keyframe and discard the other N-1, which were rendered at
      //    full cost and influenced nothing.
      //  - the join between clips becomes physical rather than planned. Clip N ends
      //    on the image clip N+1 opens with, instead of both sides merely being
      //    described in similar words.
      //
      // Skipped for a single-shot clip: there, first and last are the same frame and
      // pinning both would ask the model to produce a still.
      // Whether this clip actually got anchored. Without it an unanchored clip renders
      // as plain text-to-video and still reports "done" — the composition is invented
      // rather than inherited, and nothing in the result says so. A shot with no
      // keyframe is the ordinary way that happens.
      if (!firstFrame) {
        ctx.progress({
          phase: 'video',
          current: i,
          total: selected.length,
          message: `${label}: 首镜头没有关键帧，这一段会退化成纯文字生成（构图不受控）。先出关键帧再出片。`,
        })
      }
      const anchored = { first: Boolean(firstFrame), last: false }

      let lastFrame = null
      const lastShot = shots[shots.length - 1]
      if (shots.length > 1 && lastShot?.keyframeAssetId && project.assets[lastShot.keyframeAssetId]) {
        const meta = project.assets[lastShot.keyframeAssetId]
        const bytes = await ctx.readAsset(meta)
        const uploaded = await ctx.comfy.uploadImage(bytes, `${project.id}-clip${clip.index}-last.${meta.ext}`, {
          overwrite: true,
        })
        lastFrame = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
      }

      /**
       * Which sampling settings THIS clip gets.
       *
       * One preset used to apply to the whole film, so a fight scene and a shot of someone standing
       * still cost the same and were sampled the same. That is the wrong trade in both directions:
       * the action needs the 20 full steps that turbo gives up, and nothing else needs to pay for
       * them. A 60-clip film is hours of rendering, most of it on shots where turbo is fine.
       *
       * The rule is one-way — auto-selection only ever RAISES quality, never drops below what the
       * operator chose. Quietly downgrading a clip they deliberately set to 精细 would be the
       * automation undoing a decision, which is worse than being slow.
       *
       * Each clip is a separate submission to ComfyUI, so this is genuinely per clip rather than a
       * label on the batch.
       */
      const motionReasons = [...new Set(shots.flatMap((shot) => detectFastMotion(shot).reasons))]
      const autoPreset = autoQuality && motionReasons.length > 0 && ctx.preset.turbo
        ? (ctx.presets?.quality ?? null)
        : null
      const effectivePreset = autoPreset ?? ctx.preset
      if (autoPreset) {
        ctx.progress({
          message: `${label}: 检测到快速动作（${motionReasons.join('、')}），自动改用「${autoPreset.label}」`
            + `${autoPreset.h3Steps} 步 · 不启用加速 LoRA`,
        })
      }

      // REF2VA keeps a subject's identity across the whole clip rather than only
      // pinning its opening frame, so it is the better path when the cast has
      // reference art. It needs no keyframe at all.
      let graph = null
      if (ctx.mode === 'ref2va') {
        const characterById = new Map(project.characters.map((c) => [c.id, c]))
        const wanted = []
        for (const shot of shots) {
          for (const id of shot.characters ?? []) {
            const character = characterById.get(id)
            if (character?.refAssetId && !wanted.includes(character.refAssetId)) wanted.push(character.refAssetId)
          }
        }
        const scene = project.scenes.find((s) => s.id === firstShot?.sceneId)
        if (scene?.refAssetId && !wanted.includes(scene.refAssetId)) wanted.push(scene.refAssetId)

        const referenceImages = []
        for (const assetId of wanted.slice(0, H3_MAX_REFERENCE_IMAGES)) {
          const meta = project.assets[assetId]
          if (!meta) continue
          const bytes = await ctx.readAsset(meta)
          const uploaded = await ctx.comfy.uploadImage(bytes, `${project.id}-ref-${assetId}.${meta.ext}`, { overwrite: true })
          referenceImages.push(uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name)
        }

        if (referenceImages.length > 0) {
          graph = buildH3ReferenceGraph({
            models: ctx.models.h3,
            prompt: compiled.prompt,
            width,
            height,
            length: clip.frames,
            seed,
            turbo: effectivePreset.turbo,
            steps: effectivePreset.h3Steps,
            referenceImages,
            refImageSize: ctx.refImageSize ?? 'match',
            filenamePrefix,
          })
        } else {
          ctx.progress({ message: `${label}: REF2VA 模式但没有可用参考图，回退到首尾帧模式` })
        }
      }

      if (!graph) {
        graph = buildH3Graph({
          models: ctx.models.h3,
          prompt: compiled.prompt,
          width,
          height,
          length: clip.frames,
          seed,
          turbo: effectivePreset.turbo,
          steps: effectivePreset.h3Steps,
          firstFrame,
          // Anchors the clip's ending on the last shot's keyframe, so the join to
          // the next clip is a real shared frame rather than a similar-sounding
          // description.
          lastFrame,
          filenamePrefix,
        })
      }

      anchored.last = Boolean(lastFrame)

      const result = await runGraph(ctx, graph, {
        kind: 'video',
        label,
        index: i + 1,
        total: selected.length,
        timeoutMs: 90 * 60 * 1000,
      })
      const ext = thumbExt(result.output, result.contentType)
      const asset = await ctx.putAsset('video', result.bytes, ext, {
        label,
        clipIndex: clip.index,
        stage: 'video',
        elapsedMs: result.elapsedMs,
        shotIds: clip.shotIds,
        frames: clip.frames,
        seconds: clip.seconds,
        comfy: {
          filename: result.output.filename,
          subfolder: result.output.subfolder,
          type: result.output.type,
          // Recorded so the question "was this an image-to-video render?" can be
          // answered from the artifact rather than by remembering the settings.
          anchoredFirstFrame: anchored.first,
          anchoredLastFrame: anchored.last,
        },
        prompt: compiled.prompt,
      })

      for (const shot of shots) {
        shot.videoAssetId = asset.id
        shot.status = 'done'
      }
      done.push({ anchored, clipIndex: clip.index, assetId: asset.id, frames: clip.frames, seconds: clip.seconds, elapsedMs: result.elapsedMs })
      await ctx.persist()
      ctx.progress({ phase: 'video', current: i + 1, total: selected.length, message: `${label}: done` })
    } catch (error) {
      const detail = error?.code === 'render-failed' && error.detail
        ? ` — ${JSON.stringify(error.detail?.status ?? {}).slice(0, 300)}`
        : ''
      failed.push({ clipIndex: clip.index, label, code: error?.code ?? 'error', message: `${String(error?.message ?? error)}${detail}` })
      ctx.progress({ phase: 'video', current: i + 1, total: selected.length, message: `${label}: FAILED — ${error?.message ?? error}` })
    }
  }

  assertSomethingRendered('出片', done, failed)
  return { kind: 'video', rendered: done, failed, total: selected.length }
}

export default { renderReferences, renderKeyframes, renderClips }
