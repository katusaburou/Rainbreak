import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Tauri と組み合わせるための最小設定。
export default defineConfig({
	plugins: [sveltekit()],
	// Tauri CLI が出力を読むのでクリアしない。
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true
	},
	// `TAURI_` 系の環境変数をフロントへ露出。
	envPrefix: ['VITE_', 'TAURI_']
});
