// raindrop-fx（WebGL2）バックエンド — 窓ガラスの雨の本実装。
//
// 粒ごとの形状シミュレーション（合体・伸縮）、slip による蛇行滑落、
// 通過跡のトレイル滴、ガラスに張り付く微小滴、背景のぼかし屈折・ミストを
// ライブラリ側が担う。ここでは intensity(0..1) をパラメータ群へ写像する。
//
// 注意（ライブラリの性質）:
// - `new RaindropFX()` はコンストラクタで実 canvas の WebGL2 コンテキストを
//   取得する。以後その canvas では 2d コンテキストが取れないため、Canvas2D
//   へのフォールバック可否の判断はファサード側（preload まで＝構築前）。
// - `start()` は呼ぶたびにアセット読込＋新しい rAF ループを生成する。
//   多重起動やロード中の stop/destroy で壊れないよう、操作を直列化する。
// - `destroy()` は存在しない（stop/resize/setBackground のみ）。

import type RaindropFX from 'raindrop-fx';
import type { RainBackend, RainOptions } from './types';

type FxOptions = RaindropFX['options'];

export class RaindropFxBackend implements RainBackend {
	private static module: { default: new (o: Partial<FxOptions> & { canvas: HTMLCanvasElement }) => RaindropFX } | null =
		null;

	private fx: RaindropFX | null = null;
	/** 直前の操作の完了を待ってから次を実行するためのキュー。 */
	private queue: Promise<void> = Promise.resolve();
	/** 望ましい状態（start/stop の呼び出し履歴の最新）。 */
	private running = false;
	/** 実際に rAF ループが動いているか。 */
	private active = false;
	/** 一度でもアセット読込が完了したか（完了前の fx.resize() は背景未ロードで落ちる）。 */
	private loaded = false;
	private destroyed = false;
	private size: [number, number] | null = null;

	/**
	 * モジュール読込だけを先に済ませる。実 canvas には一切触れないため、
	 * ここで失敗しても Canvas2D フォールバックが可能。
	 */
	static async preload(): Promise<void> {
		RaindropFxBackend.module ??= await import('raindrop-fx');
	}

	async init(canvas: HTMLCanvasElement, opts: RainOptions = {}): Promise<void> {
		await RaindropFxBackend.preload();
		const Raindrop = RaindropFxBackend.module!.default;
		// raindrop-fx は構築時点の canvas.width/height を viewport に使う（CSS px・DPR 1）。
		canvas.width = canvas.clientWidth || window.innerWidth;
		canvas.height = canvas.clientHeight || window.innerHeight;
		// ここから先（WebGL コンテキスト取得後）の失敗は Canvas2D に切り替え不可。
		this.fx = new Raindrop({
			canvas,
			background: opts.backgroundUrl ?? '/bg/default.png',
			backgroundBlurSteps: 4,
			mist: true,
			mistColor: [0.01, 0.01, 0.02, 1],
			gravity: 2400,
			spawnSize: [30, 90],
			...intensityParams(0)
		});
	}

	setIntensity(value: number): void {
		if (!this.fx || this.destroyed) return;
		// simulator/renderer はこの options オブジェクトを参照し続けるため、
		// 直接書き換えるだけで次フレームから効く（README 記載の運用）。
		Object.assign(this.fx.options, intensityParams(clamp(value, 0, 1)));
	}

	start(): void {
		if (this.destroyed) return;
		this.running = true;
		this.queue = this.queue.then(async () => {
			if (this.destroyed || !this.running || this.active || !this.fx) return;
			try {
				await this.fx.start();
				this.active = true;
				this.loaded = true;
				// 読込中に届いたリサイズを反映。
				if (this.size) this.fx.resize(...this.size);
				// 読込完了までに stop() されていたら即停止。
				if (!this.running) {
					this.fx.stop();
					this.active = false;
				}
			} catch (e) {
				console.error('rain: raindrop-fx の開始に失敗しました。', e);
			}
		});
	}

	stop(): void {
		this.running = false;
		this.queue = this.queue.then(() => {
			if (this.active) {
				this.fx?.stop();
				this.active = false;
			}
		});
	}

	resize(width: number, height: number): void {
		if (this.destroyed) return;
		this.size = [width, height];
		this.queue = this.queue.then(() => {
			if (!this.destroyed && this.loaded && this.fx && this.size) {
				this.fx.resize(...this.size);
			}
		});
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.running = false;
		this.queue = this.queue.then(() => {
			if (this.active) {
				this.fx?.stop();
				this.active = false;
			}
			// ライブラリに destroy が無いため、GPU リソースはベストエフォートで解放。
			try {
				this.fx?.renderer.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
			} catch {
				// 解放失敗は無視（ウィンドウ破棄時に GC される）。
			}
			this.fx = null;
		});
	}
}

/**
 * intensity(0..1) → raindrop-fx パラメータの写像。
 * 生成系は k = i^2 で立ち上げ、終盤ほど一気に強まる（予兆の演出に合わせる）。
 * i=0 では新規生成がほぼ止まり、既存粒は蒸発・滑落だけになるため、
 * 雨上がりの 3 秒 tween が「雨が自然に止む」見えになる。
 *
 * option 名は node_modules/raindrop-fx/dist/*.d.ts で確認済み
 * （dropletsPerSeconds が正。README の dropletsPerSecond は誤記）。
 */
function intensityParams(i: number): Partial<FxOptions> {
	const k = i * i;
	return {
		spawnInterval: [lerp(2.5, 0.06, k), lerp(5.0, 0.15, k)],
		// README の性能目安（1080p/600 粒で 2-3ms/frame）に合わせた保守値。
		// Gate 3 の実機計測で余裕があれば 800〜1000 まで上げる余地あり。
		spawnLimit: Math.round(lerp(100, 600, i)),
		slipRate: lerp(0.05, 0.3, i),
		dropletsPerSeconds: lerp(2, 40, i),
		trailDropDensity: lerp(0.1, 0.25, i),
		evaporate: lerp(30, 10, i)
	};
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
