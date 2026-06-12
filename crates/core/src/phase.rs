//! タイマー状態機械（Work / Incoming / Shower / Clearing）。
//!
//! 実装計画 §4 に対応。フェーズ遷移の境界条件をすべてここに閉じ込め、
//! Tauri 非依存・実時間非依存に保つことで早送り単体テストを可能にする。

/// 予兆フェーズの長さ（秒）。作業の最後の一定秒に「重なる」（別カウントではない）。
///
/// 要件 §3.1: 「予兆（Incoming）— 休憩30秒前から」。
pub const INCOMING_LEAD_SECS: u32 = 30;

/// 雨上がり（フェードアウト）の長さ（秒）。
///
/// フロントの完了通知に依存しすぎないよう、フェード尺は Rust が固定値で持つ
/// （実装計画 §4「Clearing はフェードアウト完了…タイマーで遷移」）。
pub const CLEARING_SECS: u32 = 3;

/// セット終了画面に架かる虹の演出の長さ（秒）。最終セットの作業が終わった
/// あと、フロントのセット終了画面が虹と余韻（雫・鳥の声）を出す尺で、フロント
/// の虹タイムラインはこの値に同期する。タイマー駆動ではない（セット終了は停止）。
pub const FINAL_CLEARING_SECS: u32 = 10;

/// サイクルの 4 フェーズ ＋ 終端のセット終了。
///
/// 文字列表現は WebView へ送るイベントのフェーズ名と一致させる（`as_str`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Phase {
    /// 作業。全画面オーバーレイは退避し、隅の HUD バーのみ表示。
    Work,
    /// 予兆。全画面・透過・クリックスルー ON で雨が 0→強。作業は継続できる。
    Incoming,
    /// 通り雨（休憩本体）。クリックスルー OFF、雨が画面を覆う。Skip/Esc 可。
    Shower,
    /// 雨上がり。雨・音をフェードアウトして退避し、作業へループ。
    Clearing,
    /// セット終了。設定したセット数の作業を終えた終端で、タイマーは停止する。
    /// フロントは「もう一度／終了」の選択肢を出す。`restart`（または Skip）で
    /// 新しいセッション（セット 1）を開始する。
    Finished,
}

impl Phase {
    /// WebView へ送るフェーズ名（イベントペイロードのキーと一致させる）。
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Work => "work",
            Phase::Incoming => "incoming",
            Phase::Shower => "shower",
            Phase::Clearing => "clearing",
            Phase::Finished => "finished",
        }
    }
}

/// サイクル長（作業・休憩）とセット数の設定。秒で保持する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CycleConfig {
    pub work_secs: u32,
    pub break_secs: u32,
    /// セット数（こなす作業サイクルの回数）。`0` は無制限（従来どおりループ）。
    pub sets: u32,
}

impl CycleConfig {
    /// 分から生成する。0 分は不正なので最低 1 分にクランプする。セット数は無制限。
    pub fn from_minutes(work_min: u32, break_min: u32) -> Self {
        Self {
            work_secs: work_min.max(1) * 60,
            break_secs: break_min.max(1) * 60,
            sets: 0,
        }
    }

    /// セット数を設定する（`0` = 無制限）。
    pub fn with_sets(mut self, sets: u32) -> Self {
        self.sets = sets;
        self
    }
}

impl Default for CycleConfig {
    /// 既定 20 分 / 5 分（要件 §3.6）。
    fn default() -> Self {
        Self::from_minutes(20, 5)
    }
}

/// 1 tick 後のタイマー状態のスナップショット。Tauri 側はこれをイベント化する。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimerSnapshot {
    /// 現在のフェーズ。
    pub phase: Phase,
    /// 現在のセグメントの残り秒。
    pub remaining_secs: u32,
    /// 作業サイクルの通し番号（1 始まり）。
    pub cycle: u32,
    /// 一時停止中か。
    pub paused: bool,
    /// この tick でフェーズが変化したか（ウィンドウ属性の切替トリガ）。
    pub phase_changed: bool,
    /// 予兆フェーズの進捗 `0.0..=1.0`（雨を 0→強へ漸増させる用）。
    /// 予兆フェーズ以外では `None`。
    pub incoming_progress: Option<f32>,
    /// 最終セット（この雨上がりの後にセット終了）か。フロントは雨上がりで
    /// これが立っていたら虹と余韻を演出する。`sets = 0`（無制限）では常に false。
    pub last_set: bool,
}

/// タイマー状態機械。`tick()` を 1 秒ごとに呼んで駆動する。
///
/// 内部状態は外から直接触らせず、`tick` / `skip` / `update_config` /
/// `set_paused` 経由でのみ遷移させる。
#[derive(Debug, Clone)]
pub struct Timer {
    phase: Phase,
    /// 現在セグメント（Work+Incoming は同一の作業タイマーを共有）の残り秒。
    remaining: u32,
    cycle: u32,
    paused: bool,
    cfg: CycleConfig,
}

impl Timer {
    /// 作業フェーズから開始する。
    pub fn new(cfg: CycleConfig) -> Self {
        Self {
            phase: Phase::Work,
            remaining: cfg.work_secs,
            cycle: 1,
            paused: false,
            cfg,
        }
    }

    /// 1 秒進める。一時停止中は時間を減らさず、状態も変えない。
    pub fn tick(&mut self) -> TimerSnapshot {
        if self.paused {
            return self.snapshot(false);
        }
        if self.remaining > 0 {
            self.remaining -= 1;
        }
        let phase_changed = self.evaluate_transition();
        self.snapshot(phase_changed)
    }

    /// 残り秒に応じてフェーズ遷移を評価する。遷移したら `true`。
    ///
    /// 注意: Work→Incoming は作業タイマーを止めず（残りは減り続ける）、
    /// 「予兆は作業の最後の `INCOMING_LEAD_SECS` 秒に重なる」を表現する。
    fn evaluate_transition(&mut self) -> bool {
        match self.phase {
            Phase::Work => {
                if self.remaining == 0 {
                    // 作業の完了。最終セットならセット終了、ほかは休憩へ。
                    self.end_of_work();
                    true
                } else if self.remaining <= INCOMING_LEAD_SECS && !self.is_last_set() {
                    // 作業タイマーは継続したまま見た目だけ予兆へ。
                    // 最終セットは休憩が無いため予兆を出さない（作業のまま終了へ）。
                    self.phase = Phase::Incoming;
                    true
                } else {
                    false
                }
            }
            Phase::Incoming => {
                if self.remaining == 0 {
                    self.end_of_work();
                    true
                } else {
                    false
                }
            }
            Phase::Shower => {
                if self.remaining == 0 {
                    self.enter_clearing();
                    true
                } else {
                    false
                }
            }
            Phase::Clearing => {
                if self.remaining == 0 {
                    // 休憩を終えて次の作業サイクルへ（セット消化は作業の完了時に判定）。
                    self.enter_work();
                    true
                } else {
                    false
                }
            }
            // セット終了は時間では遷移しない（restart / Skip でのみ次のセッションへ）。
            Phase::Finished => false,
        }
    }

    /// Skip / Esc: 現在の区切りを先へ送る（要件 §3.5）。
    ///
    /// - 予兆 / 通り雨 / 雨上がり / 作業: 休憩を飛ばして次の作業サイクルへ。
    ///   ただし最終セットの作業を Skip した場合は、次の作業が無いのでセット終了へ。
    /// - セット終了: 新しいセッション（セット 1）を始める。
    pub fn skip(&mut self) -> TimerSnapshot {
        match self.phase {
            // 最終セットの作業を切り上げると、次の作業は無いのでセット終了。
            Phase::Work if self.is_last_set() => self.enter_finished(),
            Phase::Finished => {
                self.cycle = 0; // enter_work の加算で 1 に戻る
                self.enter_work();
            }
            _ => self.enter_work(),
        }
        self.snapshot(true)
    }

    /// セッションを最初（セット 1 の作業）からやり直す。セット終了画面の
    /// 「もう一度」で使う。どのフェーズからでも作業の頭へ戻す。
    pub fn restart(&mut self) -> TimerSnapshot {
        self.phase = Phase::Work;
        self.remaining = self.cfg.work_secs;
        self.cycle = 1;
        self.paused = false;
        self.snapshot(true)
    }

    /// 一時停止 / 再開。
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    /// サイクル長を更新する。現在セグメントの残りが新しい総量を超える場合は
    /// クランプし、即時に反映されるようにする（実装計画 §4 のテスト観点）。
    pub fn update_config(&mut self, cfg: CycleConfig) {
        self.cfg = cfg;
        let cap = match self.phase {
            Phase::Work | Phase::Incoming => self.cfg.work_secs,
            Phase::Shower => self.cfg.break_secs,
            Phase::Clearing => self.clearing_total(),
            Phase::Finished => 0,
        };
        if self.remaining > cap {
            self.remaining = cap;
        }
    }

    /// いま最終セットの作業中（この作業の完了でセット終了する）か。
    /// `sets = 0`（無制限）では常に false。
    fn is_last_set(&self) -> bool {
        self.cfg.sets > 0 && self.cycle >= self.cfg.sets
    }

    /// 雨上がりの長さ。セット途中の休憩のあとにだけ起き、一定（虹の余韻は
    /// セット終了画面側が担う）。
    fn clearing_total(&self) -> u32 {
        CLEARING_SECS
    }

    /// 作業セッションの終わり。セット消化はこの「作業の完了」時点で判定する。
    /// 最終セット（設定セット数に到達）ならセット終了へ入りタイマーを止め、
    /// そうでなければ休憩（通り雨）へ進む。
    fn end_of_work(&mut self) {
        if self.is_last_set() {
            self.enter_finished();
        } else {
            self.enter_shower();
        }
    }

    fn enter_work(&mut self) {
        self.phase = Phase::Work;
        self.remaining = self.cfg.work_secs;
        self.cycle += 1;
    }

    fn enter_finished(&mut self) {
        self.phase = Phase::Finished;
        self.remaining = 0;
    }

    fn enter_shower(&mut self) {
        self.phase = Phase::Shower;
        self.remaining = self.cfg.break_secs;
    }

    fn enter_clearing(&mut self) {
        self.phase = Phase::Clearing;
        self.remaining = self.clearing_total();
    }

    fn snapshot(&self, phase_changed: bool) -> TimerSnapshot {
        let incoming_progress = if self.phase == Phase::Incoming {
            let elapsed = INCOMING_LEAD_SECS - self.remaining.min(INCOMING_LEAD_SECS);
            Some(elapsed as f32 / INCOMING_LEAD_SECS as f32)
        } else {
            None
        };
        TimerSnapshot {
            phase: self.phase,
            remaining_secs: self.remaining,
            cycle: self.cycle,
            paused: self.paused,
            phase_changed,
            incoming_progress,
            last_set: self.is_last_set(),
        }
    }

    // ---- getters（読み取り専用アクセス） ----

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn remaining_secs(&self) -> u32 {
        self.remaining
    }
    pub fn cycle(&self) -> u32 {
        self.cycle
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn config(&self) -> CycleConfig {
        self.cfg
    }

    /// 現在のセグメントの総量（残り割合の計算などに使う）。
    pub fn segment_total_secs(&self) -> u32 {
        match self.phase {
            Phase::Work | Phase::Incoming => self.cfg.work_secs,
            Phase::Shower => self.cfg.break_secs,
            Phase::Clearing => self.clearing_total(),
            Phase::Finished => 0,
        }
    }

    /// 現在の状態を `phase_changed = false` のスナップショットとして返す。
    pub fn current(&self) -> TimerSnapshot {
        self.snapshot(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用に短いサイクルを作る（work 120s / break 60s / セット無制限）。
    fn timer() -> Timer {
        timer_with_sets(0)
    }

    /// セット数指定つきの短いサイクル（work 120s / break 60s）。
    fn timer_with_sets(sets: u32) -> Timer {
        Timer::new(CycleConfig {
            work_secs: 120,
            break_secs: 60,
            sets,
        })
    }

    /// N 回 tick し、フェーズが変わった瞬間の (tick番号, snapshot) を集める。
    fn collect_changes(t: &mut Timer, n: usize) -> Vec<(usize, TimerSnapshot)> {
        let mut changes = Vec::new();
        for i in 1..=n {
            let s = t.tick();
            if s.phase_changed {
                changes.push((i, s));
            }
        }
        changes
    }

    #[test]
    fn initial_state_is_work() {
        let t = timer();
        assert_eq!(t.phase(), Phase::Work);
        assert_eq!(t.remaining_secs(), 120);
        assert_eq!(t.cycle(), 1);
        assert!(!t.paused());
    }

    #[test]
    fn config_from_minutes_clamps_zero_to_one() {
        let c = CycleConfig::from_minutes(0, 0);
        assert_eq!(c.work_secs, 60);
        assert_eq!(c.break_secs, 60);
        assert_eq!(c.sets, 0); // 既定は無制限
        assert_eq!(c.with_sets(4).sets, 4);
    }

    #[test]
    fn default_cycle_is_20_5() {
        let c = CycleConfig::default();
        assert_eq!(c.work_secs, 20 * 60);
        assert_eq!(c.break_secs, 5 * 60);
    }

    #[test]
    fn work_transitions_to_incoming_at_lead_boundary() {
        let mut t = timer();
        // remaining が 30 になるのは 120 - 30 = 90 回目の tick。
        for _ in 0..89 {
            let s = t.tick();
            assert_eq!(s.phase, Phase::Work);
            assert!(!s.phase_changed);
        }
        let s = t.tick(); // 90 回目
        assert_eq!(s.phase, Phase::Incoming);
        assert!(s.phase_changed);
        assert_eq!(s.remaining_secs, 30);
        assert_eq!(s.incoming_progress, Some(0.0));
    }

    #[test]
    fn full_cycle_transition_sequence() {
        let mut t = timer();
        // 1 サイクル = work(120) + break(60) + clearing(3) = 183 tick。
        let changes = collect_changes(&mut t, 183);
        let phases: Vec<Phase> = changes.iter().map(|(_, s)| s.phase).collect();
        assert_eq!(
            phases,
            vec![Phase::Incoming, Phase::Shower, Phase::Clearing, Phase::Work]
        );
        // 遷移の tick 番号を確認。
        assert_eq!(changes[0].0, 90); // Work->Incoming（残り30）
        assert_eq!(changes[1].0, 120); // Incoming->Shower（作業満了）
        assert_eq!(changes[2].0, 180); // Shower->Clearing（休憩満了）
        assert_eq!(changes[3].0, 183); // Clearing->Work（フェード完了）
        // ループ後は新しい作業サイクル。
        assert_eq!(t.phase(), Phase::Work);
        assert_eq!(t.remaining_secs(), 120);
        assert_eq!(t.cycle(), 2);
    }

    #[test]
    fn incoming_to_shower_resets_break_timer() {
        let mut t = timer();
        for _ in 0..120 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Shower);
        assert_eq!(t.remaining_secs(), 60);
    }

    #[test]
    fn incoming_progress_is_monotonic_0_to_near_1() {
        let mut t = timer();
        for _ in 0..90 {
            t.tick();
        }
        // ここから Incoming。残り 30→1 まで progress が単調増加する。
        let mut last = -1.0f32;
        for _ in 0..29 {
            let s = t.tick();
            let p = s.incoming_progress.expect("incoming phase has progress");
            assert!(p > last, "progress should increase: {p} > {last}");
            assert!((0.0..=1.0).contains(&p));
            last = p;
        }
    }

    #[test]
    fn skip_from_incoming_returns_to_work() {
        let mut t = timer();
        for _ in 0..90 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Incoming);
        let s = t.skip();
        assert!(s.phase_changed);
        assert_eq!(s.phase, Phase::Work);
        assert_eq!(s.remaining_secs, 120);
        assert_eq!(t.cycle(), 2);
    }

    #[test]
    fn skip_from_shower_returns_to_work() {
        let mut t = timer();
        for _ in 0..121 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Shower);
        let s = t.skip();
        assert_eq!(s.phase, Phase::Work);
        assert_eq!(s.remaining_secs, 120);
    }

    #[test]
    fn pause_freezes_time_and_phase() {
        let mut t = timer();
        t.tick();
        let before = t.remaining_secs();
        t.set_paused(true);
        for _ in 0..50 {
            let s = t.tick();
            assert!(s.paused);
            assert!(!s.phase_changed);
        }
        assert_eq!(t.remaining_secs(), before);
        // 再開すれば再び進む。
        t.set_paused(false);
        t.tick();
        assert_eq!(t.remaining_secs(), before - 1);
    }

    #[test]
    fn update_config_shrink_clamps_remaining() {
        let mut t = timer();
        // 作業中（残り 120）に作業を 1 分（60s）へ短縮 → 残りは 60 にクランプ。
        t.update_config(CycleConfig {
            work_secs: 60,
            break_secs: 30,
            sets: 0,
        });
        assert_eq!(t.remaining_secs(), 60);
    }

    #[test]
    fn update_config_grow_keeps_remaining() {
        let mut t = timer();
        for _ in 0..10 {
            t.tick();
        }
        let before = t.remaining_secs(); // 110
        t.update_config(CycleConfig {
            work_secs: 1800,
            break_secs: 300,
            sets: 0,
        });
        // 伸ばした場合は現在の残りを保持（クランプされない）。
        assert_eq!(t.remaining_secs(), before);
    }

    #[test]
    fn skip_repeatedly_is_stable() {
        let mut t = timer();
        for _ in 0..5 {
            let s = t.skip();
            assert_eq!(s.phase, Phase::Work);
            assert_eq!(s.remaining_secs, 120);
        }
        assert_eq!(t.cycle(), 6);
    }

    #[test]
    fn finishes_after_configured_sets() {
        let mut t = timer_with_sets(2);
        // 1 セット目（最終でない）= work(120)+break(60)+clearing(3) = 183 tick で
        // 2 セット目の作業へ。
        for _ in 0..183 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Work);
        assert_eq!(t.cycle(), 2);
        // 2 セット目（最終）は予兆も休憩も無く、作業の完了でセット終了。
        for _ in 0..119 {
            let s = t.tick();
            assert_eq!(s.phase, Phase::Work);
        }
        let last = t.tick(); // 作業 120 tick 目で満了。
        assert_eq!(last.phase, Phase::Finished);
        assert!(last.phase_changed);
        assert_eq!(t.cycle(), 2);
        assert_eq!(t.remaining_secs(), 0);
        assert_eq!(t.segment_total_secs(), 0);
    }

    #[test]
    fn last_set_has_no_incoming_and_finishes_at_work_end() {
        // セット数 1: 最初から最終セット。予兆に一切入らず、作業満了で終了。
        let mut t = timer_with_sets(1);
        let changes = collect_changes(&mut t, 120);
        let phases: Vec<Phase> = changes.iter().map(|(_, s)| s.phase).collect();
        assert_eq!(phases, vec![Phase::Finished]);
        assert_eq!(changes[0].0, 120); // 作業満了の tick でのみ遷移
        assert_eq!(t.cycle(), 1);
    }

    #[test]
    fn last_set_flag_tracks_final_set() {
        // セット数 1 は最初から最終セット。
        assert!(timer_with_sets(1).current().last_set);
        // セット数 2 の 1 セット目は最終でない。
        assert!(!timer_with_sets(2).current().last_set);
        // 無制限は常に最終でない。
        assert!(!timer().current().last_set);
    }

    #[test]
    fn finished_is_stable_until_skip() {
        let mut t = timer_with_sets(1);
        for _ in 0..120 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Finished);
        // 放置してもセット終了のまま動かない。
        for _ in 0..100 {
            let s = t.tick();
            assert_eq!(s.phase, Phase::Finished);
            assert!(!s.phase_changed);
        }
    }

    #[test]
    fn skip_from_finished_starts_new_session() {
        let mut t = timer_with_sets(1);
        for _ in 0..120 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Finished);
        let s = t.skip();
        assert!(s.phase_changed);
        assert_eq!(s.phase, Phase::Work);
        assert_eq!(s.remaining_secs, 120);
        assert_eq!(s.cycle, 1); // セットは 1 から数え直す
    }

    #[test]
    fn restart_resets_to_first_work() {
        let mut t = timer_with_sets(2);
        for _ in 0..183 {
            t.tick();
        }
        assert_eq!(t.cycle(), 2);
        // セット終了画面の「もう一度」: どこからでもセット 1 の作業へ。
        let s = t.restart();
        assert!(s.phase_changed);
        assert_eq!(s.phase, Phase::Work);
        assert_eq!(s.remaining_secs, 120);
        assert_eq!(s.cycle, 1);
    }

    #[test]
    fn skip_from_last_work_finishes() {
        // 最終セットの作業 Skip → 次の作業が無いのでセット終了。
        let mut t = timer_with_sets(1);
        let s = t.skip();
        assert_eq!(s.phase, Phase::Finished);
    }

    #[test]
    fn skip_from_non_last_work_advances_to_next_work() {
        // 非最終セットの作業 Skip → 休憩を飛ばして次の作業サイクルへ。
        let mut t = timer_with_sets(2);
        let s = t.skip();
        assert_eq!(s.phase, Phase::Work);
        assert_eq!(s.remaining_secs, 120);
        assert_eq!(t.cycle(), 2);
    }

    #[test]
    fn mid_session_clearing_is_short_and_not_flagged() {
        // セット途中の雨上がりは常に 3 秒で、last_set は立たない。
        let mut t = timer_with_sets(2);
        for _ in 0..180 {
            t.tick();
        }
        assert_eq!(t.phase(), Phase::Clearing);
        assert_eq!(t.remaining_secs(), CLEARING_SECS);
        assert_eq!(t.segment_total_secs(), CLEARING_SECS);
        assert!(!t.current().last_set);
    }

    #[test]
    fn reducing_sets_mid_session_finishes_at_next_work_end() {
        let mut t = timer_with_sets(0);
        for _ in 0..183 {
            t.tick();
        }
        assert_eq!(t.cycle(), 2);
        // 走行中にセット数を 1 へ減らす → すでに消化済み（cycle 2 ≥ 1）なので
        // この作業の完了でセット終了する（予兆にも入らない）。
        t.update_config(CycleConfig {
            work_secs: 120,
            break_secs: 60,
            sets: 1,
        });
        for _ in 0..119 {
            let s = t.tick();
            assert_eq!(s.phase, Phase::Work);
        }
        let s = t.tick();
        assert_eq!(s.phase, Phase::Finished);
    }

    #[test]
    fn phase_as_str_matches_event_names() {
        assert_eq!(Phase::Work.as_str(), "work");
        assert_eq!(Phase::Incoming.as_str(), "incoming");
        assert_eq!(Phase::Shower.as_str(), "shower");
        assert_eq!(Phase::Clearing.as_str(), "clearing");
        assert_eq!(Phase::Finished.as_str(), "finished");
    }
}
