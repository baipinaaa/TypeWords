//@ts-ignore
import VueVirtualScroller from 'vue-virtual-scroller'
import { ENV } from '@/core/config/env.ts'
import { withAppBaseURL } from '@/core/utils/base-url'
import { isDesktop } from '@/core/utils/desktop'

export default defineNuxtPlugin(async nuxtApp => {
  // 桌面端不注入第三方统计脚本（离线优先，且 tauri.localhost 并不代表本机开发环境）
  if (
    !isDesktop() &&
    !location.href.includes('localhost') &&
    !location.href.includes('192.168') &&
    !location.href.includes('172.16') &&
    !location.href.includes('10.0')
  ) {
    ;(function () {
      var t = document.createElement('script')
      t.src = ENV.LIBS_URL + 't.js?t=' + Date.now()
      document.head.appendChild(t)
    })()
  }

  // 桌面端不注册 Service Worker：自定义协议下 SW 注册请求永不响应（tauri#12214），
  // 且项目 public/ 下并无 service-worker.js
  if (!isDesktop() && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register(withAppBaseURL('/service-worker.js'))
        .then(registration => {
          console.log('ServiceWorker registration successful with scope: ', registration.scope)
        })
        .catch(error => {
          console.log('ServiceWorker registration failed: ', error)
        })
    })
  }

  console.json = function (v: any, space = 0) {
    const json = JSON.stringify(
      v,
      (key, value) => {
        if (Array.isArray(value) && key !== 'nameList') {
          return `__ARRAY__${JSON.stringify(value)}`
        }
        return value
      },
      space
    )
      .replace(/"__ARRAY__(\[.*?\])"/g, (_, arr) => arr)
      // 专门处理 nameList，将其压缩成一行
      .replace(/"nameList": \[\s*([^\]]+)\s*\]/g, (match, content) => {
        // 移除数组内部的换行和多余空格，但保留字符串间的空格
        const compressed = content.replace(/\s*\n\s*/g, ' ').trim()
        return `"nameList": [${compressed}]`
      })

    console.log(json)
    return json
  }
  console.parse = function (v: any) {
    console.log(JSON.parse(v))
  }

  nuxtApp.vueApp.use(VueVirtualScroller)
})
