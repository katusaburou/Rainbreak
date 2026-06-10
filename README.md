# 雨やどり（仮称） / Amayadori

> ポモドーロ型の作業タイマー × 窓ガラスを流れる雨のアンビエント表現。
> 集中中は隅の穏やかなバーだけが残り時間を伝える。休憩30秒前から透過オーバーレイで雨が徐々に強まり（作業は継続可能）、休憩本体では雨が画面を覆う。
> ただし **Skip／Esc でいつでも抜けられる**。雨が上がれば静かに引っ込む。

<p align="center"><em>「通り雨が来たから少し手を止める」── 強制ではなく、誘いとしての休憩。</em></p>

---

## ダウンロード

[![最新リリース](https://img.shields.io/github/v/release/katusaburou/Rainbreak?label=latest&sort=semver)](https://github.com/katusaburou/Rainbreak/releases/latest)

**▶ [最新版をダウンロード（GitHub Releases）](https://github.com/katusaburou/Rainbreak/releases/latest)**

| OS | ファイル | 備考 |
|---|---|---|
| **macOS**（Apple Silicon） | `..._aarch64.dmg` | M1 以降 |
| **macOS**（Intel） | `..._x64.dmg` | Intel Mac |
| **Windows** | `..._x64-setup.exe` | Windows 10/11 |

> 上記リンクの **Assets** から各OSのインストーラを取得できます（リリース公開後に表示されます）。過去版は [リリース一覧](https://github.com/katusaburou/Rainbreak/releases) から。
> **未署名配布**のため、初回起動時はOSの警告回避が必要です → [インストール手順](#インストール)。

---

## これは何か

**雨やどり**は、ポモドーロ型の作業タイマーと、窓ガラスを流れる雨のアンビエント表現を組み合わせた **macOS / Windows 向けのデスクトップ常駐アプリ**です。

- 集中中は、画面の隅に置いた**数字なしの穏やかなバー**だけが時間の経過を静かに伝えます。画面の大半には何も出しません。
- 休憩が近づくと、**透過した雨が画面に重なって徐々に強まり**ます（＝予兆）。このとき作業は止まりません。
- 休憩本体では**雨が画面を覆って**休息を促します。それでも Skip／Esc でいつでも作業に戻れます。
- 雨が上がれば静かに引っ込み、次の作業へ戻ってループします。

梅雨どきのしんみりした空気感を基調に、集中と休息のリズムをやわらかく区切ることを目的としています。

> 仮称「雨やどり」。名称は未確定です。

---

## コンセプト / 世界観

| | |
|---|---|
| **テーマ** | 梅雨の通り雨。休憩＝雨やどり。 |
| **トーン** | 静か、しんみり、急かさない。 |
| **中核体験** | 作業（隅に穏やかなバー）→ 透過の雨が30秒かけて近づく予兆 → 通り雨で休息 → 雨上がり → 作業、の反復。 |
| **設計原則** | 休息は強制ではなく誘い。逃げ場（Skip／中断）を必ず残す。 |

---

## 特徴 — 2本の楔

時間を一切表示せず休憩をブラーで受動的に促す既存アプリ（Jun 等）や、強制中断する系（Stretchly 等）に対し、雨やどりの差別化は次の2本に固定しています。両者は層が異なるため競合せず、互いを補強します。

### (A) 予兆という「移行」の発明
休憩はいきなり来ません。**休憩30秒前から雨が近づき**、作業を続けたまま「もうすぐ通り雨」を体で察知できます。「いきなり降る」のとも「強制中断」とも違う、滑らかな移行の設計です。

### (B) 集中中の穏やかな常時バー
時間を隠すのではなく「見せる、ただし穏やかに」。隅に**数字なしの連続バー**を常駐させ、ゴールが近づく感覚（goal-gradient）で集中を後押しします。**表示専用・常時クリックスルー**なので、操作は一切妨げません。

> 純ミニマル路線（集中中も何も出さず、差別化を (A) 予兆の一点に寄せる）は **ビルド時の分岐**として残しますが、既定は **(A)+(B) 併用**です（ユーザー設定にはしません）。

---

## 体験フロー（状態遷移）

4つのフェーズを Rust 側の状態機械が駆動します。**時間の真実は常に Rust 側**にあり、WebView は描画と演出に専念します。

```mermaid
stateDiagram-v2
    [*] --> Work
    state "作業 Work\nオーバーレイ hide / HUDバーのみ" as Work
    state "予兆 Incoming\n全画面・透過・クリックスルーON / 雨 0→強" as Incoming
    state "通り雨 Shower\n全画面・クリックスルーOFF / 雨 強 / Skip可" as Shower
    state "雨上がり Clearing\n雨フェードアウト→退避" as Clearing

    Work --> Incoming: 作業残り30秒
    Incoming --> Shower: 作業時間 満了
    Shower --> Clearing: 休憩時間 満了
    Clearing --> Work: フェード完了（ループ）

    Incoming --> Work: Esc（予兆を中止）
    Shower --> Work: Skip / Esc（休憩を切り上げ）
```

| フェーズ | 全画面オーバーレイ | 隅HUD（バー） | always-on-top | クリックスルー | 雨 | 音 | 操作 |
|---|---|---|---|---|---|---|---|
| **作業** | hide | 表示（残り＝作業バー） | HUDのみ | — | なし | OFF | — |
| **予兆**（30秒） | 全画面・透過 | 表示（ほぼ満了） | ON | **ON** | 0→強へ漸増 | （任意）小 | 後ろのアプリ操作可（作業継続） |
| **通り雨**（休憩） | 全画面 | 非表示 | ON | **OFF** | 強 | フェードイン | **Skip／Esc で作業へ** |
| **雨上がり** | 全画面→hide | 作業復帰時に再表示 | ON→OFF | OFF | 強→消滅 | フェードアウト | — |

---

## アーキテクチャ

```mermaid
flowchart TB
    subgraph Core["Rust / Tauri Core — 時間の真実"]
        direction TB
        SCH["スケジューラ<br/>tokio interval"]
        SM["フェーズ状態機械"]
        WIN["ウィンドウ制御"]
        TRAY["トレイ / メニューバー"]
        CFG["設定の永続化"]
        SCH --> SM
        SM --> WIN
        SM --> TRAY
    end

    subgraph Front["SvelteKit / WebView — 描画と演出"]
        direction TB
        RAIN["雨レンダリング<br/>WebGL / raindrop-fx"]
        HUDV["HUDバー（数字なし）"]
        AUD["雨音<br/>Web Audio / Tone.js"]
        SET["設定UI"]
    end

    SM -->|"emit: phase-changed"| RAIN
    SM -->|"emit: phase-changed / tick"| HUDV
    SM -->|"emit: phase-changed"| AUD
    SET -->|"invoke: update_config"| CFG
    WIN -.->|"show / hide / always-on-top / click-through"| Front
```

**なぜこの分担か**: 非表示 WebView の JS タイマーはスロットリングで周期がズレるため、時間管理を Rust（tokio）側に置きます。フロントはイベントを受けて雨・HUD・音・UI を反映するだけで、時間を持ちません。

---

## 技術スタック

| レイヤ | 採用 | 理由（要約） |
|---|---|---|
| シェル | **Tauri 2** | 常駐フットプリントが決め手。インストーラ10MB未満・メモリ30〜50MB（Electron は80〜150MB／150〜300MB）。 |
| フロントエンド | **SvelteKit** | そのまま動作。増える Rust 表面積は小さい。 |
| 雨描画 | **WebGL**（`raindrop-fx` 等 / Codrops 系自前実装） | 背景テクスチャを屈折元に使う「モードA」にそのまま適合。 |
| スケジューラ | **Rust**（tokio interval） | バックエンド駆動でタイマー精度を担保。 |
| 音 | **Web Audio**（Tone.js 等） | 雨音のフェードイン／アウト。 |

> **Electron を選ぶ条件**（不採用理由の裏返し）: Linux 含む全OSで WebGL を盤石にしたい、または Rust を一切入れたくない場合のみ。本件はどちらにも当たりません。

---

## 動作環境

| 項目 | 内容 |
|---|---|
| 対応OS | **macOS（WKWebView）／ Windows 10 1803以降・11（WebView2）**。**Linux は対象外**。 |
| WebView2（Windows） | 11 は全機プリインストール。10 にも配布済みだが、ごく一部は未導入 → Tauri インストーラが `downloadBootstrapper` で自動導入。 |
| パフォーマンス | FPS上限 30fps 目安。待機・非表示・被覆時はレンダリング停止で省電力。 |
| アクセシビリティ | `prefers-reduced-motion` を**自動で尊重**（演出を簡略化／無効化）。Skip／Esc を常備し、ユーザーを閉じ込めない。 |

---

## インストール

> インストーラは **[最新リリース](https://github.com/katusaburou/Rainbreak/releases/latest)** の Assets から取得します。
> 現状は **未署名配布**です。OSの警告を回避する手順を以下に示します。署名は将来段階的に追加予定（[配布](#配布--リリース)参照）。

### macOS（`.dmg`）
1. `.dmg` を開き、アプリを「アプリケーション」へドラッグ。
2. **初回のみ**: アプリを右クリック →「開く」→ ダイアログで「開く」。2回目以降は通常起動。
3. 「壊れているため開けません」と出る場合は、ターミナルで：
   ```sh
   xattr -dr com.apple.quarantine /Applications/雨やどり.app
   ```

### Windows（`-setup.exe`）
1. `-setup.exe` を実行。
2. 「Windows によって PC が保護されました」が出たら →「詳細情報」→「実行」。

---

## 開発

### 前提
- Node.js（LTS）＋ pnpm（または npm）
- Rust ツールチェーン（`rustup`）
- 各OSの Tauri 前提（[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) 参照）

### セットアップ & 実行
```sh
pnpm install                     # フロント依存
node tools/gen-assets.mjs        # 背景・アイコン素材を生成（初回のみ）
pnpm tauri icon app-icon.png     # 各OS用アイコンを生成（初回のみ）
pnpm tauri dev                   # 開発起動（HMR + Rust ホットリロード）
pnpm tauri build                 # 各OSインストーラを生成
```

> アイコン（`src-tauri/icons/`）と素材は生成物のため git 管理外です。`pnpm tauri dev/build` の前に上記の生成コマンドを一度実行してください（CI は自動で実行します）。

### テスト / チェック
```sh
cargo test --manifest-path crates/core/Cargo.toml   # 状態機械の単体テスト
pnpm run check                                       # フロントの型チェック
pnpm run build                                       # 静的SPAビルド
```

### ディレクトリ構成
```
Rainbreak/
├─ src/                       # SvelteKit フロント（描画・演出のみ）
│  ├─ routes/
│  │  ├─ overlay/+page.svelte # 全画面・雨オーバーレイ窓
│  │  ├─ hud/+page.svelte     # 隅のHUDバー窓
│  │  └─ settings/+page.svelte# 設定窓
│  └─ lib/
│     ├─ rain/                # フレームワーク非依存の雨モジュール（将来のWeb版と共有）
│     ├─ audio/               # 雨音（Web Audio で合成）
│     ├─ ipc/                 # Tauri event/command ラッパ + 型
│     └─ motion.ts            # prefers-reduced-motion
├─ crates/core/               # 時間の真実: 状態機械（Tauri 非依存・単体テスト対象）
│  └─ src/phase.rs            # Work/Incoming/Shower/Clearing の遷移
├─ src-tauri/                 # Tauri シェル（Rust）
│  └─ src/
│     ├─ main.rs              # セットアップ・プラグイン・ウィンドウ・トレイ登録
│     ├─ scheduler.rs         # tokio interval（1s tick）
│     ├─ glue.rs              # イベント emit + フェーズ遷移の副作用集約
│     ├─ windows.rs           # ウィンドウ制御（show/hide/最前面/クリックスルー）
│     ├─ shortcuts.rs         # グローバル Esc
│     ├─ tray.rs              # トレイ・メニュー
│     ├─ commands.rs          # #[tauri::command]
│     ├─ config.rs            # 設定の永続化
│     └─ state.rs             # 共有状態
├─ static/bg/                 # ぼかし背景の静止画（屈折元）
├─ tools/gen-assets.mjs       # 背景・アイコン素材の生成（依存なし）
├─ .github/workflows/         # ci.yml（テスト/ビルド）・release.yml（tauri-action）
└─ docs/                      # 要件定義・実装計画
```

> 「時間の真実」は `crates/core` に分離し、Tauri 非依存で単体テストできるようにしています（実装計画 §4）。`src-tauri` はこのコアを駆動して描画窓へイベントを配信するシェルです。

詳細な段取りは **[docs/implementation-plan.md](docs/implementation-plan.md)** を参照してください。

---

## 設定（最小）

設定は「道具を管理させる」負債と捉え、**美的パラメータ（背景・雨量・演出強度）は作者が決め打ち**し、設定から外しています。残すのは次の3点のみで、値は永続化します。

- **作業時間 / 休憩時間**（デフォルト **20分 / 5分**）── 唯一の機能的可変項目。
- **音量 / ミュート** ── 好みではなく基本操作。
- **起動時の自動開始 ON/OFF** ── 常駐アプリの標準的利便。

---

## ロードマップ

### MVP（最小）
- 設定可能な 20/5 サイクル
- 4フェーズ（作業／予兆／通り雨／雨上がり）とウィンドウ連動
- 雨描画（自前背景1枚 ＋ raindrop-fx）
- 隅の HUD バー（数字なし・常時クリックスルー）
- トレイ常駐 ＋ 残り時間表示
- Skip／Esc
- GitHub Releases で未署名配布（mac `.dmg` / win `-setup.exe`）＋手順

### 後続（拡張）
- 予兆の演出磨き込み、雨音とフェード
- 自動アップデート（updater + `latest.json`）
- サイクル統計
- （必要なら）コード署名

> **roadmap から除外**: 集中中ずっと薄い雨を重ねる「雨の作業モード」。常時降雨は予兆ランプの可読性と排他になり、(B) の HUD バーが集中中の時間提示を担うため採りません。

---

## 配布 / リリース

- **GitHub Releases ＋ `tauri-apps/tauri-action`**。macOS(Arm/Intel)・Windows のインストーラをビルド → Release（ドラフト）作成＆アップロードまで自動化。起動方法は2通り:
  - **タグ push**: `git tag v0.1.0 && git push origin v0.1.0`（`v*` で発火）。
  - **手動実行**: GitHub の **Actions → release → Run workflow** で `version`（例 `v0.1.0`）を入力。タグを push できない環境向け。実行したコミットに同名タグを作成する。
  - いずれもドラフトのリリースが作られるため、内容を確認して **Publish** すると一般公開される。
- 生成物: macOS `.dmg`、Windows `.msi`(WiX) / `-setup.exe`(NSIS)。
- **未署名で配布**し、本 README とリリースノートに手順を明記。
- 自動アップデート（任意）: updater プラグイン ＋ `includeUpdaterJson: true` で `latest.json` を同梱（Tauri 更新用署名鍵が必要。OSのコード署名とは別物）。

### 将来のコード署名（任意・段階的）
- **macOS**: Apple Developer Program（年99ドル）→ Developer ID 署名＋notarization で Gatekeeper 警告を解消。
- **Windows**: **Azure Artifact Signing（旧 Azure Trusted Signing）は日本の個人・法人とも現在も対象外**。現実解は従来型 OV 証明書（年2〜4万円前後＋鍵の HSM/トークン保管）。EV の SmartScreen 即時回避特典は 2024 年に廃止済みで、署名しても評価が貯まるまで警告が出る点に留意。

---

## ⚠️ 着工前の技術検証ゲート

フル実装の前に、設計の前提を支える2点を最小プロトタイプで潰します。ここが転ぶと設計を組み替える必要があります。

1. **macOS：ユーザーの全画面アプリ上へのオーバーレイ表示。** 全画面エディタ／動画／Zoom の**上に**予兆・通り雨が出るか（`NSWindowCollectionBehaviorFullScreenAuxiliary` ＋ `canJoinAllSpaces` ＋ window level）。**未達なら中核体験が発火しない最優先課題**。
2. **予兆 → 通り雨のクリックスルー切替の体感。** `setIgnoreCursorEvents` ON→OFF 切替時のクリック取りこぼし／誤クリックを mac / win 両方で確認。

> 副次的に、内蔵GPU 機での通り雨フルスクリーン時の実機FPS も同じプロトで測ります。詳細は実装計画 **Phase 0** を参照。

---

## ライセンス

未定（個人開発 / ポートフォリオ用途）。

---

*本書は要件定義 v3（[docs/requirements-v3.md](docs/requirements-v3.md)）に基づきます。開発フェーズに合わせて随時更新します。*
