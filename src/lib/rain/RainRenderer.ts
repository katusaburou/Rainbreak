// 窓ガラスを流れる雨の描画ファサード（フレームワーク非依存）。
//
// 実装計画 §6 に従い、Svelte に依存しない素の TS クラスとして
// `init / setIntensity / start / stop / destroy` の API を提供する。
// 裏側のバックエンドはこのファサードが選択する:
//
// - 既定: raindrop-fx（WebGL2）。粒ごとの不規則な形状・蛇行滑落・トレイル滴・
//   背景のぼかし屈折を持つ本実装（モードA: `static/bg/` の静止画を屈折元に使う）。
// - フォールバック: Canvas2D 簡易版。WebGL2 が無い環境と
//   `prefers-reduced-motion`（静的表示）で使う。
//
// フォールバック境界: 一度 WebGL コンテキストを取った canvas は 2d コンテキストを
// 返さないため、Canvas2D へ切り替えられるのは「実 canvas にコンテキストを取る前」
// の失敗（WebGL2 判定・モジュール読込）まで。raindrop-fx はコンストラクタで
// コンテキストを取るので、構築以降の失敗時はエラーを記録し雨なし（透明）に留める。
//
// 背景が不透明になるぶん、「予兆で現れて雨上がりで消える」見せ隠しは
// intensity に連動した canvas の opacity フェードとしてここで管理する。
// 省電力（§4）: 非表示時は visibilitychange で確実に停止し、FPS 上限は
// Canvas2D 側のみ（raindrop-fx は内部 rAF。雨フェーズ外は完全停止で相殺）。

import type { RainBackend, RainOptions } from './types';

export type { RainOptions } from './types';

export class RainRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private backend: RainBackend | null = null;
	private intensity = 0;
	private fpsCap: number | undefined;
	private reducedMotion: boolean;
	private desiredRunning = false;
	private destroyed = false;
	private resizeObserver: ResizeObserver | null = null;

	constructor(opts: RainOptions = {}) {
		this.fpsCap = opts.fpsCap;
		this.reducedMotion = opts.reducedMotion ?? false;
	}

	/** キャンバスと背景を結びつけ、バックエンドを選択する。 */
	async init(canvas: HTMLCanvasElement, opts: RainOptions = {}): Promise<void> {
		this.canvas = canvas;
		if (opts.fpsCap) this.fpsCap = opts.fpsCap;
		if (opts.reducedMotion !== undefined) this.reducedMotion = opts.reducedMotion;
		const merged: RainOptions = {
			...opts,
			fpsCap: this.fpsCap,
			reducedMotion: this.reducedMotion
		};

		// 不透明な窓ガラス描画の見せ隠しフェード（setIntensity と連動）。
		canvas.style.opacity = '0';
		canvas.style.transition = 'opacity 250ms linear';

		let webglPoisoned = false;
		if (!this.reducedMotion && supportsWebGL2()) {
			let Backend: typeof import('./RaindropFxBackend').RaindropFxBackend | null = null;
			try {
				// モジュール読込までは実 canvas に触れない（失敗しても Canvas2D へ行ける）。
				const mod = await import('./RaindropFxBackend');
				await mod.RaindropFxBackend.preload();
				Backend = mod.RaindropFxBackend;
			} catch (e) {
				console.warn('rain: raindrop-fx の読込に失敗。Canvas2D にフォールバックします。', e);
			}
			if (Backend) {
				const backend = new Backend();
				try {
					await backend.init(canvas, merged); // ここで WebGL コンテキストを取得
					this.backend = backend;
				} catch (e) {
					// コンテキスト取得後の失敗: canvas は 2d を返せないため雨なしに留める。
					console.error('rain: raindrop-fx の初期化に失敗。雨表現を無効化します。', e);
					backend.destroy();
					webglPoisoned = true;
				}
			}
		}
		if (!this.backend && !webglPoisoned) {
			const { Canvas2DRainBackend } = await import('./Canvas2DRainBackend');
			this.backend = new Canvas2DRainBackend();
			await this.backend.init(canvas, merged);
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

	// 予兆の序盤（intensity 0→0.3）でガラスが現れきり、雨上がりの終盤で消える。
	// work 中は intensity 0 → opacity 0 でデスクトップが完全に見える。
	private applyOpacity(): void {
		if (!this.canvas) return;
		this.canvas.style.opacity = String(Math.min(1, this.intensity / 0.3));
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
