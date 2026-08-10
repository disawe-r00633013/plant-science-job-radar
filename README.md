# US Plant Science Career Radar v9 — Bullet Cards

v9 保留 v8 的來源與職缺驗證，只改職缺卡閱讀方式。

每張職缺改成：
- 職稱
- 公司／學校
- 地點
- 「職缺摘要」3–5 點
- Match tags
- 來源、首次發現、最近看到、網站
- 查看職缺／收藏／已申請／隱藏

另外會自動：
- 解碼 `&amp;`
- 移除 `<p>`, `<strong>` 等 HTML tags
- 將長摘要切成最多 5 個條列
- 太長的單點自動截短

v9 ZIP 仍不包含 live `data/jobs.json` / `data/status.json`，所以直接覆蓋上傳即可，不會清掉資料。
