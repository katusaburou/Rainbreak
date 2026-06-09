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
            .update_config(CycleConfig::from_minutes(cfg.work_min, cfg.break_min));
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

fn apply_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}
