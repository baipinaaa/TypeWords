import { isDesktopTtsAvailable, playDesktopTts, stopDesktopTtsAudio } from './espeak'

/**
 * 桌面版离线发音（高质量引擎）：内置 piper + VITS 模型 `en_GB-cori-high`。
 *
 * 合成同样在 Rust 侧完成（命令 `piper_speak`），WAV 字节回前端用 Blob 播放。
 * 模型缺失或首次加载失败时只会退化一次，之后本次会话不再尝试，由调用方回退到 espeak-ng。
 */

/** piper 对应的 Tauri 命令名 */
export const PIPER_COMMAND = 'piper_speak'

/** 记录 piper 是否已经失败过，避免每次发音都白等一次模型加载 */
let piperBroken = false

export function isPiperAvailable(): boolean {
  return isDesktopTtsAvailable() && !piperBroken
}

export interface PiperPlayOptions {
  rate?: number
  volume?: number
  onEnd?: () => void
}

export async function playPiper(text: string, options: PiperPlayOptions = {}): Promise<boolean> {
  if (!isPiperAvailable()) return false
  const played = await playDesktopTts(PIPER_COMMAND, text, options)
  if (!played) {
    piperBroken = true
    console.warn('[piper] 合成失败，本次会话回退到 espeak-ng')
  }
  return played
}

export function cancelPiperAudio() {
  stopDesktopTtsAudio()
}

/** 调试用：重置「piper 已损坏」标记 */
export function resetPiperState() {
  piperBroken = false
}
