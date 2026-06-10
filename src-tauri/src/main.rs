// Windows のリリースビルドで余分なコンソール窓を出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod glue;
mod scheduler;
mod shortcuts;
mod state;
mod tray;
mod updater;
mod windows;

use std::sync::Mutex;

use rainbreak_core::{CycleConfig, Phase, Timer};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Shortcut, ShortcutState};

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let esc = Shortcut::new(None, Code::Escape);
                    if shortcut != &esc {
                        return;
                    }
                    // [デッドロック回避] このハンドラはプラグインが内部の
                    // shortcuts ミューテックスを保持したままメインスレッドで呼ぶ。
                    // ここから同期的に do_skip → shortcuts::sync → unregister と
                    // 進むと同じミューテックスを再取得して自己デッドロックし、
                    // アプリ全体が固まる（休憩中の Esc で発生していた不具合）。
                    // 仕事はすべて async ランタイムへ逃がし、ハンドラは即返す。
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        // 作業中は Esc を奪わない（shortcuts::sync が解除しているが二重防御）。
                        let state = app.state::<AppState>();
                        let phase = { state.timer.lock().unwrap().phase() };
                        if phase != Phase::Work {
                            commands::do_skip(&app);
                        }
                    });
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::skip_break,
            commands::pause,
            commands::resume,
            commands::get_config,
            commands::update_config,
            commands::quit,
            commands::capture_screen,
        ])
        .on_window_event(|window, event| {
            // HUD のドラッグ移動・リサイズを記憶する（デバウンス保存は windows 側）。
            if window.label() == "hud" {
                match event {
                    tauri::WindowEvent::Moved(pos) => {
                        windows::on_hud_moved(window.app_handle(), *pos);
                    }
                    tauri::WindowEvent::Resized(size) => {
                        windows::on_hud_resized(window.app_handle(), *size);
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let cfg = config::load(handle);
            let timer = Timer::new(CycleConfig::from_minutes(cfg.work_min, cfg.break_min));
            app.manage(AppState {
                timer: Mutex::new(timer),
                config: Mutex::new(cfg.clone()),
            });

            windows::init(handle);
            tray::build(handle)?;

            // 起動時に作業フェーズの初期表示（HUD バー）を一度配信する。
            {
                let state = app.state::<AppState>();
                let (snap, seg) = {
                    let timer = state.timer.lock().unwrap();
                    (timer.current(), timer.segment_total_secs())
                };
                glue::broadcast(handle, &snap, seg);
            }

            scheduler::spawn(handle.clone());
            updater::spawn_startup_check(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
