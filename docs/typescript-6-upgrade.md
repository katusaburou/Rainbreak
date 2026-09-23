# TypeScript 6 移行記録

## 結論

TypeScript 6（`typescript@^6.0.3`）へ移行済みです（Dependabot PR #21）。
`package.json` と `pnpm-lock.yaml` はどちらも 6.0.3 を指しています。

現在利用している `@sveltejs/kit` は peer dependency として
`typescript: ^5.3.3 || ^6.0.0` を宣言しており、`svelte-check` も
`typescript: >=5.0.0` を宣言しているため、フレームワークの互換範囲内です。

## 実施した確認

- `pnpm install --frozen-lockfile` がロックファイルを変更せずに完了すること
- `pnpm exec tsc --version` が `Version 6.0.3` を示すこと
- `pnpm check` がエラー・警告ともに 0 件であること
- `pnpm build` が静的アダプターによる出力まで完了すること
- CI（core / frontend / app-build macOS・Windows / audit）がすべて成功すること

## 更新方針

minor / patch 更新は既存の Dependabot グループで継続します。TypeScript 7 のような
major 更新は他の依存更新と混ぜず、単独の PR で上記確認をすべて通してから取り込みます。
