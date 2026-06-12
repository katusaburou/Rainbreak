//! macOS 固有のネイティブウィンドウ属性（要件 §11 Gate 1 / 実装計画 Phase 0）。
//!
//! Tauri(tao) の API だけでは設定できない NSWindow 属性を AppKit で直接設定する。
//!
//! - `collectionBehavior` — 全 Space 参加（`canJoinAllSpaces`）＋ネイティブ全画面
//!   Space への補助表示（`fullScreenAuxiliary`）。これが無いと全画面アプリの
//!   Space では overlay / HUD が一切表示されず、中核体験（予兆〜通り雨）が
//!   発火しない。`stationary` / `ignoresCycle` で Mission Control の整列や
//!   ウィンドウ巡回の対象からも外す。
//! - `sharingType` — 自窓を画面キャプチャから除外する。モードB（capture_screen）
//!   の屈折元に雨や HUD 自身が写り込む多重露光を防ぐ。Windows 側の
//!   `SetWindowDisplayAffinity`（windows.rs）と対になる。
//!
//! window level は意図的に触らない: tao の `set_always_on_top` が使う
//! Floating(3) で、全画面 Space 上の通常コンテンツ（level 0）は覆える。
//! これ以上（メニューバー 24 / ポップアップ 101 超え）へ上げると、通り雨中に
//! トレイメニューや Zoom の操作 UI まで覆って「逃げ場を残す」原則に反する。
//! 実機検証で不足が判明した場合の引き上げ手順は docs/macos-fullscreen-gate.md。

use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};
use tauri::WebviewWindow;

/// AppKit の NSWindow 操作はメインスレッド限定のため、`run_on_main_thread`
/// 経由で取り出して適用する（フェーズ遷移は scheduler の tick スレッドから来る）。
fn with_ns_window(win: &WebviewWindow, f: impl FnOnce(&NSWindow) + Send + 'static) {
    let win2 = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(ptr) = win2.ns_window() {
            // tao が生成する TaoWindow は NSWindow のサブクラス。
            let ns_window = unsafe { &*ptr.cast::<NSWindow>() };
            f(ns_window);
        }
    });
}

/// overlay / HUD 共通の常駐属性。起動時に一度だけ設定する。
///
/// tao 側で collectionBehavior を書き換えるのは `set_visible_on_all_workspaces`
/// のみで、本アプリは呼ばないため、この値が起動中ずっと維持される。
pub fn init_window(win: &WebviewWindow) {
    with_ns_window(win, |ns_window| {
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    });
}

/// 自窓を画面キャプチャ・画面共有から除外する。
///
/// 副作用として画面共有・録画にも写らなくなるが、共有相手に通り雨を
/// 見せない挙動はこのアプリでは望ましい側（windows.rs の同名処理と同じ判断）。
pub fn exclude_from_capture(win: &WebviewWindow) {
    with_ns_window(win, |ns_window| {
        ns_window.setSharingType(NSWindowSharingType::None);
    });
}
