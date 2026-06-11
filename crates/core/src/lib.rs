//! 雨やどり / Rainbreak — コアロジッククレート。
//!
//! 「時間の真実は Rust 側」という設計原則（要件 v3 §6 / 実装計画 §0）を担う、
//! Tauri に一切依存しない純粋なタイマー状態機械を提供する。秒刻みの
//! [`Timer::tick`] を呼ぶだけでフェーズが遷移するため、実時間に依存せず
//! 早送りで単体テストできる。
//!
//! Tauri 側（`src-tauri`）はこのクレートを `path` 依存で取り込み、tokio の
//! interval で 1 秒ごとに [`Timer::tick`] を駆動し、結果をイベントとして
//! WebView へ emit する。

mod phase;

pub use phase::{
    CycleConfig, Phase, TimerSnapshot, Timer, CLEARING_SECS, FINAL_CLEARING_SECS,
    INCOMING_LEAD_SECS,
};
