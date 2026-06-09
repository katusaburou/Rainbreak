// prefers-reduced-motion を自動で尊重するためのヘルパ（要件 §4）。
// 設定項目にはせず、OS の設定をそのまま反映する。

export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || !window.matchMedia) return false;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** reduced-motion の変化を監視する。解除関数を返す。 */
export function watchReducedMotion(cb: (reduced: boolean) => void): () => void {
	if (typeof window === 'undefined' || !window.matchMedia) return () => {};
	const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
	const handler = (e: MediaQueryListEvent) => cb(e.matches);
	mq.addEventListener('change', handler);
	return () => mq.removeEventListener('change', handler);
}
