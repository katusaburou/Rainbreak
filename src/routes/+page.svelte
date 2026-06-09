<script lang="ts">
	// ルート "/" は実ウィンドウでは使われない（各窓は /overlay /hud /settings を開く）。
	// 開発時の手動確認用に各ルートへのリンクだけ置く。
	const routes = [
		{ href: '/overlay', label: 'overlay（全画面・雨）' },
		{ href: '/hud', label: 'hud（隅のバー）' },
		{ href: '/settings', label: 'settings（設定）' }
	];
</script>

<main>
	<h1>雨やどり / Rainbreak</h1>
	<p>このルートはアプリでは使用しません。各ウィンドウのプレビュー:</p>
	<ul>
		{#each routes as r (r.href)}
			<li><a href={r.href}>{r.label}</a></li>
		{/each}
	</ul>
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 32rem;
		margin: 4rem auto;
		padding: 0 1rem;
		color: #cdd6e4;
		background: #11151c;
	}
	a {
		color: #8ab4f8;
	}
</style>
