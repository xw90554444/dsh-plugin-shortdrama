/**
 * Programmatic ComfyUI graph construction.
 *
 * The design originally required users to export API-format workflows by hand,
 * because the shipped templates are UI format with subgraphs. Building the graph
 * here instead removes that step entirely: every node class, input name and enum
 * below was read from the live server's `/object_info`, and
 * `ComfyClient.validate()` re-checks the assembled graph before it is queued.
 *
 * Node ids are opaque strings; the builders allocate them so a reader can follow
 * the wiring by name rather than by number.
 */

const FPS = 24

/** Loader class per text-encoder family, derived from the installed file name. */
const ENCODER_TYPE_HINTS = [
  [/minimax/i, 'minimax'],
  [/qwen_image|qwen_image_2/i, 'qwen_image'],
  [/qwen3vl|qwen_2\.5_vl|qwen_3_/i, 'qwen_image'],
  [/t5xxl|clip_l/i, 'flux'],
  [/flux2/i, 'flux2'],
  [/umt5|wan/i, 'wan'],
  [/ltx/i, 'ltxv'],
]

/**
 * Guess the `CLIPLoader.type` enum for a text encoder file.
 * @param {string} clipName
 * @param {string} [override]
 */
export function encoderTypeFor(clipName, override) {
  if (override) return override
  for (const [pattern, type] of ENCODER_TYPE_HINTS) {
    if (pattern.test(String(clipName ?? ''))) return type
  }
  return 'stable_diffusion'
}

/**
 * Small helper that hands out stable node ids and wires links.
 */
class GraphBuilder {
  constructor() {
    this.nodes = {}
    this.counter = 0
  }

  /** @param {string} classType */
  add(classType, inputs, label) {
    this.counter += 1
    const id = String(this.counter)
    const node = { class_type: classType, inputs }
    if (label) node._meta = { title: label }
    this.nodes[id] = node
    return id
  }

  /** A link reference: `[nodeId, outputSlot]`. */
  static ref(id, slot = 0) {
    return [id, slot]
  }

  build() {
    return this.nodes
  }
}

// ---------------------------------------------------------------------------
// Image stages (reference art and keyframes)
// ---------------------------------------------------------------------------

/**
 * Text-to-image graph.
 *
 * Wiring: UNETLoader -> [LoRA] -> KSampler, with CLIPLoader feeding two
 * CLIPTextEncode nodes and a VAELoader decoding the result.
 *
 * @param {object} spec
 * @param {Record<string,string>} spec.models resolved model file names
 * @param {string} spec.positive
 * @param {string} spec.negative
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.seed
 * @param {number} [spec.steps]
 * @param {number} [spec.cfg]
 * @param {string} [spec.samplerName]
 * @param {string} [spec.scheduler]
 * @param {string} [spec.filenamePrefix]
 * @param {boolean} [spec.turbo] apply the speed LoRA
 * @param {number} [spec.turboStrength]
 * @param {string} [spec.encoderType] override the CLIPLoader type enum
 * @returns {Record<string, object>} an API-format graph
 */
export function buildImageGraph(spec) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    positive = '',
    negative = '',
    width = 768,
    height = 1344,
    seed = 0,
    steps = 20,
    cfg = 2.5,
    samplerName = 'euler',
    scheduler = 'simple',
    filenamePrefix = 'shortdrama/image',
    turbo = false,
    turboStrength = 1,
    encoderType,
  } = spec

  if (!models.diffusionModel) throw new Error('image graph needs a diffusion model')
  if (!models.textEncoder) throw new Error('image graph needs a text encoder')
  if (!models.vae) throw new Error('image graph needs a VAE')

  const model = g.add('UNETLoader', {
    unet_name: models.diffusionModel,
    weight_dtype: 'default',
  }, 'UNETLoader')

  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, encoderType),
    device: 'default',
  }, 'CLIPLoader')

  const vae = g.add('VAELoader', { vae_name: models.vae }, 'VAELoader')

  // The LoRA is optional and only applied when a file was actually resolved.
  let effectiveModel = ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: ref(model),
      lora_name: models.lora,
      strength_model: turboStrength,
    }, 'LoRA')
    effectiveModel = ref(lora)
  }

  // Qwen-Image 2.1 encodes text through its OWN node.
  //
  // The generic `CLIPTextEncode` loads a Qwen-typed CLIP correctly (the loader type
  // comes from `encoderTypeFor`) but then runs the wrong text-encoding path: Qwen
  // splices the text through its own encoder and hands back an already-conditioned
  // pair. Using the generic node produced visibly soft output on the t2i path —
  // 371s and a blurred result, against 21.7s and a sharp one with the right node —
  // and this builder kept the old wiring, so the i2i keyframe mode inherited it.
  //
  // One node, two outputs: 0 = positive CONDITIONING, 1 = negative CONDITIONING.
  let positiveRef
  let negativeRef
  if (isQwenImage(models)) {
    const encode = g.add('TextEncodeQwenImage21', {
      clip: ref(clip),
      vae: ref(vae),
      prompt: positive,
      negative_prompt: negative,
      // Required by this node. The canvas this builder is about to create is its
      // natural value, so it is derived from width/height rather than declared.
      resolution: Math.max(width, height),
    }, 'TextEncodeQwenImage21')
    positiveRef = ref(encode, 0)
    negativeRef = ref(encode, 1)
  } else {
    positiveRef = ref(g.add('CLIPTextEncode', { text: positive, clip: ref(clip) }, 'Positive'))
    negativeRef = ref(g.add('CLIPTextEncode', { text: negative, clip: ref(clip) }, 'Negative'))
  }
  const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 }, 'Latent')

  const sampler = g.add('KSampler', {
    model: effectiveModel,
    seed,
    steps,
    cfg,
    sampler_name: samplerName,
    scheduler,
    positive: positiveRef,
    negative: negativeRef,
    latent_image: ref(latent),
    denoise: 1,
  }, 'KSampler')

  const decode = g.add('VAEDecode', { samples: ref(sampler), vae: ref(vae) }, 'VAEDecode')
  g.add('SaveImage', { images: ref(decode), filename_prefix: filenamePrefix }, 'SaveImage')

  return g.build()
}

/**
 * Image-to-image graph: the same chain, but the latent comes from an uploaded
 * image instead of an empty canvas, and `denoise` decides how far the result may
 * drift from it. This is the lever that keeps a character's face recognisable.
 *
 * @param {object} spec as {@link buildImageGraph}, plus:
 * @param {string} spec.inputImage file name already present in ComfyUI's input dir
 * @param {number} [spec.denoise]
 */
export function buildImageToImageGraph(spec) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    positive = '',
    negative = '',
    seed = 0,
    steps = 20,
    cfg = 2.5,
    samplerName = 'euler',
    scheduler = 'simple',
    filenamePrefix = 'shortdrama/keyframe',
    turbo = false,
    turboStrength = 1,
    encoderType,
    inputImage,
    denoise = 0.6,
    targetMegapixels = null,
    /**
     * Long edge the text encoder is told to expect.
     *
     * `TextEncodeQwenImage21` requires it. On the t2i path it comes from the canvas
     * this builder is about to create; here the canvas comes from the INPUT image at
     * runtime, so the value is a hint rather than a promise — 1024 matches the t2i
     * default and is what Qwen-Image 2.1 is documented around.
     */
    resolution = 1024,
  } = spec

  if (!inputImage) throw new Error('image-to-image graph needs an input image')
  if (!models.diffusionModel || !models.textEncoder || !models.vae) {
    throw new Error('image-to-image graph needs a diffusion model, text encoder and VAE')
  }

  const model = g.add('UNETLoader', { unet_name: models.diffusionModel, weight_dtype: 'default' }, 'UNETLoader')
  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, encoderType),
    device: 'default',
  }, 'CLIPLoader')
  const vae = g.add('VAELoader', { vae_name: models.vae }, 'VAELoader')

  let effectiveModel = ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: ref(model),
      lora_name: models.lora,
      strength_model: turboStrength,
    }, 'LoRA')
    effectiveModel = ref(lora)
  }

  const load = g.add('LoadImage', { image: inputImage }, 'Reference image')

  // Optionally normalise the reference to the target canvas. Without this, an
  // off-ratio reference silently decides the output size.
  let imageRef = ref(load)
  if (Number.isFinite(targetMegapixels) && targetMegapixels > 0) {
    const scale = g.add('ImageScaleToTotalPixels', {
      image: ref(load),
      upscale_method: 'lanczos',
      megapixels: targetMegapixels,
      resolution_steps: 32,
    }, 'Scale reference')
    imageRef = ref(scale)
  }

  const encode = g.add('VAEEncode', { pixels: imageRef, vae: ref(vae) }, 'VAEEncode')
  // Qwen-Image 2.1 encodes text through its OWN node.
  //
  // The generic `CLIPTextEncode` loads a Qwen-typed CLIP correctly — the loader type
  // comes from `encoderTypeFor` — but then runs the wrong text-encoding path. Qwen
  // splices the prompt through its own encoder and returns an already-conditioned
  // pair; the generic node does not, and the result is visibly soft. Measured on the
  // t2i path: 371s and blurred against 21.7s and sharp with the correct node.
  //
  // This builder kept the old wiring, so the keyframe stage's `i2i` mode — the one
  // caller that reaches it — inherited the softness.
  //
  // One node, two outputs: 0 = positive CONDITIONING, 1 = negative CONDITIONING.
  let positiveRef
  let negativeRef
  if (isQwenImage(models)) {
    const encode = g.add('TextEncodeQwenImage21', {
      clip: ref(clip),
      vae: ref(vae),
      prompt: positive,
      negative_prompt: negative,
      // Required by this node; omitting it is a validation failure, not a default.
      resolution,
    }, 'TextEncodeQwenImage21')
    positiveRef = ref(encode, 0)
    negativeRef = ref(encode, 1)
  } else {
    positiveRef = ref(g.add('CLIPTextEncode', { text: positive, clip: ref(clip) }, 'Positive'))
    negativeRef = ref(g.add('CLIPTextEncode', { text: negative, clip: ref(clip) }, 'Negative'))
  }

  const sampler = g.add('KSampler', {
    model: effectiveModel,
    seed,
    steps,
    cfg,
    sampler_name: samplerName,
    scheduler,
    positive: positiveRef,
    negative: negativeRef,
    latent_image: ref(encode),
    denoise,
  }, 'KSampler')

  const decode = g.add('VAEDecode', { samples: ref(sampler), vae: ref(vae) }, 'VAEDecode')
  g.add('SaveImage', { images: ref(decode), filename_prefix: filenamePrefix }, 'SaveImage')

  return g.build()
}

// ---------------------------------------------------------------------------
// MiniMax-H3 video + audio
// ---------------------------------------------------------------------------

/** Turbo LoRAs are distilled for a much smaller step count. */
export const H3_STEPS = { turbo: 6, full: 20 }

/** `ref_images` is an autogrow group capped at 9 reference images. */
export const H3_MAX_REFERENCE_IMAGES = 9

/**
 * Reference-to-video+audio graph (REF2VA).
 *
 * A different node from the FL2VA path: `MiniMaxH3ReferenceToVideo` takes
 * reference images instead of a keyframe, and keeps the referenced subject's
 * identity through the whole clip rather than only pinning the opening frame.
 * That is the stronger lever for a character who recurs across shots.
 *
 * Wiring matches the official `video_minimax_h3_r2v` template:
 *   UNETLoader -> [turbo LoRA] -> BasicGuider + BasicScheduler
 *   CLIPLoader + video/audio VAE + ref images -> MiniMaxH3ReferenceToVideo
 *   MiniMaxH3ReferenceToVideo -> CONDITIONING -> BasicGuider, LATENT -> sampler
 *   sampler -> VAEDecode (video) + VAEDecodeAudio (audio) -> CreateVideo -> SaveVideo
 *
 * `ref_images` is a COMFY_AUTOGROW_V3 group: the API format addresses its slots by
 * dotted key (`ref_images.ref_image_0`, ...), not by an array on `ref_images`.
 *
 * @param {object} spec as {@link buildH3Graph}, plus:
 * @param {string[]} spec.referenceImages input-dir file names, newest-first priority
 * @param {'match'|'max'} [spec.refImageSize] 'max' favours identity at several times the cost
 */
export function buildH3ReferenceGraph(spec) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    prompt = '',
    width = 768,
    height = 1344,
    length = 124,
    seed = 0,
    turbo = true,
    steps,
    referenceImages = [],
    refImageSize = 'match',
    samplerName = 'res_multistep',
    scheduler = 'simple',
    filenamePrefix = 'shortdrama/h3ref',
    format = 'mp4',
    codec = 'h264',
    fps = FPS,
  } = spec

  if (!models.diffusionModel) throw new Error('H3 graph needs a diffusion model')
  if (!models.textEncoder) throw new Error('H3 graph needs a text encoder')
  if (!models.vae) throw new Error('H3 graph needs a video VAE')
  if (!models.audioVae) throw new Error('H3 graph needs an audio VAE')

  const model = g.add('UNETLoader', { unet_name: models.diffusionModel, weight_dtype: 'default' }, 'UNETLoader')
  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, 'minimax'),
    device: 'default',
  }, 'CLIPLoader')
  const videoVae = g.add('VAELoader', { vae_name: models.vae }, 'Video VAE')
  const audioVae = g.add('VAELoader', { vae_name: models.audioVae }, 'Audio VAE')

  let effectiveModel = ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: ref(model),
      lora_name: models.lora,
      strength_model: 1,
    }, 'Turbo LoRA')
    effectiveModel = ref(lora)
  }
  // Identity LoRA, chained AFTER the speed one. Only the H3 paths carry this: the
  // face LoRA is trained against MiniMax-H3 REF2VA and means nothing to the image
  // graphs, which never set a faceLora anyway.
  if (models.faceLora) {
    const face = g.add('LoraLoaderModelOnly', {
      model: effectiveModel,
      lora_name: models.faceLora,
      strength_model: 1,
    }, 'Face LoRA')
    effectiveModel = ref(face)
  }

  const resolvedSteps = Number.isFinite(steps) ? steps : (turbo ? H3_STEPS.turbo : H3_STEPS.full)

  const referenceInputs = {}
  for (const [index, file] of referenceImages.slice(0, H3_MAX_REFERENCE_IMAGES).entries()) {
    referenceInputs[`ref_images.ref_image_${index}`] = ref(g.add('LoadImage', { image: file }, `Reference ${index + 1}`))
  }

  const h3 = g.add('MiniMaxH3ReferenceToVideo', {
    clip: ref(clip),
    vae: ref(videoVae),
    audio_vae: ref(audioVae),
    prompt,
    width,
    height,
    length,
    ref_image_size: refImageSize,
    ...referenceInputs,
  }, 'MiniMax-H3 (REF2VA)')

  const guider = g.add('BasicGuider', { model: effectiveModel, conditioning: ref(h3, 0) }, 'BasicGuider')
  const samplerSelect = g.add('KSamplerSelect', { sampler_name: samplerName }, 'Sampler')
  const sigmas = g.add('BasicScheduler', { model: effectiveModel, scheduler, steps: resolvedSteps, denoise: 1 }, 'Scheduler')
  const noise = g.add('RandomNoise', { noise_seed: seed }, 'Noise')

  const sampled = g.add('SamplerCustomAdvanced', {
    noise: ref(noise),
    guider: ref(guider),
    sampler: ref(samplerSelect),
    sigmas: ref(sigmas),
    latent_image: ref(h3, 1),
  }, 'Sampler')

  const frames = g.add('VAEDecode', { samples: ref(sampled), vae: ref(videoVae) }, 'VAEDecode')
  const audio = g.add('VAEDecodeAudio', { samples: ref(sampled), vae: ref(audioVae) }, 'VAEDecodeAudio')
  const video = g.add('CreateVideo', { images: ref(frames), fps, audio: ref(audio) }, 'CreateVideo')
  g.add('SaveVideo', { video: ref(video), filename_prefix: filenamePrefix, format, codec }, 'SaveVideo')

  return g.build()
}

/**
 * MiniMax-H3 video graph, assembled from the same wiring as the official
 * template but without its subgraph and switch nodes — this graph always has one
 * concrete configuration, so the LoRA and step count are chosen here instead of
 * branched at execution time.
 *
 * Wiring mirrors the template exactly:
 *   UNETLoader -> [turbo LoRA] -> BasicGuider + BasicScheduler
 *   CLIPLoader -> MiniMaxH3ImageToVideo -> BasicGuider
 *   MiniMaxH3ImageToVideo -> LATENT -> SamplerCustomAdvanced
 *   SamplerCustomAdvanced -> VAEDecode (video) and VAEDecodeAudio (audio)
 *   CreateVideo(images, audio) -> SaveVideo
 *
 * H3 models audio in the same forward pass, which is why the audio VAE is decoded
 * from the same latent and muxed into one container rather than added later.
 *
 * @param {object} spec
 * @param {Record<string,string>} spec.models needs diffusionModel, textEncoder, vae, audioVae
 * @param {string} spec.prompt
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.length frame count, already snapped to the 17k+5 grid
 * @param {number} [spec.seed]
 * @param {boolean} [spec.turbo]
 * @param {number} [spec.steps] overrides the turbo-dependent default
 * @param {string} [spec.firstFrame] an input-dir file name, for the FL2VA path
 * @param {string} [spec.lastFrame]
 * @param {string} [spec.samplerName]
 * @param {string} [spec.scheduler]
 * @param {string} [spec.filenamePrefix]
 * @param {string} [spec.format] SaveVideo container
 * @param {string} [spec.codec]
 * @param {number} [spec.fps]
 * @returns {Record<string, object>} an API-format graph
 */
export function buildH3Graph(spec) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    prompt = '',
    width = 768,
    height = 1344,
    length = 124,
    seed = 0,
    turbo = true,
    steps,
    firstFrame = null,
    lastFrame = null,
    samplerName = 'res_multistep',
    scheduler = 'simple',
    filenamePrefix = 'shortdrama/h3',
    format = 'mp4',
    codec = 'h264',
    fps = FPS,
  } = spec

  if (!models.diffusionModel) throw new Error('H3 graph needs a diffusion model')
  if (!models.textEncoder) throw new Error('H3 graph needs a text encoder')
  if (!models.vae) throw new Error('H3 graph needs a video VAE')
  if (!models.audioVae) throw new Error('H3 graph needs an audio VAE')

  const model = g.add('UNETLoader', {
    unet_name: models.diffusionModel,
    weight_dtype: 'default',
  }, 'UNETLoader')

  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, 'minimax'),
    device: 'default',
  }, 'CLIPLoader')

  const videoVae = g.add('VAELoader', { vae_name: models.vae }, 'Video VAE')
  const audioVae = g.add('VAELoader', { vae_name: models.audioVae }, 'Audio VAE')

  let effectiveModel = ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: ref(model),
      lora_name: models.lora,
      strength_model: 1,
    }, 'Turbo LoRA')
    effectiveModel = ref(lora)
  }
  // Identity LoRA, chained AFTER the speed one. Only the H3 paths carry this: the
  // face LoRA is trained against MiniMax-H3 REF2VA and means nothing to the image
  // graphs, which never set a faceLora anyway.
  if (models.faceLora) {
    const face = g.add('LoraLoaderModelOnly', {
      model: effectiveModel,
      lora_name: models.faceLora,
      strength_model: 1,
    }, 'Face LoRA')
    effectiveModel = ref(face)
  }

  const resolvedSteps = Number.isFinite(steps) ? steps : (turbo ? H3_STEPS.turbo : H3_STEPS.full)

  const h3Inputs = {
    clip: ref(clip),
    vae: ref(videoVae),
    prompt,
    width,
    height,
    length,
  }
  if (firstFrame) {
    h3Inputs.first_frame = ref(g.add('LoadImage', { image: firstFrame }, 'First frame'))
  }
  if (lastFrame) {
    h3Inputs.last_frame = ref(g.add('LoadImage', { image: lastFrame }, 'Last frame'))
  }
  // Outputs: 0 = CONDITIONING, 1 = LATENT.
  const h3 = g.add('MiniMaxH3ImageToVideo', h3Inputs, 'MiniMax-H3')

  // No negative conditioning: the node emits positive-only conditioning and the
  // official template guides with BasicGuider, which takes no CFG term at all.
  const guider = g.add('BasicGuider', {
    model: effectiveModel,
    conditioning: ref(h3, 0),
  }, 'BasicGuider')

  const samplerSelect = g.add('KSamplerSelect', { sampler_name: samplerName }, 'Sampler')
  const sigmas = g.add('BasicScheduler', {
    model: effectiveModel,
    scheduler,
    steps: resolvedSteps,
    denoise: 1,
  }, 'Scheduler')
  const noise = g.add('RandomNoise', { noise_seed: seed }, 'Noise')

  const sampled = g.add('SamplerCustomAdvanced', {
    noise: ref(noise),
    guider: ref(guider),
    sampler: ref(samplerSelect),
    sigmas: ref(sigmas),
    latent_image: ref(h3, 1),
  }, 'Sampler')

  const frames = g.add('VAEDecode', { samples: ref(sampled), vae: ref(videoVae) }, 'VAEDecode')
  const audio = g.add('VAEDecodeAudio', { samples: ref(sampled), vae: ref(audioVae) }, 'VAEDecodeAudio')

  const video = g.add('CreateVideo', {
    images: ref(frames),
    fps,
    audio: ref(audio),
  }, 'CreateVideo')

  g.add('SaveVideo', {
    video: ref(video),
    filename_prefix: filenamePrefix,
    format,
    codec,
  }, 'SaveVideo')

  return g.build()
}

// ---------------------------------------------------------------------------
// Qwen-Image 2.1
// ---------------------------------------------------------------------------

/** Model-name fragments that identify the Qwen-Image family. */
export function isQwenImage(models = {}) {
  return /qwen_image/i.test(String(models.diffusionModel ?? ''))
}

/**
 * Qwen-Image 2.1 graph, matching the official `image_qwen_image_2_1_t2i` template
 * and the settings a working local workflow uses.
 *
 * Two things make this a different graph rather than a variation of
 * {@link buildImageGraph}, and both matter for output quality:
 *
 *  - The prompt goes through **`TextEncodeQwenImage21`**, not a generic
 *    `CLIPTextEncode`. That node owns prompt/negative/resolution together and
 *    emits both conditionings, so the model sees conditioning in the shape it was
 *    trained for.
 *  - Its `clip` input wants the **main** text encoder (`qwen3vl_8b`) loaded with
 *    `CLIPLoader.type = 'qwen_image'`. The `*_pe_*` checkpoint is a *prompt
 *    enhancer* — a separate model that rewrites prompts — and using it as the text
 *    encoder yields exactly the soft, mushy output it is not built for.
 *
 * Official guidance is cfg 1 with `euler`/`simple` at ~25–50 steps. The Lightning
 * LoRA is a distilled shortcut and belongs only in a fast draft.
 *
 * @param {object} spec
 * @param {Record<string,string>} spec.models needs diffusionModel, textEncoder, vae
 * @param {string} spec.positive
 * @param {string} [spec.negative]
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.resolution] reference-image sizing hint
 * @param {number} spec.seed
 * @param {number} [spec.steps]
 * @param {number} [spec.cfg]
 * @param {string} [spec.samplerName]
 * @param {string} [spec.scheduler]
 * @param {boolean} [spec.turbo] apply the Lightning LoRA (draft only)
 * @param {string} [spec.filenamePrefix]
 * @param {object} [spec.upscale] SeedVR2 pass: { dit, vae, resolution, batchSize, colorCorrection }
 * @param {boolean} [spec.hasCacheNode] set false to skip QwenImage21Cache
 * @param {string} [spec.encoderType]
 */
export function buildQwenImageGraph(spec) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const {
    models = {},
    positive = '',
    negative = '',
    width = 1024,
    height = 1024,
    resolution = 1024,
    seed = 0,
    steps = 25,
    cfg = 1,
    samplerName = 'euler',
    scheduler = 'simple',
    turbo = false,
    filenamePrefix = 'shortdrama/image',
    upscale = null,
    hasCacheNode = true,
    encoderType,
    /** Input-dir file names; supplying any turns this into an edit/composite pass. */
    referenceImages = [],
  } = spec

  if (!models.diffusionModel) throw new Error('Qwen-Image graph needs a diffusion model')
  if (!models.textEncoder) throw new Error('Qwen-Image graph needs a text encoder')
  if (!models.vae) throw new Error('Qwen-Image graph needs a VAE')

  const model = g.add('UNETLoader', { unet_name: models.diffusionModel, weight_dtype: 'default' }, 'UNETLoader')
  // Caches the immutable prefix across sampling steps — an optimisation only, so
  // it is skipped on a ComfyUI that does not ship the node.
  const cache = hasCacheNode
    ? g.add('QwenImage21Cache', { model: ref(model), device: 'auto', dtype: 'default' }, 'Qwen cache')
    : null

  const clip = g.add('CLIPLoader', {
    clip_name: models.textEncoder,
    type: encoderTypeFor(models.textEncoder, encoderType ?? 'qwen_image'),
    device: 'default',
  }, 'CLIPLoader')
  const vae = g.add('VAELoader', { vae_name: models.vae }, 'VAELoader')

  let effectiveModel = cache ? ref(cache) : ref(model)
  if (turbo && models.lora) {
    const lora = g.add('LoraLoaderModelOnly', {
      model: effectiveModel,
      lora_name: models.lora,
      strength_model: 1,
    }, 'Lightning LoRA')
    effectiveModel = ref(lora)
  }
  // A second, identity-only LoRA chained after the speed one. Order is deliberate:
  // the turbo LoRA is a distillation of the WHOLE model while the face LoRA is a
  // narrow correction, so the correction is applied last.
  if (models.faceLora) {
    const face = g.add('LoraLoaderModelOnly', {
      model: effectiveModel,
      lora_name: models.faceLora,
      strength_model: 1,
    }, 'Face LoRA')
    effectiveModel = ref(face)
  }

  // Outputs: 0 = positive CONDITIONING, 1 = negative CONDITIONING, 2 = LATENT.
  //
  // Reference images ride the SAME node as the prompt. Qwen-Image 2.1 does t2i and
  // image editing with one encoder: with no `images` it is text-to-image; with
  // them the references are seen by the text encoder and spliced in as latents.
  // That is why the official edit template needs no separate edit node, and why
  // this builder covers restyling, background swaps and multi-subject composites
  // without a second graph.
  const encodeInputs = {
    clip: ref(clip),
    vae: ref(vae),
    prompt: positive,
    negative_prompt: negative,
    resolution,
  }
  for (const [index, file] of (referenceImages ?? []).slice(0, 9).entries()) {
    encodeInputs['images.image_' + (index + 1)] = ref(g.add('LoadImage', { image: file }, 'Reference ' + (index + 1)))
  }
  const encode = g.add('TextEncodeQwenImage21', encodeInputs, 'TextEncodeQwenImage21')

  // The official template still builds its latent explicitly rather than using the
  // encoder's third output, so this follows it.
  const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 }, 'Latent')

  const sampler = g.add('KSampler', {
    model: effectiveModel,
    seed,
    steps,
    cfg,
    sampler_name: samplerName,
    scheduler,
    positive: ref(encode, 0),
    negative: ref(encode, 1),
    latent_image: ref(latent),
    denoise: 1,
  }, 'KSampler')

  let imageRef = ref(g.add('VAEDecode', { samples: ref(sampler), vae: ref(vae) }, 'VAEDecode'))

  if (upscale?.dit && upscale?.vae) {
    const dit = g.add('SeedVR2LoadDiTModel', { model: upscale.dit, device: upscale.device ?? 'cuda:0' }, 'SeedVR2 DiT')
    const uvae = g.add('SeedVR2LoadVAEModel', { model: upscale.vae, device: upscale.device ?? 'cuda:0' }, 'SeedVR2 VAE')
    imageRef = ref(g.add('SeedVR2VideoUpscaler', {
      image: imageRef,
      dit: ref(dit),
      vae: ref(uvae),
      seed,
      resolution: upscale.resolution ?? 1080,
      max_resolution: upscale.maxResolution ?? 0,
      batch_size: upscale.batchSize ?? 1,
      uniform_batch_size: false,
      color_correction: upscale.colorCorrection ?? 'lab',
    }, 'SeedVR2 upscale'))
  }

  g.add('SaveImage', { images: imageRef, filename_prefix: filenamePrefix }, 'SaveImage')
  return g.build()
}

// ---------------------------------------------------------------------------
// Upscaling
// ---------------------------------------------------------------------------

/**
 * One image through an ESRGAN-family upscale model.
 *
 * `scaleBy` is not optional decoration. These models are 4x, and 4x on a 1056x1888
 * keyframe is 4224x7552 — 32 MP for one picture, several times what the model was
 * trained to see and enough to exhaust VRAM on its own. Passing a factor below 1
 * here means the model still does its detail work at 4x and the result is then
 * resampled down with lanczos, which keeps the added detail at a sane output size
 * instead of asking the upscaler to be a different upscaler.
 *
 * @param {object} spec
 * @param {string} spec.image input-directory file name
 * @param {string} spec.model upscale model file name
 * @param {number} [spec.scaleBy] multiplier applied AFTER the model, default 0.5 (net 2x)
 * @param {string} [spec.filenamePrefix]
 */
export function buildImageUpscaleGraph(spec = {}) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const scaleBy = Number.isFinite(spec.scaleBy) ? Number(spec.scaleBy) : 0.5

  const source = g.add('LoadImage', { image: spec.image }, 'Source')
  const loader = g.add('UpscaleModelLoader', { model_name: spec.model }, 'Upscale model')
  const upscaled = g.add('ImageUpscaleWithModel', {
    upscale_model: ref(loader),
    image: ref(source),
  }, 'Upscale')
  const sized = scaleBy === 1
    ? upscaled
    : g.add('ImageScaleBy', {
      image: ref(upscaled),
      upscale_method: 'lanczos',
      scale_by: scaleBy,
    }, 'Resize')
  g.add('SaveImage', {
    images: ref(sized),
    filename_prefix: spec.filenamePrefix ?? 'shortdrama/upscale',
  }, 'Save')
  return g.build()
}

/**
 * One CHUNK of video through the same model.
 *
 * Chunking lives in the caller, not here, and that is deliberate. Doing it inside the
 * graph would mean decoding the whole file, slicing the frame batch, upscaling each
 * slice and joining the batches back — and a 243-frame H3 clip at 4x is roughly 35 GB
 * of float image data, so the "decode the whole thing first" step is exactly the step
 * that cannot fit. Splitting the FILE first means each submission only ever holds its
 * own chunk.
 *
 * The audio rides through CreateVideo rather than being added back afterwards: H3
 * clips carry a native audio track, and a re-encode that drops it would silently cost
 * the dialogue.
 *
 * @param {object} spec
 * @param {string} spec.video input-directory file name of THIS CHUNK
 * @param {string} spec.model upscale model file name
 * @param {number} [spec.scaleBy] multiplier applied after the model
 * @param {string} [spec.filenamePrefix]
 * @param {string} [spec.format] output container, 'auto' preserves a compatible stream
 */
export function buildVideoUpscaleGraph(spec = {}) {
  const g = new GraphBuilder()
  const ref = GraphBuilder.ref
  const scaleBy = Number.isFinite(spec.scaleBy) ? Number(spec.scaleBy) : 0.5

  const source = g.add('LoadVideo', { file: spec.video }, 'Source')
  const parts = g.add('GetVideoComponents', { video: ref(source) }, 'Split')
  const loader = g.add('UpscaleModelLoader', { model_name: spec.model }, 'Upscale model')
  const upscaled = g.add('ImageUpscaleWithModel', {
    upscale_model: ref(loader),
    image: ref(parts, 0),
  }, 'Upscale')
  const sized = scaleBy === 1
    ? upscaled
    : g.add('ImageScaleBy', {
      image: ref(upscaled),
      upscale_method: 'lanczos',
      scale_by: scaleBy,
    }, 'Resize')
  const rebuilt = g.add('CreateVideo', {
    images: ref(sized),
    fps: ref(parts, 2),
    audio: ref(parts, 1),
  }, 'Reassemble')
  g.add('SaveVideo', {
    video: ref(rebuilt),
    filename_prefix: spec.filenamePrefix ?? 'shortdrama/upscale-video',
    format: spec.format ?? 'auto',
  }, 'Save')
  return g.build()
}

export default {
  buildImageGraph, buildImageToImageGraph, buildH3Graph, buildH3ReferenceGraph, buildQwenImageGraph,
  encoderTypeFor, isQwenImage, H3_STEPS, H3_MAX_REFERENCE_IMAGES, buildImageUpscaleGraph, buildVideoUpscaleGraph, }
