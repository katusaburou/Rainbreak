// 雨レンダリングのバックエンド共通契約。
//
// RainRenderer（ファサード）がこの契約の裏側で WebGL（raindrop-fx）と
// Canvas2D の 2 実装を差し替える。利用側 API（実装計画 §6）は変えない。

export interface RainOptions {
	/** 屈折元になる背景画像の URL（モードA の静止画）。 */
	backgroundUrl?: string;
	/** FPS 上限。既定 30。Canvas2D バックエンドのみ有効（raindrop-fx は内部 rAF 駆動）。 */
	fpsCap?: number;
	/** 動きを抑制（prefers-reduced-motion）。 */
	reducedMotion?: boolean;
}

export interface RainBackend {
	init(canvas: HTMLCanvasElement, opts: RainOptions): Promise<void>;
	/** 雨脚の強さ（0..1）。実行時に何度でも更新できる。 */
	setIntensity(value: number): void;
	start(): void;
	stop(): void;
	/** CSS ピクセルでのリサイズ。 */
	resize(width: number, height: number): void;
	destroy(): void;
}
