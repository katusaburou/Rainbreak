// 雨音（Web Audio）。実装計画 §8 に対応。
//
// 追加アセット無しで動くよう、フィルタした擬似ピンクノイズで雨音を合成する。
// 通り雨開始でフェードイン、雨上がりでフェードアウト。音量／ミュートは設定値に従う。
// 将来、録音ループ素材に差し替える場合もこの API の裏側で完結する。

export class RainAudio {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private source: AudioBufferSourceNode | null = null;
	private filter: BiquadFilterNode | null = null;
	private volume = 0.6;
	private muted = false;
	private started = false;

	/** AudioContext を生成（ユーザー操作後に呼ぶのが安全）。 */
	private ensureContext(): AudioContext {
		if (!this.ctx) {
			const Ctor: typeof AudioContext =
				window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			this.ctx = new Ctor();
			this.master = this.ctx.createGain();
			this.master.gain.value = 0; // 無音から始める
			this.master.connect(this.ctx.destination);
		}
		return this.ctx;
	}

	/** 自動再生制約対策: 初回ユーザー操作時に resume する。 */
	async resume(): Promise<void> {
		const ctx = this.ensureContext();
		if (ctx.state === 'suspended') await ctx.resume();
	}

	private buildNoiseSource(ctx: AudioContext): AudioBufferSourceNode {
		const seconds = 2;
		const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
		const data = buffer.getChannelData(0);
		// 簡易ピンクノイズ（Paul Kellet 法の軽量版）。
		let b0 = 0,
			b1 = 0,
			b2 = 0;
		for (let i = 0; i < data.length; i++) {
			const white = Math.random() * 2 - 1;
			b0 = 0.99765 * b0 + white * 0.099;
			b1 = 0.963 * b1 + white * 0.2965;
			b2 = 0.57 * b2 + white * 1.0526;
			data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
		}
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		src.loop = true;
		return src;
	}

	/** 音源を起動し、`duration` 秒かけてフェードイン。 */
	fadeIn(duration = 2): void {
		const ctx = this.ensureContext();
		if (!this.started) {
			this.source = this.buildNoiseSource(ctx);
			this.filter = ctx.createBiquadFilter();
			this.filter.type = 'lowpass';
			this.filter.frequency.value = 1800;
			this.source.connect(this.filter);
			this.filter.connect(this.master!);
			this.source.start();
			this.started = true;
		}
		this.rampTo(this.targetGain(), duration);
	}

	/** `duration` 秒かけてフェードアウトし、停止。 */
	fadeOut(duration = 2): void {
		if (!this.ctx || !this.master) return;
		this.rampTo(0, duration);
		const src = this.source;
		window.setTimeout(
			() => {
				try {
					src?.stop();
				} catch {
					/* 既に停止 */
				}
				if (src === this.source) {
					this.source = null;
					this.started = false;
				}
			},
			duration * 1000 + 100
		);
	}

	setVolume(v: number): void {
		this.volume = Math.min(1, Math.max(0, v));
		if (this.started) this.rampTo(this.targetGain(), 0.2);
	}

	setMuted(m: boolean): void {
		this.muted = m;
		if (this.started) this.rampTo(this.targetGain(), 0.2);
	}

	private targetGain(): number {
		return this.muted ? 0 : this.volume;
	}

	private rampTo(value: number, duration: number): void {
		if (!this.ctx || !this.master) return;
		const now = this.ctx.currentTime;
		this.master.gain.cancelScheduledValues(now);
		this.master.gain.setValueAtTime(this.master.gain.value, now);
		this.master.gain.linearRampToValueAtTime(value, now + Math.max(0.01, duration));
	}

	destroy(): void {
		try {
			this.source?.stop();
		} catch {
			/* noop */
		}
		this.source = null;
		this.started = false;
		void this.ctx?.close();
		this.ctx = null;
		this.master = null;
		this.filter = null;
	}
}
