//! ウィンドウ制御（実装計画 §5 / 要件 §7 の属性表が正）。
//!
//! 2 つのウィンドウ（overlay / hud）の属性をフェーズごとに切り替える。
//! クリックスルーはウィンドウ単位トグルのみ（ピクセル単位のヒットテストはしない）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rainbreak_core::{Phase, TimerSnapshot};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::config::{self, UiState};

/// HUD の位置・サイズの最新値（メモリ上の真実）。移動とリサイズは
/// 同時発火し得るため（角ドラッグや左/上辺リサイズ）、ここで一本化して
/// ディスク保存の上書き競合を避ける。
static UI_STATE: Mutex<UiState> = Mutex::new(UiState {
    hud_pos: None,
    hud_size: None,
});
/// デバウンス用の世代カウンタ（最新のイベントだけが保存を実行する）。
static UI_SAVE_GEN: AtomicU64 = AtomicU64::new(0);

/// 起動直後の初期配置: HUD を隅（または保存済みのドラッグ位置・サイズ）に表示、
/// overlay は退避。
pub fn init(app: &AppHandle) {
    let saved = config::load_ui_state(app);
    *UI_STATE.lock().unwrap() = saved;

    if let Some(hud) = app.get_webview_window("hud") {
        // クリックスルーにはしない: マウスドラッグで移動・リサイズできるようにする。
        // 代わりに set_focusable(false) でクリック時もフォーカスを奪わず、
        // 作業中のタイピングを中断させない。
        let _ = hud.set_focusable(false);
        // 全 Space ＋ ネイティブ全画面 Space の上に出られるようにする（Gate 1）。
        #[cfg(target_os = "macos")]
        crate::macos::init_window(&hud);
        exclude_from_capture(&hud);
        if let Some((w, h)) = saved.hud_size {
            let _ = hud.set_size(PhysicalSize::new(w, h));
        }
        position_hud(&hud, saved.hud_pos);
        let _ = hud.show();
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_always_on_top(false);
        #[cfg(target_os = "macos")]
        {
            crate::macos::init_window(&overlay);
            // tao の show() は makeKeyAndOrderFront でキーフォーカスを奪う。
            // 予兆の「作業は継続できる」を守るため canBecomeKeyWindow を切り、
            // フォーカスを奪わず前面表示だけさせる（クリックは非キーでも
            // WebView に届くので通り雨の Skip は機能する。Esc はグローバル
            // ショートカット側が担う。要件 §10 の「フォーカスは奪わない」方向）。
            let _ = overlay.set_focusable(false);
        }
        exclude_from_capture(&overlay);
        let _ = overlay.hide();
    }
}

/// HUD のドラッグ移動を記憶する（デバウンス保存）。
pub fn on_hud_moved(app: &AppHandle, pos: PhysicalPosition<i32>) {
    UI_STATE.lock().unwrap().hud_pos = Some((pos.x, pos.y));
    schedule_ui_save(app);
}

/// HUD のリサイズを記憶する（デバウンス保存）。
pub fn on_hud_resized(app: &AppHandle, size: PhysicalSize<u32>) {
    UI_STATE.lock().unwrap().hud_size = Some((size.width, size.height));
    schedule_ui_save(app);
}

/// Moved / Resized はドラッグ中に連続発火するため、500ms 静止してから
/// 最新のスナップショットだけをディスクへ書く。
fn schedule_ui_save(app: &AppHandle) {
    let gen = UI_SAVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if UI_SAVE_GEN.load(Ordering::SeqCst) == gen {
            let snapshot = *UI_STATE.lock().unwrap();
            config::save_ui_state(&app, snapshot);
        }
    });
}

/// 自アプリの窓を画面キャプチャから除外する（Windows 10 2004+）。
///
/// capture_screen（モードB の屈折元キャプチャ）に雨や HUD 自身が写り込んで
/// 多重露光にならないようにする。副作用として画面共有・録画にも写らなくなるが、
/// 共有相手に通り雨を見せない挙動はこのアプリでは望ましい側。
#[cfg(windows)]
fn exclude_from_capture(win: &WebviewWindow) {
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: isize, affinity: u32) -> i32;
    }
    if let Ok(hwnd) = win.hwnd() {
        // 失敗（古い Windows 等）は無視: その場合キャプチャに薄い雨が写り得るだけ。
        unsafe {
            SetWindowDisplayAffinity(hwnd.0 as isize, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

/// macOS 版: NSWindow.sharingType で同じ除外を行う（macos.rs）。
#[cfg(target_os = "macos")]
fn exclude_from_capture(win: &WebviewWindow) {
    crate::macos::exclude_from_capture(win);
}

#[cfg(not(any(windows, target_os = "macos")))]
fn exclude_from_capture(_win: &WebviewWindow) {}

/// フェーズに応じて 2 窓の属性を切り替える。
pub fn apply_phase(app: &AppHandle, snap: &TimerSnapshot) {
    let overlay = app.get_webview_window("overlay");
    let hud = app.get_webview_window("hud");

    match snap.phase {
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
        // セット終了: 全画面の終了画面を出し、「もう一度／終了」を選ばせる。
        // クリックを受ける（クリックスルー OFF）。HUD は退避。
        Phase::Finished => {
            if let Some(o) = &overlay {
                let _ = o.set_ignore_cursor_events(false);
                let _ = o.set_always_on_top(true);
                cover_primary_monitor(o);
                let _ = o.show();
            }
            if let Some(h) = &hud {
                let _ = h.hide();
            }
        }
        // 予兆: 全画面・透過・最前面・クリックスルー ON（作業継続可）。HUD 表示継続。
        Phase::Incoming => {
            if let Some(o) = &overlay {
                let _ = o.set_ignore_cursor_events(true);
                let _ = o.set_always_on_top(true);
                cover_primary_monitor(o);
                let _ = o.show();
                // macOS のネイティブ全画面アプリ上への重ね合わせ（Gate 1）は、
                // init で設定済みの collectionBehavior（macos.rs）が担う。
                // show は全 Space 共有の窓を前面に出すだけで Space を切り替えない。
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
        // 雨上がりは常にセット途中（最終セットは休憩を挟まずセット終了へ）。
        Phase::Clearing => {}
    }
}

/// overlay を主モニタ全体に広げる。
///
/// macOS: 装飾なし窓の maximize() は visibleFrame（メニューバー・Dock を除く）
/// までしか広がらず、雨に隙間が出る。モニタ全域へ明示的にフレームを張る
/// （メニューバー・Dock は overlay より上の level に描画されるため、
/// クリックも見た目もそれらが優先され、逃げ場は塞がない）。
/// Windows: 従来どおり maximize（実装計画 §5 の第一候補）。
fn cover_primary_monitor(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(Some(monitor)) = win.primary_monitor() {
            let _ = win.set_position(*monitor.position());
            let _ = win.set_size(*monitor.size());
            return;
        }
    }
    let _ = win.maximize();
}

/// HUD を配置する。保存済みのドラッグ位置がモニタ内にあればそこへ、
/// 無ければ（またはモニタ構成が変わって画面外なら）既定の右下へ。
fn position_hud(win: &WebviewWindow, saved: Option<(i32, i32)>) {
    if let Some((x, y)) = saved {
        if point_on_some_monitor(win, x, y) {
            let _ = win.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    // tauri.conf.json の hud 窓サイズと一致させる（窓＝バー本体）。
    let bar_w = 260.0;
    let bar_h = 14.0;
    let margin = 24.0;
    let taskbar_gap = 40.0;
    let x = size.width as f64 - (bar_w + margin) * scale;
    let y = size.height as f64 - (bar_h + margin + taskbar_gap) * scale;
    let _ = win.set_position(PhysicalPosition::new(x.max(0.0), y.max(0.0)));
}

/// 指定の物理座標がいずれかのモニタ内に収まっているか。
fn point_on_some_monitor(win: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
    })
}
