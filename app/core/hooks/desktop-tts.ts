import { computed, ref } from 'vue'

/**
 * 桌面版离线发音引擎选择
 *
 * - piper：内置 VITS 神经语音（en_GB-cori-high），音质接近真人，模型约 110MB
 * - espeak-ng：内置共振峰合成（en-gb），机械音，但体积极小、合成几乎零延迟
 *
 * 两者都随安装包分发，用户可在设置里切换；选中的引擎失败时自动回退到另一个，
 * 两个都不可用才回退到 WebView2 的系统 TTS。
 */
export type DesktopTtsEngine = 'piper' | 'espeak'

const STORAGE_KEY = 'typewords:desktop-tts-engine'
const DEFAULT_ENGINE: DesktopTtsEngine = 'piper'

function readStoredEngine(): DesktopTtsEngine {
  if (typeof localStorage === 'undefined') return DEFAULT_ENGINE
  try {
    return localStorage.getItem(STORAGE_KEY) === 'espeak' ? 'espeak' : DEFAULT_ENGINE
  } catch {
    return DEFAULT_ENGINE
  }
}

const engine = ref<DesktopTtsEngine>(readStoredEngine())

/** 当前引擎（只读） */
export const desktopTtsEngine = computed(() => engine.value)

export function getDesktopTtsEngine(): DesktopTtsEngine {
  return engine.value
}

export function setDesktopTtsEngine(next: DesktopTtsEngine) {
  engine.value = next
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 隐私模式等场景写不进去，保持内存态即可
  }
}

/** 供设置页 v-model 使用的可写 computed */
export const desktopTtsEngineModel = computed({
  get: () => engine.value,
  set: (next: DesktopTtsEngine) => setDesktopTtsEngine(next),
})
