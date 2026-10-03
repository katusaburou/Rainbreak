<script lang="ts">
	import { onMount } from 'svelte';
	import { getAppVersion, getConfig, updateConfig, type AppConfig } from '$lib/ipc';

	let cfg = $state<AppConfig>({
		ambience: 'rain',
		color_mode: 'dark',
		work_min: 20,
		break_min: 5,
		volume: 0.6,
		muted: false,
		autostart: false,
		hud_opacity: 1,
		sets: 0,
		auto_pause: false
	});
	let loaded = $state(false);
	let saving = $state(false);
	let savedAt = $state(0);
	let appVersion = $state('');

	onMount(async () => {
		void getAppVersion()
			.then((version) => { appVersion = version; })
			.catch(() => {
				// ブラウザプレビューでは実行中のアプリがないので表示しない。
			});
		try {
			cfg = { ...cfg, ...await getConfig() };
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
				sets: clampInt(cfg.sets, 0, 99),
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

<div class="settings-shell" class:light={cfg.color_mode === 'light'}>
<main>
	<header>
		<h1>設定</h1>
		{#if appVersion}<span class="version">雨やどり v{appVersion}</span>{/if}
	</header>

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
			<label>
				セット数（0 = 無制限）
				<input type="number" min="0" max="99" bind:value={cfg.sets} />
			</label>
			<p class="hint">設定した回数の作業を終えると、休憩の余韻のあとにタイマーが停止します。</p>
		</section>

		<section>
			<h2>休憩の風景</h2>
			<label>
				演出
				<select bind:value={cfg.ambience}>
					<option value="rain">通り雨</option>
					<option value="autumn">紅葉</option>
				</select>
			</label>
			<p class="hint">{cfg.ambience === 'autumn'
				? '赤・橙・黄のもみじが、風に揺れながら舞い落ちます。紅葉は無音の演出です。'
				: '窓ガラスを流れる雨と、穏やかな雨音でひと休み。'}</p>
			<label>
				カラーモード
				<select bind:value={cfg.color_mode}>
					<option value="dark">ダークモード</option>
					<option value="light">ホワイトモード</option>
				</select>
			</label>
			<p class="hint">紅葉の背景と設定画面の配色を切り替えます。保存すると次回起動時も同じモードになります。</p>
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
			<p class="hint">起動約10秒後に更新を自動確認します。最新のバージョンを使用している場合は通知しません。</p>
			<label class="row">
				<input type="checkbox" bind:checked={cfg.autostart} />
				ログイン時に自動で開始する
			</label>
		</section>

		<section>
			<h2>自動停止</h2>
			<label class="row">
				<input type="checkbox" bind:checked={cfg.auto_pause} />
				離席・画面ロック時にタイマーを止める
			</label>
			<p class="hint">作業中に5分間入力がないと停止し、操作すると再開します。画面ロック時は休憩中も停止します。手動の一時停止は保持します。</p>
		</section>

		<div class="actions">
			<button onclick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
			{#if savedAt}
				<span class="saved">保存しました</span>
			{/if}
		</div>
		<p class="note">葉や雨の量・演出強度は、風景に合わせて自動で調整されます。</p>
	{/if}
</main>
</div>

<style>
	:global(html, body) {
		margin: 0;
	}
	.settings-shell {
		--page: #11151c;
		--text: #cdd6e4;
		--muted: #97a6ba;
		--field: #1b212b;
		--border: #384354;
		--strong: #eaf1fb;
		--accent: #8fb3dd;
		--button: #3a5680;
		--saved: #8fc6a0;
		min-height: 100vh;
		background: var(--page);
		color-scheme: dark;
	}
	.settings-shell.light {
		--page: #faf8f4;
		--text: #352f2a;
		--muted: #70665e;
		--field: #ffffff;
		--border: #d4cdc3;
		--strong: #302922;
		--accent: #97512d;
		--button: #824522;
		--saved: #37663e;
		color-scheme: light;
	}
	main {
		font-family: system-ui, sans-serif;
		color: var(--text);
		padding: 1.25rem 1.5rem;
		max-width: 420px;
	}
	h1 {
		font-size: 1.2rem;
		margin: 0;
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}
	.version {
		color: var(--muted);
		font-size: 0.8rem;
	}
	h2 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
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
	input[type='range'], input[type='checkbox'] {
		accent-color: var(--accent);
	}
	input[type='number'], select {
		width: 6rem;
		background: var(--field);
		border: 1px solid var(--border);
		color: var(--strong);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
	}
	select {
		width: 100%;
		max-width: 16rem;
		font: inherit;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	button {
		background: var(--button);
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
		color: var(--saved);
		font-size: 0.85rem;
	}
	.muted,
	.note,
	.hint {
		color: var(--muted);
		font-size: 0.8rem;
	}
	.note {
		margin-top: 1.5rem;
	}
	.hint {
		margin: 0;
	}
</style>
