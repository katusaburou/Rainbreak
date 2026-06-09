//! アプリ共有状態。Tauri の managed state として保持する。

use std::sync::Mutex;

use rainbreak_core::Timer;

use crate::config::AppConfig;

pub struct AppState {
    /// 時間の真実（状態機械）。
    pub timer: Mutex<Timer>,
    /// 現在の設定（永続化のキャッシュ）。
    pub config: Mutex<AppConfig>,
}
