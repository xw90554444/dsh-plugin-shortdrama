/**
 * Recommended model sets for a local MiniMax-H3 workflow.
 *
 * These are substring hints, ranked: the first installed match wins. They encode
 * knowledge about which *variant* suits which job, because the file names alone
 * do not say that `_pruned_` is the one to reach for on 16 GB of VRAM, or that
 * REF2VA is the identity-preserving path while FL2VA is the keyframe path.
 *
 * Nothing here is required — `ComfyClient.resolveModels` falls back to the first
 * installed file in each category when no hint matches.
 */

/** H3 inference modes, keyed by the unet variant they need. */
export const H3_MODES = {
  /**
   * First/last-frame to video+audio. One keyframe in, motion out. Cheapest
   * identity control: the start frame pins appearance for the whole clip.
   */
  fl2va: {
    label: '首尾帧生视频 (FL2VA)',
    hint: 'minimax_h3_fl2va',
    lora: ['minimax_h3_fl2v_turbo_8step', 'minimax_h3_fl2v_turbo_4step', 'minimax_h3_turbo'],
  },
  /**
   * Reference-to-video+audio. Several reference images in; the model keeps the
   * referenced subject's identity across the clip. This is the stronger path for
   * recurring characters, and the reason a face-swap LoRA exists for it.
   */
  ref2va: {
    label: '参考图生视频 (REF2VA)',
    hint: 'minimax_h3_ref2va',
    lora: ['minimax_h3_ref2v_turbo_8step', 'minimax_h3_ref2v_turbo_4step', 'minimax_h3_turbo'],
  },
}

/** Ranked preference per model category for the FL2VA path (the P4 default). */
export const H3_FL2VA_PREFERRED = {
  diffusionModel: [
    'minimax_h3_fl2va_pruned_int8_convrot', // smallest: reach for this first on 16 GB
    'minimax_h3_fl2va_int8_convrot',
    'minimax_h3_hybrid_fl2va_ref2va',
  ],
  textEncoder: [
    // NVFP4 first. It is 14.6 GB against the int8 build's 25.3 GB, and it was
    // verified to load and encode on Ada (sm_89) — the format was introduced for
    // Blackwell, so this ordering is an empirical result, not an assumption. On a
    // 16 GB card the 10.7 GB difference decides whether the encoder gets paged.
    'qwen3vl_32b_heretic_minimax_h3_nvfp4',
    'qwen3vl_32b_minimax_h3_nvfp4_awq',
    'qwen3vl_32b_minimax_h3_int8_convrot',
    'qwen3vl_32b_minimax_h3',
  ],
  vae: ['minimax_h3_video_vae_int8_convrot', 'minimax_h3_video_vae_fp16'],
  audioVae: ['minimax_h3_audio_vae_fp32'],
  lora: [
    // 4-step first: it is distilled for four steps, and the preset now samples
    // four. Running the 8-step LoRA at six steps paid for speed it never used.
    'minimax_h3_fl2v_turbo_4step',
    'minimax_h3_fl2v_turbo_8step',
    'minimax_h3_turbo_4步加速',
    'minimax_h3_turbo',
  ],
}

/** Ranked preference for the REF2VA path (identity-critical shots). */
export const H3_REF2VA_PREFERRED = {
  diffusionModel: ['minimax_h3_ref2va_pruned_int8_convrot', 'minimax_h3_hybrid_fl2va_ref2va'],
  textEncoder: H3_FL2VA_PREFERRED.textEncoder,
  vae: H3_FL2VA_PREFERRED.vae,
  audioVae: H3_FL2VA_PREFERRED.audioVae,
  lora: ['minimax_h3_ref2v_turbo_4step', 'minimax_h3_ref2v_turbo_8step', 'minimax_h3_turbo'],
  // The identity LoRA rides ALONGSIDE the speed one rather than replacing it, so it
  // is a separate slot that the graph chains after the turbo patch.
  faceLora: ['SS_FaceSwap_MiniMax_H3_REF2VA'],
}

/**
 * Optional identity-stabilising LoRA. When a shot must match a recurring
 * character's face exactly, applying this alongside REF2VA is the strongest
 * lever available locally.
 */
export const FACE_CONSISTENCY_LORA = ['SS_FaceSwap_MiniMax_H3_REF2VA', 'FaceSwap']

/** Ranked preference for the reference-image and keyframe stages. */
export const IMAGE_PREFERRED = {
  diffusionModel: [
    'qwen_image_2.1_int8_convrot', // best quality-per-VRAM of the installed image models
    'qwen_image_2.1_bf16',
    'z_image_turbo_bf16',          // fastest
    'Flux-2-klein-9b-fp8',
    'flux-2-klein-9b-fp8',
  ],
  /**
   * The MAIN text encoder. `qwen3vl_8b_*` is what `TextEncodeQwenImage21` expects.
   *
   * The `*_pe_*` entries below it are a different animal: a prompt *enhancer* that
   * rewrites the prompt before encoding. Listing one here was a real defect — it
   * got loaded as the text encoder and produced soft, mushy images, because the
   * enhancer is not trained to condition the diffusion model at all.
   */
  textEncoder: [
    'qwen3vl_8b_bf16',
    'qwen3vl_8b_int8_convrot',
    'qwen3vl_8b_w4a8',
    'qwen3vl_4b_fp8_scaled',
    'qwen_3_4b_fp8_mixed',
    't5xxl_fp16',
  ],
  /** Loaded separately when the prompt-enhancer path is enabled. */
  peEncoder: ['qwen3.5_qwen_image_2.1_pe_t2i', 'qwen3.5_qwen_image_2.1_pe_i2i'],
  vae: ['qwen_image_2.1_vae_bf16', 'qwen_image_vae', 'flux2-vae', 'ae.safetensors'],
  lora: ['Qwen-Image-Lightning-4steps', '一致性保持-F2k-9B-Consistance-Edit-Lora'],
}

/**
 * Image presets.
 *
 * Step counts follow the official Qwen-Image 2.1 guidance ("about 40-50 with
 * euler", the shipped template starts at 25). The Lightning LoRA is a distilled
 * shortcut trained for ~4 steps; running it at higher step counts, or leaving it
 * on for a final render, degrades the image — so it is confined to `draft`.
 */
export const IMAGE_PRESETS = {
  draft: { imageSteps: 8, turbo: true, label: '草稿 (8 步 + Lightning)' },
  standard: { imageSteps: 25, turbo: false, label: '标准 (25 步)' },
  quality: { imageSteps: 40, turbo: false, label: '精细 (40 步)' },
}

/** SeedVR2 upscaling, for the sharpness the plain decode does not give. */
export const UPSCALE_PREFERRED = {
  dit: ['seedvr2_7b', 'seedvr2_3b'],
  vae: ['ema_vae_fp16', 'seedvr2_ema_vae'],
}

/**
 * The runtime facts that decide whether a render is even feasible here, so the
 * UI can warn before a 19 GB unet starts swapping.
 */
export function assessCapacity(health) {
  const device = health?.devices?.[0]
  const vramFree = device?.vramFreeBytes ?? 0
  const ramFree = health?.ramFreeBytes ?? 0
  const notes = []
  let level = 'ok'

  if (vramFree > 0 && vramFree < 6e9) {
    level = 'warn'
    notes.push(`可用显存仅 ${(vramFree / 1e9).toFixed(1)} GB；H3 权重会被分块卸载到内存，速度显著下降。`)
  }
  if (ramFree > 0 && ramFree < 8e9) {
    level = 'blocked'
    notes.push(`可用内存仅 ${(ramFree / 1e9).toFixed(1)} GB；H3 的 19 GB 权重放不下，请先关闭占内存的程序再出片。`)
  }
  return { level, vramFreeBytes: vramFree, ramFreeBytes: ramFree, notes }
}

export default {
  H3_MODES, H3_FL2VA_PREFERRED, H3_REF2VA_PREFERRED,
  FACE_CONSISTENCY_LORA, IMAGE_PREFERRED, IMAGE_PRESETS, UPSCALE_PREFERRED, assessCapacity,
}
