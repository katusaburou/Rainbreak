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
		getConfig,
		skipBreak,
		captureScreen,
		type Phase
	} from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	let canvas: HTMLCanvasElement;
	let phase = $state<Phase>('work');
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

	function applyPhase(next: Phase, lastSet = false) {
		phase = next;
		if (!rain) return;
		stopClearingTween();
		// 虹と余韻は雨上がり（最終セット）限定。他フェーズへ移ったら引っ込める。
		rainbow = false;
		audio?.cancelAfterglow();
		switch (next) {
			case 'work':
			// セット終了は今のところ作業と同じ退避のみ（終了演出はここに差し込む）。
			case 'finished':
				stopCaptureLoop();
				rain.setIntensity(0);
				rain.stop();
				audio?.fadeOut(1.5);
				break;
			case 'incoming':
				// 強さは incoming-progress で 0→1 に動かす。
				// ガラスは半透明上限に抑え、背景は実画面のキャプチャに切り替える
				// （クリックスルー ON と合わせて、降り始めの 30 秒は作業を続けられる）。
				rain.setMaxOpacity(INCOMING_MAX_OPACITY);
				startCaptureLoop();
				rain.setIntensity(0);
				rain.start();
				break;
			case 'shower':
				// ガラスを現れきらせる。背景キャプチャは引き続き追従させ、
				// 「いまの画面がガラス越しに雨に濡れている」見えにする。
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
				// 最終セットの雨上がり（FINAL_CLEARING_SECS）: 雨が引いたあとに
				// 虹を架け（案1）、雫と遠くの鳥の余韻を鳴らす（案3）。
				if (lastSet) {
					rainbow = true;
					audio?.playAfterglow(CLEARING_SECS);
				}
				break;
			}
		}
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
			unlisten.push(await onPhaseChanged((p) => applyPhase(p.phase, p.last_set)));
			unlisten.push(
				await onIncomingProgress((p) => {
					if (phase === 'incoming') rain?.setIntensity(p.p);
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
		// ?phase=clearing&last=1 で最終セットの虹・余韻も確認できる。
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
				applyPhase(p, params.get('last') === '1');
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

	{#if rainbow}
		<div class="rainbow" style:animation-duration={`${FINAL_CLEARING_SECS}s`}></div>
	{/if}

	{#if phase === 'shower'}
		<div class="escape">
			<button onclick={() => skipBreak()}>この通り雨をやり過ごす（Skip）</button>
			<p class="hint">Esc でも作業に戻れます</p>
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
