// 全ウィンドウを SPA として動かす（サーバ描画・プリレンダなし）。
// Tauri は index.html フォールバックを各ルートへクライアントルーティングする。
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
