use std::ffi::{c_char, c_void};

use rainbreak_core::Presence;

type CFRef = *const c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> CFRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: CFRef, text: *const c_char, encoding: u32) -> CFRef;
    fn CFDictionaryGetValueIfPresent(dictionary: CFRef, key: CFRef, value: *mut CFRef) -> u8;
    fn CFGetTypeID(value: CFRef) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: CFRef) -> u8;
    fn CFRelease(value: CFRef);
}

pub fn sample() -> Presence {
    // CombinedSessionState と AnyInputEventType。イベント内容を監視する権限は不要。
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    Presence {
        idle_secs: (seconds.is_finite() && seconds >= 0.0).then_some(seconds as u64),
        locked: session_locked(),
    }
}

fn session_locked() -> Option<bool> {
    // SAFETY: Copy 関数の戻り値を所有し、読み取り後に解放する。
    let dictionary = unsafe { CGSessionCopyCurrentDictionary() };
    if dictionary.is_null() {
        return None;
    }
    let on_console = dictionary_bool(dictionary, b"kCGSSessionOnConsoleKey\0");
    // Quartz の画面ロックフラグ。OS がこの補助キーを返さない場合でも
    // 公開キー OnConsole によるユーザー切替と入力停止の検知は継続する。
    let screen_locked = dictionary_bool(dictionary, b"CGSSessionScreenIsLocked\0");
    unsafe { CFRelease(dictionary) };
    match (on_console, screen_locked) {
        (Some(false), _) | (_, Some(true)) => Some(true),
        (Some(true), _) | (_, Some(false)) => Some(false),
        _ => None,
    }
}

fn dictionary_bool(dictionary: CFRef, key: &'static [u8]) -> Option<bool> {
    const UTF8: u32 = 0x0800_0100;
    // SAFETY: 呼び出し元は有効な CFDictionary と NUL 終端キーを渡す。
    let key = unsafe { CFStringCreateWithCString(std::ptr::null(), key.as_ptr().cast(), UTF8) };
    if key.is_null() {
        return None;
    }
    let mut value = std::ptr::null();
    let found = unsafe { CFDictionaryGetValueIfPresent(dictionary, key, &mut value) } != 0;
    unsafe { CFRelease(key) };
    if found && !value.is_null() && unsafe { CFGetTypeID(value) == CFBooleanGetTypeID() } {
        Some(unsafe { CFBooleanGetValue(value) } != 0)
    } else {
        None
    }
}
