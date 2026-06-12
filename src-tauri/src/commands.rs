//! フロント → Rust のコマンド（実装計画 §3.3）と、トレイから呼ぶ補助関数。

use rainbreak_core::CycleConfig;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{self, AppConfig};
use crate::glue;
use crate::state::AppState;

/// 現在状態（フェーズ遷移なし）を即時配信する。pause/resume/config 更新後に使う。
fn broadcast_current(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (snap, seg) = {
        let timer = state.timer.lock().unwrap();
        (timer.current(), timer.segment_total_secs())
    };
    glue::broadcast(app, &snap, seg);
}

/// Skip 実行（トレイ／グローバル Esc から共用）。
pub fn do_skip(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (snap, seg) = {
        let mut timer = state.timer.lock().unwrap();
        (timer.skip(), timer.segment_total_secs())
    };
    glue::broadcast(app, &snap, seg);
}

/// セッションをやり直す（セット終了画面の「もう一度」／トレイから共用）。
pub fn do_restart(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (snap, seg) = {
        let mut timer = state.timer.lock().unwrap();
        (timer.restart(), timer.segment_total_secs())
    };
    glue::broadcast(app, &snap, seg);
}

/// 一時停止 / 再開のトグル（トレイから）。
pub fn toggle_pause(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut timer = state.timer.lock().unwrap();
        let paused = timer.paused();
        timer.set_paused(!paused);
    }
    broadcast_current(app);
}

#[tauri::command]
pub fn skip_break(app: AppHandle) {
    do_skip(&app);
}

/// セット終了画面の「もう一度」: セッションをセット 1 の作業からやり直す。
#[tauri::command]
pub fn restart_session(app: AppHandle) {
    do_restart(&app);
}

#[tauri::command]
pub fn pause(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        state.timer.lock().unwrap().set_paused(true);
    }
    broadcast_current(&app);
}

#[tauri::command]
pub fn resume(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        state.timer.lock().unwrap().set_paused(false);
    }
    broadcast_current(&app);
}

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_config(app: AppHandle, cfg: AppConfig) {
    let cfg = cfg.sanitized();
    config::save(&app, &cfg);
    {
        let state = app.state::<AppState>();
        state
            .timer
            .lock()
            .unwrap()
            .update_config(CycleConfig::from_minutes(cfg.work_min, cfg.break_min).with_sets(cfg.sets));
        *state.config.lock().unwrap() = cfg.clone();
    }
    apply_autostart(&app, cfg.autostart);
    let _ = app.emit("config-changed", cfg);
    broadcast_current(&app);
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// 画面キャプチャ（モードB）: overlay が覆うモニタの現在表示を JPEG data URL で返す。
///
/// 雨ガラスの屈折元背景として「いまのデスクトップ」を使うためのもの。
/// overlay / hud は `windows::init` で SetWindowDisplayAffinity により
/// キャプチャから除外済みなので、雨自身は写り込まない（Windows）。
#[tauri::command]
pub async fn capture_screen(app: AppHandle) -> Result<String, String> {
    // overlay の位置からキャプチャ対象モニタを決める（取得できなければ主モニタ）。
    let pos = app
        .get_webview_window("overlay")
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y));
    // キャプチャ＋エンコードは数十 ms 級のブロッキング処理なので専用スレッドへ。
    tauri::async_runtime::spawn_blocking(move || capture_jpeg_data_url(pos))
        .await
        .map_err(|e| e.to_string())?
}

/// モニタをキャプチャし、縮小＋JPEG 化して data URL にする。
///
/// 背景はぼかし屈折の元にしかならないため、幅 1600px までの縮小と JPEG q78 で
/// 転送（IPC 文字列）とデコードを軽くする（2.5 秒間隔の定期更新を想定）。
fn capture_jpeg_data_url(pos: Option<(i32, i32)>) -> Result<String, String> {
    use base64::Engine as _;
    use image::imageops::FilterType;

    const MAX_WIDTH: u32 = 1600;
    const JPEG_QUALITY: u8 = 78;

    let monitor = pick_monitor(pos)?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    let dynamic = image::DynamicImage::ImageRgba8(img);
    // JPEG はアルファ非対応なので RGB 化（デスクトップ画像は元々不透明）。
    let rgb = if w > MAX_WIDTH {
        let nh = ((h as u64 * MAX_WIDTH as u64) / w.max(1) as u64).max(1) as u32;
        dynamic
            .resize_exact(MAX_WIDTH, nh, FilterType::Triangle)
            .to_rgb8()
    } else {
        dynamic.to_rgb8()
    };

    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&jpeg)
    ))
}

/// 指定座標を含むモニタ → 主モニタ → 最初のモニタ、の順で選ぶ。
fn pick_monitor(pos: Option<(i32, i32)>) -> Result<xcap::Monitor, String> {
    if let Some((x, y)) = pos {
        if let Ok(m) = xcap::Monitor::from_point(x, y) {
            return Ok(m);
        }
    }
    let mut monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("モニタが見つかりません".into());
    }
    let idx = monitors
        .iter()
        .position(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(0);
    Ok(monitors.swap_remove(idx))
}

#[cfg(test)]
mod tests {
    /// 実ディスプレイのある開発機での疎通確認（ヘッドレス環境では失敗し得る）。
    #[test]
    fn capture_returns_jpeg_data_url() {
        let url = super::capture_jpeg_data_url(None).expect("display capture should succeed");
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(url.len() > 10_000, "captured image should not be trivially small");
    }
}

fn apply_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}
