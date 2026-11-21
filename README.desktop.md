# TypeWords 桌面版（Tauri 2）

把 TypeWords 打包成 Windows 桌面程序：外壳用 Tauri 2（系统自带 WebView2，体积小），
前端仍是原来的 Nuxt 静态产物（SPA，`ssr: false`），数据继续存在 IndexedDB 里，
只是**数据目录改到程序旁边的 `app-data/`**，可以整体拷贝迁移。

> 本仓库未提交任何构建产物与二进制图标；Windows 安装包全部由 GitHub Actions 产出。

---

## 1. 目录结构

```
TypeWords/
├── app/                      # 原有前端（少量桌面适配）
│   ├── core/utils/desktop.ts          # isDesktop() / openExternal() / umami stub
│   ├── core/hooks/espeak.ts           # 离线发音公共层（WAV blob 缓存/播放）
│   ├── core/hooks/piper.ts            # 离线神经语音 piper（en_GB-cori-high）
│   ├── core/hooks/desktop-data.ts     # 备份文件校验 + 本地落库（无 Supabase）
│   ├── core/hooks/espeak.ts           # 离线发音：调用 Rust 侧 espeak-ng，播放 WAV blob
│   ├── components/desktop/DesktopDataImportWizard.vue  # 首启数据导入向导
│   └── plugins/05.desktop.client.ts   # 桌面端插件：统计 stub、离线守卫、手动导入入口
├── src-tauri/                # Tauri 工程（Rust）
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json       # appDirectoriesOverride: "./app-data"
│   ├── capabilities/default.json
│   ├── icons/                # 空目录，图标在 CI 里用 pnpm tauri icon 生成
│   ├── resources/espeak-ng/  # espeak-ng 运行时（CI 下载解包，不入库）
│   ├── resources/piper/      # piper 运行时 + en_GB-cori-high 模型（CI 下载，不入库）
│   └── src/{main.rs,lib.rs}  # 托盘图标 + 全局快捷键 + espeak_speak / piper_speak 命令
└── .github/workflows/
    ├── release.yml           # 打 tag 出 Windows 安装包
    └── ci.yml                # 前端静态产物 + Rust 编译检查
```

## 2. 怎么构建（推荐：GitHub Actions）

### 2.1 出安装包

1. 把仓库推到 GitHub（需包含 `src-tauri/` 与 `.github/workflows/`）。
2. 打一个 tag 并推送：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. `.github/workflows/release.yml` 会在 `windows-latest` 上：

   - `pnpm install --no-frozen-lockfile`
   - 用 tag 号覆盖 `src-tauri/tauri.conf.json` 的 `version`
   - `pnpm desktop:icon`（从 `public/favicon.ico` 生成 `src-tauri/icons/*`）
   - `pnpm desktop:build` → `tauri build`
   - 收集 `*-setup.exe` 与裸 `typewords.exe`（重命名为 `TypeWords-portable.exe`）
   - **直接发布到 GitHub Release**（`softprops/action-gh-release`），不再上传 Actions artifact

4. 也可以在 Actions 页面手动 `Run workflow`（`workflow_dispatch`），填一个 tag 名（如 `v1.0.0-rc1`，
   不存在时会基于当前提交创建），同样直接发布为 Release 附件。

前两次跑会比较慢（Rust 依赖要编译 10~20 分钟），之后有 `swatinem/rust-cache` 缓存会快很多。

### 2.2 只做快速体检

`.github/workflows/ci.yml` 的 `web-build` job 只跑 `pnpm generate` 并校验 `dist/` 里的
`dicts/ list/ sound/ libs/ imgs/` 是否齐全；`rust-check` job 跑 `cargo check` + `cargo clippy`。
推 PR 或手动触发都会跑。

### 2.3 本地开发（可选，需要 Rust + pnpm）

```bash
pnpm install
pnpm desktop:dev     # 起 nuxt dev(5567) + tauri dev 窗口
pnpm desktop:build   # 本地出安装包（需要 NSIS，Tauri 会自动下载）
```

仅调试前端时不需要 Rust，直接 `pnpm dev` 即可（浏览器里 `isDesktop()` 返回 false，走原网页逻辑）。

## 3. 产物说明

| 文件 | 说明 |
| --- | --- |
| `TypeWords_<version>_x64-setup.exe` | NSIS 安装包，按当前用户安装（`installMode: currentUser`），无需管理员权限 |
| `TypeWords-portable.exe` | 裸可执行文件，与 `app-data/` 同目录即可绿色运行 |

体积基线：裸 exe ≈ 8–12 MB（Rust + 前端静态资源 14 MB 已内嵌），加上内置发音资源后
（`espeak-ng` ≈ 12 MB + `piper` + `en_GB-cori-high` ≈ 115 MB）整体约 140 MB；NSIS 安装包
压缩后约 130–150 MB。首次安装需要 WebView2
（`webviewInstallMode: downloadBootstrapper`，Win10 1803+ 通常已预装，缺失时安装器会自动下载）。

## 4. 数据目录（便携）

`src-tauri/tauri.conf.json` 里设置了：

```json
{ "app": { "appDirectoriesOverride": "./app-data" } }
```

效果：WebView2 的 User Data（含 IndexedDB）、缓存、日志都落在 **exe 同级的 `app-data/`**，
不再写入 `%LOCALAPPDATA%`。想清空数据就直接删这个目录（关掉程序后删）。

> 注意：`app-data/` 里的 `EBWebView/` 是 Chromium 缓存，体积会随使用增长（几十 MB 级），
> 迁移到 U 盘时建议先关程序再拷贝。

## 5. 从网页版迁移数据

桌面版首次启动会弹「导入网页版数据」向导（也可以从控制台 `__TYPEWORDS_OPEN_IMPORT__()` 手动打开）：

1. 网页版 → 设置 → 数据管理 → 导出数据，得到 `TypeWords-User-Data-*.zip`（或 `.json`）。
2. 桌面版向导里选中这个文件。
3. 向导会显示将导入的内容（词典数量、已缓存词条、文章书、练习进度、设置）并提示会覆盖当前数据。
4. 确认导入 → 写入本地 IndexedDB → 自动刷新。

zip 里若带 `mp3/` 目录（自定义文章音频），会一并导入。

之后在桌面版「设置 → 数据管理」里也可以继续用原来的导出/导入按钮做本地备份。

## 6. 桌面端的行为差异

| 项目 | 网页版 | 桌面版 |
| --- | --- | --- |
| 云同步（Supabase） | 设置页 Tab「数据同步」 | **入口隐藏**（代码保留，未配置时本就是 no-op） |
| 统计（umami） | 注入 `t.js` 上报 | **不注入**，`window.umami` 是 no-op stub |
| Service Worker | 注册 `/service-worker.js` | 不注册（自定义协议下也不支持） |
| 外链 / `window.open` | 新标签页 | **一律不打开**，只弹「桌面版为离线版本」提示 |
| 外链入口（侧边栏「反馈」「文档」、右键菜单「语法分析」「有道翻译」、社交渠道图标、浏览器插件排查、Supabase 文档链接） | 显示 | **入口本身不渲染**（`v-if="!desktop"` / 条件展开），页面里看不到这些链接 |
| 第三方词典 iframe（有道/金山） | 内嵌 iframe 查词 | **不渲染**，未收录时提示离线不可查 |
| 远程字体（fonts.gstatic.com） | 加载 Garamond | 改为 `local()` 回退系统衬线字体，零请求 |
| 单词发音 | 有道 `dictvoice` 在线音频（美音/英音可选） | **内置 piper（en_GB-cori-high）神经语音离线合成**，失败回退 espeak-ng，零联网 |
| 发音音调选择 | 设置里可选美音/英音 | **选择器隐藏**，桌面版固定英式（en-GB） |
| 小程序推广 / IE 提示 | 显示 | 隐藏 |
| 百度网络翻译 | 按钮存在（但 appid/key 从未配置，实为不可用） | 按钮与引擎下拉**已摘除**，保留「拆分句子」与手动翻译 |
| 移动端离屏输入框 | 创建 | **不创建**（规避 WebView2 的 IME/TSF 冻结问题） |
| 关闭窗口 | — | 隐藏到托盘；托盘菜单「退出」才真正退出 |
| 全局快捷键 | — | `Ctrl + Alt + W` 显示/隐藏主窗口 |

发音：单词发音与例句朗读**全部在本地合成**，三级优先级：
1. **piper + `en_GB-cori-high`**（VITS 神经语音，自然人声，英式）—— `src-tauri/resources/piper`
2. **espeak-ng**（机械音但极轻量，英式 `-v en-gb`）—— `src-tauri/resources/espeak-ng`
3. WebView2 系统 `speechSynthesis`（仅在两者都缺失时兜底）

语速跟随设置里的「速度」滑块（piper 映射到 `--length_scale`，espeak 映射到 `-s`，基准 165 wpm），
完全离线、不依赖系统语音包。

### 离线发音链路

```
app/core/hooks/sound.ts  useTTsPlayAudio()
   └─ playDesktopTtsChain()
        ├─ piper.ts  playPiper()  ─→ invoke('piper_speak', { text, speed })
        │     └─ src-tauri/src/lib.rs  piper_speak()          // spawn_blocking
        │          └─ piper.exe --model voices/en_GB-cori-high.onnx \
        │                      --config voices/en_GB-cori-high.onnx.json \
        │                      --output_file <cache>.wav --length_scale <165/speed>
        │                      （文本从 stdin 写入）
        ├─ espeak.ts  playEspeak() ─→ invoke('espeak_speak', { text, speed })
        │     └─ espeak-ng.exe -v en-gb -s <speed> -w <cache>.wav <text>
        │          └─ ESPEAK_DATA_PATH=<resources/espeak-ng>
        └─ playWithSpeechSynthesis()                              // 最后兜底
   └─ 返回 WAV 字节（tauri::ipc::Response::new）→ Blob URL 缓存 → <audio> 播放
```

- WAV 分别落在 `app-data/caches/piper-wav/<hash>.wav` 与 `app-data/caches/espeak-wav/<hash>.wav`，
  同一段文本第二次播放直接读缓存。
- piper 首次合成需要加载 110 MB 模型（约 1–3 秒），之后走缓存；应用启动时会在后台用
  `piper_warmup()` 跑一次合成做预热（把模型送进系统文件缓存），失败静默忽略。
  加载失败只会退化一次，本次会话内不再尝试 piper，直接走 espeak-ng。
- 两者都失败时回退到 WebView2 的 `speechSynthesis`，控制台打印 `[desktop-tts]` / `[piper]`。
- 网页版完全不受影响：`isEspeakAvailable()` 在非 Tauri 环境恒为 `false`，走的还是原来的系统 TTS。

### 零联网保证（三道闸）

1. **CSP**（`src-tauri/tauri.conf.json` → `app.security.csp`）：`default-src 'self'` + `frame-src 'none'`，
   任何远程脚本/样式/图片/媒体/字体/连接都会被 WebView2 直接拒绝。
2. **运行时守卫**（`app/plugins/05.desktop.client.ts` 的 `installOfflineGuard`）：劫持
   `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`，外部地址一律阻断并 `console.warn`
   （便于定位漏网的调用点）。
3. **代码层短路**：不注入 `t.js`（51.LA）、不注册 Service Worker、查词接口直接返回空、
   发音走本地 espeak-ng、外链只提示。

验证方式：打开 DevTools（`Ctrl+Shift+I` 在打包版被禁用时，可用系统代理或抓包工具）确认
除 `http://tauri.localhost` 之外没有任何出站请求。

## 7. 手工验收清单

装完包后按这个顺序过一遍（脚本无法覆盖的部分）：

- [ ] 干净 Win10 1803+ / Win11 上安装后能启动主窗口
- [ ] 深链不 404：直接打开 `http://tauri.localhost/words`、`/practice-words/<id>`、`/setting`
- [ ] `app-data/EBWebView` 生成，`%LOCALAPPDATA%` 下没有新增 TypeWords 目录
- [ ] 关闭再启动，词典选择/学习进度/练习缓存都在
- [ ] 首启导入向导能用网页版导出的 zip 完整恢复数据
- [ ] 跟写/默写/听写/自测四种模式各跑一组，跟写每 7 词插入的默写组正常，结算后 `fsrsData` 落库
- [ ] 中文输入法在练习输入框里不卡死（重点回归项）
- [ ] 单词发音是英式神经语音（piper cori-high），例句朗读同样有声，断网仍可用；调节语速滑块后语速跟着变
- [ ] `app-data/caches/piper-wav/` 与 `app-data/caches/espeak-wav/` 下生成了 wav 缓存文件
- [ ] `goYoudao` 等外链点击后只弹「离线」提示，不打开浏览器、不留空白窗口
- [ ] 页面里看不到外链入口：侧边栏无「反馈」「文档」，文档页只说离线、练习右键菜单无「语法分析/有道翻译」、帮助页无问卷/群二维码、设置页无 Supabase
- [ ] 托盘「显示主窗口 / 退出」正常，`Ctrl+Alt+W` 能切出窗口
- [ ] 把 `TypeWords-portable.exe` + `app-data/` 拷到另一台机器，数据随行

## 8. 已知问题

- **IME**：Tauri 在 Windows 上的中文输入依赖 WebView2 的 TSF 集成，历史上出现过「首次聚焦输入框卡死」
  （tauri#15436）。本项目已通过「不创建离屏 input」规避，但若仍有异常，先在设置里切换「输入模式」再试。
- **自定义协议 + Service Worker**：Tauri 自定义协议下 SW 不可用（tauri#12214），本项目不使用 SW，无影响。
- **图标**：仓库里没有提交二进制图标，`src-tauri/icons/` 为空时 `cargo check` 会失败，
  所以 CI 一定会先跑 `pnpm desktop:icon`。本地开发同理。
- **自动更新**：暂未接入（P2）。升级方式：下载新 exe 覆盖，保留 `app-data/`。
