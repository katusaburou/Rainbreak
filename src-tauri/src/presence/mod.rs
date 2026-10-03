//! グローバルな最終入力時刻とセッションロックを読み取る（入力内容は取得しない）。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub fn sample() -> rainbreak_core::Presence {
    #[cfg(target_os = "macos")]
    return macos::sample();
    #[cfg(windows)]
    return windows::sample();
    // Linux はアプリの対応OS外。開発用では自動停止を行わない。
    #[cfg(not(any(windows, target_os = "macos")))]
    rainbreak_core::Presence::default()
}
