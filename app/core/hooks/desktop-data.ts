/**
 * 桌面端（Tauri）本地数据导入。
 *
 * 网页版的导入流程在 `app/pages/setting.vue` 的 `importJson` 里，且夹杂着 Supabase 推送分支；
 * 桌面端离线优先，只需要「校验版本 → 写 IndexedDB → 刷新 store」这一段。
 * 这里把它抽出来复用，避免两处逻辑各自演化。
 */
import { set as idbSet } from 'idb-keyval'
import { checkAndUpgradeSaveDict, checkAndUpgradeSaveSetting, isEmpty, loadJsLib } from '@/core/utils'
import { APP_VERSION, LIB_JS_URL, LOCAL_FILE_KEY } from '@/core/config/env'
import { checkAndUpgradePracticeWordCache, PRACTICE_ARTICLE_CACHE, PRACTICE_WORD_CACHE } from '@/core/utils/cache'
import { useDataSyncPersistence } from '@/core/composables/useDataSyncPersistence'
import { useBaseStore } from '@/core/stores/base'
import { useSettingStore } from '@/core/stores/setting'
import type { BackupData } from '@/core'

/** 导入摘要，用于在向导里让用户确认「将被覆盖成什么」 */
export interface BackupSummary {
  exportVersion: number
  dictCount: number
  dictNames: string[]
  wordCount: number
  articleCount: string
  hasPracticeWord: boolean
  hasPracticeArticle: boolean
  settingSnapshot: boolean
}

/** 网页版导出的 zip 里自带的音频目录 */
const ZIP_AUDIO_PREFIX = 'mp3/'

/**
 * 把导入文件里的原始 JSON 规范化为当前版本可用的 BackupData。
 * 与 setting.vue 的 importJson 前半段保持一致（升级 + 老版本兼容）。
 */
export async function normalizeBackupData(raw: string): Promise<BackupData> {
  const obj: BackupData = JSON.parse(raw)
  if (!obj?.val?.dict || !obj?.val?.setting) {
    throw new Error('导入文件缺少 dict / setting 字段，可能不是 TypeWords 的导出文件')
  }
  const data = obj.val
  data.dict.val = await checkAndUpgradeSaveDict(data.dict)
  data.setting.val = await checkAndUpgradeSaveSetting(data.setting)
  // 与 setting.vue 的 upgradeImportedPracticeWordCache 一致：整体赋值 LocalCacheResult
  data[PRACTICE_WORD_CACHE.key] = checkAndUpgradePracticeWordCache(
    data[PRACTICE_WORD_CACHE.key],
    data.setting.val
  ) as any
  // 老版本兼容：v4 之前把版本号存在独立 key 上
  if (obj.version === 4) {
    const legacyVersion = data?.[APP_VERSION.key]
    if (!isEmpty(legacyVersion)) {
      data.setting.val.webAppVersion = legacyVersion
    }
  }
  return obj
}

/** 生成导入摘要 */
export function summarizeBackupData(data: BackupData): BackupSummary {
  const dictVal = data.val.dict?.val as any
  const books: any[] = dictVal?.word?.bookList ?? []
  const articleBooks: any[] = dictVal?.article?.bookList ?? []
  const dictNames = books
    .filter(v => v?.words?.length || v?.length)
    .map(v => v?.name || v?.enName || String(v?.id ?? ''))
    .filter(Boolean)
  const wordCount = books.reduce((sum, v) => sum + (v?.words?.length ?? 0), 0)
  const articleCount = articleBooks.reduce((sum, v) => sum + (v?.articles?.length ?? 0), 0)
  const practiceWord = data.val?.[PRACTICE_WORD_CACHE.key]?.val as any
  const practiceArticle = data.val?.[PRACTICE_ARTICLE_CACHE.key]?.val as any
  return {
    exportVersion: data.version,
    dictCount: books.length,
    dictNames,
    wordCount,
    articleCount: `${articleBooks.length} 本 / ${articleCount} 篇`,
    hasPracticeWord: !!practiceWord && !isEmpty(practiceWord),
    hasPracticeArticle: !!practiceArticle && !isEmpty(practiceArticle),
    settingSnapshot: !!data.val.setting?.val,
  }
}

/**
 * 读取用户选择的备份文件（.json / .zip），返回规范化后的数据与摘要。
 * zip 里若带 `mp3/` 目录（自定义文章音频），会一并写入 LOCAL_FILE_KEY（与原网页版行为一致）。
 */
export async function readBackupFile(file: File): Promise<{ data: BackupData; summary: BackupSummary }> {
  const name = (file.name || '').toLowerCase()

  if (name.endsWith('.json')) {
    const text = await file.text()
    const data = await normalizeBackupData(text)
    return { data, summary: summarizeBackupData(data) }
  }

  if (name.endsWith('.zip')) {
    const JSZip = await loadJsLib('JSZip', LIB_JS_URL.JSZIP)
    const zip = await JSZip.loadAsync(file)
    const dataFile = zip.file('data.json')
    if (!dataFile) {
      throw new Error('压缩包里没有 data.json，可能不是 TypeWords 的导出文件')
    }

    const audioFolder = zip.folder(ZIP_AUDIO_PREFIX.replace(/\/$/, ''))
    if (audioFolder) {
      const records: { id: string; file: Blob }[] = []
      for (const filename in zip.files) {
        if (!filename.startsWith(ZIP_AUDIO_PREFIX) || !filename.endsWith('.mp3')) continue
        const entry = zip.file(filename)
        if (!entry) continue
        const blob = await entry.async('blob')
        const id = filename.slice(ZIP_AUDIO_PREFIX.length).replace(/\.mp3$/, '')
        records.push({ id, file: blob })
      }
      if (records.length) await idbSet(LOCAL_FILE_KEY, records)
    }

    const text = await dataFile.async('string')
    const data = await normalizeBackupData(text)
    return { data, summary: summarizeBackupData(data) }
  }

  throw new Error('只支持 .json 或 .zip 备份文件')
}

/**
 * 把规范化后的备份数据落地：写 IndexedDB + 刷新两个 store。
 * 不涉及任何网络请求（Supabase 分支在桌面端不存在）。
 */
export async function applyBackupData(data: BackupData): Promise<void> {
  const dataSync = useDataSyncPersistence()
  const store = useBaseStore()
  const settingStore = useSettingStore()

  await dataSync.persistBackupLocally(data.val)

  runtimeGuard(() => {
    data.setting.val.load = true
    settingStore.setState(data.setting.val)
    data.dict.val.load = true
    store.setState(data.dict.val)
  })
}

/**
 * 导入完成后刷新一次页面，让所有 fetch/onMounted 走新数据路径。
 * 桌面端是本地 IndexedDB，reload 成本极低，比手工重放所有 watch 更可靠。
 */
export function reloadAfterImport(delay = 600) {
  setTimeout(() => {
    if (typeof window !== 'undefined') window.location.reload()
  }, delay)
}

function runtimeGuard(fn: () => void) {
  try {
    fn()
  } catch (e) {
    console.error('[desktop-data] 应用数据到 store 失败：', e)
  }
}
