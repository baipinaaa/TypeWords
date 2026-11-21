import type { Article } from '../types'
import { TranslateEngine } from '../types'

export function getSentenceAllTranslateText(article: Article) {
  return article.sections
    .map(v =>
      v
        .map(s => s.translate.trim())
        .filter(v => v)
        .join(' \n')
    )
    .filter(v => v)
    .join(' \n\n')
}

export function getSentenceAllText(article: Article) {
  return article.sections
    .map(v =>
      v
        .map(s => s.text)
        .filter(v => v)
        .join('\n')
    )
    .filter(v => v)
    .join('\n\n')
}

/**
 * @deprecated 百度翻译 appid/key 从未配置，生产环境 `/baidu` 代理也不存在，功能实际不可用。
 * 桌面版（Tauri + 离线优先）彻底摘除该入口。保留函数签名仅为兼容既有调用点。
 */
export async function getNetworkTranslate(
  article: Article,
  translateEngine: TranslateEngine,
  allShow: boolean = false,
  progressCb?: (val: number) => void
): Promise<void> {
  console.warn('[translate] 网络翻译已摘除（百度 API 未配置）')
  return
}
