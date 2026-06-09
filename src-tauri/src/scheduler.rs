//! スケジューラ（実装計画 §0 不変原則1 / §4）。
//!
//! tokio の 1 秒 interval で状態機械を駆動する。時間管理は Rust 側に置き、
//! 非表示 WebView の JS タイマーのスロットリングによるズレを避ける。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::{glue, state::AppState};

/// 毎秒 tick するバックグラウンドタスクを起動する。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        // interval の最初の tick は即時に返るため捨てて、以後ちょうど 1 秒間隔にする。
        ticker.tick().await;

        loop {
            ticker.tick().await;

            let (snap, seg_total) = {
                let state = app.state::<AppState>();
                let mut timer = state.timer.lock().unwrap();
                let snap = timer.tick();
                (snap, timer.segment_total_secs())
            };

            glue::broadcast(&app, &snap, seg_total);
        }
    });
}
