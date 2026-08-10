# US Plant Science Career Radar v7 — Data Safe

v7 修正 v6 會因新版 ZIP 的空 `jobs.json` 把舊資料清掉的問題。

## 最重要的改變

**v7 ZIP 不包含 `data/jobs.json` 與 `data/status.json`。**

所以把 v7 上傳到既有 GitHub repository 時：
- 舊的 `data/jobs.json` 會留在 GitHub。
- 新版程式每天把「舊資料 + 今天各來源新資料」合併。
- 單一來源被擋或暫時回傳 0 筆，不會讓其他職缺消失。
- 無 deadline 的舊職缺預設保留 90 天。
- 有 deadline 的職缺在 deadline 過後 14 天才會淘汰。

## v7 資料來源

### Academia
- HigherEdJobs Plant & Soil Science：直接讀取分類頁與 JobPosting structured data
- HigherEdJobs Agriculture：直接讀取
- APS Job Board：直接讀取 + indexed fallback
- AcademicJobsOnline：indexed fallback
- University official pages：搜尋與 structured data
- Recovery seed：UMass / UF / Cornell 三筆目前已知有效職缺，防止升級時再次消失

### Industry
- LinkedIn public job-search pages：10 組較小關鍵字搜尋
- Indeed public search：best effort；若 Indeed 擋自動化，不影響其他來源
- 13 家農業公司逐家公司搜尋
- Greenhouse 公開 Job Board API：找到 board token 後自動擴充
- Lever public Postings API：找到 site token 後自動擴充
- SmartRecruiters：已知 tenant 做 best-effort public postings fetch
- Bing RSS：只當備援，不再是唯一來源

## 公司搜尋
Syngenta、Corteva Agriscience、Bayer Crop Science、BASF、FMC、Valent、UPL、Gowan、Certis Biologicals、BioWorks、Pivot Bio、Indigo Ag、Ohalo Genetics。

## 上傳 v7

把 ZIP 解壓縮後覆蓋 repository 根目錄。

`data/` 裡 v7 新增的是：
- `seed_jobs.json`

**不要刪除 GitHub 上原本的：**
- `data/jobs.json`
- `data/status.json`

v7 ZIP 本身沒有這兩個檔，所以正常覆蓋不會碰它們。

## Workflow

你目前 v6 的 `Update US plant science jobs and deploy` 與 v7 相容。
即使 `.github` 隱藏資料夾這次沒有被瀏覽器上傳，v7 仍可正常跑。

上傳後：
`Actions → Update US plant science jobs and deploy → Run workflow`

完成後首頁會新增「來源健康狀態」。即使 LinkedIn / Indeed 本輪抓到 0 筆，也會顯示 0 筆與是否成功，不會整個來源消失。

## GitHub Sync

CRM 仍支援 private data repo 同步。Fine-grained token 只需要該 private data repo 的 `Contents: Read and write`。
