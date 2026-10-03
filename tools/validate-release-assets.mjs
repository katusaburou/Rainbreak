// 公開前に、既存利用者の公開鍵・更新 URL・配布ファイルの実署名を検証する。
// node tools/validate-release-assets.mjs --tag v1.1.1 --repo owner/name
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { publicKeyPacket, verifyUpdaterSignature } from './updater-signature.mjs';

const argOf = (name) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const tag = argOf('--tag');
const repo = argOf('--repo') ?? process.env.GITHUB_REPOSITORY;
if (!tag || !repo) throw new Error('Usage: --tag v1.1.1 --repo owner/name');
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
	?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
async function api(path, binary = false) {
	const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' },
		signal: AbortSignal.timeout(120000),
	});
	if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
	return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const version = tag.replace(/^v/, '');
if (config.version !== version) throw new Error('Tag and app version differ');
const releases = [];
for (let page = 1; page <= 10; page++) {
	const batch = await api(`releases?per_page=100&page=${page}`);
	releases.push(...batch);
	if (batch.length < 100) break;
}
const release = releases.find((item) => item.tag_name === tag);
if (!release) throw new Error(`Release ${tag} not found`);
// 鍵を変えると既存アプリから更新できなくなるため、前回配布版（検証対象を除く最新の公開版）とも照合する。
// 再実行時に自分自身と比較して素通りしないよう、対象タグは除外する。
const previous = releases.find((item) => item.tag_name !== tag && !item.draft && !item.prerelease);
if (previous) {
	const previousFile = await api(`contents/src-tauri/tauri.conf.json?ref=${encodeURIComponent(previous.tag_name)}`);
	const previousConfig = JSON.parse(Buffer.from(previousFile.content, 'base64').toString('utf8'));
	if (!publicKeyPacket(previousConfig.plugins.updater.pubkey).equals(publicKeyPacket(config.plugins.updater.pubkey))) {
		throw new Error('Updater public key differs from the previous release; existing apps cannot update');
	}
}
const assetOf = (name) => {
	const asset = release.assets.find((item) => item.name === name && item.size > 0);
	if (!asset) throw new Error(`Missing release asset: ${name}`);
	return asset;
};
for (const name of [`Rainbreak_${version}_Windows_Setup.exe`, `Rainbreak_${version}_macOS_AppleSilicon.dmg`, `Rainbreak_${version}_macOS_Intel.dmg`]) assetOf(name);
const manifest = JSON.parse((await api(`releases/assets/${assetOf('latest.json').id}`, true)).toString());
if (manifest.version !== version) throw new Error('Manifest and app version differ');
const expected = {
	'darwin-aarch64': `Rainbreak_${version}_macOS_AppleSilicon_Update.app.tar.gz`,
	'darwin-x86_64': `Rainbreak_${version}_macOS_Intel_Update.app.tar.gz`,
	'windows-x86_64': `Rainbreak_${version}_Windows_Setup.exe`,
};
for (const [platform, name] of Object.entries(expected)) {
	if (!manifest.platforms?.[platform]) throw new Error(`Missing updater platform: ${platform}`);
	const data = await api(`releases/assets/${assetOf(name).id}`, true);
	const signatureFile = (await api(`releases/assets/${assetOf(`${name}.sig`).id}`, true)).toString().trim();
	const entries = Object.entries(manifest.platforms).filter(([key]) => key === platform || key.startsWith(`${platform}-`));
	for (const [key, entry] of entries) {
		if (entry.url !== `https://github.com/${repo}/releases/download/${tag}/${name}`) throw new Error(`Incorrect updater URL: ${key}`);
		if (entry.signature.trim() !== signatureFile) throw new Error(`Manifest signature differs from .sig: ${key}`);
		verifyUpdaterSignature(data, entry.signature, config.plugins.updater.pubkey);
	}
	console.log(`${platform}: download URL and binary signature verified`);
}
console.log(previous
	? `${tag}: updater compatibility with ${previous.tag_name} verified`
	: `${tag}: no previous release; signatures verified`);
