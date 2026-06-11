//! トレイ / メニューバー（実装計画 §10 / 要件 §3.7）。
//!
//! 常駐アイコンにフェーズ・残り時間を出し、開始/一時停止/Skip/設定/終了を提供する。

use rainbreak_core::Phase;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::{commands, glue, updater};

/// トレイを構築する。setup から一度だけ呼ぶ。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "一時停止 / 再開", true, None::<&str>)?;
    let skip = MenuItem::with_id(app, "skip", "Skip（作業へ戻る）", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "設定…", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "アップデートを確認…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &skip, &sep, &settings, &check_update, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("雨やどり")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => commands::toggle_pause(app),
            "skip" => commands::do_skip(app),
            "settings" => show_settings(app),
            "check_update" => updater::check(app, true),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// トレイのツールチップにフェーズと残り時間を反映する。
pub fn update(app: &AppHandle, phase: Phase, remaining: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        // セット終了はタイマーが止まっているので残り時間を出さない。
        let text = if phase == Phase::Finished {
            format!("雨やどり — {}", glue::phase_label(phase))
        } else {
            format!("雨やどり — {} {}", glue::phase_label(phase), glue::fmt_mmss(remaining))
        };
        let _ = tray.set_tooltip(Some(text));
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
