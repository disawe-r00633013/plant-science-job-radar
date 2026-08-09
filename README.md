# Academic Job Radar｜學界職缺雷達

一個可直接放到 **GitHub Pages** 的靜態職缺儀表板。GitHub Actions 每天自動執行 Python，從公開職缺頁面抓取資料、去重、關鍵字評分，再更新 `data/jobs.json`。

## 目前預設來源

1. HigherEdJobs — Plant & Soil Science
2. APS Job Board
3. AcademicJobsOnline

> 網站可能改版、加上 bot protection 或更改 HTML。腳本採「失敗保留舊資料」設計，不會因單一來源抓取失敗而把歷史職缺清空。首頁會顯示來源失敗提示。

## 最快安裝方式

### 1. 建立 GitHub repository

例如命名：`academic-job-radar`

將 ZIP 解壓縮後，**把裡面的所有檔案與資料夾完整上傳到 repository 根目錄**。請保留：

```text
.github/workflows/update-jobs.yml
scripts/fetch_jobs.py
data/jobs.json
```

### 2. 開啟 GitHub Pages

GitHub repository：

`Settings → Pages → Build and deployment → Source → Deploy from a branch`

選：

- Branch: `main`
- Folder: `/ (root)`

儲存後，GitHub 會提供 Pages 網址。

### 3. 先手動跑一次更新

到：

`Actions → Update academic jobs → Run workflow`

成功後 `data/jobs.json` 與 `data/status.json` 會自動更新。

### 4. 自動更新時間

目前 `.github/workflows/update-jobs.yml` 設定為：

**每天 07:15，Asia/Taipei**

GitHub Actions 的 scheduled workflow 支援 cron；目前 GitHub 也支援在 schedule 內指定 IANA timezone。

## 如果 GitHub Actions 無法 push

Workflow 已包含：

```yaml
permissions:
  contents: write
```

若 repository 有額外 branch protection，仍可能擋住自動 push。一般個人 repository 使用預設 main branch 時不需額外處理。

## 修改「什麼工作算適合」

編輯 `config.json`。

例如：

```json
{"term": "plant pathology", "points": 22, "label": "Plant Pathology"}
```

代表頁面文字出現 `plant pathology` 就加 22 分。

可以自行增加：

```json
{"term": "rhizosphere", "points": 12, "label": "Rhizosphere"}
```

或降低不相關工作的分數。

分數最後限制在 0–100，首頁預設只顯示 80 分以上。

## 新增來源

`config.json` 的 `sources` 目前支援三種 parser：

- `higheredjobs`
- `aps`
- `ajo`

若只是想新增同一網站另一個 listing URL，可複製一個來源項目。若是全新網站，需在 `scripts/fetch_jobs.py` 的 `listing_candidates()` 加一個 parser 規則。

## 收藏 / 已申請 / 隱藏

這三個狀態存在瀏覽器 `localStorage`，所以：

- 不會被 GitHub Actions 蓋掉
- 不會上傳到 GitHub
- 換電腦或清除瀏覽器資料後不會同步

如果之後想跨裝置同步，可以再改成 GitHub Issues、Firebase、Supabase 或其他後端。

## 本機預覽

不要直接雙擊 `index.html`，部分瀏覽器會因為 `file://` 限制而擋住 JSON。

在解壓縮資料夾開終端機：

```bash
python -m http.server 8000
```

然後開：

```text
http://localhost:8000
```

## 資料欄位

每個 job 大致包含：

- `title`
- `institution`
- `location`
- `source`
- `url`
- `postedDate`
- `deadline`
- `firstSeen`
- `lastSeen`
- `active`
- `score`
- `matchReasons`
- `tags`

## 重要限制

這是一個個人職缺雷達，不是正式的職缺 API。公開職缺網站可能隨時更改版型或使用防爬機制，因此：

1. 首頁保留各來源的「直接開啟來源」連結。
2. 抓取失敗時保留舊資料。
3. `active` 是依「最近是否仍被 listing 看見」判斷，不等同校方正式確認仍在招聘。
4. Deadline 若頁面無法可靠解析，就保持空白，不自行猜測。

## 檔案結構

```text
academic-job-radar/
├── index.html
├── style.css
├── app.js
├── config.json
├── requirements.txt
├── README.md
├── data/
│   ├── jobs.json
│   └── status.json
├── scripts/
│   └── fetch_jobs.py
└── .github/
    └── workflows/
        └── update-jobs.yml
```
