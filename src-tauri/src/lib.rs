use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::ipc::Response;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const MAIN_LABEL: &str = "main";
const TOGGLE_SHORTCUT: &str = "ctrl+alt+w";

/// 桌面版离线发音：内置 espeak-ng，固定英式英语（en-gb）
const ESPEAK_VOICE: &str = "en-gb";
const ESPEAK_DEFAULT_SPEED: i32 = 165;
const ESPEAK_MAX_CHARS: usize = 4000;

/// 桌面版离线发音（高质量）：内置 piper（VITS 神经网络 TTS），英式英语 en_GB-cori-high
const PIPER_VOICE: &str = "piper-en_GB-cori-high";
const PIPER_DEFAULT_SPEED: i32 = 165;
const PIPER_MAX_CHARS: usize = 4000;
/// piper 的语速参数：length_scale 越小越快
const PIPER_MIN_LENGTH_SCALE: f32 = 0.6;
const PIPER_MAX_LENGTH_SCALE: f32 = 2.0;

fn espeak_root(app: &AppHandle) -> Result<PathBuf, String> {    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join("espeak-ng"));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("espeak-ng"),
    );
    for dir in candidates {
        if dir.join("espeak-ng.exe").exists() {
            return Ok(dir);
        }
    }
    Err("未找到内置的 espeak-ng 运行时（resources/espeak-ng）".to_string())
}

/// espeak-ng / piper 内部用单字节 fopen 打开 data 文件与输出文件，路径含非英文字符时会报
/// `Error processing file '...\phontab': Illegal byte sequence`。这里不做任何复制，
/// 直接校验路径并要求安装到纯英文目录（用户自行决定安装位置）。
fn require_ascii(path: &Path, what: &str) -> Result<(), String> {
    if path.to_string_lossy().is_ascii() {
        Ok(())
    } else {
        Err(format!(
            "{what} 路径含非英文字符，离线发音要求把程序安装到纯英文路径：{}",
            path.display()
        ))
    }
}

/// 语音链路的诊断日志：写到 `<app_cache_dir>/tts.log`，一次性回答
/// 「前端到底有没有调用合成、失败在哪一步」。最多保留最近 200KB。
fn tts_log(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_cache_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("tts.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 200 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{secs}] {line}");
    }
}

fn tts_preview(text: &str) -> String {
    let mut preview: String = text.chars().take(48).collect();
    if text.chars().count() > 48 {
        preview.push('…');
    }
    preview
}

/// 合成中间文件路径（唯一名，避免并发互相覆盖）
fn temp_wav_path(dir: &Path, tag: &str, key: u64) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    dir.join(format!("{tag}-{key:016x}-{nanos}.wav"))
}

fn wav_cache_key(text: &str, speed: i32) -> u64 {
    let mut hasher = DefaultHasher::new();
    ESPEAK_VOICE.hash(&mut hasher);
    speed.hash(&mut hasher);
    text.hash(&mut hasher);
    hasher.finish()
}

fn synthesize_wav(
    root: &Path,
    data_dir: &Path,
    work: &Path,
    text: &str,
    speed: i32,
    out_wav: &Path,
) -> Result<(), String> {
    // 文本以 '-' 开头时会被 espeak-ng 当成命令行选项，前置一个空格规避
    let payload = if text.starts_with('-') {
        format!(" {text}")
    } else {
        text.to_string()
    };
    // 参数与输出路径全部由安装目录提供：espeak-ng 内部用单字节 fopen 打开路径
    // ESPEAK_DATA_PATH / --path 的语义是「包含 espeak-ng-data 的父目录」
    let data_home = data_dir.parent().unwrap_or(data_dir);
    let output = Command::new(root.join("espeak-ng.exe"))
        .arg(format!("--path={}", data_home.display()))
        .arg("-v")
        .arg(ESPEAK_VOICE)
        .arg("-s")
        .arg(speed.to_string())
        .arg("-w")
        .arg(out_wav)
        .arg(&payload)
        .env("ESPEAK_DATA_PATH", data_home)
        .current_dir(work)
        .output()
        .map_err(|err| format!("启动 espeak-ng 失败: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("espeak-ng 退出码 {:?}: {stderr}", output.status.code()));
    }
    if !out_wav.exists() {
        return Err("espeak-ng 未生成音频文件".to_string());
    }
    Ok(())
}

/// 合成语音并直接返回 WAV 字节（前端用 Blob 播放，不落盘到用户可见目录）
#[tauri::command]
async fn espeak_speak(
    app: AppHandle,
    text: String,
    speed: Option<i32>,
) -> Result<Response, String> {
    let mut text = text.trim().to_string();
    if text.is_empty() {
        return Err("文本为空".to_string());
    }
    if text.chars().count() > ESPEAK_MAX_CHARS {
        text = text.chars().take(ESPEAK_MAX_CHARS).collect();
    }
    let speed = speed
        .unwrap_or(ESPEAK_DEFAULT_SPEED)
        .clamp(80, 450);
    tts_log(
        &app,
        &format!("espeak call speed={speed} text={}", tts_preview(&text)),
    );

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("无法定位缓存目录: {err}"))?
        .join("espeak-wav");
    std::fs::create_dir_all(&cache_dir).map_err(|err| format!("创建缓存目录失败: {err}"))?;

    let cache_key = wav_cache_key(&text, speed);
    let wav_path = cache_dir.join(format!("{cache_key:016x}.wav"));
    if wav_path.exists() {
        if let Ok(bytes) = std::fs::read(&wav_path) {
            if !bytes.is_empty() {
                return Ok(Response::new(bytes));
            }
        }
    }

    let root = espeak_root(&app)?;
    let data_dir = root.join("espeak-ng-data");
    require_ascii(&data_dir, "espeak-ng-data")?;
    require_ascii(&cache_dir, "发音缓存目录")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let tmp_wav = temp_wav_path(&cache_dir, "espeak", cache_key);
        synthesize_wav(&root, &data_dir, &cache_dir, &text, speed, &tmp_wav)?;
        let bytes = std::fs::read(&tmp_wav).map_err(|err| format!("读取音频失败: {err}"))?;
        if bytes.is_empty() {
            let _ = std::fs::remove_file(&tmp_wav);
            return Err("espeak-ng 输出为空".to_string());
        }
        if std::fs::rename(&tmp_wav, &wav_path).is_err() {
            let _ = std::fs::copy(&tmp_wav, &wav_path);
            let _ = std::fs::remove_file(&tmp_wav);
        }
        Ok::<Vec<u8>, String>(bytes)
    })
    .await;
    let bytes = match bytes {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(err)) => {
            tts_log(&app, &format!("espeak fail: {err}"));
            return Err(err);
        }
        Err(err) => {
            let message = format!("语音合成任务异常: {err}");
            tts_log(&app, &format!("espeak fail: {message}"));
            return Err(message);
        }
    };
    tts_log(&app, &format!("espeak ok bytes={}", bytes.len()));

    Ok(Response::new(bytes))
}

fn piper_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join("piper"));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("piper"),
    );
    for dir in candidates {
        if dir.join("piper.exe").exists() {
            return Ok(dir);
        }
    }
    Err("未找到内置的 piper 运行时（resources/piper）".to_string())
}

/// 在 `voices/` 下找模型：优先 cori-high，其次任意 onnx
fn piper_model_files(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let voices = root.join("voices");
    let mut fallback: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&voices) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("onnx") {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if name.contains("cori-high") {
                fallback = Some(path);
                break;
            }
            if fallback.is_none() {
                fallback = Some(path);
            }
        }
    }
    let model = fallback.ok_or_else(|| "未找到 piper 语音模型（resources/piper/voices/*.onnx）".to_string())?;
    let config = model.with_extension("onnx.json");
    if !config.exists() {
        return Err(format!("缺少模型配置 {}", config.display()));
    }
    Ok((model, config))
}

fn piper_cache_key(text: &str, speed: i32) -> u64 {
    let mut hasher = DefaultHasher::new();
    PIPER_VOICE.hash(&mut hasher);
    speed.hash(&mut hasher);
    text.hash(&mut hasher);
    hasher.finish()
}

fn synthesize_piper_wav(
    root: &Path,
    data_dir: &Path,
    work: &Path,
    model: &Path,
    config: &Path,
    text: &str,
    speed: i32,
    out_wav: &Path,
) -> Result<(), String> {
    // espeak 的 -s 是 wpm，piper 的 length_scale 越小越快，这里按 165wpm≈1.0 换算
    let length_scale = ((PIPER_DEFAULT_SPEED as f32) / (speed.max(1) as f32))
        .clamp(PIPER_MIN_LENGTH_SCALE, PIPER_MAX_LENGTH_SCALE);
    let data_home = data_dir.parent().unwrap_or(data_dir);

    let mut child = Command::new(root.join("piper.exe"))
        .arg("--model")
        .arg(model)
        .arg("--config")
        .arg(config)
        .arg("--output_file")
        .arg(out_wav)
        .arg("--length_scale")
        .arg(format!("{length_scale:.3}"))
        // piper 自己**不读** ESPEAK_DATA_PATH，必须显式 --espeak_data；
        // 它把这个值直接交给 espeak_Initialize（即 espeak-ng-data 目录本身）
        .arg("--espeak_data")
        .arg(data_dir)
        .env("ESPEAK_DATA_PATH", data_home)
        .current_dir(work)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动 piper 失败: {err}"))?;

    // piper 从 stdin 读取待合成文本，写完后关闭管道即表示输入结束
    if let Some(mut stdin) = child.stdin.take() {
        let payload = if text.starts_with('-') {
            format!(" {text}\n")
        } else {
            format!("{text}\n")
        };
        stdin
            .write_all(payload.as_bytes())
            .map_err(|err| format!("写入 piper 输入失败: {err}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 piper 结束失败: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("piper 退出码 {:?}: {stderr}", output.status.code()));
    }
    if !out_wav.exists() {
        return Err("piper 未生成音频文件".to_string());
    }
    Ok(())
}

/// 用内置 piper 模型合成语音并返回 WAV 字节
#[tauri::command]
async fn piper_speak(app: AppHandle, text: String, speed: Option<i32>) -> Result<Response, String> {
    let mut text = text.trim().to_string();
    if text.is_empty() {
        return Err("文本为空".to_string());
    }
    if text.chars().count() > PIPER_MAX_CHARS {
        text = text.chars().take(PIPER_MAX_CHARS).collect();
    }
    let speed = speed.unwrap_or(PIPER_DEFAULT_SPEED).clamp(80, 450);
    tts_log(
        &app,
        &format!("piper call speed={speed} text={}", tts_preview(&text)),
    );

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("无法定位缓存目录: {err}"))?
        .join("piper-wav");
    std::fs::create_dir_all(&cache_dir).map_err(|err| format!("创建缓存目录失败: {err}"))?;

    let cache_key = piper_cache_key(&text, speed);
    let wav_path = cache_dir.join(format!("{cache_key:016x}.wav"));
    if wav_path.exists() {
        if let Ok(bytes) = std::fs::read(&wav_path) {
            if !bytes.is_empty() {
                return Ok(Response::new(bytes));
            }
        }
    }

    let root = piper_root(&app)?;
    let data_dir = root.join("espeak-ng-data");
    require_ascii(&data_dir, "piper 的 espeak-ng-data")?;
    require_ascii(&cache_dir, "发音缓存目录")?;
    let (model, config) = piper_model_files(&root)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let tmp_wav = temp_wav_path(&cache_dir, "piper", cache_key);
        synthesize_piper_wav(
            &root, &data_dir, &cache_dir, &model, &config, &text, speed, &tmp_wav,
        )?;
        let bytes = std::fs::read(&tmp_wav).map_err(|err| format!("读取音频失败: {err}"))?;
        if bytes.is_empty() {
            let _ = std::fs::remove_file(&tmp_wav);
            return Err("piper 输出为空".to_string());
        }
        if std::fs::rename(&tmp_wav, &wav_path).is_err() {
            let _ = std::fs::copy(&tmp_wav, &wav_path);
            let _ = std::fs::remove_file(&tmp_wav);
        }
        Ok::<Vec<u8>, String>(bytes)
    })
    .await;
    let bytes = match bytes {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(err)) => {
            tts_log(&app, &format!("piper fail: {err}"));
            return Err(err);
        }
        Err(err) => {
            let message = format!("语音合成任务异常: {err}");
            tts_log(&app, &format!("piper fail: {message}"));
            return Err(message);
        }
    };
    tts_log(&app, &format!("piper ok bytes={}", bytes.len()));

    Ok(Response::new(bytes))
}

/// 启动后在后台跑一次合成，把 110MB 模型送进系统文件缓存，
/// 用户真正第一次点发音时能少等一些（失败静默忽略，不影响启动）。
fn piper_warmup(app: &AppHandle) {
    let root = match piper_root(app) {
        Ok(root) => root,
        Err(_) => return,
    };
    let (model, config) = match piper_model_files(&root) {
        Ok(files) => files,
        Err(_) => return,
    };
    let data_dir = root.join("espeak-ng-data");
    if require_ascii(&data_dir, "piper 的 espeak-ng-data").is_err() {
        return;
    }
    let Ok(work) = app
        .path()
        .app_cache_dir()
        .map(|dir| dir.join("piper-wav"))
    else {
        return;
    };
    if std::fs::create_dir_all(&work).is_err() {
        return;
    }
    let wav = temp_wav_path(&work, "warmup", 0);
    if synthesize_piper_wav(
        &root,
        &data_dir,
        &work,
        &model,
        &config,
        "ok",
        PIPER_DEFAULT_SPEED,
        &wav,
    )
    .is_ok()
    {
        let _ = std::fs::remove_file(&wav);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("TypeWords")
        .menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![espeak_speak, piper_speak])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            setup_tray(app)?;
            // 后台预热 piper 模型，让用户第一次点发音时不用等 110MB 模型加载
            let handle = app.handle().clone();
            let _ = tauri::async_runtime::spawn_blocking(move || piper_warmup(&handle));
            app.handle().global_shortcut().register(TOGGLE_SHORTCUT)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_LABEL {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
