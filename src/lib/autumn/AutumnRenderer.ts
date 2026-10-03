interface Leaf {
	x: number;
	y: number;
	size: number;
	speed: number;
	drift: number;
	angle: number;
	spin: number;
	sway: number;
	depth: number;
	sprite: number;
}

// 葉の輪郭・葉脈を一度だけ描いて再利用する。画像素材や WebGL は不要。
const PALETTE = [
	['#f4a554', '#be4023', '#7f251e'],
	['#ed6a43', '#b72d2c', '#72251e'],
	['#ffd278', '#df8b2e', '#aa491e'],
	['#ee9950', '#d35728', '#8d301e'],
	['#d96649', '#98372f', '#592920']
];

export class AutumnRenderer {
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private sprites: HTMLCanvasElement[] = [];
	private leaves: Leaf[] = [];
	private width = 1;
	private height = 1;
	private intensity = 0;
	private maxOpacity = 1;
	private running = false;
	private frame: number | null = null;
	private previousTime = 0;
	private elapsed = 0;
	private observer: ResizeObserver | null = null;

	constructor(private reducedMotion = false) {}

	init(canvas: HTMLCanvasElement): void {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.sprites = PALETTE.map(makeSprite);
		this.resize();
		this.applyOpacity();
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(canvas);
		document.addEventListener('visibilitychange', this.onVisibility);
	}

	setIntensity(value: number): void {
		this.intensity = Math.min(1, Math.max(0, value));
		this.applyOpacity();
		if (this.reducedMotion && this.running && document.visibilityState !== 'hidden') this.draw();
	}

	setMaxOpacity(value: number, fadeMs = 250): void {
		this.maxOpacity = Math.min(1, Math.max(0, value));
		this.applyOpacity(fadeMs);
	}

	start(): void {
		this.running = true;
		if (document.visibilityState !== 'hidden') {
			this.draw();
			this.requestFrame();
		}
	}

	stop(): void {
		this.running = false;
		this.cancelFrame();
	}

	destroy(): void {
		this.stop();
		this.observer?.disconnect();
		this.observer = null;
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.ctx?.clearRect(0, 0, this.width, this.height);
		this.leaves = [];
		this.sprites = [];
		this.canvas = null;
		this.ctx = null;
	}

	private resize(): void {
		if (!this.canvas) return;
		const oldWidth = this.width;
		const oldHeight = this.height;
		this.width = this.canvas.clientWidth || window.innerWidth;
		this.height = this.canvas.clientHeight || window.innerHeight;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.round(this.width * dpr);
		this.canvas.height = Math.round(this.height * dpr);
		this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
		for (const leaf of this.leaves) {
			leaf.x *= this.width / oldWidth;
			leaf.y *= this.height / oldHeight;
		}
		const count = Math.min(100, Math.max(24, Math.round(this.width * this.height / 18000)));
		this.leaves.length = Math.min(this.leaves.length, count);
		while (this.leaves.length < count) this.leaves.push(this.createLeaf(true));
		if (this.running) this.draw();
	}

	private createLeaf(scatter = false): Leaf {
		const depth = Math.random();
		return {
			x: Math.random() * (this.width + 160) - 80,
			y: scatter ? Math.random() * (this.height + 100) - 80 : -70 - Math.random() * 80,
			size: 18 + depth * 29,
			speed: 24 + depth * 37 + Math.random() * 12,
			drift: 5 + Math.random() * 16,
			angle: Math.random() * Math.PI * 2,
			spin: (Math.random() - 0.5) * 0.85,
			sway: Math.random() * Math.PI * 2,
			depth,
			sprite: Math.floor(Math.random() * PALETTE.length)
		};
	}

	private applyOpacity(fadeMs = 250): void {
		if (!this.canvas) return;
		this.canvas.style.transition = `opacity ${fadeMs}ms linear`;
		this.canvas.style.opacity = String(Math.min(1, this.intensity / 0.3) * this.maxOpacity);
	}

	private requestFrame(): void {
		if (!this.running || this.reducedMotion || !this.ctx || this.frame !== null) return;
		this.frame = requestAnimationFrame(this.animate);
	}

	private cancelFrame(): void {
		if (this.frame !== null) cancelAnimationFrame(this.frame);
		this.frame = null;
		this.previousTime = 0;
	}

	private onVisibility = (): void => {
		if (document.visibilityState === 'hidden') this.cancelFrame();
		else if (this.running) {
			this.draw();
			this.requestFrame();
		}
	};

	private animate = (now: number): void => {
		this.frame = null;
		const dt = this.previousTime ? Math.min((now - this.previousTime) / 1000, 0.05) : 0;
		this.previousTime = now;
		this.elapsed += dt;
		for (let i = 0; i < this.leaves.length; i++) {
			const leaf = this.leaves[i];
			leaf.y += leaf.speed * dt;
			leaf.x += (leaf.drift + Math.sin(this.elapsed * 0.7 + leaf.sway) * 26) * dt;
			leaf.angle += leaf.spin * dt;
			if (leaf.x > this.width + 80) leaf.x = -80;
			if (leaf.x < -80) leaf.x = this.width + 80;
			if (leaf.y > this.height + 70) this.leaves[i] = this.createLeaf();
		}
		this.draw();
		this.requestFrame();
	};

	private draw(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.width, this.height);
		for (let i = 0; i < this.leaves.length; i++) {
			const leaf = this.leaves[i];
			// 予兆は葉を順にフェードイン。単純な枚数切替による点滅を避ける。
			const reveal = Math.min(1, Math.max(0, (this.intensity * 1.15 - i / this.leaves.length) / 0.15));
			if (!reveal) continue;
			const fold = Math.cos(this.elapsed * (0.65 + leaf.depth * 0.45) + leaf.sway);
			ctx.save();
			ctx.translate(leaf.x, leaf.y);
			ctx.rotate(leaf.angle + Math.sin(this.elapsed * 0.85 + leaf.sway) * 0.3);
			ctx.scale(fold < 0 ? -Math.max(0.18, -fold) : Math.max(0.18, fold), 1);
			ctx.globalAlpha = reveal * (0.48 + leaf.depth * 0.42) * (fold < 0 ? 0.8 : 1);
			ctx.drawImage(this.sprites[leaf.sprite], -leaf.size / 2, -leaf.size / 2, leaf.size, leaf.size);
			ctx.restore();
		}
	}
}

function makeSprite(colors: string[]): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 128;
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;
	ctx.translate(64, 65);
	const outline = new Path2D(
		'M 0 31 L -12 37 L -11 24 L -29 30 L -26 18 L -49 13 ' +
		'L -40 5 L -55 -10 L -37 -10 L -40 -21 L -19 -12 ' +
		'L -26 -40 L -14 -33 L -14 -45 L -6 -36 L 0 -59 ' +
		'L 6 -36 L 14 -45 L 14 -33 L 26 -40 L 19 -12 ' +
		'L 40 -21 L 37 -10 L 55 -10 L 40 5 L 49 13 ' +
		'L 26 18 L 29 30 L 11 24 L 12 37 Z'
	);
	const gradient = ctx.createLinearGradient(-25, -45, 25, 38);
	gradient.addColorStop(0, colors[0]);
	gradient.addColorStop(0.55, colors[1]);
	gradient.addColorStop(1, colors[2]);
	ctx.fillStyle = gradient;
	ctx.fill(outline);
	ctx.strokeStyle = colors[2];
	ctx.lineWidth = 0.8;
	ctx.stroke(outline);
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.moveTo(0, 27);
	ctx.quadraticCurveTo(4, 43, -3, 56);
	ctx.lineWidth = 1.8;
	ctx.stroke();
	ctx.strokeStyle = 'rgba(255, 216, 148, 0.46)';
	ctx.lineWidth = 1;
	for (const [x, y] of [[0, -50], [-22, -32], [22, -32], [-45, -8], [45, -8], [-35, 15], [35, 15]]) {
		ctx.beginPath();
		ctx.moveTo(0, 27);
		ctx.quadraticCurveTo(x * 0.3, 0, x, y);
		ctx.stroke();
	}
	return canvas;
}
