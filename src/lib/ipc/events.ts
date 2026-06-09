// Rust → Front のイベント購読ラッパ。
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppConfig, IncomingProgress, PhaseChanged, Tick } from './types';

export function onPhaseChanged(cb: (p: PhaseChanged) => void): Promise<UnlistenFn> {
	return listen<PhaseChanged>('phase-changed', (e) => cb(e.payload));
}

export function onTick(cb: (t: Tick) => void): Promise<UnlistenFn> {
	return listen<Tick>('tick', (e) => cb(e.payload));
}

export function onIncomingProgress(cb: (p: IncomingProgress) => void): Promise<UnlistenFn> {
	return listen<IncomingProgress>('incoming-progress', (e) => cb(e.payload));
}

export function onConfigChanged(cb: (c: AppConfig) => void): Promise<UnlistenFn> {
	return listen<AppConfig>('config-changed', (e) => cb(e.payload));
}
