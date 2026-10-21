# Hit & Blow Match

スマホのブラウザで遊ぶ、キーワードマッチング式のオンライン対戦ヒットアンドブローです。

## 起動

```powershell
npm install
npm start
```

PC では `http://localhost:3000` を開きます。

同じWi-Fiのスマホから試す場合は、PC のローカルIPを使って `http://PCのIP:3000` を開きます。

## 公開URL

### 常設公開 (Render)

公開URL: https://keyword-board-games.onrender.com/

管理画面: https://dashboard.render.com/web/srv-dbc7oghsrm7s73fu744g

ソース: https://github.com/e-Effect/keyword-board-games

公開Gitリポジトリーから作成したサービスです。更新時はGitHubへpushした後、
Render管理画面のManual Deployから最新コミットをデプロイします。

`render.yaml` に無料Webサービスの設定があります。
ビルドは `npm ci && npm test`、起動は `npm start`、ヘルスチェックは `/health` です。
HTTPとWebSocketは同じホストを使います。PC側のサーバーやトンネルは不要です。

無料プランは15分間通信がないと休止し、次のアクセスで自動起動します。
初回表示には約1分かかる場合があります。
対戦データはメモリー上にあるため、サービス再起動時には失われます。

公開先の疎通・対戦確認:

```powershell
node scripts/verify-hosted.cjs https://keyword-board-games.onrender.com
```

### ローカルの一時公開

ローカルサーバーを起動したまま、別のPowerShellで次を実行します。

```powershell
npm run tunnel
```

表示された `https://...trycloudflare.com` のURLを相手に送ると、別の回線からも対戦できます。

## ルール

- 同じキーワードを入力した2人がマッチングします。
- キーワードはサーバー側でハッシュ化し、元の文字列は保持しません。
- 数字は3桁、重複なしです。
- 制限時間は部屋作成時に15秒、30秒、45秒、60秒から選びます。
- 制限時間を過ぎると無回答として履歴に残り、相手のターンになります。
- 交互に予想し、3 Hit を出したプレイヤーが勝ちです。

## PWA

ホーム画面追加向けの `site.webmanifest`、PNGアイコン、サービスワーカーを入れています。

## メモ

`trycloudflare.com` のURLは一時URLです。常設URLにする場合は、この Node.js サーバーを WebSocket 対応のホスティングへ配置します。
