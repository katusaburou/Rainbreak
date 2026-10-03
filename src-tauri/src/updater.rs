//! 自動アップデート（要件 §配布の後続項目）。
//!
//! GitHub Releases の latest.json を参照し、新版があれば確認ダイアログを出して
//! 同意時にダウンロード・適用・再起動する。チェックは起動時（少し遅延）と
//! トレイメニューの「アップデートを確認…」から行う。

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 起動直後は描画と初期化を優先し、少し待ってから自動チェックする。
const STARTUP_DELAY: Duration = Duration::from_secs(10);

/// 起動時の自動チェックを開始する。setup から一度だけ呼ぶ。
pub fn spawn_startup_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        check(&app, false);
    });
}

/// 更新チェックを非同期に開始する。起動時も現在バージョンと確認結果を知らせる。
pub fn check(app: &AppHandle, manual: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
        {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        match result {
            Ok(Some(update)) => prompt_and_install(app, update),
            Ok(None) => {
                app.dialog()
                    .message(format!(
                        "雨やどり v{}\n最新のバージョンを使用しています。",
                        app.package_info().version
                    ))
                    .title(if manual {
                        "バージョン確認"
                    } else {
                        "起動時のバージョン確認"
                    })
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
            Err(e) => {
                app.dialog()
                    .message(format!(
                        "雨やどり v{}\n更新情報を確認できませんでした。\nトレイの「アップデートを確認…」から再確認できます。\n\n{e}",
                        app.package_info().version
                    ))
                    .title(if manual { "バージョン確認" } else { "起動時のバージョン確認" })
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

/// 確認ダイアログを出し、同意されたらダウンロード・適用して再起動する。
fn prompt_and_install(app: AppHandle, update: Update) {
    let message = format!(
        "雨やどり v{} が利用可能です（現在 v{}）。\nアップデートして再起動しますか？",
        update.version, update.current_version
    );
    app.dialog()
        .message(message)
        .title("雨やどりのアップデート")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "アップデート".into(),
            "あとで".into(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => app.restart(),
                    Err(e) => {
                        app.dialog()
                            .message(format!("アップデートに失敗しました。\n{e}"))
                            .title("雨やどり")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            });
        });
}
