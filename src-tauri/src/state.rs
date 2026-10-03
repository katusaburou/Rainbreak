//! アプリ共有状態。Tauri の managed state として保持する。

use std::sync::{atomic::AtomicBool, Mutex};

use rainbreak_core::Timer;

use crate::config::AppConfig;

pub struct AppState {
    /// 時間の真実（状態機械）。
    pub timer: Mutex<Timer>,
    /// 現在の設定（永続化のキャッシュ）。
    pub config: Mutex<AppConfig>,
    /// 最後にウィンドウへ反映した自動停止状態（フェーズを変えずに退避・復帰する）。
    pub auto_pause_rendered: AtomicBool,
}
