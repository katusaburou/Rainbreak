// GitHub Release のアセット名を分かりやすい名前へ揃えるユーティリティ（追加依存なし）。
//
// Tauri が生成する既定名は、どの OS / どの Mac 向けかが一般ユーザーに伝わりにくい:
//   Rainbreak_0.1.1_x64-setup.exe      -> Rainbreak_0.1.1_Windows_Setup.exe
//   Rainbreak_0.1.1_aarch64.dmg        -> Rainbreak_0.1.1_macOS_AppleSilicon.dmg
//   Rainbreak_0.1.1_x64.dmg            -> Rainbreak_0.1.1_macOS_Intel.dmg
//   Rainbreak_aarch64.app.tar.gz(.sig) -> Rainbreak_0.1.1_macOS_AppleSilicon_Update.app.tar.gz(.sig)
//   Rainbreak_x64.app.tar.gz(.sig)     -> Rainbreak_0.1.1_macOS_Intel_Update.app.tar.gz(.sig)
// あわせて自動アップデート用 latest.json 内の URL も新名称へ書き換える。
// latest.json 自体の名前は updater のエンドポイント（releases/latest/download/latest.json）に
// 固定されているため変更しない。署名はファイル内容に対するものなので名前変更の影響を受けない。
// 再実行しても安全（変換済みの名前にはマッチしない）。
//
// 実行: node tools/rename-release-assets.mjs --tag v0.1.1 [--repo owner/name] [--dry-run]
//   - 認証: GH_TOKEN / GITHUB_TOKEN（どちらも無ければ `gh auth token` を試す）
//   - リポジトリ: --repo 省略時は GITHUB_REPOSITORY 環境変数（Actions が自動設定）
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const tag = argOf('--tag');
const repo = argOf('--repo') ?? process.env.GITHUB_REPOSITORY;
const dryRun = args.includes('--dry-run');
if (!tag || !repo) {
	console.error('使い方: node tools/rename-release-assets.mjs --tag v0.1.1 [--repo owner/name] [--dry-run]');
	process.exit(1);
}

let token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
	try {
		token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
	} catch {
		// gh が無い／未ログインの場合は直下のチェックで止める
	}
}
if (!token) {
	console.error('GitHub トークンがありません（GH_TOKEN / GITHUB_TOKEN を設定するか gh auth login してください）。');
	process.exit(1);
}

async function api(path, init = {}) {
	const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
	const res = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...init.headers,
		},
	});
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${await res.text()}`);
	return res;
}

// updater アーティファクト（*.app.tar.gz）の既定名には版番号が入らないため、タグから補う。
const version = tag.replace(/^v/, '');

// Tauri 既定名 -> 分かりやすい名前。マッチしない名前（変換済み含む）はそのまま返す。
const RULES = [
	// Windows NSIS インストーラ（.sig ごと。自動アップデートもこの exe を使う）
	[/^(.+?)_(\d[^_]*)_x64-setup\.exe(\.sig)?$/, (m) => `${m[1]}_${m[2]}_Windows_Setup.exe${m[3] ?? ''}`],
	[/^(.+?)_(\d[^_]*)_arm64-setup\.exe(\.sig)?$/, (m) => `${m[1]}_${m[2]}_Windows_ARM64_Setup.exe${m[3] ?? ''}`],
	// macOS インストーラ
	[/^(.+?)_(\d[^_]*)_aarch64\.dmg$/, (m) => `${m[1]}_${m[2]}_macOS_AppleSilicon.dmg`],
	[/^(.+?)_(\d[^_]*)_x64\.dmg$/, (m) => `${m[1]}_${m[2]}_macOS_Intel.dmg`],
	// macOS 自動アップデート用アーカイブ（.app.tar.gz 拡張子は updater の展開処理が前提とするため維持）
	[/^(.+?)_aarch64\.app\.tar\.gz(\.sig)?$/, (m) => `${m[1]}_${version}_macOS_AppleSilicon_Update.app.tar.gz${m[2] ?? ''}`],
	[/^(.+?)_x64\.app\.tar\.gz(\.sig)?$/, (m) => `${m[1]}_${version}_macOS_Intel_Update.app.tar.gz${m[2] ?? ''}`],
];

const renameOf = (name) => {
	for (const [re, fn] of RULES) {
		const m = name.match(re);
		if (m) return fn(m);
	}
	return name;
};

// ドラフトは tags/{tag} API で引けないため一覧から探す。
async function findRelease() {
	for (let page = 1; page <= 10; page++) {
		const releases = await (await api(`/repos/${repo}/releases?per_page=100&page=${page}`)).json();
		if (releases.length === 0) break;
		const hit = releases.find((r) => r.tag_name === tag);
		if (hit) return hit;
	}
	throw new Error(`タグ ${tag} のリリースが ${repo} に見つかりません。`);
}

const release = await findRelease();
console.log(`リリース「${release.name}」（${release.draft ? 'ドラフト' : '公開済み'}）: アセット ${release.assets.length} 件`);

// 1) アセット本体のリネーム
const renames = new Map(); // 旧名 -> 新名（latest.json の URL 書き換えにも使う）
for (const asset of release.assets) {
	const to = renameOf(asset.name);
	if (to === asset.name) continue;
	renames.set(asset.name, to);
	console.log(`  ${asset.name}\n    -> ${to}`);
	if (!dryRun) {
		await api(`/repos/${repo}/releases/assets/${asset.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: to }),
		});
	}
}
if (renames.size === 0) console.log('  リネーム対象なし（すべて変換済み）。');

// 2) latest.json 内の URL を新名称へ追随させる
const manifestAsset = release.assets.find((a) => a.name === 'latest.json');
if (manifestAsset) {
	const res = await api(`/repos/${repo}/releases/assets/${manifestAsset.id}`, {
		headers: { Accept: 'application/octet-stream' },
	});
	const manifest = JSON.parse(await res.text());
	let changed = false;
	for (const entry of Object.values(manifest.platforms ?? {})) {
		const cut = entry.url.lastIndexOf('/') + 1;
		const file = decodeURIComponent(entry.url.slice(cut));
		// アセット側だけ直って中断した実行をやり直す場合にも追随できるよう、マップに無ければ規則から引く。
		const to = renames.get(file) ?? renameOf(file);
		if (to !== file) {
			entry.url = entry.url.slice(0, cut) + to;
			changed = true;
		}
	}
	if (!changed) {
		console.log('latest.json: 変更不要。');
	} else if (dryRun) {
		console.log('latest.json: URL を新名称へ書き換えます（dry-run のため未実施）。');
	} else {
		// 「削除してから再アップロード」だと途中失敗でマニフェストが消えたままになる。
		// 一時名で先にアップロード -> 旧を削除 -> 一時名を latest.json へリネーム、の順で差し替える。
		const TMP = 'latest.json.new';
		const leftover = release.assets.find((a) => a.name === TMP);
		if (leftover) await api(`/repos/${repo}/releases/assets/${leftover.id}`, { method: 'DELETE' });
		const uploaded = await (
			await api(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${TMP}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(manifest, null, 2),
			})
		).json();
		await api(`/repos/${repo}/releases/assets/${manifestAsset.id}`, { method: 'DELETE' });
		await api(`/repos/${repo}/releases/assets/${uploaded.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'latest.json' }),
		});
		console.log('latest.json: URL を新名称へ書き換えました。');
	}
} else {
	console.log('latest.json が無いため URL の書き換えはスキップ。');
}

console.log(dryRun ? 'dry-run 完了。' : '完了。');
