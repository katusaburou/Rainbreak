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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            work_min: 20,
            break_min: 5,
            volume: 0.6,
            muted: false,
            autostart: false,
        }
    }
}

impl AppConfig {
    /// 不正値を実用範囲へクランプする。
    pub fn sanitized(mut self) -> Self {
        self.work_min = self.work_min.clamp(1, 180);
        self.break_min = self.break_min.clamp(1, 60);
        self.volume = self.volume.clamp(0.0, 1.0);
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
