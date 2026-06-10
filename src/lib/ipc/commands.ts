// Front → Rust のコマンド呼び出しラッパ（引数名は Rust の #[tauri::command] と一致）。
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from './types';

/** 通り雨／予兆を切り上げて作業へ戻る。 */
export const skipBreak = (): Promise<void> => invoke('skip_break');

/** タイマー一時停止。 */
export const pauseTimer = (): Promise<void> => invoke('pause');

/** タイマー再開。 */
export const resumeTimer = (): Promise<void> => invoke('resume');

/** 起動時に設定を取得。 */
export const getConfig = (): Promise<AppConfig> => invoke('get_config');

/** 設定を更新し永続化。 */
export const updateConfig = (cfg: AppConfig): Promise<void> => invoke('update_config', { cfg });

/** アプリ終了。 */
export const quitApp = (): Promise<void> => invoke('quit');

/**
 * overlay が覆うモニタの現在表示を JPEG data URL で取得する（モードB）。
 * 雨ガラスの屈折元背景に使う。overlay/hud はキャプチャから除外済み（Windows）。
 */
export const captureScreen = (): Promise<string> => invoke('capture_screen');
