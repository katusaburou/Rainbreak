<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { getConfig, onConfigChanged, onTick, onPhaseChanged, type Phase } from '$lib/ipc';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	// 数字なしの連続バー。作業の経過割合で充填し、ゴールが近づく感覚を出す（要件 §2.5 B）。
	let fill = $state(0); // 0..1（経過割合＝1 - 残り/総量）
	let phase = $state<Phase>('work');
	// バーの不透明度（設定 hud_opacity）。フェーズの表示/非表示フェードとは独立に掛かる。
	let barOpacity = $state(1);
	const unlisten: UnlistenFn[] = [];

	// 左ボタンのドラッグで HUD ごと移動する（位置は Rust 側が Moved イベントで永続化）。
	function onMousedown(e: MouseEvent) {
		if (e.button !== 0) return;
		try {
			void getCurrentWindow().startDragging();
		} catch {
			// Tauri 外（ブラウザプレビュー）では何もしない。
		}
	}

	// 外周のリサイズハンドル（8方向）。辺で縦横、角で斜めに伸縮できる。
	// サイズは Rust 側が Resized イベントで永続化する。
	const RESIZE_HANDLES = [
		{ dir: 'North', cls: 'n' },
		{ dir: 'South', cls: 's' },
		{ dir: 'East', cls: 'e' },
		{ dir: 'West', cls: 'w' },
		{ dir: 'NorthEast', cls: 'ne' },
		{ dir: 'NorthWest', cls: 'nw' },
		{ dir: 'SouthEast', cls: 'se' },
		{ dir: 'SouthWest', cls: 'sw' }
	] as const;

	function onResizeMousedown(e: MouseEvent, dir: (typeof RESIZE_HANDLES)[number]['dir']) {
		if (e.button !== 0) return;
		e.stopPropagation(); // 親（.hud）の移動ドラッグを始めない
		try {
			void getCurrentWindow().startResizeDragging(dir);
		} catch {
			// Tauri 外（ブラウザプレビュー）では何もしない。
		}
	}

	// Work / Incoming のみ表示（Shower は非表示、Clearing 完了で再表示）。
	const visible = $derived(phase === 'work' || phase === 'incoming');
	// 終盤の goal-gradient（わずかに暖色へ寄せる控えめな演出）。
	const nearGoal = $derived(fill > 0.85);

	onMount(async () => {
		try {
			barOpacity = (await getConfig()).hud_opacity;
		} catch {
			// Tauri 外（ブラウザプレビュー）では既定値のまま。
		}
		unlisten.push(
			await onTick((t) => {
				phase = t.phase;
				if (t.segment_total_secs > 0 && (t.phase === 'work' || t.phase === 'incoming')) {
					fill = 1 - t.remaining_secs / t.segment_total_secs;
				}
			})
		);
		unlisten.push(await onPhaseChanged((p) => (phase = p.phase)));
		unlisten.push(await onConfigChanged((c) => (barOpacity = c.hud_opacity)));
	});

	onDestroy(() => {
		for (const u of unlisten) u();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="hud" class:visible onmousedown={onMousedown}>
	<div class="bar" class:near={nearGoal} style:opacity={barOpacity}>
		<div class="fill" style:width={`${Math.round(fill * 100)}%`}></div>
	</div>
	{#each RESIZE_HANDLES as h (h.dir)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="handle {h.cls}" onmousedown={(e) => onResizeMousedown(e, h.dir)}></div>
	{/each}
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent;
		overflow: hidden;
	}
	/* 窓＝バー。見えている範囲とマウスの当たり判定を一致させるため、
	   バーが窓いっぱいに広がる（太さの調整は窓の縦リサイズそのもの）。 */
	.hud {
		position: fixed;
		inset: 0;
		opacity: 0;
		transition: opacity 0.6s ease;
		/* ドラッグで移動できる（窓はフォーカスを奪わない set_focusable(false)）。 */
		cursor: grab;
		user-select: none;
	}
	.hud:active {
		cursor: grabbing;
	}
	/* 外周のリサイズハンドル（不可視）。辺＝縦横、角＝斜め。
	   窓が細い（既定 14px 高）ため辺は薄く、角は DOM 順で辺の上に重ねる。 */
	.handle {
		position: absolute;
	}
	.handle.n {
		top: 0;
		left: 7px;
		right: 7px;
		height: 3px;
		cursor: ns-resize;
	}
	.handle.s {
		bottom: 0;
		left: 7px;
		right: 7px;
		height: 3px;
		cursor: ns-resize;
	}
	.handle.e {
		right: 0;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: ew-resize;
	}
	.handle.w {
		left: 0;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: ew-resize;
	}
	.handle.ne {
		top: 0;
		right: 0;
		width: 7px;
		height: 7px;
		cursor: nesw-resize;
	}
	.handle.nw {
		top: 0;
		left: 0;
		width: 7px;
		height: 7px;
		cursor: nwse-resize;
	}
	.handle.se {
		bottom: 0;
		right: 0;
		width: 7px;
		height: 7px;
		cursor: nwse-resize;
	}
	.handle.sw {
		bottom: 0;
		left: 0;
		width: 7px;
		height: 7px;
		cursor: nesw-resize;
	}
	.hud.visible {
		opacity: 1;
	}
	.bar {
		width: 100%;
		height: 100%;
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
