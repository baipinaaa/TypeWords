/**
 * 桌面端（Tauri 2）运行时适配层。
 *
 * Tauri 2 会注入 `window.__TAURI_INTERNALS__`，这是最可靠的运行时探测点；
 * 同时兼容 UA 中的 `Tauri/x.y.z` 标记。所有函数在 web 环境下均应保持无副作用
 * 或安全降级，因此本模块可以被客户端代码随意引入。
 */
import { Toast } from '@/base'

/** 是否运行在 Tauri 桌面容器内（运行时探测，web 环境恒为 false） */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean((window as any).__TAURI_INTERNALS__) || /\bTauri\//.test(navigator.userAgent)
}

/** 桌面端安装 no-op 的 umami stub，避免 19 处 window.umami?.track 触发外网请求 */
export function installUmamiStub(): void {
  if (typeof window === 'undefined') return
  const w = window as any
  // web 端优先使用真实统计脚本，仅在缺失时补一个空实现
  if (!w.umami) {
    w.umami = { track: () => {} }
  }
}

/** 打开外链：桌面版（离线）不联网也不拉起浏览器，仅提示；web 回退 window.open */
export async function openExternal(url: string): Promise<void> {
  if (!url) return

  if (isDesktop()) {
    // 桌面版按「纯离线」交付：不允许任何外部网页，只提示用户
    notifyOfflineFeature()
    return
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch (e) {
    console.warn('[desktop] window.open 打开外链失败：', e)
  }
}

let offlineToastShownAt = 0

/** 统一的「桌面版离线」提示，1.5s 内只弹一次，避免连点刷屏 */
export function notifyOfflineFeature(message = '桌面版为离线版本，已禁用联网功能') {
  const now = Date.now()
  if (now - offlineToastShownAt < 1500) return
  offlineToastShownAt = now
  Toast.info(message)
}

/** 是否是外部 http(s) 链接（相对于应用自身 origin）；桌面端据此拦截，不打开浏览器 */
export function isExternalUrl(url: string): boolean {
  if (!url) return false
  const href = url.trim()
  // 站内绝对路径 / 锚点 / 空链接都不算外链
  if (href.startsWith('/') || href.startsWith('#')) return false
  // 邮件 / 电话协议：桌面端同样不打开（离线版），只是归类为外链
  if (/^(mailto|tel):/i.test(href)) return true
  if (typeof location === 'undefined') return false

  try {
    const target = new URL(href, location.origin)
    // 只把 http(s) 视为外部链接（about:blank、javascript: 等一律不拦截）
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    return target.origin !== location.origin
  } catch {
    return false
  }
}
