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
		type Phase
	} from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	let canvas: HTMLCanvasElement;
	let phase = $state<Phase>('work');
	let rain: RainRenderer | null = null;
	let audio: RainAudio | null = null;
	let clearingTimer: ReturnType<typeof setInterval> | null = null;
	const unlisten: UnlistenFn[] = [];

	const CLEARING_SECS = 3; // Rust の CLEARING_SECS と一致

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
		switch (next) {
			case 'work':
				rain.setIntensity(0);
				rain.stop();
				audio?.fadeOut(1.5);
				break;
			case 'incoming':
				// 強さは incoming-progress で 0→1 に動かす。
				rain.setIntensity(0);
				rain.start();
				break;
			case 'shower':
				rain.setIntensity(1);
				rain.start();
				void audio?.resume().then(() => audio?.fadeIn(2));
				break;
			case 'clearing': {
				// 雨・音を CLEARING_SECS かけてフェードアウト。
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
		rain = new RainRenderer({ fpsCap: 30, reducedMotion: reduced });
		await rain.init(canvas, { backgroundUrl: '/bg/default.png', reducedMotion: reduced });
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
			unlisten.push(await onPhaseChanged((p) => applyPhase(p.phase)));
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
		if (dev && !('__TAURI_INTERNALS__' in window)) {
			const p = new URLSearchParams(location.search).get('phase');
			if (p === 'work' || p === 'incoming' || p === 'shower' || p === 'clearing') {
				applyPhase(p);
			}
		}
	});

	onDestroy(() => {
		stopClearingTween();
		for (const u of unlisten) u();
		window.removeEventListener('keydown', onKeydown);
		rain?.destroy();
		audio?.destroy();
	});
</script>

<div class="overlay">
	<canvas bind:this={canvas}></canvas>

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
