<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { RainRenderer } from '$lib/rain';
	import { RainAudio } from '$lib/audio';
	import { prefersReducedMotion } from '$lib/motion';
	import {
		onPhaseChanged,
		onIncomingProgress,
		onConfigChanged,
		onTick,
		getConfig,
		skipBreak,
		restartSession,
		quitApp,
		captureScreen,
		type Phase
	} from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	let canvas: HTMLCanvasElement;
	let phase = $state<Phase>('work');
	// 通り雨中だけ表示する休憩の残り時間（秒）。tick で毎秒更新する。
	let remainingSecs = $state(0);
	// セット終了画面に出す「やり切ったセット数」（= 最終セットの通し番号）。
	let finishedSets = $state(0);
	// 雨が描けない劣化モード（WebGL2 なし / reduced-motion / 初期化失敗）。
	// canvas に CSS の静的ベールを出して「通り雨中」を可視化する。
	let degraded = $state(false);
	// 最終セットの雨上がりに架かる虹（案1）。表示中だけ DOM に置く。
	let rainbow = $state(false);
	let rain: RainRenderer | null = null;
	let audio: RainAudio | null = null;
	let clearingTimer: ReturnType<typeof setInterval> | null = null;
	const unlisten: UnlistenFn[] = [];

	const CLEARING_SECS = 3; // Rust の CLEARING_SECS と一致
	const FINAL_CLEARING_SECS = 10; // Rust の FINAL_CLEARING_SECS と一致（虹のタイムライン）

	// 予兆（休憩 30 秒前〜）のガラス不透明度の上限。1 未満に抑えることで、
	// クリックスルーと合わせて背後のライブ画面が読める＝作業を続けられる。
	const INCOMING_MAX_OPACITY = 0.45;
	// 通り雨入りでガラスが現れきるまでのフェード時間。
	const SHOWER_GLASS_FADE_MS = 1200;
	// 画面キャプチャ（屈折元背景）の更新間隔。雨ガラス越しの像を実画面に追従させる。
	const CAPTURE_REFRESH_MS = 2500;

	let captureTimer: ReturnType<typeof setInterval> | null = null;
	let captureInFlight = false;
	let captureFailures = 0;

	// 現在のディスプレイ表示を取り込み、雨ガラスの屈折元背景を差し替える（モードB）。
	// Tauri 外（ブラウザプレビュー）や旧バックエンドでは失敗するので、
	// 連続失敗でループを止めて静止画（モードA）のまま続行する。
	async function refreshBackground() {
		if (captureInFlight || !rain) return;
		captureInFlight = true;
		try {
			const dataUrl = await captureScreen();
			await rain.setBackground(dataUrl);
			captureFailures = 0;
		} catch (e) {
			if (++captureFailures >= 3) {
				console.warn('rain: 画面キャプチャに失敗。静止画背景のまま続行します。', e);
				stopCaptureLoop();
			}
		} finally {
			captureInFlight = false;
		}
	}

	function startCaptureLoop() {
		// 劣化モードでは屈折元背景の使い道が無いのでキャプチャ自体を省く。
		if (captureTimer || degraded) return;
		captureFailures = 0;
		void refreshBackground();
		captureTimer = setInterval(() => void refreshBackground(), CAPTURE_REFRESH_MS);
	}

	function stopCaptureLoop() {
		if (captureTimer) {
			clearInterval(captureTimer);
			captureTimer = null;
		}
	}

	function stopClearingTween() {
		if (clearingTimer) {
			clearInterval(clearingTimer);
			clearingTimer = null;
		}
	}

	function applyPhase(next: Phase) {
		phase = next;
		if (!rain) return;
		stopClearingTween();
		// 虹と余韻はセット終了画面限定。他フェーズへ移ったら引っ込める。
		rainbow = false;
		audio?.cancelAfterglow();
		switch (next) {
			case 'work':
				stopCaptureLoop();
				rain.setIntensity(0);
				rain.stop();
				audio?.fadeOut(1.5);
				break;
			case 'finished':
				// セット終了画面: 雨は止め、雨上がりの虹を架けて余韻を鳴らす。
				// overlay は Rust 側（windows.rs）が全画面・クリック可で表示する。
				stopCaptureLoop();
				rain.setIntensity(0);
				rain.stop();
				audio?.fadeOut(1.5);
				rainbow = true;
				audio?.playAfterglow(CLEARING_SECS);
				break;
			case 'incoming':
				// 強さは incoming-progress で 0→1 に動かす。
				// ガラスは半透明上限に抑え、背景は実画面のキャプチャに切り替える
				// （クリックスルー ON と合わせて、降り始めの 30 秒は作業を続けられる）。
				// すりガラスは控えめ（背景が読める）にして作業継続を妨げない。
				rain.setMaxOpacity(INCOMING_MAX_OPACITY);
				rain.setGlass(false);
				startCaptureLoop();
				rain.setIntensity(0);
				rain.start();
				break;
			case 'shower':
				// ガラスを現れきらせる。背景キャプチャは引き続き追従させ、
				// 「いまの画面がガラス越しに雨に濡れている」見えにする。
				// すりガラスを一段深め、水滴を際立たせる（setGlass は次回の
				// キャプチャ反映前に呼び、直後の background 更新へ効かせる）。
				rain.setGlass(true);
				rain.setMaxOpacity(1, SHOWER_GLASS_FADE_MS);
				startCaptureLoop();
				rain.setIntensity(1);
				rain.start();
				void audio?.resume().then(() => audio?.fadeIn(2));
				break;
			case 'clearing': {
				// 雨・音を CLEARING_SECS かけてフェードアウト。背景は最後の像で固定。
				stopCaptureLoop();
				rain.setMaxOpacity(1);
				rain.start();
				audio?.fadeOut(CLEARING_SECS);
				const from = rain.getIntensity() || 1;
				const start = performance.now();
				clearingTimer = setInterval(() => {
					const t = (performance.now() - start) / (CLEARING_SECS * 1000);
					const v = Math.max(0, from * (1 - t));
					rain?.setIntensity(v);
					if (t >= 1) {
						stopClearingTween();
						rain?.stop();
					}
				}, 1000 / 30);
				// 雨上がりは常にセット途中（最終セットは休憩を挟まずセット終了へ）。
				// 虹と余韻はセット終了画面（finished）が担う。
				break;
			}
		}
	}

	// 残り秒を m:ss に整形（通り雨の残り時間表示用）。
	function fmtTime(total: number): string {
		const s = Math.max(0, Math.floor(total));
		const m = Math.floor(s / 60);
		return `${m}:${String(s % 60).padStart(2, '0')}`;
	}

	function onKeydown(e: KeyboardEvent) {
		// 通り雨／予兆は Esc で切り上げ（Rust 側のグローバルショートカットと二重化）。
		if (e.key === 'Escape' && (phase === 'shower' || phase === 'incoming')) {
			void skipBreak();
		}
	}

	onMount(async () => {
		const reduced = prefersReducedMotion();
		rain = new RainRenderer({ reducedMotion: reduced });
		await rain.init(canvas, { backgroundUrl: '/bg/default.png', reducedMotion: reduced });
		degraded = rain.isDegraded();
		audio = new RainAudio();
		// 保存済みの音量／ミュートを初回の通り雨より前に反映する
		// （config-changed を待たず、起動直後の最初の休憩でも設定が効くように）。
		try {
			const cfg = await getConfig();
			audio.setVolume(cfg.volume);
			audio.setMuted(cfg.muted);
		} catch {
			// Tauri 外（ブラウザプレビュー）では既定値のまま。
		}

		try {
			unlisten.push(
				await onPhaseChanged((p) => {
					// セット終了画面の「X セット完了」に使う通し番号を控える。
					if (p.phase === 'finished') finishedSets = p.cycle;
					applyPhase(p.phase);
				})
			);
			unlisten.push(
				await onIncomingProgress((p) => {
					if (phase === 'incoming') rain?.setIntensity(p.p);
				})
			);
			unlisten.push(
				await onTick((t) => {
					// 通り雨の残り時間だけ拾う（他フェーズの表示はしない）。
					if (t.phase === 'shower') remainingSecs = t.remaining_secs;
				})
			);
			unlisten.push(
				await onConfigChanged((c) => {
					audio?.setVolume(c.volume);
					audio?.setMuted(c.muted);
				})
			);
		} catch {
			// Tauri 外（ブラウザプレビュー）ではイベント購読に失敗し得る。続行する。
		}
		window.addEventListener('keydown', onKeydown);

		// [dev プレビュー] Tauri 外では phase イベントが来ないため、
		// ?phase=shower などのクエリでフェーズを手動再現できるようにする。
		// ?phase=finished&sets=4 でセット終了画面（虹・選択肢）も確認できる。
		if (dev && !('__TAURI_INTERNALS__' in window)) {
			const params = new URLSearchParams(location.search);
			const p = params.get('phase');
			if (
				p === 'work' ||
				p === 'incoming' ||
				p === 'shower' ||
				p === 'clearing' ||
				p === 'finished'
			) {
				// Tauri 外では tick が来ないため、表示のプレビュー用に種を置く。
				if (p === 'shower') remainingSecs = Number(params.get('remaining')) || 300;
				if (p === 'finished') finishedSets = Number(params.get('sets')) || 4;
				applyPhase(p);
			}
		}
	});

	onDestroy(() => {
		stopClearingTween();
		stopCaptureLoop();
		for (const u of unlisten) u();
		window.removeEventListener('keydown', onKeydown);
		rain?.destroy();
		audio?.destroy();
	});
</script>

<div class="overlay">
	<canvas bind:this={canvas} class:degraded></canvas>

	<!-- セット終了の暗転（虹より下に敷く）。虹は screen 合成で上に乗る。 -->
	{#if phase === 'finished'}
		<div class="finish-dim"></div>
	{/if}

	{#if rainbow}
		<div class="rainbow" style:animation-duration={`${FINAL_CLEARING_SECS}s`}></div>
	{/if}

	{#if phase === 'shower'}
		<div class="remaining">
			<span class="time">{fmtTime(remainingSecs)}</span>
			<span class="label">休憩中</span>
		</div>
		<div class="escape">
			<button onclick={() => skipBreak()}>この通り雨をやり過ごす（Skip）</button>
			<p class="hint">Esc でも作業に戻れます</p>
		</div>
	{/if}

	<!-- セット終了画面: 虹を背に「もう一度／終了」を選ばせる。 -->
	{#if phase === 'finished'}
		<div class="finish-card">
			<p class="finish-title">おつかれさま</p>
			{#if finishedSets > 0}
				<p class="finish-sub">{finishedSets} セット、やり切りました</p>
			{/if}
			<div class="finish-actions">
				<button class="primary" onclick={() => restartSession()}>もう一度</button>
				<button class="ghost" onclick={() => quitApp()}>終了</button>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent;
		overflow: hidden;
	}
	.overlay {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	/* 劣化モードの静的ベール（アニメなし）。雨が描けなくても「いまは通り雨で
	   クリックが遮断されている」ことを可視化する。現れ方・消え方は通常時と
	   同じ canvas の opacity 制御（intensity × maxOpacity）に乗る。 */
	canvas.degraded {
		background: linear-gradient(180deg, rgba(13, 18, 26, 0.72), rgba(22, 31, 44, 0.88));
	}
	/* セット終了画面に架かる、ぼんやりした虹。画面下のさらに下を中心とする
	   大円の上弧だけを見せる。動きは opacity のみなので reduced-motion でも
	   穏やか。劣化モードでも出す（CSS のみで描ける）。終了画面は留まるので
	   フェードインして保持する（消えない）。 */
	.rainbow {
		position: absolute;
		inset: 0;
		pointer-events: none;
		/* 光として加算的に乗せる。暗い画面ほどよく見え、明るい画面ではほのかに残る。 */
		mix-blend-mode: screen;
		background: radial-gradient(
			circle 110vh at 50% 150vh,
			transparent 85%,
			rgba(167, 139, 250, 0.4) 87%,
			rgba(125, 211, 252, 0.5) 89%,
			rgba(134, 239, 172, 0.5) 91%,
			rgba(253, 224, 71, 0.55) 93%,
			rgba(251, 146, 60, 0.55) 94.5%,
			rgba(252, 165, 165, 0.45) 96.5%,
			transparent 98.5%
		);
		filter: blur(9px) saturate(1.25);
		opacity: 0;
		animation-name: rainbow-arc;
		animation-timing-function: ease-in-out;
		animation-fill-mode: forwards;
		/* animation-duration はマークアップ側で FINAL_CLEARING_SECS に同期 */
	}
	/* ゆっくり架かり、そのまま留まる（終了画面が続く間ずっと見える）。 */
	@keyframes rainbow-arc {
		0% {
			opacity: 0;
		}
		35% {
			opacity: 1;
		}
		100% {
			opacity: 1;
		}
	}
	/* 通り雨中の残り時間。雨ガラス越しに浮かぶ、控えめで滲んだ表示。
	   クリックは奪わない（pointer-events: none）。 */
	.remaining {
		position: absolute;
		left: 50%;
		top: 30vh;
		transform: translateX(-50%);
		text-align: center;
		color: #eef4fc;
		font-family: system-ui, sans-serif;
		user-select: none;
		pointer-events: none;
		text-shadow: 0 2px 22px rgba(0, 0, 0, 0.5);
	}
	.remaining .time {
		display: block;
		font-size: 4.6rem;
		font-weight: 200;
		line-height: 1;
		letter-spacing: 0.04em;
		font-variant-numeric: tabular-nums;
	}
	.remaining .label {
		display: block;
		margin-top: 0.6rem;
		font-size: 0.9rem;
		letter-spacing: 0.4em;
		opacity: 0.7;
	}
	.escape {
		position: absolute;
		left: 50%;
		bottom: 8vh;
		transform: translateX(-50%);
		text-align: center;
		color: #dbe6f3;
		font-family: system-ui, sans-serif;
		user-select: none;
	}
	button {
		background: rgba(20, 28, 40, 0.55);
		color: #eaf1fb;
		border: 1px solid rgba(190, 210, 235, 0.35);
		border-radius: 999px;
		padding: 0.7rem 1.6rem;
		font-size: 1rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition: background 0.2s ease;
	}
	button:hover {
		background: rgba(40, 52, 70, 0.7);
	}
	.hint {
		margin: 0.6rem 0 0;
		font-size: 0.8rem;
		opacity: 0.7;
	}

	/* セット終了の暗転。雨上がりの空のように、上は澄み下はほのかに暗い。
	   虹（screen 合成）はこの上に乗るので、虹を沈ませないよう控えめに。 */
	.finish-dim {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: linear-gradient(180deg, rgba(12, 18, 28, 0.55), rgba(8, 12, 20, 0.78));
		animation: finish-fade 0.8s ease forwards;
	}
	/* セット終了画面のカード（中央）。クリックを受ける唯一の要素。 */
	.finish-card {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		text-align: center;
		color: #eef4fc;
		font-family: system-ui, sans-serif;
		user-select: none;
		animation: finish-rise 0.9s ease forwards;
	}
	/* 虹の明るい帯に文字が重なっても読めるよう、カード背後にソフトな暗がりを敷く。 */
	.finish-card::before {
		content: '';
		position: absolute;
		inset: -56px -96px;
		z-index: -1;
		pointer-events: none;
		background: radial-gradient(ellipse at center, rgba(8, 12, 20, 0.62), transparent 72%);
	}
	.finish-title {
		margin: 0;
		font-size: 2.4rem;
		font-weight: 300;
		letter-spacing: 0.08em;
		text-shadow: 0 2px 24px rgba(0, 0, 0, 0.55);
	}
	.finish-sub {
		margin: 0.8rem 0 0;
		font-size: 1rem;
		letter-spacing: 0.12em;
		opacity: 0.8;
	}
	.finish-actions {
		margin-top: 2.2rem;
		display: flex;
		gap: 1rem;
		justify-content: center;
	}
	/* 「もう一度」は主アクションとして少し強調、「終了」は控えめ。 */
	.finish-actions .primary {
		background: rgba(120, 150, 200, 0.32);
		border-color: rgba(200, 220, 245, 0.5);
		font-size: 1.05rem;
		padding: 0.8rem 2rem;
	}
	.finish-actions .primary:hover {
		background: rgba(140, 172, 222, 0.46);
	}
	.finish-actions .ghost {
		background: rgba(20, 28, 40, 0.4);
	}
	@keyframes finish-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes finish-rise {
		from {
			opacity: 0;
			transform: translate(-50%, calc(-50% + 12px));
		}
		to {
			opacity: 1;
			transform: translate(-50%, -50%);
		}
	}
</style>
