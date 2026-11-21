import { isDesktop } from '../utils/desktop'

/**
 * 桌面版离线发音的公共播放层。
 *
 * 合成在 Rust 侧完成（命令名由调用方给出，如 `espeak_speak` / `piper_speak`），
 * 返回的 WAV 字节在前端变成 Blob URL 播放，不产生任何网络请求，
 * 也不依赖 WebView2 是否装了英文语音包。
 */

/** espeak-ng 基准语速（每分钟词数），与 WebView2 TTS 的 rate=1 大致对齐 */
const BASE_SPEED = 165
const MAX_SPEED = 450
const MIN_SPEED = 80
/** Blob URL 缓存上限，超出后按插入顺序淘汰 */
const MAX_CACHE_ENTRIES = 200

const wavUrlCache = new Map<string, string>()
const pendingCache = new Map<string, Promise<string | null>>()

let activeAudio: HTMLAudioElement | null = null
let playbackToken = 0

const DEBUG_KEY = 'typewords:tts-debug'

/**
 * 把语音链路的关键状态记到 localStorage（最多 24 条环缓冲）。
 * 桌面版没有 devtools，这个是现场排查「为什么没声音」的唯一线索。
 */
export function logTtsDebug(step: string, detail?: unknown) {
  try {
    const raw = localStorage.getItem(DEBUG_KEY)
    const list: any[] = raw ? JSON.parse(raw) : []
    let text = ''
    if (detail !== undefined && detail !== null) {
      text = typeof detail === 'string' ? detail : String(detail)
    }
    list.push({ t: Date.now(), step, detail: text.slice(0, 160) })
    while (list.length > 24) list.shift()
    localStorage.setItem(DEBUG_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/** 是否处在可以调用 Tauri IPC 的桌面环境 */
export function isDesktopTtsAvailable(): boolean {
  if (typeof window === 'undefined') return false
  return isDesktop() && Boolean((window as any).__TAURI_INTERNALS__)
}

function speedFromRate(rate?: number): number {
  const value = Math.round(BASE_SPEED * (rate && rate > 0 ? rate : 1))
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value))
}

function toWavBlob(payload: unknown): Blob | null {
  if (payload instanceof ArrayBuffer) return new Blob([payload], { type: 'audio/wav' })
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    return new Blob([new Uint8Array(view.buffer, view.byteOffset, view.byteLength)], { type: 'audio/wav' })
  }
  if (Array.isArray(payload)) return new Blob([new Uint8Array(payload as number[])], { type: 'audio/wav' })
  return null
}

function trimCache() {
  while (wavUrlCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = wavUrlCache.keys().next().value as string | undefined
    if (!firstKey) break
    const url = wavUrlCache.get(firstKey)
    wavUrlCache.delete(firstKey)
    if (url) URL.revokeObjectURL(url)
  }
}

async function requestWavBlob(command: string, text: string, speed: number): Promise<Blob | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const payload = await invoke(command, { text, speed })
    return toWavBlob(payload)
  } catch (error) {
    console.warn(`[desktop-tts] ${command} 合成失败`, error)
    logTtsDebug('synth.fail', `${command} ${String(error)}`)
    return null
  }
}

/** 取（或合成）文本对应的 WAV Blob URL；失败返回 null，由调用方回退 */
export async function getDesktopTtsWavUrl(command: string, text: string, rate?: number): Promise<string | null> {
  const content = (text || '').trim()
  if (!content) return null
  const speed = speedFromRate(rate)
  const key = `${command}|${speed}|${content}`

  const cached = wavUrlCache.get(key)
  if (cached) return cached

  const pending = pendingCache.get(key)
  if (pending) return pending

  const task = (async () => {
    const blob = await requestWavBlob(command, content, speed)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    wavUrlCache.set(key, url)
    trimCache()
    return url
  })()

  pendingCache.set(key, task)
  try {
    return await task
  } finally {
    pendingCache.delete(key)
  }
}

export function stopDesktopTtsAudio() {
  playbackToken++
  if (activeAudio) {
    activeAudio.onended = null
    activeAudio.onerror = null
    try {
      activeAudio.pause()
      activeAudio.currentTime = 0
    } catch {
      /* ignore */
    }
    activeAudio = null
  }
}

export interface DesktopTtsPlayOptions {
  rate?: number
  volume?: number
  onEnd?: () => void
}

/**
 * 播放一段语音。resolve 为 true 表示已成功开始播放（或已被新播放取消），
 * resolve 为 false 表示合成/播放失败，调用方可以回退到别的引擎。
 * 只有成功路径（含自然结束/报错结束）才会调用 onEnd。
 */
export async function playDesktopTts(
  command: string,
  text: string,
  options: DesktopTtsPlayOptions = {}
): Promise<boolean> {
  const content = (text || '').trim()
  if (!content || typeof Audio === 'undefined') return false

  const token = ++playbackToken
  logTtsDebug('play.enter', `${command} speed=${speedFromRate(options.rate)} text=${content.slice(0, 24)}`)
  const url = await getDesktopTtsWavUrl(command, content, options.rate)
  // 已被后一次播放取代：不算失败，也不再回调 onEnd
  if (token !== playbackToken) {
    logTtsDebug('play.superseded', command)
    return true
  }
  if (!url) {
    logTtsDebug('play.no-url', command)
    return false
  }

  if (activeAudio) {
    try {
      activeAudio.pause()
    } catch {
      /* ignore */
    }
    activeAudio = null
  }

  const audio = new Audio(url)
  activeAudio = audio
  const volume = options.volume
  if (typeof volume === 'number') {
    audio.volume = Math.min(1, Math.max(0, volume))
  }

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (activeAudio === audio) activeAudio = null
    options.onEnd?.()
  }

  audio.onended = finish
  audio.onerror = finish
  try {
    await audio.play()
    return true
  } catch (error) {
    console.warn(`[desktop-tts] ${command} 播放失败`, error)
    logTtsDebug('play.fail', `${command} ${String(error)}`)
    if (activeAudio === audio) activeAudio = null
    finished = true
    return false
  }
}

/* ------------------------------------------------------------------ */
/* espeak-ng（英式英语，轻量兜底引擎）                                  */
/* ------------------------------------------------------------------ */

/** espeak-ng 对应的 Tauri 命令名 */
export const ESPEAK_COMMAND = 'espeak_speak'

export function isEspeakAvailable(): boolean {
  return isDesktopTtsAvailable()
}

export interface EspeakPlayOptions extends DesktopTtsPlayOptions {}

export function getEspeakWavUrl(text: string, rate?: number): Promise<string | null> {
  return getDesktopTtsWavUrl(ESPEAK_COMMAND, text, rate)
}

export function playEspeak(text: string, options: EspeakPlayOptions = {}): Promise<boolean> {
  return playDesktopTts(ESPEAK_COMMAND, text, options)
}

export function stopEspeakAudio() {
  stopDesktopTtsAudio()
}

export function cancelEspeakAudio() {
  stopDesktopTtsAudio()
}
