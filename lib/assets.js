/**
 * Durable artifacts produced by renders.
 *
 * Generated images and videos are too large for the project JSON, so bytes live
 * on disk under the plugin root and the project document keeps only the index
 * (kind, extension, size, and the ComfyUI coordinates they came from).
 */
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginRootDir } from './config.js'

export function assetsDir(projectId) {
  return join(pluginRootDir(), 'assets', projectId)
}

/** @param {'image'|'video'|'audio'} kind */
export function newAssetId(kind) {
  return `${kind}-${globalThis.crypto.randomUUID().slice(0, 10)}`
}

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

/** Derive a safe extension from a ComfyUI filename or a content type. */
export function guessExt(filename, contentType) {
  const fromName = String(filename ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)
  if (fromName) return fromName[1]
  return EXT_BY_TYPE[String(contentType ?? '').split(';')[0].trim()] ?? 'bin'
}

/** @param {'image'|'video'|'audio'|'file'} kind */
export function mediaTypeFor(kind, ext) {
  if (kind === 'video') return ext === 'webm' ? 'video/webm' : 'video/mp4'
  if (kind === 'audio') return ext === 'wav' ? 'audio/wav' : 'audio/flac'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

export function assetFilePath(projectId, asset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(asset?.id ?? ''))) {
    throw new Error(`unsafe asset id "${asset?.id}"`)
  }
  const ext = String(asset?.ext ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin'
  return join(assetsDir(projectId), `${asset.id}.${ext}`)
}

/**
 * @param {string} projectId
 * @param {{id:string, kind:string, ext:string}} meta
 * @param {Uint8Array} bytes
 */
export async function writeAsset(projectId, meta, bytes) {
  await mkdir(assetsDir(projectId), { recursive: true })
  const path = assetFilePath(projectId, meta)
  await writeFile(path, bytes)
  return { ...meta, bytes: bytes.byteLength, path }
}

/** @returns {Promise<Buffer>} */
export async function readAsset(projectId, meta) {
  return readFile(assetFilePath(projectId, meta))
}

export async function removeAsset(projectId, meta) {
  try {
    await rm(assetFilePath(projectId, meta), { force: true })
  } catch { /* a missing file is already the desired state */ }
}

/** Remove every stored artifact for a project. Used when a project is deleted. */
export async function removeProjectAssets(projectId) {
  try {
    await rm(assetsDir(projectId), { recursive: true, force: true })
  } catch { /* nothing to remove */ }
}

/** @returns {Promise<number|null>} */
export async function assetSize(projectId, meta) {
  try {
    return (await stat(assetFilePath(projectId, meta))).size
  } catch {
    return null
  }
}

export default {
  assetsDir, newAssetId, guessExt, mediaTypeFor, assetFilePath,
  writeAsset, readAsset, removeAsset, removeProjectAssets, assetSize,
}
