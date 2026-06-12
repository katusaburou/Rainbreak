// 窓ガラスを流れる雨の描画ファサード（フレームワーク非依存）。
//
// 実装計画 §6 に従い、Svelte に依存しない素の TS クラスとして
// `init / setIntensity / start / stop / destroy` の API を提供する。
// 裏側は raindrop-fx（WebGL2）の単一バックエンド: 粒ごとの不規則な形状・
// 蛇行滑落・トレイル滴・背景のぼかし屈折を持つ本実装
// （屈折元はモードA: `static/bg/` の静止画 → モードB: 画面キャプチャが差し替え）。
//
// 劣化方針: WebGL2 なし / prefers-reduced-motion / 初期化失敗は console に
// 明示した上で「雨なし」に統一する（isDegraded() が true になる）。
// その場合の見せ方（静的ベール）は overlay ページの CSS が担い、ここは
// canvas の opacity 制御を続けるだけ（ベールも同じフェードで現れ消えする）。
//
// 背景が不透明になるぶん、「予兆で現れて雨上がりで消える」見せ隠しは
// intensity に連動した canvas の opacity フェードとしてここで管理する。
// 省電力（§4）: 非表示時は visibilitychange で確実に停止する
// （raindrop-fx は内部 rAF 駆動。雨フェーズ外は完全停止で相殺）。

import type { RainBackend, RainOptions } from './types';

export type { RainOptions } from './types';

export class RainRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private backend: RainBackend | null = null;
	private intensity = 0;
	private maxOpacity = 1;
	private reducedMotion: boolean;
	private desiredRunning = false;
	private destroyed = false;
	private resizeObserver: ResizeObserver | null = null;

	constructor(opts: RainOptions = {}) {
		this.reducedMotion = opts.reducedMotion ?? false;
	}

	/** キャンバスと背景を結びつけ、バックエンドを初期化する。 */
	async init(canvas: HTMLCanvasElement, opts: RainOptions = {}): Promise<void> {
		this.canvas = canvas;
		if (opts.reducedMotion !== undefined) this.reducedMotion = opts.reducedMotion;
		const merged: RainOptions = {
			...opts,
			reducedMotion: this.reducedMotion
		};

		// 雨（劣化時は静的ベール）の見せ隠しフェード（setIntensity と連動）。
		canvas.style.opacity = '0';
		canvas.style.transition = 'opacity 250ms linear';

		if (this.reducedMotion) {
			// エラーではなく設定の尊重なので warn に留める。雨なし＝ベール表示へ。
			console.warn('rain: prefers-reduced-motion のため雨アニメーションを無効化します。');
		} else if (!supportsWebGL2()) {
			console.error('rain: WebGL2 が利用できないため雨表現を無効化します（静的ベール表示）。');
		} else {
			let backend: import('./RaindropFxBackend').RaindropFxBackend | null = null;
			try {
				const mod = await import('./RaindropFxBackend');
				backend = new mod.RaindropFxBackend();
				await backend.init(canvas, merged); // ここで WebGL コンテキストを取得
				this.backend = backend;
			} catch (e) {
				// 取得済みの GPU リソースはベストエフォートで解放し、雨なしに統一。
				backend?.destroy();
				console.error('rain: raindrop-fx の初期化に失敗。雨表現を無効化します（静的ベール表示）。', e);
			}
		}

		this.backend?.setIntensity(this.intensity);
		this.applyOpacity();

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.canvas) return;
			this.backend?.resize(
				this.canvas.clientWidth || window.innerWidth,
				this.canvas.clientHeight || window.innerHeight
			);
		});
		this.resizeObserver.observe(canvas);
		document.addEventListener('visibilitychange', this.onVisibility);
	}

	/** 雨脚の強さ（0..1）。予兆＝0→強、通り雨＝1、雨上がり＝→0。 */
	setIntensity(value: number): void {
		this.intensity = clamp(value, 0, 1);
		this.backend?.setIntensity(this.intensity);
		this.applyOpacity();
	}

	getIntensity(): number {
		return this.intensity;
	}

	/**
	 * 雨バックエンドが無い＝劣化モードか（init 完了後に有効）。
	 * true のときは overlay ページが canvas に静的ベール（CSS）を出す。
	 */
	isDegraded(): boolean {
		return this.backend === null;
	}

	/**
	 * キャンバス全体の不透明度の上限（0..1）。
	 *
	 * 予兆中は 1 未満に抑えて背後のライブ画面を読めるようにし（作業継続可）、
	 * 通り雨で 1 に上げて「ガラスが現れきる」。`fadeMs` はその切替の所要時間で、
	 * 通り雨入りのガラス出現だけ長め（既定 250ms）を渡す。
	 */
	setMaxOpacity(cap: number, fadeMs = 250): void {
		this.maxOpacity = clamp(cap, 0, 1);
		this.applyOpacity(fadeMs);
	}

	/** 屈折元背景の差し替え（モードB: 画面キャプチャ）。 */
	async setBackground(url: string): Promise<void> {
		await this.backend?.setBackground(url);
	}

	/**
	 * すりガラスの度合い（通り雨で frosted=true）。背景ぼかしを深め、水滴の
	 * 屈折・陰影・ハイライトを立てて「ガラスに付いた雫」を際立たせる。予兆は
	 * false で背景を読める控えめなぼかしに戻す。劣化モードでは無効（背景なし）。
	 */
	setGlass(frosted: boolean): void {
		this.backend?.setGlass(frosted);
	}

	/** アニメーション開始。非表示中は visibilitychange の復帰時に始める。 */
	start(): void {
		this.desiredRunning = true;
		if (document.visibilityState !== 'hidden') this.backend?.start();
	}

	/** アニメーション停止（省電力）。 */
	stop(): void {
		this.desiredRunning = false;
		this.backend?.stop();
	}

	/** 後始末。 */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.desiredRunning = false;
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.backend?.destroy();
		this.backend = null;
		this.canvas = null;
	}

	// 被覆・非表示時は確実に止める（§4）。復帰時は望ましい状態を再適用する。
	// バックエンド側の二重起動ガードと合わせ、連続発火しても rAF は重複しない。
	private onVisibility = (): void => {
		if (this.destroyed) return;
		if (document.visibilityState === 'hidden') {
			this.backend?.stop();
		} else if (this.desiredRunning) {
			this.backend?.start();
		}
	};

	// 予兆の序盤（intensity 0→0.3）で maxOpacity まで現れ、雨上がりの終盤で消える。
	// work 中は intensity 0 → opacity 0 でデスクトップが完全に見える。
	// 雨上がりの 3 秒 tween（30fps）を追従させるため、フェードは既定 250ms に留める
	// （長くすると Work 遷移の overlay 非表示時にまだ濃いまま切れて「パッ」と消える）。
	private applyOpacity(fadeMs = 250): void {
		if (!this.canvas) return;
		this.canvas.style.transition = `opacity ${fadeMs}ms linear`;
		this.canvas.style.opacity = String(Math.min(1, this.intensity / 0.3) * this.maxOpacity);
	}
}

function supportsWebGL2(): boolean {
	// 実 canvas で試すと以後 2d コンテキストが取れなくなるため、
	// 必ず使い捨ての canvas で判定する。
	try {
		return !!document.createElement('canvas').getContext('webgl2');
	} catch {
		return false;
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
