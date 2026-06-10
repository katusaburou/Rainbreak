//! 設定の永続化（実装計画 §9）。
//!
//! 項目は最小（要件 §3.6）: 作業/休憩分・音量・ミュート・自動起動。
//! OS の設定ディレクトリに JSON で保存する。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub work_min: u32,
    pub break_min: u32,
    /// 0.0..=1.0
    pub volume: f32,
    pub muted: bool,
    pub autostart: bool,
    /// HUD バーの不透明度 0.1..=1.0（旧設定ファイルには無いので default で補う）。
    #[serde(default = "default_hud_opacity")]
    pub hud_opacity: f32,
}

fn default_hud_opacity() -> f32 {
    1.0
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            work_min: 20,
            break_min: 5,
            volume: 0.6,
            muted: false,
            autostart: false,
            hud_opacity: default_hud_opacity(),
        }
    }
}

impl AppConfig {
    /// 不正値を実用範囲へクランプする。
    pub fn sanitized(mut self) -> Self {
        self.work_min = self.work_min.clamp(1, 180);
        self.break_min = self.break_min.clamp(1, 60);
        self.volume = self.volume.clamp(0.0, 1.0);
        // 0 だとバーが行方不明になるため下限 0.1。
        self.hud_opacity = self.hud_opacity.clamp(0.1, 1.0);
        self
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

/// 設定を読み込む。無ければ既定値。
pub fn load(app: &AppHandle) -> AppConfig {
    let Some(path) = config_path(app) else {
        return AppConfig::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<AppConfig>(&text)
            .map(AppConfig::sanitized)
            .unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

/// 設定を保存する。
pub fn save(app: &AppHandle, cfg: &AppConfig) {
    let Some(path) = config_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(&path, text);
    }
}

// ---- UI 状態（HUD のドラッグ位置・サイズ） ----
//
// ユーザー設定（AppConfig / config.json）とは別ファイルに分ける。
// AppConfig は設定画面の update_config で丸ごと上書きされるため、
// そこに混ぜると設定変更のたびに HUD 位置が消える。
// 移動とリサイズの同時発火で互いを上書きしないよう、最新値の保持と
// デバウンス保存は windows 側が一本化し、ここは入出力だけを担う。

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct UiState {
    /// HUD 左上の物理ピクセル座標。
    #[serde(default)]
    pub hud_pos: Option<(i32, i32)>,
    /// HUD の物理ピクセルサイズ。
    #[serde(default)]
    pub hud_size: Option<(u32, u32)>,
}

fn ui_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("ui-state.json"))
}

/// 保存済みの UI 状態（無ければ既定値 → HUD は右下・既定サイズ）。
pub fn load_ui_state(app: &AppHandle) -> UiState {
    let Some(path) = ui_state_path(app) else {
        return UiState::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// UI 状態を保存する（移動／リサイズのデバウンス後に呼ばれる）。
pub fn save_ui_state(app: &AppHandle, state: UiState) {
    let Some(path) = ui_state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(&path, text);
    }
}
