//! OS から得た入力・セッション状態を、タイマーの自動停止理由に変換する。
//! 入力内容は扱わず、最後の入力からの秒数だけを使う。

use crate::Phase;

pub const IDLE_PAUSE_SECS: u64 = 5 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoPauseReason {
    Idle,
    Locked,
}

/// 取得失敗は None。失敗を「操作あり／ロック解除」として扱わない。
#[derive(Debug, Clone, Copy, Default)]
pub struct Presence {
    pub idle_secs: Option<u64>,
    pub locked: Option<bool>,
}

pub(crate) fn pause_reason(
    enabled: bool,
    phase: Phase,
    presence: Presence,
    previous: Option<AutoPauseReason>,
) -> Option<AutoPauseReason> {
    if !enabled {
        return None;
    }
    match presence.locked {
        Some(true) => return Some(AutoPauseReason::Locked),
        None if previous == Some(AutoPauseReason::Locked) => return previous,
        _ => {}
    }
    // 休憩・雨上がりは入力しないのが自然なので、離席判定の対象にしない。
    if !matches!(phase, Phase::Work | Phase::Incoming) {
        return None;
    }
    match presence.idle_secs {
        Some(secs) if secs >= IDLE_PAUSE_SECS => Some(AutoPauseReason::Idle),
        // ロック解除直後に入力経過だけ取得できない場合も、離席判定を飛ばして再開しない。
        None if previous.is_some() => previous,
        _ => None,
    }
}
