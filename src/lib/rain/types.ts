// 雨レンダリングのバックエンド契約。
//
// 実装は raindrop-fx（WebGL2）の単一バックエンド。利用側 API（実装計画 §6）は
// 変えない。WebGL2 なし / prefers-reduced-motion / 初期化失敗は「雨なし」に
// 統一し、見せ方（静的ベール）は overlay ページの CSS が担う
// （フォールバック描画はしない。RainRenderer.isDegraded() で判定する）。

export interface RainOptions {
	/** 屈折元になる背景画像の URL（初期値。モードB が画面キャプチャで差し替える）。 */
	backgroundUrl?: string;
	/** 動きを抑制（prefers-reduced-motion）。true なら雨を初期化しない。 */
	reducedMotion?: boolean;
}

export interface RainBackend {
	init(canvas: HTMLCanvasElement, opts: RainOptions): Promise<void>;
	/** 雨脚の強さ（0..1）。実行時に何度でも更新できる。 */
	setIntensity(value: number): void;
	/**
	 * 屈折元の背景を実行時に差し替える（モードB: 画面キャプチャ）。
	 * data URL / 通常 URL のどちらも受け付ける。
	 */
	setBackground(url: string): Promise<void>;
	start(): void;
	stop(): void;
	/** CSS ピクセルでのリサイズ。 */
	resize(width: number, height: number): void;
	destroy(): void;
}
