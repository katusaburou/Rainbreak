//! グローバルショートカット（Esc）。要件 §3.5 の「逃げ場を必ず残す」。
//!
//! 予兆／通り雨／雨上がり中だけ Esc を奪い、作業中はユーザーのエディタ等の
//! Esc を妨げないよう登録を解除する（実装計画 §3.3 の脚注）。

use rainbreak_core::Phase;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

fn esc() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// フェーズに応じて Esc の登録／解除を同期する。
pub fn sync(app: &AppHandle, phase: Phase) {
    let gs = app.global_shortcut();
    let shortcut = esc();
    if phase == Phase::Work {
        let _ = gs.unregister(shortcut);
    } else if !gs.is_registered(shortcut) {
        let _ = gs.register(shortcut);
    }
}
