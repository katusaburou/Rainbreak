// 追加依存なしで PNG を生成するユーティリティ（zlib のみ使用）。
// - static/bg/default.png : 雨の屈折元になるぼかし風景のプレースホルダ。
// - app-icon.png          : `tauri icon` の元画像（1024x1024）。
//
// 実行: node tools/gen-assets.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBuf = Buffer.from(type, 'ascii');
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(data.length, 0);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** rgba(x,y) -> [r,g,b,a] を返す関数から PNG を作る。 */
function encodePNG(width, height, pixel) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(6, 9); // color type RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	let o = 0;
	for (let y = 0; y < height; y++) {
		raw[o++] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = pixel(x, y);
			raw[o++] = r;
			raw[o++] = g;
			raw[o++] = b;
			raw[o++] = a;
		}
	}
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	return Buffer.concat([
		sig,
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function write(path, buf) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, buf);
	console.log(`wrote ${path} (${buf.length} bytes)`);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// --- 背景: 夕暮れの青のグラデーション + ぼんやりした地平線帯 ---
{
	const W = 1280;
	const H = 800;
	const buf = encodePNG(W, H, (x, y) => {
		const t = y / H;
		// 上＝藍、下＝より暗い藍。
		let r = 26 + (12 - 26) * t;
		let g = 34 + (17 - 34) * t;
		let b = 48 + (24 - 48) * t;
		// 地平線のにじみ（中央やや下に淡い光）。
		const horizon = Math.exp(-(((y - H * 0.62) / (H * 0.08)) ** 2)) * 18;
		r += horizon;
		g += horizon * 1.1;
		b += horizon * 1.3;
		// 緩い縦の濃淡で「ぼかし風景」感。
		const band = Math.sin(x / 140) * 4 + Math.sin(x / 37) * 2;
		r += band;
		g += band;
		b += band;
		return [clamp(r), clamp(g), clamp(b), 255];
	});
	write('static/bg/default.png', buf);
}

// --- アイコン元画像: 円形の雫を思わせる青のラジアルグラデ ---
{
	const S = 1024;
	const cx = S / 2;
	const cy = S * 0.46;
	const buf = encodePNG(S, S, (x, y) => {
		const dx = x - cx;
		const dy = y - cy;
		const d = Math.sqrt(dx * dx + dy * dy);
		const R = S * 0.42;
		if (d > R) return [17, 21, 28, 0]; // 透明
		const t = d / R;
		// 中心は明るい水色、外周は藍。
		let r = 150 + (40 - 150) * t;
		let g = 195 + (70 - 195) * t;
		let b = 235 + (120 - 235) * t;
		// 左上のハイライト。
		const hl = Math.exp(-(((dx + R * 0.35) ** 2 + (dy + R * 0.4) ** 2) / (2 * (R * 0.25) ** 2)));
		r += hl * 60;
		g += hl * 50;
		b += hl * 40;
		return [clamp(r), clamp(g), clamp(b), 255];
	});
	write('app-icon.png', buf);
}
