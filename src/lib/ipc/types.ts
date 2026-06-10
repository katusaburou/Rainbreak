// Rust コア（src-tauri）とやり取りするイベント／コマンドの型。
// Rust 側のペイロードと **フィールド名を一致** させること（serde）。

/** 4 フェーズ。Rust の `Phase::as_str()` と一致。 */
export type Phase = 'work' | 'incoming' | 'shower' | 'clearing';

/** `phase-changed` イベント。フェーズ遷移時に各窓が見た目を切り替える。 */
export interface PhaseChanged {
	phase: Phase;
	remaining_secs: number;
	cycle: number;
}

/** `tick` イベント。毎秒。HUD バーの充填率・トレイ残り時間に使う。 */
export interface Tick {
	phase: Phase;
	remaining_secs: number;
	/** 現在セグメントの総量（残り割合の分母）。 */
	segment_total_secs: number;
}

/** `incoming-progress` イベント。予兆の雨漸増（0→1）。 */
export interface IncomingProgress {
	p: number;
}

/** 永続化される設定（要件 §3.6：最小）。 */
export interface AppConfig {
	work_min: number;
	break_min: number;
	/** 0.0..=1.0 */
	volume: number;
	muted: boolean;
	autostart: boolean;
	/** HUD バーの不透明度 0.1..=1.0（1 = 透過なし）。 */
	hud_opacity: number;
}
