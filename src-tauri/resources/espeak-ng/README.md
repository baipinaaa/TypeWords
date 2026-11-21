# espeak-ng 运行时（离线发音）

这个目录用于存放 espeak-ng 的 Windows 运行时（`espeak-ng.exe`、依赖 dll 与 `espeak-ng-data/`），
它们在构建时由 GitHub Actions 自动下载官方 release 的 msi 并解包填充，
**不提交到仓库**（见根目录 `.gitignore`）。

本地手动准备（`pnpm desktop:dev` 调试时需要）：

1. 下载 <https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi>
2. 解包（任选其一）：
   - `msiexec /a espeak-ng.msi /qn TARGETDIR=D:\tmp\espeak`
   - 7-Zip 直接解压 msi
3. 把解包结果里 `espeak-ng.exe` 所在目录的**全部内容**拷贝到本目录，最终结构应为：

```
src-tauri/resources/espeak-ng/
├── espeak-ng.exe
├── espeak-ng-data/
└── ...（其余 dll）
```

Rust 侧通过 `ESPEAK_DATA_PATH` 指向本目录，命令行为 `espeak-ng.exe -v en-gb -s <wpm> -w <out>.wav <text>`。
