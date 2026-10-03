use std::{mem::size_of, ptr};

use rainbreak_core::Presence;
use windows_sys::Win32::{
    System::{
        RemoteDesktop::{
            WTSActive, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
            WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK,
        },
        SystemInformation::GetTickCount,
    },
    UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
};

pub fn sample() -> Presence {
    Presence {
        idle_secs: idle_secs(),
        locked: session_locked(),
    }
}

fn idle_secs() -> Option<u64> {
    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: API に渡す構造体は初期化済みで、サイズも API の契約どおり。
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // 両方とも32bit tick。49.7日ごとの wrap を跨いでも正しい差になる。
    Some(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)) / 1000)
}

fn session_locked() -> Option<bool> {
    let mut buffer = ptr::null_mut();
    let mut bytes = 0;
    // 現在のユーザーセッションだけを読み取る（管理者権限・他ユーザーの情報は不要）。
    // SAFETY: 有効な出力ポインタを渡し、返されたバッファは最後に WTSFreeMemory する。
    let ok = unsafe {
        WTSQuerySessionInformationW(
            ptr::null_mut(),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
    };
    if ok == 0 {
        return None;
    }
    let locked = if !buffer.is_null() && bytes as usize >= size_of::<WTSINFOEXW>() {
        // SAFETY: API の情報クラスと返されたバッファサイズを検証済み。
        let info = unsafe { &*buffer.cast::<WTSINFOEXW>() };
        if info.Level == 1 {
            // SAFETY: Level が1なので union の Level1 フィールドが有効。
            let session = unsafe { info.Data.WTSInfoExLevel1 };
            if session.SessionState != WTSActive {
                // ユーザー切替・リモートセッション切断も作業中とは見なさない。
                Some(true)
            } else {
                match session.SessionFlags as u32 {
                    WTS_SESSIONSTATE_LOCK => Some(true),
                    WTS_SESSIONSTATE_UNLOCK => Some(false),
                    _ => None,
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    unsafe { WTSFreeMemory(buffer.cast()) };
    locked
}
