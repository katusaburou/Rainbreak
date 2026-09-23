# TypeScript 6 移行判断

## 結論

TypeScript 6 への移行は、依存関係の宣言上は可能です。ただし、`typescript@6`
本体を取得した状態で型検査とプロダクションビルドを完走できるまでは、
`package.json` と `pnpm-lock.yaml` を TypeScript 6 に更新しません。

現在利用している `@sveltejs/kit` は peer dependency として
`typescript: ^5.3.3 || ^6.0.0` を宣言しており、`svelte-check` も
`typescript: >=5.0.0` を宣言しています。このため、フレームワークが示す互換範囲には
TypeScript 6 が含まれます。一方、ロック済みなのは TypeScript 5.9.3 だけであり、
未取得のパッケージを推測でロックファイルへ記録することは避けます。

## 移行時の確認手順

レジストリへ接続できる環境で、次の順序で更新します。

```sh
pnpm update --latest typescript
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

あわせて、次を確認します。

- `pnpm exec tsc --version` が安定版の 6.x を示すこと
- `pnpm check` がエラー・警告ともに 0 件であること
- `pnpm build` が静的アダプターによる出力まで完了すること
- `package.json` と `pnpm-lock.yaml` が同じ TypeScript バージョンを指すこと
- TypeScript 6 の移行診断で、廃止されたコンパイラーオプションが検出されないこと

## 更新方針

minor / patch 更新は既存の Dependabot グループで継続します。TypeScript 6 のような
major 更新は他の依存更新と混ぜず、単独の PR で上記確認をすべて通してから取り込みます。
