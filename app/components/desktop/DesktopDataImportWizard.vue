<script setup lang="ts">
/**
 * 桌面版首启数据导入向导（Tauri）。
 *
 * 网页版用户的数据全部在浏览器 IndexedDB 里，装到桌面版后是全新的空库；
 * 这个向导复用网页版「设置 → 数据管理 → 导入数据」产出的 .json / .zip，
 * 在本地完成校验与落库（桌面端没有 Supabase）。
 *
 * 触发方式：
 *  1) 首启自动：桌面端 + 词典库里只有 3 个虚拟词典（收藏/错词/已掌握）时弹一次
 *  2) 手动：window 事件 `typewords:open-import-wizard`
 */
import { Dialog, BaseButton, Toast } from '@/base'
import { get as idbGet } from 'idb-keyval'
import { onMounted, onUnmounted, watch } from 'vue'
import { SAVE_DICT_KEY } from '@/core/config/env'
import { isDesktop } from '@/core/utils/desktop'
import { useBaseStore } from '@/core/stores/base'
import {
  type BackupSummary,
  applyBackupData,
  readBackupFile,
  reloadAfterImport,
} from '@/core/hooks/desktop-data'
import type { BackupData } from '@/core'

const FIRST_RUN_FLAG = 'typewords:desktop-first-run-done'
const OPEN_EVENT = 'typewords:open-import-wizard'

const store = useBaseStore()

let visible = $ref(false)
let firstRun = $ref(false)
let step = $ref<'idle' | 'preview' | 'importing' | 'done'>('idle')
let fileName = $ref('')
let errorMessage = $ref('')
let summary = $ref<BackupSummary | null>(null)
let pendingData: BackupData | null = null
let fileInputRef = $ref<HTMLInputElement>()

const desktop = isDesktop()

function open(asFirstRun = false) {
  firstRun = asFirstRun
  visible = true
  if (step === 'done') step = 'idle'
}

function close() {
  visible = false
  if (firstRun) markFirstRunDone()
}

function markFirstRunDone() {
  try {
    localStorage.setItem(FIRST_RUN_FLAG, '1')
  } catch (e) {
    // localStorage 不可用时忽略：下次启动最多再弹一次
  }
}

/** 只有 3 个虚拟词典 = 全新安装，没有任何用户数据 */
function looksLikeFirstRun() {
  const books = store.word?.bookList ?? []
  const realBooks = books.filter(v => !['wordCollect', 'wordWrong', 'wordKnown'].includes(String(v?.id)))
  return realBooks.length === 0
}

async function detectFirstRun() {
  if (!desktop || !store.load) return
  if (localStorage.getItem(FIRST_RUN_FLAG)) return
  // 老用户升级（已有 IndexedDB 数据）不应弹窗：dict key 存在即视为已有数据
  const hasLocalDict = await idbGet(SAVE_DICT_KEY.key)
  if (hasLocalDict && !looksLikeFirstRun()) {
    markFirstRunDone()
    return
  }
  open(true)
}

function pickFile() {
  errorMessage = ''
  fileInputRef?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input?.files?.[0]
  input.value = ''
  if (!file) return
  fileName = file.name
  summary = null
  pendingData = null
  errorMessage = ''
  try {
    const result = await readBackupFile(file)
    pendingData = result.data
    summary = result.summary
    step = 'preview'
  } catch (err: any) {
    console.error('[DesktopDataImportWizard] 解析备份失败', err)
    errorMessage = err?.message || '解析备份文件失败'
    step = 'idle'
  }
}

async function confirmImport() {
  if (!pendingData) return
  step = 'importing'
  try {
    await applyBackupData(pendingData)
    markFirstRunDone()
    step = 'done'
    Toast.success('数据导入成功，正在重新加载…')
    reloadAfterImport()
  } catch (err: any) {
    console.error('[DesktopDataImportWizard] 导入失败', err)
    errorMessage = err?.message || '导入失败，数据未被修改'
    step = 'preview'
  }
}

onMounted(() => {
  if (!desktop) return
  window.addEventListener(OPEN_EVENT, onOpenEvent)
})

onUnmounted(() => {
  window.removeEventListener(OPEN_EVENT, onOpenEvent)
})

function onOpenEvent() {
  open(false)
}

watch(
  () => store.load,
  () => {
    void detectFirstRun()
  },
  { immediate: true }
)
</script>

<template>
  <Dialog v-if="desktop" v-model="visible" title="导入网页版数据" :close-on-click-bg="false" @close="close">
    <div class="flex flex-col gap-3 p-5" style="width: 34rem">
      <!-- 首启说明 -->
      <div v-if="firstRun && step === 'idle'" class="text-sm text-gray">
        检测到这是桌面版首次启动。如果你之前在网页版（typewords.cc）用过 TypeWords，可以先把网页版的备份导入进来；
        全新开始的话直接点「跳过」。
      </div>

      <!-- 步骤 1：选择文件 -->
      <div v-if="step === 'idle'" class="flex flex-col gap-3">
        <div class="text-md">
          选择网页版「设置 → 数据管理 → 导出数据」得到的
          <span class="font-bold">.json</span> 或 <span class="font-bold">.zip</span> 文件
        </div>
        <div class="text-sm text-gray">导入会覆盖当前桌面版里的全部词典、设置与练习进度。</div>
        <div v-if="errorMessage" class="text-red text-sm break-all">{{ errorMessage }}</div>
        <input ref="fileInputRef" type="file" accept=".json,.zip" class="hidden" @change="onFileChange" />
        <div class="flex gap-space justify-end">
          <BaseButton size="large" @click="pickFile">选择备份文件</BaseButton>
        </div>
      </div>

      <!-- 步骤 2：确认摘要 -->
      <div v-if="step === 'preview' && summary" class="flex flex-col gap-3">
        <div class="text-sm text-gray break-all">文件：{{ fileName }}</div>
        <div class="line"></div>
        <div class="flex flex-col gap-1 text-sm">
          <div>导出格式版本：{{ summary.exportVersion }}</div>
          <div>词典：{{ summary.dictCount }} 本<template v-if="summary.wordCount">（已缓存 {{ summary.wordCount }} 个词条）</template></div>
          <div v-if="summary.dictNames.length" class="text-gray break-all">
            {{ summary.dictNames.join('、') }}
          </div>
          <div>文章书：{{ summary.articleCount }}</div>
          <div>单词练习进度：{{ summary.hasPracticeWord ? '有' : '无' }}</div>
          <div>文章练习进度：{{ summary.hasPracticeArticle ? '有' : '无' }}</div>
          <div>设置：{{ summary.settingSnapshot ? '将覆盖' : '文件里没有' }}</div>
        </div>
        <div class="line"></div>
        <div class="text-red text-sm">确认后当前桌面版的数据将被覆盖，且不可撤销。</div>
        <div v-if="errorMessage" class="text-red text-sm break-all">{{ errorMessage }}</div>
        <div class="flex gap-space justify-end">
          <BaseButton size="large" @click="step = 'idle'">重新选择</BaseButton>
          <BaseButton size="large" type="primary" @click="confirmImport">确认导入</BaseButton>
        </div>
      </div>

      <!-- 步骤 3：导入中 / 完成 -->
      <div v-if="step === 'importing'" class="text-md">正在导入…</div>
      <div v-if="step === 'done'" class="text-md">导入完成，页面即将自动刷新。</div>

      <div v-if="firstRun && (step === 'idle' || step === 'preview')" class="flex justify-end">
        <BaseButton size="large" type="info" @click="close">跳过</BaseButton>
      </div>

      <div class="text-xs text-gray">
        提示：桌面版数据保存在程序目录的 <span class="font-bold">app-data/</span>
        下，把整个文件夹一起复制即可换机使用。
      </div>
    </div>
  </Dialog>
</template>
