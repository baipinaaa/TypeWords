# TypeWords → Windows 桌面版（Tauri 2）实施计划

> 状态：待 review
> 方向：**Tauri 2 + WebView2**，前端为 `nuxt generate` 静态产物
> 构建：**全部走 GitHub Actions**，本地不编译

---

## Context

`TypeWords` 是一个 **纯前端** Nuxt 4 打字背单词项目：

- 无任何服务端逻辑（无 Nitro 处理、无 `useAsyncData`/`onServerPrefetch`），只有 `ssr: false` 页面 + 4 个 `prerender` 的 `/book/nce*`；
- 前端资源 `public/` 共 **14MB**（dicts 4.3M / sound 5.7M / libs 1.7M / imgs 1.9M），词典是**单文件单行 JSON**；
- 数据全存 **IndexedDB**（`idb-keyval`，4 个 key），云同步 Supabase **已是可选形态**（用户自己填 url/key 才启用，无配置时返回空操作 stub）；
- 项目已具备「不登录、纯本地使用」的完整形态。

目标：把项目打包成可双击运行的 Windows 桌面程序，**离线可用**、**无需本地编译**、由 GitHub Actions 出包。

### 核心结论（来自子代理调研，决定方案可行性）

| 关注点 | 结论 | 依据 |
|---|---|---|
| history 路由深链是否 404 | **不会**。Tauri 2 `get_asset()` 内置兜底链：精确路径 → `{path}.html` → `{path}/index.html` → 全局 `index.html` | `crates/tauri/src/manager/mod.rs:395-417` |
| 是否需要 hash 路由 / localhost 插件 | **都不需要**。默认自定义协议更安全；`tauri-plugin-localhost` 官方标注「considerable security risks，不确定就别用」 | v2.tauri.app/plugin/localhost |
| 前端加载方式 | `frontendDist: "../dist"`，Windows 上以 **`http://tauri.localhost`** 提供内嵌资源（非 `file://`） | v2.tauri.app/reference/config/ |
| Windows origin 变化 | 由 `https://typewords.cc` 变为 `http://tauri.localhost`（`*.localhost` 属 potentially trustworthy origin，主页面是 secure context） | v2.tauri.app/start/migrate/from-tauri-1 |
| IndexedDB 数据目录 | `%LOCALAPPDATA%\<identifier>\EBWebView`，`identifier` 变更即换目录；**官方支持 `app.appDirectoriesOverride`** 改到 exe 旁（便携版） | v2.tauri.app/reference/config/ |
| service worker | **自定义协议下不可用**（注册请求永不响应）。但本项目 `public/` **根本没有 `service-worker.js`**，线上注册本来就 404 → 桌面端直接跳过即可 | tauri#12214；本地 `find public -name 'service-worker*'` 无结果 |
| umami 统计 | `app/plugins/02.init.client.ts:8-16` 非本地地址就注入 `t.js`（51.la/百度统计/umami）；全项目 **19 处** `window.umami?.track` | 子代理排查 |
| 发音（有道） | `PronunciationApi = 'https://dict.youdao.com/dictvoice?audio='`，跨域。`<audio>` 元素不受 CORS 限制 → **联网可响，离线 onerror 回退 TTS** | `app/core/hooks/sound.ts:179-233` |
| 例句 TTS | `speechSynthesis` → WebView2 走 Windows SAPI，**不要求 secure context**，英文音色系统自带（中文需装中文语音包） | Web 标准 + 子代理调研 |
| 百度翻译 | **当前线上本来就不可用**：`app/core/hooks/translate.ts:43-49` 的 `appid`/`key` 是**空字符串**，且生产无 `/baidu` 代理 → 直接摘除，不做离线引擎 | 子代理排查 |
| Supabase | 无配置时 `Supabase.check()` 返回 false、`getInstance()` 返回空操作 stub → **桌面端天然禁用，无需大改** | `app/core/utils/supabase.ts` |
| **IME 中文输入（最大风险）** | 存在 **open bug** tauri#15436：带文本的 input 首次聚焦会冻结 Windows TSF，中文输入法候选窗不弹出、按键被吞（**空 input 不受影响**）。另有 tauri#16391 多窗口光标丢失 | tauri#15436 / #16391 |
| 自动播放策略 | Tauri 不注入 `--autoplay-policy=no-user-gesture-required` → **仍需用户手势**。本项目发音均由按键触发，风险低，但首屏自动发音需验证 | tauri#9968 |
| `window.open` / 外链 | 官方推荐 `tauri-plugin-opener` 的 `openUrl()` / `openPath()`；`target="_blank"` 锚点在 WebView2 下 `on_new_window` 可能不触发 | tauri#15872 |
| 便携版打包目标 | **官方没有 `portable` target**。可行做法：分发 `target/release/<name>.exe` 裸二进制（目标机已装 WebView2）+ `appDirectoriesOverride` 指到 exe 旁 | v2.tauri.app/distribute/windows-installer |
| 体积基线 | 官方只给出 WebView2 模式增量：`downloadBootstrapper`/`skip` **0MB**、`embedBootstrapper` **1.8MB**、`offlineInstaller` **127MB**、`fixedRuntime` **180MB**；社区实测 Tauri 2 裸 exe **~8–10MB** | 官方文档 + tauri#12820（社区推断，非官方） |
| WebView2 前置 | **Win10 1803+ / Win11 系统自带**，无需安装；MSI 打包需 VBSCRIPT 功能 | v2.tauri.app/start/prerequisites/ |

---

## Approach

### 架构

```
┌────────────────────────────────────────────────────────────┐
│ src-tauri/  (Tauri 2, Rust)                                 │
│   main.rs / tauri.conf.json / capabilities.json / Cargo.toml│
│   ├─ frontendDist: "../dist"  ← 嵌入静态资源               │
│   ├─ http://tauri.localhost  → 内嵌资源 + 内置 SPA fallback │
│   └─ appDirectoriesOverride  → ./app-data（便携）           │
└────────────────────────────────────────────────────────────┘
            ▲
┌───────────┴─────────────────────────────────────────────────┐
│ app/ (Nuxt 4)                                              │
│  ├─ nuxt generate → dist/（含全部 public/ 14MB）          │
│  ├─ 平台适配层：app/core/utils/desktop.ts + 05.desktop      │
│  │    .client.ts（统一 isDesktop() 开关）                  │
│  ├─ 数据迁移向导（首启）                                   │
│  └─ 桌面增值：全局快捷键 / 托盘 / 自动启动                  │
└─────────────────────────────────────────────────────────────┘
            ▲
┌───────────┴────────────────────────────────────────────────┐
│ .github/workflows/release.yml (windows-latest runner)      │
│  pnpm install → pnpm generate → pnpm tauri build → 上传   │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **保持 history 路由**，不改 `createWebHistory`、不用 hash、不加 localhost 插件。
2. **baseURL 固定 `/`**，`NUXT_APP_BASE_URL` 不设置 → `resourceWrap()` 原样返回，`/sound/`、`/imgs/`、`/libs/`、`/dicts/`、`/list/` 这些**绝对路径在 `http://tauri.localhost` 下直接命中内嵌资源**，**不需要改动大量路径**。这是本方案改造量小的根本原因。
3. **桌面版 = 全新 origin**，IndexedDB 与线上完全隔离 → 首启提供**导入向导**（复用项目已有的 `typing-word-export` v5 格式导入能力，零新增格式成本）。
4. **不做离线单词发音库**（词库量级不可接受）；保留有道在线发音（联网可用），离线回退 TTS，并在设置页给出可读说明。
5. **摘除/屏蔽**：umami 统计、service worker、百度翻译入口、MiniProgram/打赏入口。
6. **保留 Supabase 代码但隐藏设置入口**（最低改动、零风险），P2 再考虑彻底移除依赖。
7. **便携优先**：数据目录随 exe，U 盘可带走词库与进度。

### 决策默认值（需用户确认，见文末）

| 编号 | 决策 | 计划采用的默认值 |
|---|---|---|
| D1 | 发行目标 | **自用 / 小范围分发**（GitHub Releases 提供 NSIS 安装包 + 便携 exe） |
| D2 | 离线发音边界 | **离线不保证单词发音**，例句用 WebView2 TTS；联网时有道发音正常 |
| D3 | 云同步 | **隐藏入口、保留代码**（默认不启用） |
| D4 | 老用户数据迁移 | **做首启导入向导**（复用 `typing-word-export` v5） |
| D5 | 数据目录 | **便携版**：`appDirectoriesOverride: "./app-data"` |
| D6 | 桌面增值 | **做**：全局快捷键呼出 + 托盘；自动更新 P2 |

---

## Files to modify / create

### 新建

| 路径 | 内容 |
|---|---|
| `src-tauri/Cargo.toml` | Tauri 2 + 插件依赖（`tauri 2.x`、`tauri-build`、`tauri-plugin-opener`、`tauri-plugin-global-shortcut`、`tauri-plugin-tray-icon`、`tauri-plugin-store`） |
| `src-tauri/tauri.conf.json` | `frontendDist`、`beforeBuildCommand`、`appDirectoriesOverride`、`bundle.targets`、`webviewInstallMode`、插件配置 |
| `src-tauri/src/main.rs` | 插件注册、托盘、全局快捷键、外链拦截 |
| `src-tauri/src/lib.rs` | 业务逻辑（窗口、数据目录解析） |
| `src-tauri/build.rs` | `tauri_build::build()` |
| `src-tauri/capabilities/default.json` | 权限（`core:default`、`opener:default`、`global-shortcut:default`、`tray-icon:default`、`store:default`、`fs:default`） |
| `src-tauri/tauri.toml` / `.gitignore` | 忽略 `target/` |
| `app/core/utils/desktop.ts` | **平台适配层**：`isDesktop()`、`isDesktopBuild()`、桌面端 no-op stub（umami）、外链打开封装 |
| `app/plugins/05.desktop.client.ts` | 桌面端全局初始化：摘除 SW、挂载 umami stub、拦截 `window.open`/`a[target=_blank]` 走 opener |
| `app/components/desktop/DesktopDataImportWizard.vue` | **首启导入向导**（本地 JSON/ZIP 选择 → 校验 → 写入 idb） |
| `app/core/hooks/desktop-data.ts` | 导入向导逻辑（复用 `checkAndUpgradeSaveDict` / `checkAndUpgradeSaveSetting` / `checkAndUpgradePracticeWordCache`） |
| `.github/workflows/release.yml` | Windows 构建 + 发布 |
| `.github/workflows/ci.yml` | 前端产物冒烟构建（可选，加快反馈） |

### 修改

| 路径 | 改动 |
|---|---|
| `package.json` | 新增 `@tauri-apps/cli`、`@tauri-apps/api`、`@tauri-apps/plugin-opener` 等依赖；新增 `"desktop:dev"` / `"desktop:build"` / `"desktop:tauri"` scripts |
| `nuxt.config.ts` | `ignore: ['**/src-tauri/**']`；确认 `app.baseURL` 默认 `/`；`vite.envPrefix` 加 `TAURI_`；devServer `host: '0'`、`strictPort: true`（对齐官方 Nuxt 集成示例） |
| `app/plugins/02.init.client.ts` | **去掉** umami `t.js` 注入（`:8-16`）；**去掉** service worker 注册（`:18-29`），或整体改为 `if (!isDesktop())` 守卫 |
| `app/pages/setting.vue` | **隐藏 Tab 6「数据同步」**（`:670-722`）；Tab 5 保留导出/导入/历史/清空（导入向导改为桌面版首启自动触发，但保留手动入口）；隐藏「跳过导出」（Mac 专用，`:661-665`） |
| `app/components/dialog/BackupGateDialog.vue` | 桌面版首启自动打开导入向导；调整文案 |
| `app/layouts/default.vue` | 隐藏 `MiniProgram.vue`（`:20`）、`IeDialog`；`Supabase.check()` 的 umami 调用（`:55`）保留但走 stub |
| `app/components/MiniProgram.vue` | 桌面版整组件隐藏（打赏/小程序引导在桌面无意义） |
| `app/core/hooks/translate.ts` | **摘除**百度翻译入口（`EditArticle.vue:49,53-55` 的引擎下拉、`:121` 的调用）——当前线上本就不可用 |
| `app/components/article/EditArticle.vue` | 去掉「网络翻译」按钮与引擎选择 |
| `app/core/hooks/sound.ts` | 保持有道发音 + TTS 回退；补充桌面端 TTS 可用性提示；`speechSynthesis` 不可用时的兜底提示 |
| `app/core/utils/index.ts` | `loadJsLib` 在桌面端改为优先静态资源路径（`/libs/...` 已内嵌，可不变；但 `.mjs` 动态 `import()` 需验证 secure context，必要时改为构建时静态引入 Shepherd） |
| `app/components/article/TypingArticle.vue` / `app/core/hooks/event.ts` | **IME 风险规避**：`ensureMobileInput()` 的离屏 input 创建/聚焦（`event.ts:96-125`）在桌面端**不执行**；聚焦前确保输入框为空 |
| `app/pages/(articles)/practice-articles/[id].vue` | `ConflictNotice` 提示在桌面端关闭或改写（`:52,196-198`） |
| `app/core/config/env.ts` | 新增 `DESKTOP` 标志与桌面端相关常量（如离线提示文案开关） |
| `tsconfig.json` | 确认 `src-tauri` 不进 TS 检查范围 |

### 不改动（经评估确认）

- `app/core/utils/base-url.ts` —— baseURL `/` 时 `withAppBaseURL` 原样返回，绝对路径天然正确
- `app/core/utils/cache.ts` —— idb-keyval 在 `http://tauri.localhost` 下正常工作
- `app/core/composables/practice-words/*`（练习引擎）—— 纯逻辑，无环境依赖
- `app/core/utils/supabase.ts` —— 无配置时天然禁用，保留代码
- `app/core/utils/word-test.ts` / `wordLookup.ts` —— 无网络依赖
- `app/core/stores/*` —— 无环境依赖

---

## Reuse

项目内可直接复用、**不要重写**的既有实现：

| 复用项 | 路径 | 用途 |
|---|---|---|
| `checkAndUpgradeSaveDict` | `app/core/utils/index.ts:67-100` | 导入向导校验词典数据 |
| `checkAndUpgradeSaveSetting` | `app/core/utils/index.ts:102-140` | 导入向导校验设置数据 |
| `checkAndUpgradePracticeWordCache` | `app/core/utils/cache.ts:156-` | 导入向导校验练习缓存 |
| `importJson` 的全部逻辑 | `app/pages/setting.vue:209-259` | **导入向导直接照搬此函数体**，拆到 `desktop-data.ts` 复用 |
| `importData`（JSON/ZIP 解析） | `app/pages/setting.vue:265-310` | 同上，含 mp3 提取到 `LOCAL_FILE_KEY` |
| `forcePushLocalDataToRemote` 的本地写入部分 | `app/core/composables/useDataSyncPersistence.ts:460-494` | 导入后落库（可去掉 Supabase 分支，只留 `persistLocalState`） |
| `useExport().getExportedData()` / `buildExportZip()` | `app/core/hooks/export.ts:26-94` | 桌面版导出仍可用；同时用于生成「从网页版导出」的说明 |
| `withAppBaseURL` / `normalizeBaseURL` | `app/core/utils/base-url.ts:88-106` | 资源路径处理，桌面端无需改动 |
| `resourceWrap` | `app/core/utils/index.ts:661` | 静态资源 URL 统一入口 |
| `_getDictDataByUrl` | `app/core/utils/index.ts:364-375` | 内嵌 dicts 后本地 fetch 即可，无需改造 |
| `normalizePracticeTimer` / 计时暂停机制 | `app/core/composables/practice-words/usePracticeIdleTimer.ts` | 桌面端仍需空闲暂停计时 |
| `useWordOptions` / `useArticleOptions` | `app/core/hooks/dict.ts` | 收藏/错词逻辑，无环境依赖 |
| 全部 `*.vue` UI 组件 | `app/base/`、`app/components/` | 自研组件库直接用 |

---

## Steps

> 标注 **[子代理]** 的任务按用户要求分派给子代理执行，主流程负责汇总与验证。

### Phase 0 — 决策确认（主流程）
- [x] 向用户确认 D1–D6 六项决策（文末表），记录结论并回填计划

### Phase 1 — Tauri 脚手架
- [ ] 1.1 **[子代理]** 创建 `src-tauri/` 目录结构：`Cargo.toml`、`src/main.rs`、`src/lib.rs`、`build.rs`、`tauri.conf.json`、`capabilities/default.json`、`.gitignore`
- [ ] 1.2 **[子代理]** 按调研结论配置 `tauri.conf.json`：
      - `build.beforeBuildCommand: "pnpm generate"`、`devUrl: "http://localhost:5567"`、`frontendDist: "../dist"`
      - `app.appDirectoriesOverride: "./app-data"`（D5 便携）
      - `bundle.targets: ["nsis"]`、`bundle.active: true`
      - `bundle.windows.webviewInstallMode.type: "downloadBootstrapper"`（0MB 增量，Win10 1803+/Win11 系统已有运行时）
      - `bundle.windows.installMode: "currentUser"`（免管理员）
- [ ] 1.3 **[子代理]** 编写 `main.rs`：注册 `opener` / `global-shortcut` / `tray-icon` / `store` 插件；`on_new_window` 与 `on_page_load` 中拦截外链走 `opener::open_url`
- [ ] 1.4 **[子代理]** 编写 `capabilities/default.json`：`core:default`、`opener:default`、`global-shortcut:default`、`tray-icon:default`、`store:default`
- [ ] 1.5 **[子代理]** 修改 `package.json`：新增 `@tauri-apps/cli`（devDep）、`@tauri-apps/api`、`@tauri-apps/plugin-opener`、`@tauri-apps/plugin-global-shortcut`、`@tauri-apps/plugin-tray-icon`、`@tauri-apps/plugin-store`；新增 scripts `desktop:dev` / `desktop:build` / `desktop:tauri`
- [ ] 1.6 **[子代理]** 修改 `nuxt.config.ts`：`ignore: ['**/src-tauri/**']`、`vite.envPrefix: ['VITE_','TAURI_']`、`devServer.host: '0'`、`strictPort: true`、`ssr: false`（全站，替换现有 `routeRules` 的 ssr:false）
- [ ] 1.7 **[子代理]** 修改 `tsconfig.json`，排除 `src-tauri`

### Phase 2 — 前端平台适配层
- [ ] 2.1 **[子代理]** 新建 `app/core/utils/desktop.ts`：
      - `isDesktop()`：运行时探测 Tauri 环境（`window.__TAURI_INTERNALS__` / `navigator.userAgent` 含 Tauri，或构建期 `NUXT_DESKTOP=1` 环境变量）
      - `getUmamiStub()`：返回 no-op 的 `{ track(){} }`，注入 `window.umami`
      - `openExternal(url)`：封装 `@tauri-apps/plugin-opener` 的 `openUrl`，非桌面端回退 `window.open`
      - `openPath(path)`：封装 `openPath`
- [ ] 2.2 **[子代理]** 新建 `app/plugins/05.desktop.client.ts`：
      - 挂载 umami stub（覆盖 19 处 `window.umami?.track` 调用，不报错且不发网络请求）
      - 桌面端拦截 `window.open` / `a[target="_blank"]` / `location.href` 外链，统一走 `openExternal`
- [ ] 2.3 **[子代理]** 修改 `app/plugins/02.init.client.ts`：
      - 去掉 `:8-16` 的 `t.js` 注入
      - 去掉 `:18-29` 的 service worker 注册
      - 保留 `console.json` / `console.parse` 与 `VueVirtualScroller` 注册
- [ ] 2.4 **[子代理]** 修改 `app/layouts/default.vue`：桌面端隐藏 `MiniProgram.vue` 与 `IeDialog`
- [ ] 2.5 **[子代理]** 修改 `app/components/MiniProgram.vue`：导出前判断 `isDesktop()`，为 true 时渲染空节点
- [ ] 2.6 **[子代理]** 摘除百度翻译：修改 `app/core/hooks/translate.ts`（保留类型，函数体改为抛 `TODO`/返回 null）与 `app/components/article/EditArticle.vue`（去掉引擎下拉与网络翻译按钮）

### Phase 3 — 资源离线化
- [ ] 3.1 **[子代理]** 核对 `nuxt generate` 产物：确认 `dist/` 中包含 `dicts/`、`list/`、`sound/`、`libs/`、`imgs/` 全量（`public/` 原样拷贝，14MB）
- [ ] 3.2 **[子代理]** 验证 `ENV.RESOURCE_URL` 保持 `''`，所有 `/sound/...`、`/libs/...`、`/dicts/...`、`/list/...` 绝对路径在 `http://tauri.localhost` 下可命中（本地用静态服务器模拟验证）
- [ ] 3.3 **[子代理]** 评估 `loadJsLib` 的 `.mjs` 动态 `import()`（Shepherd，`app/core/utils/index.ts:622-644`）：在自定义协议下验证是否可用；不可用则改为构建时静态引入 `Shepherd`，去掉 `loadJsLib('Shepherd')`
- [ ] 3.4 **[子代理]** 评估 `shakeCommonDict`（`app/core/utils/index.ts`）在桌面端的行为：内嵌资源后官方词典被剔除 `words` 后仍可 `_getDictDataByUrl` 重新拉取（本地 fetch，**预期无需改动**）；确认后记录结论
- [ ] 3.5 **[子代理]** 确认 `runtimeConfig.public.latestCommitHash`（`nuxt.config.ts` 构建时 `git rev-parse`）在 CI checkout 后正常产出

### Phase 4 — 首启数据导入向导
- [ ] 4.1 **[子代理]** 新建 `app/core/hooks/desktop-data.ts`：把 `app/pages/setting.vue:209-259`（`importJson`）与 `:265-310`（`importData`）的函数体拆出复用，去掉 Supabase 分支，只保留本地 `persistLocalState` 落库
- [ ] 4.2 **[子代理]** 新建 `app/components/desktop/DesktopDataImportWizard.vue`：本地选择 `.json`/`.zip` → 校验版本 → 显示将覆盖的数据摘要 → 确认导入 → 调用 `desktop-data.ts`
- [ ] 4.3 **[子代理]** 接入首启触发：`app/plugins/05.desktop.client.ts` 中，`isDesktop()` 且本地四个存储 key 全为空时，延迟到 `store.load === true` 后打开向导
- [ ] 4.4 **[子代理]** 修改 `app/pages/setting.vue`：隐藏 Tab 6「数据同步」（`:670-722`）；隐藏「跳过导出」（`:661-665`）；保留 Tab 5 的导出/导入/历史/清空入口
- [ ] 4.5 **[子代理]** 修改 `app/components/dialog/BackupGateDialog.vue`：桌面端首启文案调整

### Phase 5 — 桌面增值
- [ ] 5.1 **[子代理]** `main.rs` 实现**全局快捷键**呼出小窗口（无边框置顶默写窗）：复用 `tauri-plugin-global-shortcut`，注册如 `Ctrl+Alt+W`
- [ ] 5.2 **[子代理]** `main.rs` 实现**托盘图标**：`tauri-plugin-tray-icon`，右键菜单「显示主窗口 / 退出」
- [ ] 5.3 **[子代理]** 验证 `appDirectoriesOverride` 生效：启动后 `%LOCALAPPDATA%` 不再写入，`./app-data/EBWebView` 生成；**重启后 IndexedDB 数据仍在**
- [ ] 5.4 **[子代理]** 修改 `app/core/hooks/event.ts`：`ensureMobileInput()`（`:96-125`）仅在 `isMobile()` 为真时执行，桌面端不创建离屏 input（**规避 tauri#15436 IME 冻结**）
- [ ] 5.5 **[子代理]** `app/components/word/PracticeOnboardingHost.vue` 引导流程（Shepherd）在桌面端保持可用，验证动态加载

### Phase 6 — CI 工作流（本地不编译）
- [ ] 6.1 **[子代理]** 新建 `.github/workflows/release.yml`：
      - `on: [push, workflow_dispatch, release]`，`jobs.build-windows.runs-on: windows-latest`
      - 步骤：`actions/checkout` → `pnpm/action-setup@v4`（指定 Node 版本）→ `pnpm/action-setup` → `pnpm install --frozen-lockfile` → `pnpm generate` → `pnpm tauri build`
      - 产物发布：**直接发布到 GitHub Release**（`softprops/action-gh-release`），不再上传 Actions artifact（用户后续要求，见偏差 7）
      - 发布：`softprops/action-gh-release`（仅 `release` 事件），支持 `RELEASES_TOKEN` 环境变量注入，**不硬编码凭据**
      - 签名：环境变量 `TAURI_SIGNING_PRIVATE_KEY`（可选，未配置则跳过，不阻断构建）
- [ ] 6.2 **[子代理]** 新建 `.github/workflows/ci.yml`：仅前端 `pnpm install && pnpm generate`，快速验证静态产物（可选，但建议保留作为前置门禁）
- [ ] 6.3 **[子代理]** 编写 `README.desktop.md` / 在根 README 增加「桌面版构建」章节：说明 CI 触发方式、产物说明、便携版数据目录、从网页版迁移数据的步骤

### Phase 7 — 验证
见下方 Verification。

---

## Verification

### 本地可验证（不依赖编译 Tauri）

- [ ] `pnpm install` 成功，无破坏性依赖变更
- [ ] `pnpm generate` 成功，`dist/` 完整：`ls dist` 应见 `dicts/ list/ sound/ libs/ imgs/ _nuxt/ index.html`，`dicts/en/word/CET4_T.json` 存在
- [ ] `app/core/utils/desktop.ts` 的 `isDesktop()` 在浏览器（非 Tauri）下返回 `false`，在模拟 Tauri 环境下返回 `true`
- [ ] 摘除后无残留：`grep -rn "umami\|service-worker\|/baidu" app/` 应只剩 stub 与桌面守卫，无主动注入
- [ ] 前端无 SSR 依赖：`grep -rn "useAsyncData\|onServerPrefetch" app/` 应为空
- [ ] 设置页 Tab 6 同步入口已隐藏，Tab 5 导出/导入仍可用

### 需要在 CI / 真机验证（本机无法完成）

- [ ] **CI 全绿**：`release.yml` 在 `windows-latest` 上跑通，产出 `-setup.exe` 与裸 exe 并发布为 Release 附件
- [ ] **安装包运行**：在干净 Windows 10 1803+/Win11 上安装后能启动主窗口
- [ ] **SPA 深链**：直接访问 `http://tauri.localhost/words`、`/practice-words/<id>`、`/setting` 不 404（Tauri 内置 fallback）
- [ ] **IndexedDB 持久化**：关闭重启后词典选择、学习进度、练习缓存全部保留；数据落在 `./app-data`（非 `%LOCALAPPDATA%`）
- [ ] **首启导入向导**：用网页版导出的 `TypeWords-User-Data-*.zip` 导入，词典/设置/练习缓存全部恢复，无报错
- [ ] **练习全流程**：跟写/默写/听写/自测四种模式各跑一组；跟写模式每 7 词插入默写组（`GROUP_SIZE`）正常；结算后 `fsrsData` 正确写入
- [ ] **键盘与 IME（最高优先级）**：
      - 桌面端英文输入打字正常，空格/退格/`Ctrl+→` 快捷键正确
      - **中文输入法**：在练习页面输入中文，候选窗正常弹出、光标不跳（重点测 tauri#15436 的「带文本 input 首次聚焦」场景）
      - 离屏 `#typing-listener` 在桌面端不创建
- [ ] **音频**：单词发音（联网有道）正常；断网时回退 TTS 并给出可读提示；例句 TTS 正常；键盘音效/效果音正常
- [ ] **外链与弹窗**：所有 `window.open` / `a[target=_blank]`（如 `goYoudao`）都走 opener，不出现空白窗口
- [ ] **统计与同步**：桌面端无任何外网请求（用系统代理/抓包确认 `t.js`、`dictvoice` 之外的请求已消失）；Supabase 入口已隐藏
- [ ] **便携性**：把 `.exe` + `app-data/` 整体拷到另一台机器/U 盘，数据随行
- [ ] **体积记录**：记录最终 `-setup.exe` 与裸 exe 大小，对照基线（裸 exe ~8–10MB + 14MB 前端资源 ≈ 22–25MB）

### 交付物清单

- `src-tauri/` 完整工程
- 前端平台适配层（`desktop.ts`、`05.desktop.client.ts`、导入向导）
- 修改后的 `package.json` / `nuxt.config.ts` / `tsconfig.json`
- `.github/workflows/release.yml` + `ci.yml`
- 验证记录（上述清单逐项勾选，CI 构建日志）

---

## 决策结论（已于计划审批时确认）

> 用户在计划 review 中批准了下列全部默认值（2026-11-21），无需再逐项追问；若后续需要改动，直接改本节并同步受影响的 Phase。

- [x] **D1 发行目标** —— 确认：自用/小范围分发，GitHub Releases 出 NSIS + 便携 exe
- [x] **D2 离线发音边界** —— 确认：离线不保证单词发音，例句走 WebView2 TTS
- [x] **D3 云同步** —— 确认：隐藏设置入口、保留代码
- [x] **D4 老用户数据迁移** —— 确认：做首启导入向导
- [x] **D5 数据目录** —— 确认：便携版（`./app-data`）
- [x] **D6 桌面增值** —— 确认：全局快捷键 + 托盘；自动更新列为 P2

## 风险与未确认项

1. **IME 中文输入**（tauri#15436 / #16391，open）—— 本项目依赖键盘打字，是**最高风险项**。缓解：桌面端不创建离屏 input、聚焦前清空输入框；若仍复现，需在 Tauri 侧打 patch 或改用 `tauri-plugin-localhost`（有安全代价）作为兜底。
2. **`speechSynthesis` 音色可用性** —— 官方无文档；WebView2 走 Windows SAPI，英文音色系统自带，中文需装中文语音包。需真机实测。
3. **远程 `Audio` URL 的 CORS** —— 有道发音用 `<audio>` 元素，预期不受 CORS 限制，但**未获官方确认**，需实测。
4. **Tauri SPA fallback 是否有关闭开关** —— 配置参考中无对应键，官方文档未写明，仅源码证据。
5. **`loadJsLib` 的 `.mjs` 动态 `import()`** 在自定义协议下的行为 —— 需验证，必要时改为静态引入。
6. **体积基线** —— 裸 exe ~8–10MB 为社区数据，官方无数字；最终以实测为准。
7. **无签名** —— SmartScreen 会显示警告（Win11 开启 Smart App Control 会**直接拦截**）。若需上架 Store 或规避拦截，需配置 `TAURI_SIGNING_PRIVATE_KEY` 与代码签名证书。

---

## 执行记录与偏差（实施阶段回填）

### 偏差 1：D6 的「无边框置顶默写小窗」降级为主窗口切换

计划 step 25 原写「全局快捷键呼出无边框置顶默写小窗」，实际实现为 **`Ctrl+Alt+W` 显示/隐藏主窗口**。

理由：
1. **IME 风险优先**：Tauri 在多 WebView 窗口下存在已知 bug（tauri#16391：多窗口光标丢失），而本项目的 IME 表现是 D 项里最高优先级；多开一个置顶小窗会显著抬高 IME 回归风险。
2. **IME 输入**需要稳定的焦点上下文；小窗（逃逸主界面）还会与 `app/core/hooks/event.ts` 的焦点接管逻辑冲突（该逻辑已按「不创建离屏 input」改造）。
3. 主窗口本身可自由调整尺寸并置顶（后续若需要，可在 `capabilities` 增加 `core:window:allow-set-always-on-top` 由前端切换），成本更低。

若后续确需独立小窗，建议单独走一轮：`main.rs` 用 `WebviewWindowBuilder` 创建 `label="mini"`、`window.webviewWindow("mini")` 复用，且**先**在真实设备上回归 IME。

### 偏差 2：首启向导的触发点放在组件内而非插件

计划 step 22 写「在 `app/plugins/05.desktop.client.ts` 中」触发。实际实现：
- 向导组件 `DesktopDataImportWizard.vue` 自身 `watch(store.load)` 判定首启并弹出（渲染位置在 `app/layouts/default.vue`）；
- 插件只暴露手动入口 `window.__TYPEWORDS_OPEN_IMPORT__()`（dispatch `typewords:open-import-wizard` 事件）。

理由：Nuxt 插件没有可靠的「挂载全局组件」方式，程序化 mount 一个 Ui 组件反而要绕过 Vue 应用实例；「layout 渲染 + 组件自判定」时序更可控，也便于检查「是否首启」。

### 偏差 3：`persistBackupLocally` 落在 useDataSyncPersistence 而不是 desktop-data.ts

为了让导入路径与云同步路径共用同一套 `persistLocalState`（含版本号、`updated_at`、store key 映射），
在 `app/core/composables/useDataSyncPersistence.ts` 内新增 `persistBackupLocally(data)` 并导出；
`app/core/hooks/desktop-data.ts` 只负责「解析 → 规范化 → 摘要 → 调它 → 刷新 store」。

### 静态核对结论（Phase 3，本地无 pnpm 无法跑 generate）

- **step 15 资源完整性**：`public/` 共 14MB —— `dicts 4.3M / list 10K / sound 5.7M / libs 1.7M / imgs 1.9M`，`public/dicts/en/word/CET4_T.json` 存在。Nuxt 会将 `public/` 原样拷入 `dist/`；最终仍需 CI 首跑核对 `dist/`。
- **step 16 路径**：`app/core/config/env.ts:19` `RESOURCE_URL: ''`；`LIBS_URL: '/libs/'`；`LIST_URL` 拼成 `/list/...`；`resourceWrap()` 走 `withAppBaseURL()`，而 `app.baseURL = normalizeBaseURL(process.env.NUXT_APP_BASE_URL || '/')`，CI 未设该变量 → baseURL 为 `/` → 所有资源为根绝对路径，在 `http://tauri.localhost` 下命中。
- **step 17 Shepherd**：`app/core/utils/index.ts:622-644` 的 `loadJsLib` 对 `.mjs` 先插入 `<script type="module" src="/libs/Shepherd.14.5.1.mjs.js">`，`onload` 后再运行时 `import(url)`。文件名以 `.js` 结尾，Tauri 按扩展名给 `text/javascript`；同源绝对路径无 CORS 问题 → **预期可用，暂不改静态引入**（改为静态会增大首屏包并需重构 4 处 `loadJsLib` 调用）。
- **step 18 `shakeCommonDict`**：仅在导出/上传时把「非 custom 且非 system」词典的 `words`、文章 `sections` 清空；本地 `store` 不受影响，`_getDictDataByUrl()` 仍可从 `/dicts/...` 拉取 → **无需改动**。
- **step 19 `latestCommitHash`**：`nuxt.config.ts:10-18` 用 `execSync('git rev-parse --short HEAD')` 与 `git log -1 --format=%ci`，失败 catch 为 `'unknown'`；CI `actions/checkout`（fetch-depth:1）+ Windows runner 自带 git → 正常产出。
- **step 36**：`grep -rn "umami|service-worker|/baidu"` 仅剩 `window.umami?.track` 调用点（stub 后 no-op）、`app/plugins/02.init.client.ts` 里已加 `!isDesktop()` 守卫的注入/注册、`app/libs/translate/baidu.ts:47` 的 `endpoint = "/baidu"`（无调用方）。✔
- **step 37**：`grep -rn "useAsyncData|onServerPrefetch" app/` 为空。✔
- **step 38**：`app/pages/setting.vue:605` Tab6 加 `v-if="!desktop"`，`:673` 同步内容区 `v-if="!desktop && tabIndex === 6"`，`:664` 「跳过导出」Popup 加 `v-if="!desktop"`。✔

### 仍需真实环境验证（本地无法执行）

`pnpm install` / `pnpm generate` / `cargo check` / Tauri 打包在本机均不可用（无 pnpm、无 Rust 工具链、用户要求「不需要本地编译」），因此以下步骤留待 **CI 首次运行**与**用户真机验收**：
step 15（dist 产物）、27（appDirectoriesOverride）、29（Shepherd 桌面加载）、33–35（本地 pnpm）、39–50（CI 全绿与真机清单）。

### 偏差 4：改为「纯离线版」——桌面端零联网（用户后续追加要求）

用户要求（原文）：「远程链接全部去掉，只需要本地的」。据此推翻了原计划中「外链交给系统浏览器」「单词发音走有道在线音频」两项设计，改为：

| 项目 | 原设计 | 现设计 | 落点 |
| --- | --- | --- | --- |
| 单词发音 | 有道 `dict.youdao.com/dictvoice`，失败退 TTS | 桌面端不再请求在线音频；**最终方案见偏差 5：改由内置 espeak-ng 合成** | `app/core/hooks/sound.ts`（`useTTsPlayAudio()` 在 `isEspeakAvailable()` 时分流到 `app/core/hooks/espeak.ts`） |
| 外链 / `window.open` | `@tauri-apps/plugin-opener` 拉起系统浏览器 | **一律不打开**，`notifyOfflineFeature()` 弹 Toast「桌面版为离线版本，已禁用联网功能」 | `app/core/utils/desktop.ts` `openExternal()`；1.5s 节流 |
| 第三方词典 iframe | 有道 / 金山 iframe 内嵌查词 | **桌面端不渲染** iframe、不显示词典 tab 与「在新窗口打开」；未收录时提示「桌面版为离线版本，内置词表未收录该词，且不支持联网查询」 | `app/components/word/WordLookupPopover.vue`（`const desktop = isDesktop()`，`isExternalLookup` 加 `!desktop`） |
| 查词请求 | `queryWord()` → `ENV.API`（`http://localhost/`，本来就必败） | 桌面端**直接返回 `data: null`**，不发请求 | `app/core/utils/wordLookup.ts` `resolveWordLookup()` |
| 远程字体 | `fonts.gstatic.com` 的 Garamond italic（`app/pages/index.vue`） | 改为 `src: local('Garamond'), local('EB Garamond'), local('Georgia')`，零请求 | `app/pages/index.vue` |
| CSP | `null`（全放开） | 严格白名单：`default-src 'self' ipc: http://ipc.localhost`、`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`、`style-src 'self' 'unsafe-inline'`、`img-src 'self' data: blob:`、`media-src 'self' data: blob:`、`font-src 'self' data:`、`connect-src 'self' ipc: http://ipc.localhost blob: data:`、`worker-src 'self' blob:`、**`frame-src 'none'`**、`object-src 'none'`、`base-uri 'self'`、`form-action 'none'`；`devCsp` 额外放行 `http://localhost:5567` 与 `ws://localhost:5567` | `src-tauri/tauri.conf.json` `app.security` |
| 运行时守卫 | 无 | `installOfflineGuard()`：劫持 `fetch`（外部地址 reject `TypeError('offline: ...')`）、`XMLHttpRequest.prototype.open`（外部地址改写为 `/__offline_blocked__`）、`WebSocket` / `EventSource`（改指向本地兜底路径）；全部 `console.warn('[desktop-offline] 已阻断外部…请求：<url>')` 便于定位遗漏 | `app/plugins/05.desktop.client.ts` |
| opener 插件 | Rust + capability + JS 依赖 | **整体移除**（`Cargo.toml`、`src-tauri/src/lib.rs`、`capabilities/default.json`、`package.json`） | 见左 |
| capabilities | `core:default` + `opener:default` + `global-shortcut:default` | **只留 `core:default`**（快捷键注册在 Rust 侧，不需要前端 IPC 能力） | `src-tauri/capabilities/default.json` |

| UI 入口（外链所在区块） | 全部显示 | **全部不渲染**（见下表） | 见下表 |

桌面端直接不渲染的外链入口（用户要求「全部去掉」）：

| 位置 | 处理 |
| --- | --- |
| 侧边栏「反馈」「文档」两个入口 | `app/layouts/default.vue` 两个 `<NuxtLink>` 加 `v-if="!desktop"` |
| 文档页（整页是夸克网盘） | `app/pages/doc.vue`：`const desktop = isDesktop()`；分类筛选与资源列表 `v-if="!desktop"`，改为提示「桌面版为离线版本，不内置网盘资源分享页面」；底部问卷链接 `<li>` 加 `v-if="!desktop"` |
| About / 反馈页（`app/components/About.vue`） | GitHub 地址行、微信群、问卷链接、`ChannelIcons` 行全部 `v-if="!desktop"`，改为一行灰字「桌面版为离线版本，不提供在线反馈与交流渠道」 |
| 帮助页 qa13 区块 | `app/pages/help.vue` 的微信群 / GitHub / 问卷三块 `v-if="!desktop"`，加桌面提示 |
| 社交渠道图标组件 | `app/components/channel-icons/ChannelIcons.vue` 根 `div` 加 `v-if="!isDesktop()"`（含 x.com、mailto、小红书/QQ 弹窗、分享），影响 About / help / 练习结算 `Statistics.vue` 三处 |
| 浏览器插件冲突排查文案 | `app/components/dialog/ConflictNoticeText.vue` 根 `div` 加 `v-if="!isDesktop()"`（WebView2 无插件冲突场景），同时覆盖 `ConflictNotice` / `ConflictNotice2` 弹窗与 help 页 FAQ |
| 练习右键菜单「语法分析」「有道翻译」 | `app/components/article/TypingArticle.vue` 与 `app/components/practice-sentences/TypingSentence.vue` 把这两项包进 `...(isDesktop() ? [] : [...])`，桌面端菜单只剩收藏/复制/从这里开始/朗读 |
| Supabase 文档与官网链接 | 已随设置页 Tab6 整体 `v-if="!desktop"` 隐藏 |
| IE 提示 / Chrome 下载链接 | 已随 `<IeDialog v-if="!desktop" />` 隐藏 |
残留：`app/components/dialog/MigrateDialog.vue`（无任何引用，死代码）与 `app/core/utils/index.ts` 的 `jump2Feedback()` / `goYoudao()` 函数体保留，但调用点全在已隐藏的 UI 里，桌面端不可达。


副作用提醒：CSP 严格化后，桌面端 DevTools 里如果出现被拒的请求，`console` 会有 CSP 违规报告；`'unsafe-eval'` 是为 `vxe-table`/`vue-virtual-scroller` 保留的，如未来确认不需要可去掉。

### 偏差 5：发音改用内置 espeak-ng（英式英语）——用户后续追加要求

用户要求（原文）：「发音用espeak-ng实现，用British English」。据此推翻偏差 4 里「桌面端走 WebView2 系统 TTS」的临时方案，改为把 espeak-ng 直接打进安装包，纯离线合成：

| 项目 | 原设计（偏差 4） | 现设计 | 落点 |
| --- | --- | --- | --- |
| 合成引擎 | WebView2 `speechSynthesis`（依赖系统语音包，Win10 可能没有英文音色） | **内置 espeak-ng 1.52.0**（`espeak-ng.exe` + `libespeak-ng.dll` + `espeak-ng-data`），随安装包分发 | `src-tauri/resources/espeak-ng/`（`bundle.resources: ["resources/espeak-ng/**/*"]`，仓库不提交，CI 现场下载解包） |
| 音色 | 跟随系统（默认 en-US，或用户调 `ttsVoiceMap`） | **固定 `-v en-gb`**（British English） | `src-tauri/src/lib.rs` `const ESPEAK_VOICE: &str = "en-gb"` |
| 语速 | `utterance.rate` | 设置里的「速度」×165 wpm，clamp 到 80–450，传给 espeak-ng `-s` | `app/core/hooks/espeak.ts` `speedFromRate()` |
| 调用链 | JS 直接 `speechSynthesis.speak` | JS `invoke('espeak_speak', {text, speed})` → Rust `spawn_blocking` 起子进程 → 返回 WAV 原始字节（`tauri::ipc::Response::new(bytes)`）→ 前端 `Blob` + `<audio>` 播放 | `src-tauri/src/lib.rs` `espeak_speak`；`app/core/hooks/espeak.ts` `playEspeak()` |
| 缓存 | 无 | Rust 侧按 `hash(en-gb|speed|text)` 写 `app-data/caches/espeak-wav/<hash>.wav`，命中直接读；JS 侧再缓存 Blob URL（上限 160 条，FIFO 淘汰） | `wav_cache_key()` / `getEspeakWavUrl()` |
| 失败兜底 | — | 资源缺失或进程异常时 `console.warn('[espeak] …')` 并回退 `speechSynthesis` | `playEspeak()` 返回 `null` → `useTTsPlayAudio()` 继续走原 TTS 分支 |
| 发音类型选择器 | 显示（美音/英音） | **桌面端隐藏**，改为一行「桌面版内置 espeak-ng，固定英式发音（en-gb） / British English」 | `app/components/setting/SoundSetting.vue`、`app/components/word/VolumeSettingMiniDialog.vue` |
| IPC 权限 | 只留 `core:default` | 不需要额外 capability（自定义 command 不受 capability 约束），`@tauri-apps/api` 重新加入 dependencies（动态 import，web 构建不影响） | `package.json` |
| 体积 | 裸 exe ≈ 8–10MB + 14MB 前端 | 再 +≈12MB（espeak-ng 运行时，NSIS 压缩后约 +6–8MB） | — |

实现细节备忘：

- `espeak_root()` 先查 `resource_dir()/resources/espeak-ng`，debug 构建再回退到 `CARGO_MANIFEST_DIR/resources/espeak-ng`，便于 `tauri dev`。
- 子进程设 `ESPEAK_DATA_PATH=<root>` 且 `current_dir=<root>`，兼容 data 与 exe 同目录的官方布局。
- 文本以 `-` 开头时前置一个空格，避免被 getopt 当成选项；超过 4000 字符截断。
- 所有调用点（`app/components/word/WordMetaPanel.vue`、`app/core/composables/useWordPracticeAudio.ts`、`app/core/hooks/article.ts`）都走 `useTTsPlayAudio()`，因此只需改这一处即可全覆盖单词/例句/文章朗读。
- `cancelWordPracticeAudio()` 额外调用 `cancelEspeakAudio()`，避免切词时旧音频继续播。

### 偏差 6：再加一个高质量发声模型 piper + en_GB-cori-high（神经 TTS）——用户后续追加要求

用户要求（原文）：「再来另一个发声模型 https://huggingface.co/4-alokk/piper-voices 里的 vits-piper-en_GB-cori-high」。
据此在 espeak-ng 之外再内置 piper（VITS）作为**首选**发音引擎，形成三级链：piper → espeak-ng → 系统 TTS。

| 项目 | 偏差 5（espeak-ng） | 偏差 6（新增 piper） | 落点 |
| --- | --- | --- | --- |
| 引擎优先级 | 唯一内置引擎 | **piper 优先，espeak-ng 兜底**（piper 失败一次后本次会话不再尝试） | `app/core/hooks/sound.ts` `playDesktopTtsChain()` |
| 运行时 | espeak-ng 1.52.0（msi 解包） | **rhasspy/piper `2023.11.14-2` 的 `piper_windows_amd64.zip`**（含 `piper.exe`、onnxruntime dll、`espeak-ng-data`） | `src-tauri/resources/piper/` |
| 模型 | — | **`vits-piper-en_GB-cori-high`**（110 MB tar.bz2 → `en_GB-cori-high.onnx` + `.onnx.json`），英式英语、22.05kHz | `resources/piper/voices/` |
| 下载源 | GitHub release | HuggingFace 官方源，**失败自动回退 `hf-mirror.com`**（本机实测 huggingface.co 直连/代理均不可达 `http=000`，镜像可达 `http=200`） | `.github/workflows/release.yml` |
| 解包 | msiexec /a | 7-Zip 两步解 bz2→tar（Windows 自带 `tar` 对 bz2 不稳），再摊平 `*.onnx`/`*.onnx.json` | 同上 |
| 语速 | `-s <wpm>`（80–450） | `--length_scale = 165/speed`，clamp 到 0.6–2.0 | `synthesize_piper_wav()` |
| 文本传入 | 命令行参数 | **stdin**（piper 从标准输入读句子），`-` 开头加空格防误判 | 同上 |
| 调用链 | `invoke('espeak_speak')` | `invoke('piper_speak')`，同一套 `playDesktopTts()` 播放/缓存层（key 前缀含命令名，两引擎互不串味） | `app/core/hooks/piper.ts`、`app/core/hooks/espeak.ts` |
| 缓存 | `app-data/caches/espeak-wav/` | `app-data/caches/piper-wav/` | Rust 侧 |
| 体积 | +12 MB | **再 +≈115 MB**（模型 110 MB + 运行时 21 MB 解包后约 45 MB，含自带 espeak-ng-data）；整包约 140 MB | — |
| CI | 仅 release.yml | release.yml 下载资源；ci.yml 只 stub 目录（`bundle.resources` glob 需非空） | 两份 workflow |

实现备忘：

- 模型目录约定：`piper_model_files()` 在 `resources/piper/voices/` 里找 `*.onnx`，**优先文件名含 `cori-high`**，config 由 `model.with_extension("onnx.json")` 推出；缺 config 直接报错（避免 piper 用默认参数乱读）。
- `ESPEAK_DATA_PATH` 指向 piper 根目录：piper 用 espeak-ng-data 做音素化，缺了会合成失败。
- 首次合成要加载 110 MB 模型（约 1–3 秒），之后走 WAV 缓存；`piperBroken` 标记保证资源缺失时不会每次都白等。
- 前端缓存上限从 160 提到 200 条（两引擎共用一套 Blob URL 缓存，key = `command|speed|text`）。
- 若将来想彻底去掉 espeak-ng（省 12 MB），只需删掉 `resources/espeak-ng` 与 `playDesktopTtsChain()` 中间那一段回退，piper 自带 espeak-ng-data 不依赖它。
- 待 CI 验证：`piper_windows_amd64.zip` 解包后 `piper.exe` 是否在根层（CI 已 `-Recurse` 查找）；7-Zip 是否在 `windows-latest` 的 `C:\Program Files\7-Zip\7z.exe`（否则走 `tar -xjf`）。

### 偏差 7：产物改为直接发 Release（不再上传 Actions artifact）——用户后续要求

用户要求（原文）：「改wolkflow，不发布那个actions里的产物，直接发release」。据此调整 `release.yml`：

| 项目 | 原设计 | 现设计 |
| --- | --- | --- |
| 产物去向 | `actions/upload-artifact`（`TypeWords-Windows`，保留 14 天）+ tag 时另发 Release | **只发 Release**，`upload-artifact` 步骤整段删除 |
| 手动触发 | `workflow_dispatch` 只出 artifact、不发 Release | `workflow_dispatch` 需填 `tag` 输入，**同样直接发 Release**（tag 不存在时由 action 基于当前提交创建） |
| tag 来源 | `Sync version from tag` 仅 tag 推送时执行，取 `github.ref_name` | job 级 `env.RELEASE_TAG: ${{ inputs.tag || github.ref_name }}`，版本同步步骤始终执行，为空则报错 |
| Release 正文 | `generate_release_notes: true`（自动生成 changelog） | 手写固定正文（下载哪个、离线说明、迁移方式、体积提示），并 `fail_on_unmatched_files: true` 保证附件缺失时构建失败 |
| 附件 | `files: out/*` | `files: out/*.exe`（只有安装包与便携 exe，不含无关文件） |

### 偏差 8：桌面发音引擎可切换 + 桌面端去掉新手教程 + 中文安装路径修复——用户后续要求

用户要求（原文）：「增加切换TTS的功能，可以在vits-piper-en_GB-cori-high和espeak-ng之间切换，而且给我去掉新手教程」。

| 项目 | 偏差 6 的状态 | 现在 | 落点 |
| --- | --- | --- | --- |
| 发音引擎顺序 | 固定 piper → espeak-ng → 系统 TTS | **用户可在设置里切换**，选中的优先，失败自动回退另一个，再回退系统 TTS | `app/core/hooks/desktop-tts.ts`（localStorage `typewords:desktop-tts-engine`）+ `sound.ts` 的 `playDesktopTtsChain()` |
| 设置页 UI | 只显示「British English」文字 | 「桌面发音引擎」下拉：`piper（en_GB-cori-high）` / `espeak-ng（en-gb）` | `app/components/setting/SoundSetting.vue` |
| 新手教程（Shepherd + 收藏引导） | 桌面端首次练习会弹出 | **桌面端完全不加载**（宿主组件不渲染，script 内的定时器与 Shepherd 初始化都加了 `isDesktop()` 守卫），网页版行为不变 | `app/pages/(words)/practice-words/[id].vue`、`app/components/word/PracticeOnboardingHost.vue` |
| 中文安装路径 | 未考虑 | `espeak-ng-data` 与临时 wav 全部搬到纯 ASCII 工作目录（`%ProgramData%\TypeWords\tts\<tag>`，退化 `%TEMP%\TypeWords-tts`），并用 `--path=` + `ESPEAK_DATA_PATH` 指过去 | `src-tauri/src/lib.rs` 的 `ascii_work_dir()` / `ensure_espeak_data()` / `temp_wav_path()` |

实现备忘：

- piper 自身读取模型不依赖单字节路径（实测中文路径下 `Loaded voice in 0.95s` 成功），失败点在它内部调用的 espeak-ng 语音学库打开 `espeak-ng-data\phontab`；因此只需要把 **espeak-ng-data 与输出 wav** 放到 ASCII 路径，模型仍可留在安装目录。
- `ESPEAK_DATA_PATH` / `--path` 的语义是「包含 `espeak-ng-data` 的父目录」：piper 传 `...\tts\piper`，espeak-ng.exe 传 `...\tts\espeak-ng`。
- 故障现场证据：手动执行 piper 时 `Error processing file 'F:\????\TypeWords\resources\piper\espeak-ng-data\phontab': Illegal byte sequence`；把 resources 拷到 `F:\tts-test` 后同一命令成功（`Real-time factor: 0.60`），据此定位为路径编码问题而非模型/资源缺失。
- PLAN 步骤 29（「验证 Shepherd 在桌面端可用」）已被本条取代：桌面端不再加载 Shepherd。
