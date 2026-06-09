<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { onTick, onPhaseChanged, type Phase } from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	// 数字なしの連続バー。作業の経過割合で充填し、ゴールが近づく感覚を出す（要件 §2.5 B）。
	let fill = $state(0); // 0..1（経過割合＝1 - 残り/総量）
	let phase = $state<Phase>('work');
	const unlisten: UnlistenFn[] = [];

	// Work / Incoming のみ表示（Shower は非表示、Clearing 完了で再表示）。
	const visible = $derived(phase === 'work' || phase === 'incoming');
	// 終盤の goal-gradient（わずかに暖色へ寄せる控えめな演出）。
	const nearGoal = $derived(fill > 0.85);

	onMount(async () => {
		unlisten.push(
			await onTick((t) => {
				phase = t.phase;
				if (t.segment_total_secs > 0 && (t.phase === 'work' || t.phase === 'incoming')) {
					fill = 1 - t.remaining_secs / t.segment_total_secs;
				}
			})
		);
		unlisten.push(await onPhaseChanged((p) => (phase = p.phase)));
	});

	onDestroy(() => {
		for (const u of unlisten) u();
	});
</script>

<div class="hud" class:visible>
	<div class="bar" class:near={nearGoal}>
		<div class="fill" style:width={`${Math.round(fill * 100)}%`}></div>
	</div>
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent;
		overflow: hidden;
	}
	.hud {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.6s ease;
		/* 表示専用・常時クリックスルー（窓側でも ignore_cursor_events 済み） */
		pointer-events: none;
	}
	.hud.visible {
		opacity: 1;
	}
	.bar {
		width: 86%;
		height: 6px;
		border-radius: 999px;
		background: rgba(120, 140, 170, 0.22);
		overflow: hidden;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
	}
	.fill {
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(90deg, #5b7fb0, #8fb3dd);
		transition:
			width 1s linear,
			background 1.2s ease;
	}
	.bar.near .fill {
		/* goal-gradient: 終盤だけほのかに暖色へ */
		background: linear-gradient(90deg, #6f86b0, #d6b98f);
	}
</style>
