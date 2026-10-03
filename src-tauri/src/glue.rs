//! Rust コア（状態機械）→ WebView へのイベント送出と、フェーズ遷移時の
//! ウィンドウ／ショートカット／トレイ反映を一箇所に集約する。
//!
//! スケジューラ（毎秒の tick）と各コマンド（skip/pause 等）の双方がここを
//! 通すことで、フェーズ遷移時の副作用が一貫する。

use std::sync::atomic::Ordering;

use rainbreak_core::{Phase, TimerSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{shortcuts, state::AppState, tray, windows};

#[derive(Clone, Serialize)]
struct PhasePayload {
    phase: &'static str,
    remaining_secs: u32,
    cycle: u32,
    /// 最終セットか（雨上がりで虹と余韻を出すかの判定に使う）。
    last_set: bool,
    /// 自動停止中はフェーズを保持したまま演出を退避する。
    auto_paused: bool,
}

#[derive(Clone, Serialize)]
struct TickPayload {
    phase: &'static str,
    remaining_secs: u32,
    segment_total_secs: u32,
}

#[derive(Clone, Serialize)]
struct IncomingPayload {
    p: f32,
}

/// 1 スナップショットぶんの反映: tick イベント、必要なら予兆進捗・フェーズ遷移、
/// そしてトレイ更新。`seg_total` は HUD の充填率の分母。
pub fn broadcast(app: &AppHandle, snap: &TimerSnapshot, seg_total: u32) {
    let _ = app.emit(
        "tick",
        TickPayload {
            phase: snap.phase.as_str(),
            remaining_secs: snap.remaining_secs,
            segment_total_secs: seg_total,
        },
    );

    if let Some(p) = snap.incoming_progress {
        let _ = app.emit("incoming-progress", IncomingPayload { p });
    }

    let auto_paused = snap.auto_pause_reason.is_some();
    let pause_changed = app
        .state::<AppState>()
        .auto_pause_rendered
        .swap(auto_paused, Ordering::Relaxed)
        != auto_paused;
    if snap.phase_changed || pause_changed {
        let _ = app.emit(
            "phase-changed",
            PhasePayload {
                phase: snap.phase.as_str(),
                remaining_secs: snap.remaining_secs,
                cycle: snap.cycle,
                last_set: snap.last_set,
                auto_paused,
            },
        );
        windows::apply_phase(app, snap);
        // 退避中は他アプリの Esc を奪わない。
        shortcuts::sync(app, if auto_paused { Phase::Work } else { snap.phase });
    }

    tray::update(app, snap);
}

/// フェーズ名（日本語）。トレイ表示用。
pub fn phase_label(phase: Phase) -> &'static str {
    match phase {
        Phase::Work => "作業",
        Phase::Incoming => "まもなく通り雨",
        Phase::Shower => "通り雨（休憩）",
        Phase::Clearing => "雨上がり",
        Phase::Finished => "セット終了",
    }
}

/// 残り秒を mm:ss に整形。
pub fn fmt_mmss(secs: u32) -> String {
    format!("{:02}:{:02}", secs / 60, secs % 60)
}
