//! スケジューラ（実装計画 §0 不変原則1 / §4）。
//!
//! tokio の 1 秒 interval で状態機械を駆動する。時間管理は Rust 側に置き、
//! 非表示 WebView の JS タイマーのスロットリングによるズレを避ける。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::{glue, presence, state::AppState};

fn new_ticker() -> tokio::time::Interval {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    // スリープ中の未処理 tick を復帰時に連続消化しない。
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker
}

/// 毎秒 tick するバックグラウンドタスクを起動する。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = new_ticker();
        // interval の最初の tick は即時に返るため捨てて、以後ちょうど 1 秒間隔にする。
        ticker.tick().await;

        loop {
            ticker.tick().await;

            let observation = presence::sample();

            let (snap, seg_total) = {
                let state = app.state::<AppState>();
                let mut timer = state.timer.lock().unwrap();
                // update_config と同じ順序でロックし、古い設定で自動停止を戻さない。
                let enabled = state.config.lock().unwrap().auto_pause;
                timer.update_presence(enabled, observation);
                let snap = timer.tick();
                (snap, timer.segment_total_secs())
            };

            glue::broadcast(&app, &snap, seg_total);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn waking_does_not_consume_ticks_from_sleep_in_a_burst() {
        let mut ticker = new_ticker();
        ticker.tick().await;
        tokio::time::advance(Duration::from_secs(120)).await;
        ticker.tick().await;
        // 復帰直後の1回に続いて、過去の120回が即時に発火してはならない。
        assert!(
            tokio::time::timeout(Duration::from_millis(20), ticker.tick())
                .await
                .is_err()
        );
    }
}
