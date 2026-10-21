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

- ホストが部屋を作り、同じゲーム・キーワードを選んだゲストが入室します。
- 存在しない部屋には入室できず、使用中のキーワードで部屋を重複作成できません。
- キーワードはサーバー側でハッシュ化し、元の文字列は保持しません。
- 数字は部屋作成時に3桁または4桁を選び、重複なしです。
- 2人がそろった時点で数字設定の30秒カウントダウンが始まります。
- 30秒以内に数字を決定しなければ負けです。両者未決定なら両者とも負けになります。
- 対戦の制限時間は部屋作成時に15秒、30秒、45秒、60秒、無制限から選びます。
- 制限時間を過ぎると無回答として履歴に残り、相手のターンになります。
- 先攻が正解した場合は後攻に最後の回答機会を設け、両者正解ならDrawです。
- 後攻が不正解または時間切れなら先攻が勝ち、後攻だけが正解した場合は後攻が勝ちます。
- 終了後は同じ相手と再戦するか、メインに戻ります。再戦は先攻・後攻を入れ替えます。

## PWA

ホーム画面追加向けの `site.webmanifest`、PNGアイコン、サービスワーカーを入れています。

## メモ

`trycloudflare.com` のURLは一時URLです。常設URLにする場合は、この Node.js サーバーを WebSocket 対応のホスティングへ配置します。
