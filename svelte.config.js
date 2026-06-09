import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * 各 Tauri ウィンドウ（overlay / hud / settings）は SPA ルートとして
 * `/overlay` `/hud` `/settings` を読み込む。adapter-static の SPA フォール
 * バック（index.html）で dev / prod のパスを一致させる（実装計画 §3.2）。
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
