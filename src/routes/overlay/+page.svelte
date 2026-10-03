<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { RainRenderer } from '$lib/rain';
	import { AutumnRenderer } from '$lib/autumn/AutumnRenderer';
	import { RainAudio } from '$lib/audio';
	import { prefersReducedMotion } from '$lib/motion';
	import {
		onPhaseChanged,
		onIncomingProgress,
		onTick,
		onConfigChanged,
		getConfig,
		skipBreak,
		captureScreen,
		type Phase,
		type Ambience,
		type ColorMode
	} from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	let canvas: HTMLCanvasElement;
	let autumnCanvas: HTMLCanvasElement;
	let ambience = $state<Ambience>('rain');
	let colorMode = $state<ColorMode>('dark');
	let preview = $state(false);
	let phase = $state<Phase>('work');
	let autoPaused = $state(false);
	// 雨が描けない劣化モード（WebGL2 なし / reduced-motion / 初期化失敗）。
	// canvas に CSS の静的ベールを出して「通り雨中」を可視化する。
	let degraded = $state(false);
	// 最終セットの雨上がりに架かる虹（案1）。表示中だけ DOM に置く。
	let rainbow = $state(false);
	let rainbowElapsed = $state(0);
	let rain: RainRenderer | null = null;
	let autumn: AutumnRenderer | null = null;
	let lastSetActive = false;
	let remaining: number | undefined;
	let audio: RainAudio | null = null;
	let clearingTimer: ReturnType<typeof setInterval> | null = null;
	const unlisten: UnlistenFn[] = [];

	const CLEARING_SECS = 3; // Rust の CLEARING_SECS と一致
	const FINAL_CLEARING_SECS = 10; // Rust の FINAL_CLEARING_SECS と一致（虹のタイムライン）
	const INCOMING_LEAD_SECS = 30; // Rust の INCOMING_LEAD_SECS と一致

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
		if (captureInFlight || !rain || ambience !== 'rain') return;
		captureInFlight = true;
		try {
			const dataUrl = await captureScreen();
			if (ambience !== 'rain') return;
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
		if (captureTimer || degraded || ambience !== 'rain') return;
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

	function applyPhase(next: Phase, lastSet = false, remainingSecs?: number, pausedAutomatically = false) {
		phase = next;
		autoPaused = pausedAutomatically;
		lastSetActive = lastSet;
		remaining = remainingSecs;
		const scenery = ambience === 'autumn' ? autumn : rain;
		if (!scenery) return;
		stopClearingTween();
		// 虹と余韻は雨上がり（最終セット）限定。他フェーズへ移ったら引っ込める。
		rainbow = false;
		audio?.cancelAfterglow();
		if (autoPaused) {
			stopCaptureLoop();
			scenery.stop();
			audio?.fadeOut(0.2);
			return;
		}
		switch (next) {
			case 'work':
			// セット終了は今のところ作業と同じ退避のみ（終了演出はここに差し込む）。
			case 'finished':
				stopCaptureLoop();
				scenery.setIntensity(0);
				scenery.stop();
				audio?.fadeOut(1.5);
				break;
			case 'incoming':
				// 強さは incoming-progress で 0→1 に動かす。
				// ガラスは半透明上限に抑え、背景は実画面のキャプチャに切り替える
				// （クリックスルー ON と合わせて、降り始めの 30 秒は作業を続けられる）。
				scenery.setMaxOpacity(INCOMING_MAX_OPACITY);
				startCaptureLoop();
				scenery.setIntensity(Math.max(0, Math.min(1,
					(INCOMING_LEAD_SECS - (remainingSecs ?? INCOMING_LEAD_SECS)) / INCOMING_LEAD_SECS)));
				scenery.start();
				break;
			case 'shower':
				// ガラスを現れきらせる。背景キャプチャは引き続き追従させ、
				// 「いまの画面がガラス越しに雨に濡れている」見えにする。
				scenery.setMaxOpacity(1, SHOWER_GLASS_FADE_MS);
				startCaptureLoop();
				scenery.setIntensity(1);
				scenery.start();
				if (ambience === 'rain') {
					void audio?.resume().then(() => {
						if (phase === 'shower' && !autoPaused && ambience === 'rain') audio?.fadeIn(2);
					});
				}
				break;
			case 'clearing': {
				// 雨・音を CLEARING_SECS かけてフェードアウト。背景は最後の像で固定。
				stopCaptureLoop();
				scenery.setMaxOpacity(1);
				scenery.start();
				audio?.fadeOut(CLEARING_SECS);
				// 自動停止からの復帰でも Rust の残り秒から演出位置を再現する。
				const total = lastSet ? FINAL_CLEARING_SECS : CLEARING_SECS;
				const elapsed = remainingSecs === undefined ? 0 : Math.max(0, total - remainingSecs);
				const start = performance.now() - elapsed * 1000;
				scenery.setIntensity(Math.max(0, 1 - elapsed / CLEARING_SECS));
				clearingTimer = setInterval(() => {
					const t = (performance.now() - start) / (CLEARING_SECS * 1000);
					const v = Math.max(0, 1 - t);
					scenery.setIntensity(v);
					if (t >= 1) {
						stopClearingTween();
						scenery.stop();
					}
				}, 1000 / 30);
				// 最終セットの雨上がり（FINAL_CLEARING_SECS）: 雨が引いたあとに
				// 虹を架け（案1）、雫と遠くの鳥の余韻を鳴らす（案3）。
				if (lastSet) {
					rainbow = true;
					rainbowElapsed = elapsed;
					if (ambience === 'rain') audio?.playAfterglow(Math.max(0, CLEARING_SECS - elapsed));
				}
				break;
			}
		}
	}

	function setAmbience(next: Ambience) {
		if (next === ambience) return;
		stopCaptureLoop();
		rain?.stop();
		autumn?.stop();
		audio?.fadeOut(0.3);
		ambience = next;
		applyPhase(phase, lastSetActive, remaining, autoPaused);
	}

	function onKeydown(e: KeyboardEvent) {
		// 通り雨／予兆は Esc で切り上げ（Rust 側のグローバルショートカットと二重化）。
		if (!autoPaused && e.key === 'Escape' && (phase === 'shower' || phase === 'incoming')) {
			skipCurrentBreak();
		}
	}

	function skipCurrentBreak() {
		if (dev && !('__TAURI_INTERNALS__' in window)) applyPhase('work');
		else void skipBreak();
	}

	onMount(async () => {
		const reduced = prefersReducedMotion();
		rain = new RainRenderer({ reducedMotion: reduced });
		await rain.init(canvas, { backgroundUrl: '/bg/default.png', reducedMotion: reduced });
		degraded = rain.isDegraded();
		autumn = new AutumnRenderer(reduced);
		autumn.init(autumnCanvas);
		audio = new RainAudio();
		// 保存済みの音量／ミュートを初回の通り雨より前に反映する
		// （config-changed を待たず、起動直後の最初の休憩でも設定が効くように）。
		try {
			const cfg = await getConfig();
			colorMode = cfg.color_mode ?? 'dark';
			setAmbience(cfg.ambience ?? 'rain');
			audio.setVolume(cfg.volume);
			audio.setMuted(cfg.muted);
		} catch {
			// Tauri 外（ブラウザプレビュー）では既定値のまま。
		}

		try {
			unlisten.push(await onPhaseChanged((p) => applyPhase(p.phase, p.last_set, p.remaining_secs, p.auto_paused)));
			unlisten.push(await onTick((t) => { remaining = t.remaining_secs; }));
			unlisten.push(
				await onIncomingProgress((p) => {
					if (phase === 'incoming' && !autoPaused) {
						(ambience === 'autumn' ? autumn : rain)?.setIntensity(p.p);
					}
				})
			);
			unlisten.push(
				await onConfigChanged((c) => {
					colorMode = c.color_mode ?? 'dark';
					setAmbience(c.ambience ?? 'rain');
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
		// ?phase=clearing&last=1 で最終セットの虹・余韻も確認できる。
		if (dev && !('__TAURI_INTERNALS__' in window)) {
			preview = true;
			const params = new URLSearchParams(location.search);
			colorMode = params.get('mode') === 'light' ? 'light' : 'dark';
			setAmbience(params.get('ambience') === 'autumn' ? 'autumn' : 'rain');
			const p = params.get('phase');
			if (
				p === 'work' ||
				p === 'incoming' ||
				p === 'shower' ||
				p === 'clearing' ||
				p === 'finished'
			) {
				const parsed = Number(params.get('remaining'));
				const previewRemaining = params.has('remaining') && Number.isFinite(parsed) ? parsed : undefined;
				applyPhase(p, params.get('last') === '1', previewRemaining);
			}
		}
	});

	onDestroy(() => {
		stopClearingTween();
		stopCaptureLoop();
		for (const u of unlisten) u();
		window.removeEventListener('keydown', onKeydown);
		rain?.destroy();
		autumn?.destroy();
		audio?.destroy();
	});
</script>

<div class="overlay" class:auto-paused={autoPaused} class:autumn={ambience === 'autumn'} class:light={colorMode === 'light'}>
	<canvas bind:this={canvas} class:degraded class:inactive={ambience !== 'rain'} aria-hidden="true"></canvas>
	<canvas bind:this={autumnCanvas} class="leaves" class:inactive={ambience !== 'autumn'} aria-hidden="true"></canvas>

	{#if rainbow}
		<div class="rainbow" class:autumn-light={ambience === 'autumn'} style:animation-duration={`${FINAL_CLEARING_SECS}s`} style:animation-delay={`${-rainbowElapsed}s`}></div>
	{/if}

	{#if preview && ambience === 'autumn'}
		<div class="mode-switch" role="group" aria-label="カラーモードのプレビュー">
			<button aria-pressed={colorMode === 'dark'} onclick={() => colorMode = 'dark'}>ダーク</button>
			<button aria-pressed={colorMode === 'light'} onclick={() => colorMode = 'light'}>ホワイト</button>
		</div>
	{/if}

	{#if phase === 'shower' && !autoPaused}
		<div class="escape">
			<button onclick={skipCurrentBreak}>{ambience === 'autumn' ? '紅葉のひと休みを終える（Skip）' : 'この通り雨をやり過ごす（Skip）'}</button>
			<p class="hint">Esc でも作業に戻れます</p>
		</div>
	{/if}
</div>

<style>
	.overlay.auto-paused {
		visibility: hidden;
	}
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
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
	}
	canvas.inactive {
		visibility: hidden;
	}
	canvas.leaves {
		/* canvas の opacity に乗せ、予兆は透過・休憩は背景色・終了時は透明に戻す。 */
		background: radial-gradient(ellipse at 75% 8%, rgba(158, 90, 40, 0.19), transparent 65%),
			linear-gradient(180deg, #1d1c20, #101116);
	}
	.light canvas.leaves {
		background: radial-gradient(ellipse at 75% 8%, rgba(237, 181, 88, 0.13), transparent 65%),
			linear-gradient(180deg, #fffefb, #f4efe7);
	}
	.autumn .escape {
		color: #f5dfbe;
	}
	.autumn button {
		background: rgba(61, 35, 24, 0.7);
		border-color: rgba(236, 188, 123, 0.45);
		color: #fff0d9;
	}
	.autumn button:hover {
		background: rgba(94, 51, 30, 0.85);
	}
	.autumn .hint {
		width: max-content;
		margin: 0.6rem auto 0;
		padding: 0.3rem 0.75rem;
		border-radius: 999px;
		background: rgba(61, 35, 24, 0.7);
		opacity: 1;
	}
	.light .escape {
		color: #594334;
	}
	.light button {
		background: rgba(255, 253, 248, 0.94);
		border-color: #cfc1ae;
		color: #513a2c;
	}
	.light button:hover {
		background: #f1e6d5;
	}
	.light .hint {
		background: rgba(255, 253, 248, 0.9);
		color: #685341;
		opacity: 1;
	}
	.mode-switch {
		position: absolute;
		top: 1.5rem;
		right: 1.5rem;
		display: flex;
		gap: 0.25rem;
		padding: 0.25rem;
		border: 1px solid rgba(214, 183, 143, 0.25);
		border-radius: 999px;
		background: #1e1a18;
		font-family: system-ui, sans-serif;
	}
	.mode-switch button {
		border: 1px solid transparent;
		background: transparent;
		padding: 0.45rem 0.9rem;
		font-size: 0.8rem;
		color: #b9a38c;
	}
	.mode-switch button[aria-pressed='true'] {
		background: #4f3827;
		color: #fff0d9;
	}
	.light .mode-switch {
		background: #fffdf8;
		border-color: #d7cdbd;
	}
	.light .mode-switch button {
		color: #796553;
	}
	.light .mode-switch button[aria-pressed='true'] {
		background: #eee2cf;
		color: #513a2c;
	}
	button:focus-visible {
		outline: 2px solid #c99657;
		outline-offset: 4px;
	}
	/* 劣化モードの静的ベール（アニメなし）。雨が描けなくても「いまは通り雨で
	   クリックが遮断されている」ことを可視化する。現れ方・消え方は通常時と
	   同じ canvas の opacity 制御（intensity × maxOpacity）に乗る。 */
	canvas.degraded {
		background: linear-gradient(180deg, rgba(13, 18, 26, 0.72), rgba(22, 31, 44, 0.88));
	}
	/* 通り雨をすべてやり過ごした最終セットだけに架かる、ぼんやりした虹。
	   画面下のさらに下を中心とする大円の上弧だけを見せる。動きは opacity のみ
	   なので reduced-motion でも穏やか。劣化モードでも出す（CSS のみで描ける）。 */
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
	.rainbow.autumn-light {
		background: radial-gradient(ellipse at 70% 15%, rgba(255, 212, 136, 0.32), rgba(218, 135, 63, 0.12) 45%, transparent 75%);
	}
	/* 序盤（雨がまだ残る 0〜26% ≒ CLEARING_SECS）は出さず、半ばで満ち、終わりに引く。 */
	@keyframes rainbow-arc {
		0%,
		26% {
			opacity: 0;
		}
		50% {
			opacity: 1;
		}
		76% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
	.escape {
		position: absolute;
		width: max-content;
		max-width: calc(100vw - 3rem);
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
</style>
