// raindrop-fx（WebGL2）バックエンド — 窓ガラスの雨の本実装。
//
// 粒ごとの形状シミュレーション（合体・伸縮）、slip による蛇行滑落、
// 通過跡のトレイル滴、ガラスに張り付く微小滴、背景のぼかし屈折・ミストを
// ライブラリ側が担う。ここでは intensity(0..1) をパラメータ群へ写像する。
//
// 注意（ライブラリの性質）:
// - `new RaindropFX()` はコンストラクタで実 canvas の WebGL2 コンテキストを
//   取得する。構築以降の失敗はファサード側が「雨なし（静的ベール）」に倒す。
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

	/** モジュール読込だけを先に済ませる（実 canvas には触れない）。 */
	static async preload(): Promise<void> {
		RaindropFxBackend.module ??= await import('raindrop-fx');
	}

	async init(canvas: HTMLCanvasElement, opts: RainOptions = {}): Promise<void> {
		await RaindropFxBackend.preload();
		const Raindrop = RaindropFxBackend.module!.default;
		// raindrop-fx は構築時点の canvas.width/height を viewport に使う（CSS px・DPR 1）。
		canvas.width = canvas.clientWidth || window.innerWidth;
		canvas.height = canvas.clientHeight || window.innerHeight;
		// ここで WebGL コンテキストを取得する。以降の失敗はファサードが雨なしに倒す。
		this.fx = new Raindrop({
			canvas,
			background: opts.backgroundUrl ?? '/bg/default.png',
			// 画面キャプチャ背景（モードB）でデスクトップの文字が読める程度に
			// ぼかしは控えめ（既定 3。4 だと作業画面の判別が難しい）。
			backgroundBlurSteps: 3,
			mist: true,
			mistColor: [0.01, 0.01, 0.02, 1],
			gravity: 2400,
			spawnSize: [30, 90],
			// --- 水滴の輪郭強調（既定値からひと回り強く） ---
			// エッジのスムージング幅を狭めて輪郭線をくっきりさせる（既定 [0.96, 1.0]）。
			smoothRaindrop: [0.97, 0.995],
			// 法線の平坦化を弱め（既定 1）、縁の陰影＝立体感を出す。
			raindropLightBump: 0.6,
			// 拡散光を少し明るくしてリムライトを見えやすく（既定 [0.2,0.2,0.2]）。
			raindropDiffuseLight: [0.35, 0.35, 0.4],
			// 影をわずかに増やし下縁の輪郭を締める（既定 0.8）。
			raindropShadowOffset: 0.85,
			// 粒内部の屈折を強めて背景とのコントラストを上げる（既定 0.6）。
			refractScale: 0.7,
			...intensityParams(0)
		});
	}

	setIntensity(value: number): void {
		if (!this.fx || this.destroyed) return;
		// simulator/renderer はこの options オブジェクトを参照し続けるため、
		// 直接書き換えるだけで次フレームから効く（README 記載の運用）。
		Object.assign(this.fx.options, intensityParams(clamp(value, 0, 1)));
	}

	setGlass(frosted: boolean): void {
		if (!this.fx || this.destroyed) return;
		// 屈折・陰影・スペキュラは options 参照なので次フレームで効く。
		// backgroundBlurSteps / mistBlurStep はテクスチャ再生成を伴うため、
		// 反映は次の setBackground（通り雨は 2.5 秒間隔のキャプチャ）から。
		Object.assign(this.fx.options, glassParams(frosted));
	}

	setBackground(url: string): Promise<void> {
		// 初回 start()（loadAssets）前に fx.setBackground を呼ぶとテクスチャ未生成で
		// 落ちるため、resize と同じく loaded をゲートに直列化する。
		// 未ロード時は options.background の差し替えだけで済ませ、start() 時に読ませる。
		const run = this.queue.then(async () => {
			if (this.destroyed || !this.fx) return;
			if (this.loaded) {
				await this.fx.setBackground(url);
			} else {
				this.fx.options.background = url;
			}
		});
		// キューは失敗でも繋がるように握りつぶし、呼び出し元へはエラーを返す。
		this.queue = run.catch(() => {});
		return run;
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
 *
 * 生成間隔は等比（幾何）補間 × k=i^2 で詰める。線形補間だと生成レート
 * （= 1/間隔）の増加が最終盤に集中し、予兆 30 秒の序盤〜中盤がほぼ無雨に
 * 見えるため、レートが一定倍率で伸びる等比にして「降り始めから少しずつ
 * 強くなる」体感を作る。始点は等比の素直な値（2.5s）の 1/3 ＝予兆の雨量
 * 約 3 倍（終点＝通り雨へ向けて滑らかに 1 倍へ収束する）。
 * 目安: 開始直後 ~0.8s に1粒 → 15 秒で ~0.36s → 25 秒で ~0.08s →
 * 通り雨 0.03s。雨上がりは同じ曲線を逆に下るので「自然に止む」見えも
 * 保たれる。i=0 は生成が最も疎（work では stop 済みで描画なし）。
 *
 * option 名は node_modules/raindrop-fx/dist/*.d.ts で確認済み
 * （dropletsPerSeconds が正。README の dropletsPerSecond は誤記）。
 */
function intensityParams(i: number): Partial<FxOptions> {
	const k = i * i;
	return {
		// 上端（i=1 ＝ 通り雨）は初期値の 2 倍の雨量。
		// spawnLimit 1200 はライブラリ推奨上限（<2000）の範囲内で、
		// README の性能目安（1080p/600 粒で 2-3ms/frame）から ~4-6ms/frame 想定。
		spawnInterval: [expLerp(2.5 / 3, 0.03, k), expLerp(5.0 / 3, 0.075, k)],
		spawnLimit: Math.round(lerp(100, 1200, i)),
		slipRate: lerp(0.05, 0.3, i),
		// 微小滴も予兆 3 倍に合わせて始点を引き上げ（終点は通り雨の値のまま）。
		dropletsPerSeconds: lerp(6, 80, i),
		trailDropDensity: lerp(0.1, 0.25, i),
		evaporate: lerp(30, 10, i)
	};
}

/**
 * すりガラス度の写像。通り雨（frosted=true）は背景ぼかしを一段深くして板
 * ガラスの曇りを出し、水滴側は屈折・立体感・スペキュラを強めて「ガラスに
 * 付いた雫」を際立たせる。予兆（false）は背景を読める控えめな値（init の
 * 構築時パラメータと同値）へ戻し、クリックスルー中の作業継続を妨げない。
 *
 * backgroundBlurSteps / mistBlurStep の変更はぼかしテクスチャの再生成を伴う
 * ため、次の setBackground（モードB は降雨中 2.5 秒間隔で更新）で反映される。
 * refractScale / raindropLightBump / スペキュラは options 参照なので次フレーム
 * で効く。
 */
function glassParams(frosted: boolean): Partial<FxOptions> {
	return frosted
		? {
				backgroundBlurSteps: 4, // すりガラス（背景をひと回り曇らせる）
				mistBlurStep: 5, // 推奨 = backgroundBlurSteps + 1
				refractScale: 0.85, // 雫越しの像をくっきり屈折
				raindropLightBump: 0.5, // 法線を立て、縁の陰影＝立体感を強める
				raindropSpecularLight: [0.45, 0.5, 0.58], // 雫が光を拾う淡いハイライト
				raindropSpecularShininess: 180
			}
		: {
				backgroundBlurSteps: 3, // 背景が読める控えめなぼかし
				mistBlurStep: 4,
				refractScale: 0.7,
				raindropLightBump: 0.6,
				raindropSpecularLight: [0, 0, 0], // ハイライトなし
				raindropSpecularShininess: 256
			};
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** 等比補間（a, b > 0）。レート系パラメータを体感が滑らかな倍率変化で動かす。 */
function expLerp(a: number, b: number, t: number): number {
	return a * Math.pow(b / a, t);
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
