<script lang="ts">
	import { onMount } from 'svelte';
	import { getConfig, updateConfig, type AppConfig } from '$lib/ipc';

	let cfg = $state<AppConfig>({
		work_min: 20,
		break_min: 5,
		volume: 0.6,
		muted: false,
		autostart: false,
		hud_opacity: 1
	});
	let loaded = $state(false);
	let saving = $state(false);
	let savedAt = $state(0);

	onMount(async () => {
		try {
			cfg = await getConfig();
		} catch {
			// Tauri 外（ブラウザプレビュー）では既定値のまま。
		}
		loaded = true;
	});

	async function save() {
		saving = true;
		try {
			await updateConfig({
				...cfg,
				work_min: clampInt(cfg.work_min, 1, 180),
				break_min: clampInt(cfg.break_min, 1, 60),
				volume: Math.min(1, Math.max(0, cfg.volume)),
				hud_opacity: Math.min(1, Math.max(0.1, cfg.hud_opacity))
			});
			savedAt = Date.now();
		} finally {
			saving = false;
		}
	}

	function clampInt(v: number, lo: number, hi: number): number {
		const n = Math.round(Number(v) || lo);
		return Math.min(hi, Math.max(lo, n));
	}
</script>

<main>
	<h1>設定</h1>

	{#if !loaded}
		<p class="muted">読み込み中…</p>
	{:else}
		<section>
			<h2>サイクル</h2>
			<label>
				作業時間（分）
				<input type="number" min="1" max="180" bind:value={cfg.work_min} />
			</label>
			<label>
				休憩時間（分）
				<input type="number" min="1" max="60" bind:value={cfg.break_min} />
			</label>
		</section>

		<section>
			<h2>音</h2>
			<label class="row">
				<input type="checkbox" bind:checked={cfg.muted} />
				ミュート
			</label>
			<label>
				音量
				<input
					type="range"
					min="0"
					max="1"
					step="0.01"
					bind:value={cfg.volume}
					disabled={cfg.muted}
				/>
			</label>
		</section>

		<section>
			<h2>HUD バー</h2>
			<label>
				濃さ（{Math.round(cfg.hud_opacity * 100)}%・左へ動かすほど透ける）
				<input type="range" min="0.1" max="1" step="0.05" bind:value={cfg.hud_opacity} />
			</label>
		</section>

		<section>
			<h2>起動</h2>
			<label class="row">
				<input type="checkbox" bind:checked={cfg.autostart} />
				ログイン時に自動で開始する
			</label>
		</section>

		<div class="actions">
			<button onclick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
			{#if savedAt}
				<span class="saved">保存しました</span>
			{/if}
		</div>
		<p class="note">背景・雨量・演出強度は作者が決め打ちのため設定にありません。</p>
	{/if}
</main>

<style>
	:global(html, body) {
		margin: 0;
		background: #11151c;
	}
	main {
		font-family: system-ui, sans-serif;
		color: #cdd6e4;
		padding: 1.25rem 1.5rem;
		max-width: 420px;
	}
	h1 {
		font-size: 1.2rem;
		margin: 0 0 1rem;
	}
	h2 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #8595ad;
		margin: 1.25rem 0 0.5rem;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.9rem;
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}
	input[type='number'],
	input[type='range'] {
		accent-color: #8fb3dd;
	}
	input[type='number'] {
		width: 6rem;
		background: #1b212b;
		border: 1px solid #2b3441;
		color: #eaf1fb;
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	button {
		background: #3a5680;
		color: #eaf1fb;
		border: none;
		border-radius: 8px;
		padding: 0.5rem 1.4rem;
		font-size: 0.95rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.saved {
		color: #8fc6a0;
		font-size: 0.85rem;
	}
	.muted,
	.note {
		color: #7c8aa0;
		font-size: 0.8rem;
	}
	.note {
		margin-top: 1.5rem;
	}
</style>
