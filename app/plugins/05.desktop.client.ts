import { isDesktop, installUmamiStub, openExternal, isExternalUrl } from '@/core/utils/desktop'

/**
 * 桌面端（Tauri 2）适配插件。
 *
 * web 环境下直接 return，不产生任何副作用；
 * 桌面端按「纯离线版」交付：不发任何外部网络请求，也不拉起外部浏览器。
 */
export default defineNuxtPlugin(() => {
  if (!isDesktop()) return

  // 1) umami stub：桌面端离线，不发第三方统计请求
  installUmamiStub()

  // 2) 桌面标记，供其它模块/调试使用
  ;(window as any).__TYPEWORDS_DESKTOP__ = true

  // 3) 全局离线守卫（CSP 之外的第二道保险，便于定位遗漏）
  installOfflineGuard()

  // 4) 拦截 window.open：站内/空白页仍走原逻辑，外链一律不打开（仅提示）
  const originalOpen = window.open
  window.open = function (url?: string | URL, target?: string, features?: string) {
    const href = typeof url === 'string' ? url : url ? String(url) : ''
    if (href && isExternalUrl(href)) {
      void openExternal(href)
      return null
    }
    return originalOpen.call(window, url as any, target, features)
  } as typeof window.open

  // 4) document 捕获阶段 click 委托：拦下 a 标签的外链，避免 WebView 内白屏或未处理的导航
  document.addEventListener(
    'click',
    e => {
      // 只处理未被打断的左键单击，带修饰键时放行默认行为（新标签页/新窗口）
      if (e.defaultPrevented || e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return

      const target = e.target as Element | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return

      const href = anchor.getAttribute('href') || ''
      if (!isExternalUrl(href)) return

      e.preventDefault()
      void openExternal(anchor.href || href)
    },
    true
  )

  // --- 首启数据导入向导（见 app/components/desktop/DesktopDataImportWizard.vue） ---
  // 向导由 <DesktopDataImportWizard> 自身监听 `store.load` 后判定首启并弹出
  //（layout/default.vue 中渲染）；这里只暴露一个手动触发入口，便于未来从托盘菜单调用。
  ;(window as any).__TYPEWORDS_OPEN_IMPORT__ = () => {
    window.dispatchEvent(new CustomEvent('typewords:open-import-wizard'))
  }
})

/** 允许的请求目标：只允许同源（tauri.localhost）与 IPC */
function isLocalRequest(rawUrl: string): boolean {
  if (!rawUrl) return true
  const href = rawUrl.trim()
  if (/^(data|blob|about|ipc|tauri):/i.test(href)) return true
  // 相对路径 / 站内绝对路径
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return true
  try {
    const url = new URL(href, location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    // Tauri 的 IPC 端点（Windows 上可能走 fetch/XHR 到 ipc.localhost），必须放行
    if (url.hostname === 'ipc.localhost' || url.hostname === 'tauri.localhost') return true
    return url.origin === location.origin
  } catch {
    return true
  }
}

/**
 * 把 fetch / XHR / WebSocket / EventSource 的外部请求全部短路掉。
 * 命中时只 console.warn，不抛异常，避免打断既有调用链。
 */
function installOfflineGuard() {
  const BLOCKED_PATH = '/__offline_blocked__'

  const warn = (kind: string, url: string) => {
    console.warn(`[desktop-offline] 已阻断外部${kind}请求：${url}`)
  }

  // fetch
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch
    window.fetch = function (input: any, init?: any) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
      if (!isLocalRequest(String(url))) {
        warn(' fetch ', String(url))
        return Promise.reject(new TypeError(`offline: ${url}`))
      }
      return originalFetch.call(window, input, init)
    } as typeof window.fetch
  }

  // XMLHttpRequest：不改 open 的语义，只把外部地址换成必然 404 的本地路径
  const originalXhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
    const url = String(args[1] ?? '')
    if (!isLocalRequest(url)) {
      warn(' XHR ', url)
      args[1] = BLOCKED_PATH
    }
    // @ts-ignore 参数透传
    return originalXhrOpen.apply(this, args as any)
  } as typeof XMLHttpRequest.prototype.open

  // WebSocket / EventSource：项目当前未使用，直接从源头禁掉
  const WSocket = window.WebSocket
  if (WSocket) {
    // @ts-ignore 只做拦截，不保留重连能力
    window.WebSocket = function (url: string, protocols?: any) {
      warn(' WebSocket ', String(url))
      return new WSocket(BLOCKED_PATH, protocols)
    } as any
  }
  const ESource = window.EventSource
  if (ESource) {
    // @ts-ignore
    window.EventSource = function (url: string) {
      warn(' EventSource ', String(url))
      return new ESource(BLOCKED_PATH)
    } as any
  }
}
