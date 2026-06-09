//! ウィンドウ制御（実装計画 §5 / 要件 §7 の属性表が正）。
//!
//! 2 つのウィンドウ（overlay / hud）の属性をフェーズごとに切り替える。
//! クリックスルーはウィンドウ単位トグルのみ（ピクセル単位のヒットテストはしない）。

use rainbreak_core::Phase;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

/// 起動直後の初期配置: HUD を常時クリックスルーで隅に表示、overlay は退避。
pub fn init(app: &AppHandle) {
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.set_ignore_cursor_events(true);
        position_hud(&hud);
        let _ = hud.show();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.hide();
    }
}

/// フェーズに応じて 2 窓の属性を切り替える。
pub fn apply_phase(app: &AppHandle, phase: Phase) {
    let overlay = app.get_webview_window("overlay");
    let hud = app.get_webview_window("hud");

    match phase {
        // 作業: overlay 退避、HUD のみ表示。他アプリ操作を一切妨げない。
        Phase::Work => {
            if let Some(o) = &overlay {
                let _ = o.set_always_on_top(false);
                let _ = o.hide();
            }
            if let Some(h) = &hud {
                let _ = h.show();
            }
        }
        // 予兆: 全画面・透過・最前面・クリックスルー ON（作業継続可）。HUD 表示継続。
        Phase::Incoming => {
            if let Some(o) = &overlay {
                let _ = o.set_ignore_cursor_events(true);
                let _ = o.set_always_on_top(true);
                cover_primary_monitor(o);
                let _ = o.show();
                // macOS のネイティブ全画面アプリ上への重ね合わせ（Gate 1）は
                // collectionBehavior / window level の設定が要る。Phase 0 の検証
                // 結果に従ってネイティブ実装を追加する（要件 §11 / 実装計画 §2）。
            }
            if let Some(h) = &hud {
                let _ = h.show();
            }
        }
        // 通り雨: クリックスルー OFF（Skip 有効）、HUD 非表示。フォーカスは奪わない。
        Phase::Shower => {
            if let Some(o) = &overlay {
                let _ = o.set_ignore_cursor_events(false);
                let _ = o.show();
            }
            if let Some(h) = &hud {
                let _ = h.hide();
            }
        }
        // 雨上がり: フェードはフロントが演出。退避は Work 遷移で行う。
        Phase::Clearing => {}
    }
}

/// overlay を主モニタ全体に広げる（装飾なし maximize を第一候補。実装計画 §5）。
fn cover_primary_monitor(win: &WebviewWindow) {
    let _ = win.maximize();
}

/// HUD を画面右下に配置する（MVP は位置決め打ち・主モニタのみ）。
fn position_hud(win: &WebviewWindow) {
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let bar_w = 260.0;
    let bar_h = 64.0;
    let margin = 24.0;
    let taskbar_gap = 40.0;
    let x = size.width as f64 - (bar_w + margin) * scale;
    let y = size.height as f64 - (bar_h + margin + taskbar_gap) * scale;
    let _ = win.set_position(PhysicalPosition::new(x.max(0.0), y.max(0.0)));
}
