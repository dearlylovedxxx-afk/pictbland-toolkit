## v0.3.47 — 保存検索「まとめて新着」除外タグのクラウド同期対応

- 除外タグの変更時だけ更新日時を記録し、Niji Cloud Backupに変更通知を送信します。
- Niji Cloud側からの反映時、開いている「まとめて新着」のタグ表示とフィルタを自動更新します。
- 表示までのタグ確認方法は従来のままです。既存の作品収集・除外ロジックは変更していません。

# pictbland-toolkit

pictBLand向けの個人用ツール集です。

- `index.html` — 印刷PDFから本文を抽出してTXT化するブラウザツール
- `PictBLand_Novel_Tools.user.js` — pictBLand小説ページ用Userscript
- `PictBLand_Novel_Tools.meta.js` — Userscript更新確認用メタデータ

PDF→TXTツールはPDFをブラウザ内で処理し、PDFファイル自体をサーバーへ送信しません。
