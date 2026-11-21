# piper 运行时与语音模型（离线神经 TTS）

这个目录用于存放 piper（VITS 神经网络 TTS）的 Windows 运行时与英式英语模型，
构建时由 GitHub Actions 自动下载并填充，**不提交到仓库**（见根目录 `.gitignore`）。

最终目录结构（由 CI 生成）：

```
src-tauri/resources/piper/
├── piper.exe                 # rhasspy/piper 的 Windows 二进制
├── *.dll                     # onnxruntime 等依赖
├── espeak-ng-data/           # piper 做音素化时要用
└── voices/
    ├── en_GB-cori-high.onnx
    └── en_GB-cori-high.onnx.json
```

来源：

- 运行时：<https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip>
- 模型：<https://huggingface.co/4-alokk/piper-voices/resolve/main/vits-piper-en_GB-cori-high.tar.bz2>
  （国内镜像：`https://hf-mirror.com/4-alokk/piper-voices/resolve/main/...`）

本地手动准备（`pnpm desktop:dev` 调试时需要）：把上面两个压缩包分别解压到本目录与
本目录下的 `voices/`，保证 `piper.exe` 与 `voices/en_GB-cori-high.onnx` 存在即可。

Rust 侧调用形式：

```
piper.exe --model voices/en_GB-cori-high.onnx --config voices/en_GB-cori-high.onnx.json \
          --output_file <cache>.wav --length_scale <165/speed 换算>
# 待合成文本从 stdin 写入
```

若本目录缺失，应用会在本次会话内自动回退到 `resources/espeak-ng`（更轻量），
再失败则回退 WebView2 系统 TTS。
