// 窓ガラスを流れる雨の描画モジュール（フレームワーク非依存）。
//
// 実装計画 §6 に従い、Svelte に依存しない素の TS クラスとして実装し、
// `init / setIntensity / start / stop / destroy` の API を提供する。将来の
// ブラウザ版や WebGL（raindrop-fx）実装は **この同じインターフェイスの裏側**
// に差し替えられる。本実装は追加依存なしで動く Canvas2D の暫定版。
//
// - 背景は「ぼかした風景の静止画 1 枚」を屈折元に使う想定（モードA, §3.3）。
// - FPS 上限 30、被覆・非表示時は停止して省電力（§4）。
// - `prefers-reduced-motion` 時はアニメーションを止め静的表示にする（§4）。

export interface RainOptions {
	/** 屈折元になる背景画像の URL（モードA の静止画）。 */
	backgroundUrl?: string;
	/** FPS 上限。既定 30。 */
	fpsCap?: number;
	/** 動きを抑制（prefers-reduced-motion）。 */
	reducedMotion?: boolean;
}

interface Drop {
	x: number;
	y: number;
	r: number;
	/** 落下速度（px/s）。0 なら静止（窓に張り付いた粒）。 */
	vy: number;
	/** 尾の長さ。 */
	trail: number;
	life: number;
}

export class RainRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private bg: HTMLImageElement | null = null;
	private drops: Drop[] = [];
	private intensity = 0;
	private running = false;
	private rafId = 0;
	private lastFrame = 0;
	private lastSpawn = 0;
	private frameInterval: number;
	private reducedMotion: boolean;
	private dpr = 1;
	private resizeObserver: ResizeObserver | null = null;

	constructor(opts: RainOptions = {}) {
		this.frameInterval = 1000 / (opts.fpsCap ?? 30);
		this.reducedMotion = opts.reducedMotion ?? false;
	}

	/** キャンバスと背景を結びつける。 */
	async init(canvas: HTMLCanvasElement, opts: RainOptions = {}): Promise<void> {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		if (opts.fpsCap) this.frameInterval = 1000 / opts.fpsCap;
		if (opts.reducedMotion !== undefined) this.reducedMotion = opts.reducedMotion;
		this.resize();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(canvas);
		const url = opts.backgroundUrl;
		if (url) {
			this.bg = await loadImage(url).catch(() => null);
		}
		this.renderOnce();
	}

	/** 雨脚の強さ（0..1）。予兆＝0→強、通り雨＝1、雨上がり＝→0。 */
	setIntensity(value: number): void {
		this.intensity = clamp(value, 0, 1);
		if (this.reducedMotion) this.renderOnce();
	}

	getIntensity(): number {
		return this.intensity;
	}

	/** アニメーション開始。reduced-motion 時は静的表示に留める。 */
	start(): void {
		if (this.running) return;
		this.running = true;
		if (this.reducedMotion) {
			this.renderOnce();
			return;
		}
		this.lastFrame = performance.now();
		this.lastSpawn = this.lastFrame;
		this.rafId = requestAnimationFrame(this.loop);
	}

	/** アニメーション停止（省電力）。 */
	stop(): void {
		this.running = false;
		if (this.rafId) cancelAnimationFrame(this.rafId);
		this.rafId = 0;
	}

	/** 後始末。 */
	destroy(): void {
		this.stop();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.drops = [];
		this.canvas = null;
		this.ctx = null;
		this.bg = null;
	}

	private resize(): void {
		if (!this.canvas) return;
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = this.canvas.clientWidth || window.innerWidth;
		const h = this.canvas.clientHeight || window.innerHeight;
		this.canvas.width = Math.floor(w * this.dpr);
		this.canvas.height = Math.floor(h * this.dpr);
	}

	private loop = (now: number): void => {
		if (!this.running) return;
		this.rafId = requestAnimationFrame(this.loop);
		const elapsed = now - this.lastFrame;
		if (elapsed < this.frameInterval) return; // FPS 上限
		this.lastFrame = now - (elapsed % this.frameInterval);
		this.step((now - this.lastSpawn) / 1000, now);
		this.lastSpawn = now;
	};

	private step(dt: number, now: number): void {
		const { ctx, canvas } = this;
		if (!ctx || !canvas) return;
		const w = canvas.width;
		const h = canvas.height;

		this.drawBackground(ctx, w, h);

		// 強さに応じて生成。通り雨ほど多く・速く。
		const spawnRate = this.intensity * this.intensity * 6; // 0..6 個/フレーム目安
		if (Math.random() < spawnRate % 1 || spawnRate >= 1) {
			const count = Math.max(0, Math.floor(spawnRate));
			for (let i = 0; i <= count; i++) this.spawnDrop(w, h);
		}

		// 粒の更新と描画。
		ctx.save();
		for (const d of this.drops) {
			d.y += d.vy * dt * this.dpr;
			d.life -= dt;
			this.drawDrop(ctx, d);
		}
		ctx.restore();
		this.drops = this.drops.filter((d) => d.y - d.trail < h && d.life > 0);

		// 全体のしっとり感（強いほど画面を覆う）。
		void now;
	}

	private spawnDrop(w: number, h: number): void {
		const big = Math.random() < 0.15;
		const r = (big ? 6 + Math.random() * 8 : 2 + Math.random() * 4) * this.dpr;
		this.drops.push({
			x: Math.random() * w,
			y: -r,
			r,
			vy: (40 + Math.random() * 120) * (0.4 + this.intensity),
			trail: (big ? 60 + Math.random() * 120 : 20 + Math.random() * 50) * this.dpr,
			life: 4 + Math.random() * 4
		});
		void h;
	}

	private drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
		// [一時デモ] 透過確認用: 不透明な背景画像を描かず、透明にクリアして
		// 背後のデスクトップが雨越しに透けるかを目視確認する。
		// （本来は bg/default.png を屈折元に不透明描画＝モードA）
		ctx.clearRect(0, 0, w, h);
		// 軽いベール（強さに応じて少しだけ曇らせる。透過は保つ）。
		const veil = 0.02 + this.intensity * 0.12;
		ctx.fillStyle = `rgba(12, 17, 24, ${veil})`;
		ctx.fillRect(0, 0, w, h);
	}

	private drawDrop(ctx: CanvasRenderingContext2D, d: Drop): void {
		// 尾（流れた跡）。
		const grad = ctx.createLinearGradient(d.x, d.y - d.trail, d.x, d.y);
		grad.addColorStop(0, 'rgba(190, 210, 235, 0)');
		grad.addColorStop(1, `rgba(190, 210, 235, ${0.18 + this.intensity * 0.22})`);
		ctx.strokeStyle = grad;
		ctx.lineWidth = Math.max(1, d.r * 0.5);
		ctx.beginPath();
		ctx.moveTo(d.x, d.y - d.trail);
		ctx.lineTo(d.x, d.y);
		ctx.stroke();

		// 粒（簡易な屈折ハイライト）。
		ctx.beginPath();
		ctx.fillStyle = `rgba(220, 232, 245, ${0.35 + this.intensity * 0.25})`;
		ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
		ctx.fill();
		ctx.beginPath();
		ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
		ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.3, 0, Math.PI * 2);
		ctx.fill();
	}

	/** 1 フレームだけ描く（静止・初期表示・reduced-motion 用）。 */
	private renderOnce(): void {
		const { ctx, canvas } = this;
		if (!ctx || !canvas) return;
		this.drawBackground(ctx, canvas.width, canvas.height);
		if (this.reducedMotion && this.intensity > 0) {
			// 動かさず、まばらな静止した粒だけ描く。
			const n = Math.floor(this.intensity * 40);
			for (let i = 0; i < n; i++) {
				this.drawDrop(ctx, {
					x: Math.random() * canvas.width,
					y: Math.random() * canvas.height,
					r: (2 + Math.random() * 4) * this.dpr,
					vy: 0,
					trail: 0,
					life: 1
				});
			}
		}
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = url;
	});
}

function drawImageCover(
	ctx: CanvasRenderingContext2D,
	img: HTMLImageElement,
	w: number,
	h: number
): void {
	const ir = img.width / img.height;
	const cr = w / h;
	let dw = w;
	let dh = h;
	if (ir > cr) {
		dh = h;
		dw = h * ir;
	} else {
		dw = w;
		dh = w / ir;
	}
	ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
