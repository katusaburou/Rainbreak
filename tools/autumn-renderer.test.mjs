import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
	readFileSync(new URL('../src/lib/autumn/AutumnRenderer.ts', import.meta.url), 'utf8'),
	{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;

function fixture(reducedMotion = false) {
	const frames = new Map();
	const listeners = new Map();
	let nextId = 0;
	let disconnected = false;
	const positions = [];
	const noop = () => {};
	function canvas() {
		const ctx = {
			clearRect: () => { positions.length = 0; },
			translate: (x, y) => positions.push([x, y]),
			setTransform: noop, save: noop, restore: noop, rotate: noop,
			scale: noop, drawImage: noop, fill: noop, stroke: noop,
			beginPath: noop, moveTo: noop, quadraticCurveTo: noop,
			createLinearGradient: () => ({ addColorStop: noop })
		};
		return { style: {}, clientWidth: 1280, clientHeight: 720, getContext: () => ctx };
	}
	const document = {
		visibilityState: 'visible',
		createElement: canvas,
		addEventListener: (name, fn) => listeners.set(name, fn),
		removeEventListener: (name, fn) => {
			if (listeners.get(name) === fn) listeners.delete(name);
		}
	};
	const exports = {};
	runInNewContext(source, {
		exports, document,
		window: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 },
		Path2D: class {},
		ResizeObserver: class { observe() {} disconnect() { disconnected = true; } },
		requestAnimationFrame: (fn) => { frames.set(++nextId, fn); return nextId; },
		cancelAnimationFrame: (id) => frames.delete(id)
	});
	const renderer = new exports.AutumnRenderer(reducedMotion);
	const surface = canvas();
	renderer.init(surface);
	positions.length = 0; // 初期化中の葉素材の描画は、表示用 canvas の描画に数えない。
	return {
		renderer, surface, frames, positions, listeners,
		get disconnected() { return disconnected; },
		visibility(value) {
			document.visibilityState = value;
			listeners.get('visibilitychange')?.();
		},
		step(time) {
			const pending = [...frames.values()];
			frames.clear();
			for (const fn of pending) fn(time);
		}
	};
}

test('hidden, stopped and destroyed overlays never keep an animation loop alive', () => {
	const f = fixture();
	assert.equal(f.frames.size, 0);
	f.renderer.setIntensity(1);
	f.visibility('hidden');
	f.renderer.start();
	assert.equal(f.frames.size, 0);
	f.visibility('visible');
	f.renderer.start();
	f.renderer.start();
	assert.equal(f.frames.size, 1, 'repeated starts must not multiply loops');
	f.step(1000);
	const before = structuredClone(f.positions);
	f.step(1050);
	assert.notDeepEqual(f.positions, before, 'visible leaves should move');
	f.visibility('hidden');
	assert.equal(f.frames.size, 0);
	f.visibility('visible');
	assert.equal(f.frames.size, 1);
	f.renderer.stop();
	f.visibility('hidden');
	f.visibility('visible');
	assert.equal(f.frames.size, 0, 'visibility must not restart a stopped break');
	f.renderer.start();
	f.renderer.destroy();
	assert.equal(f.frames.size, 0);
	assert.equal(f.listeners.size, 0);
	assert.ok(f.disconnected);
});

test('reduced motion shows static leaves and fades to an empty canvas without animation', () => {
	const f = fixture(true);
	f.renderer.setIntensity(1);
	f.renderer.start();
	assert.ok(f.positions.length > 0);
	const before = structuredClone(f.positions);
	f.visibility('hidden');
	f.visibility('visible');
	f.renderer.start();
	assert.deepEqual(f.positions, before);
	assert.equal(f.frames.size, 0);
	f.renderer.setIntensity(0);
	assert.equal(f.positions.length, 0);
	assert.equal(f.surface.style.opacity, '0');
	f.renderer.destroy();
});

test('reduced motion draws leaves when an initially hidden break becomes visible', () => {
	const f = fixture(true);
	f.visibility('hidden');
	f.renderer.setIntensity(1);
	f.renderer.start();
	assert.equal(f.positions.length, 0, 'hidden overlays should not paint');
	f.visibility('visible');
	assert.ok(f.positions.length > 0, 'the first visible frame must contain static leaves');
	assert.equal(f.frames.size, 0, 'reduced motion must never schedule animation');
	f.renderer.destroy();
});

test('incoming leaves increase with progress and respect the translucent opacity cap', () => {
	const f = fixture(true);
	f.renderer.setMaxOpacity(0.45);
	f.renderer.setIntensity(0.15);
	f.renderer.start();
	const incomingCount = f.positions.length;
	assert.ok(incomingCount > 0);
	assert.ok(Number(f.surface.style.opacity) < 0.45);
	f.renderer.setIntensity(1);
	assert.ok(f.positions.length > incomingCount);
	assert.equal(f.surface.style.opacity, '0.45');
	f.renderer.setMaxOpacity(1);
	assert.equal(f.surface.style.opacity, '1');
	f.renderer.destroy();
});
