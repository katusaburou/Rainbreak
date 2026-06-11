// 雨音と雨上がりの余韻（Web Audio）。実装計画 §8 に対応。
//
// 追加アセット無しで動くよう、フィルタした擬似ピンクノイズで雨音を合成する。
// 通り雨開始でフェードイン、雨上がりでフェードアウト。音量／ミュートは設定値に従う。
// 最終セットの雨上がりでは、雨が引いたあとに軒先の雫と遠くの鳥の声を合成で鳴らす。
// 将来、録音ループ素材に差し替える場合もこの API の裏側で完結する。

export class RainAudio {
	private ctx: AudioContext | null = null;
	/** 音量・ミュートを反映するマスター。雨のフェードとは独立に保つ
	 *  （フェードアウト後の余韻もここを通すことでミュート・音量に従う）。 */
	private master: GainNode | null = null;
	/** 雨音のフェードイン／アウト用（0..1）。 */
	private rainGain: GainNode | null = null;
	private source: AudioBufferSourceNode | null = null;
	private filter: BiquadFilterNode | null = null;
	/** 余韻（雫・鳥）でスケジュール済みの音源。キャンセル用に保持する。 */
	private afterglowSources: OscillatorNode[] = [];
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
			this.master.gain.value = this.targetGain();
			this.master.connect(this.ctx.destination);
			this.rainGain = this.ctx.createGain();
			this.rainGain.gain.value = 0; // 雨は無音から始める
			this.rainGain.connect(this.master);
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

	/** 雨音を起動し、`duration` 秒かけてフェードイン。 */
	fadeIn(duration = 2): void {
		const ctx = this.ensureContext();
		if (!this.started) {
			this.source = this.buildNoiseSource(ctx);
			this.filter = ctx.createBiquadFilter();
			this.filter.type = 'lowpass';
			this.filter.frequency.value = 1800;
			this.source.connect(this.filter);
			this.filter.connect(this.rainGain!);
			this.source.start();
			this.started = true;
		}
		this.rampGain(this.rainGain, 1, duration);
	}

	/** 雨音を `duration` 秒かけてフェードアウトし、停止。 */
	fadeOut(duration = 2): void {
		if (!this.ctx || !this.rainGain) return;
		this.rampGain(this.rainGain, 0, duration);
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

	/**
	 * 雨上がりの余韻（最終セット用・案3）: `delaySecs` 後（＝雨のフェードアウト
	 * 完了の頃）から、軒先の雫の滴りと遠くの鳥のさえずりをまばらに鳴らす。
	 * すべて master を通るので音量・ミュート設定に従う。
	 */
	playAfterglow(delaySecs = 0): void {
		const ctx = this.ensureContext();
		this.cancelAfterglow();
		const t0 = ctx.currentTime + delaySecs;
		// 雫: 間隔を少しずつ広げながら数滴（雨樋から落ちる残り雫のイメージ）。
		let t = t0 + 0.4 + Math.random() * 0.5;
		for (let i = 0; i < 4; i++) {
			this.scheduleDrip(t, 900 + Math.random() * 700, 0.1 + Math.random() * 0.05);
			t += 0.7 + i * 0.45 + Math.random() * 0.6;
		}
		// 鳥: 雫の合間に、遠くで 1〜2 フレーズだけ。
		this.scheduleChirp(t0 + 1.8 + Math.random() * 0.8, 0.045);
		if (Math.random() < 0.7) {
			this.scheduleChirp(t0 + 4.0 + Math.random() * 1.2, 0.03);
		}
	}

	/** スケジュール済みの余韻を止める（Skip やフェーズ移行で呼ぶ）。 */
	cancelAfterglow(): void {
		for (const osc of this.afterglowSources) {
			try {
				osc.stop();
			} catch {
				/* 既に停止 */
			}
		}
		this.afterglowSources = [];
	}

	/** 雫一滴。サイン波の音程を素早く落としてから戻す「ぴちょん」。 */
	private scheduleDrip(at: number, baseFreq: number, level: number): void {
		if (!this.ctx || !this.master) return;
		const osc = this.ctx.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(baseFreq, at);
		osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, at + 0.04);
		osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.7, at + 0.16);
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0, at);
		g.gain.linearRampToValueAtTime(level, at + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
		osc.connect(g);
		g.connect(this.master);
		osc.start(at);
		osc.stop(at + 0.35);
		this.trackAfterglow(osc, g);
	}

	/** 遠くの鳥のさえずり一フレーズ（3 音）。ローパスで距離感を出す。 */
	private scheduleChirp(at: number, level: number): void {
		if (!this.ctx || !this.master) return;
		const notes: Array<[number, number, number]> = [
			[3100, 3800, 0.09],
			[3600, 2800, 0.07],
			[2900, 3500, 0.13]
		];
		let t = at;
		for (const [f0, f1, dur] of notes) {
			const osc = this.ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.setValueAtTime(f0, t);
			osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
			const g = this.ctx.createGain();
			g.gain.setValueAtTime(0, t);
			g.gain.linearRampToValueAtTime(level, t + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
			const lp = this.ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = 4500;
			osc.connect(g);
			g.connect(lp);
			lp.connect(this.master);
			osc.start(t);
			osc.stop(t + dur + 0.1);
			this.trackAfterglow(osc, lp);
			t += dur + 0.06 + Math.random() * 0.05;
		}
	}

	/** 余韻の音源を登録し、鳴り終わったらグラフから外す。 */
	private trackAfterglow(osc: OscillatorNode, tail: AudioNode): void {
		this.afterglowSources.push(osc);
		osc.onended = () => {
			tail.disconnect();
			const i = this.afterglowSources.indexOf(osc);
			if (i >= 0) this.afterglowSources.splice(i, 1);
		};
	}

	setVolume(v: number): void {
		this.volume = Math.min(1, Math.max(0, v));
		this.rampGain(this.master, this.targetGain(), 0.2);
	}

	setMuted(m: boolean): void {
		this.muted = m;
		this.rampGain(this.master, this.targetGain(), 0.2);
	}

	private targetGain(): number {
		return this.muted ? 0 : this.volume;
	}

	private rampGain(node: GainNode | null, value: number, duration: number): void {
		if (!this.ctx || !node) return;
		const now = this.ctx.currentTime;
		node.gain.cancelScheduledValues(now);
		node.gain.setValueAtTime(node.gain.value, now);
		node.gain.linearRampToValueAtTime(value, now + Math.max(0.01, duration));
	}

	destroy(): void {
		this.cancelAfterglow();
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
		this.rainGain = null;
		this.filter = null;
	}
}
