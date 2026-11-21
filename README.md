# TypeWords 桌面版（Windows · 纯离线）

基于 [zyronon/TypeWords](https://github.com/zyronon/TypeWords) 的 Windows 桌面版分支：用 Tauri 2 把原来的网页版打包成原生应用，纯离线运行，不联网也能完整使用。

- 安装包下载：仓库的 **Releases** 页面（`-setup.exe` 为安装版，`TypeWords-portable.exe` 为免安装版）
- 构建方式、数据迁移、验收清单：[README.desktop.md](./README.desktop.md)
- 许可证：GPL-3.0（与原项目一致）

---

## 一、相对原项目的变更

### 新增

- **Windows 桌面端**：Tauri 2 外壳 + WebView2，行为与网页版一致，安装即用。
- **系统托盘**：托盘菜单提供「显示主窗口 / 退出」，关闭窗口不退出、收进托盘。
- **全局快捷键**：`Ctrl + Alt + W` 随时显示或隐藏主窗口。
- **离线发音（三级链路）**：内置 piper 神经语音 `en_GB-cori-high`（英式）→ 内置 espeak-ng `en-gb` → WebView2 系统 TTS 兜底；合成结果缓存为 WAV，重复朗读不再重新合成。
- **便携数据目录**：数据库、缓存、WebView2 用户数据全部写在程序同级的 `app-data/`，不写入 `%LOCALAPPDATA%`，整个文件夹可拷到 U 盘带走。
- **首启导入向导**：桌面端首次启动引导导入网页版「导出数据」生成的 zip/json 备份，词典、设置、练习进度一并恢复。
- **纯离线三道闸**：严格 CSP + 运行时网络守卫（拦截 `fetch`/`XHR`/`WebSocket` 的外部地址）+ 代码层短路，任何残留联网调用都不会真正发出。
- **自动关闭在线服务**：桌面模式下不注入统计脚本、不注册 Service Worker、不请求远程查词接口。
- **桌面端输入适配**：不再创建移动端软键盘用的离屏输入框，规避 WebView2 下中文输入法冻结的问题。

### 去除

- **有道发音接口**（`dict.youdao.com/dictvoice`）——改为本地合成。
- **51.LA 统计脚本**（`libs.typewords.cc/t.js`）。
- **百度翻译**：编辑文章页的「网络翻译」按钮与引擎下拉（原项目也未配置 key，线上不可用）。
- **Supabase 云同步入口**：设置页的同步页签与「跳过导出」按钮（网页版保留）。
- **侧边栏的「反馈」「文档」入口**。
- **关于页 / 帮助页的所有外链**：GitHub、微信群、问卷、打赏二维码等。
- **文档页**的网盘资源列表、下载链接与问卷。
- **单词查询弹层**里的第三方词典 `iframe`（有道 / 爱词霸）。
- **远程字体**：Google Fonts 的 Garamond 改为本地字体族。
- **移动端输入接管**逻辑（`#typing-listener` 离屏输入框）。
- **站内查词接口** `localhost/public.word/query`（桌面端直接走本地词库）。

### 保持不变

原项目的全部学习功能：词库与词典、四种练习模式（跟写 / 默写 / 听写 / 自测）、每 7 词插入默写组、错词闭环与 FSRS 复习调度、文章背诵与逐句纠错、生词本 / 错词本 / 已掌握、数据导入导出、键盘音效与提示音、深色主题与各项自定义设置。

---

## 二、构建

全部构建在 GitHub Actions 完成，本地无需安装 Rust 或编译：

- 打 tag（如 `v1.0.0`）并推送 → 自动构建 Windows 安装包并直接发布到 Release；
- 也可在 Actions 页面手动触发 `Release Desktop (Windows)`，填入要发布的 tag 名。

详见 [README.desktop.md](./README.desktop.md)。

## 三、致谢

功能与设计全部来自原项目 [zyronon/TypeWords](https://github.com/zyronon/TypeWords)，本项目只做桌面化与离线化改造。
