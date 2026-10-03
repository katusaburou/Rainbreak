use rainbreak_core::{AutoPauseReason, CycleConfig, Phase, Presence, Timer, IDLE_PAUSE_SECS};

fn active() -> Presence {
    Presence {
        idle_secs: Some(0),
        locked: Some(false),
    }
}

fn idle() -> Presence {
    Presence {
        idle_secs: Some(IDLE_PAUSE_SECS),
        locked: Some(false),
    }
}

fn locked() -> Presence {
    Presence {
        idle_secs: Some(0),
        locked: Some(true),
    }
}

#[test]
fn idle_boundary_freezes_work_and_input_resumes_remaining_time() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.update_presence(
        true,
        Presence {
            idle_secs: Some(IDLE_PAUSE_SECS - 1),
            ..active()
        },
    );
    timer.tick();
    let remaining = timer.remaining_secs();
    timer.update_presence(true, idle());
    for _ in 0..600 {
        let snap = timer.tick();
        assert_eq!(snap.auto_pause_reason, Some(AutoPauseReason::Idle));
        assert_eq!(snap.remaining_secs, remaining);
        assert!(!snap.phase_changed);
    }
    timer.update_presence(true, active());
    assert_eq!(timer.tick().remaining_secs, remaining - 1);
}

#[test]
fn incoming_can_pause_without_starting_the_break() {
    let mut timer = Timer::new(CycleConfig::from_minutes(1, 1));
    for _ in 0..30 {
        timer.tick();
    }
    assert_eq!(timer.phase(), Phase::Incoming);
    timer.update_presence(true, idle());
    for _ in 0..60 {
        timer.tick();
    }
    assert_eq!(timer.phase(), Phase::Incoming);
    assert_eq!(timer.remaining_secs(), 30);
}

#[test]
fn lack_of_input_does_not_pause_a_break_or_clearing() {
    let mut timer = Timer::new(CycleConfig::from_minutes(1, 1));
    for _ in 0..120 {
        timer.update_presence(true, idle());
        // 作業中だけは入力があるものとして進める。
        if matches!(timer.phase(), Phase::Work | Phase::Incoming) {
            timer.update_presence(true, active());
        }
        timer.tick();
    }
    assert_eq!(timer.phase(), Phase::Clearing);
    timer.update_presence(true, idle());
    assert!(!timer.paused());
    assert_eq!(timer.tick().remaining_secs, 2);
}

#[test]
fn lock_freezes_every_phase_and_unlock_restores_the_same_segment() {
    for ticks in [0, 30, 60, 120, 123] {
        let mut timer = Timer::new(CycleConfig::from_minutes(1, 1).with_sets(1));
        for _ in 0..ticks {
            timer.tick();
        }
        let before = timer.current();
        timer.update_presence(true, locked());
        for _ in 0..100 {
            let snap = timer.tick();
            assert_eq!(snap.auto_pause_reason, Some(AutoPauseReason::Locked));
            assert_eq!(
                (snap.phase, snap.remaining_secs, snap.cycle),
                (before.phase, before.remaining_secs, before.cycle)
            );
        }
        timer.update_presence(true, active());
        assert!(!timer.paused());
        assert_eq!(timer.remaining_secs(), before.remaining_secs);
    }
}

#[test]
fn manual_pause_survives_automatic_pause_and_return() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.set_paused(true);
    timer.update_presence(true, locked());
    timer.update_presence(true, active());
    assert!(timer.manually_paused());
    assert!(timer.tick().paused);
    timer.set_paused(false);
    assert!(!timer.paused());
}

#[test]
fn manual_resume_does_not_override_a_locked_session() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.set_paused(true);
    timer.update_presence(true, locked());
    timer.set_paused(false);
    assert!(!timer.manually_paused());
    assert!(timer.paused());
    timer.update_presence(true, active());
    assert!(!timer.paused());
}

#[test]
fn disabling_auto_pause_releases_only_the_automatic_reason() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.set_paused(true);
    timer.update_presence(true, idle());
    timer.update_presence(false, locked());
    assert_eq!(timer.current().auto_pause_reason, None);
    assert!(timer.paused());
    timer.set_paused(false);
    assert!(!timer.paused());
}

#[test]
fn observation_failure_cannot_resume_a_known_automatic_pause() {
    let mut timer = Timer::new(CycleConfig::default());
    for presence in [idle(), locked()] {
        timer.update_presence(true, presence);
        let reason = timer.current().auto_pause_reason;
        timer.update_presence(true, Presence::default());
        assert_eq!(timer.current().auto_pause_reason, reason);
    }
    // 入力を観測してもロック状態が不明なら解除しない。
    timer.update_presence(
        true,
        Presence {
            idle_secs: Some(0),
            locked: None,
        },
    );
    assert!(timer.paused());
    timer.update_presence(true, active());
    assert!(!timer.paused());
}

#[test]
fn unlock_without_activity_keeps_work_paused_for_idle() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.update_presence(true, locked());
    timer.update_presence(true, idle());
    assert_eq!(
        timer.current().auto_pause_reason,
        Some(AutoPauseReason::Idle)
    );
    timer.update_presence(true, active());
    assert!(!timer.paused());
}

#[test]
fn unlock_with_unknown_idle_keeps_work_paused() {
    let mut timer = Timer::new(CycleConfig::default());
    timer.update_presence(true, locked());
    timer.update_presence(
        true,
        Presence {
            idle_secs: None,
            locked: Some(false),
        },
    );
    assert!(timer.paused());
    let remaining = timer.remaining_secs();
    assert_eq!(timer.tick().remaining_secs, remaining);
    timer.update_presence(true, active());
    assert!(!timer.paused());
}
