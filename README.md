# US Plant Science Career Radar v6

v6 重做 Industry 資料來源，保留 v5 的 Job Search CRM 與 GitHub Sync。

## Industry 資料來源

1. **LinkedIn**
   - 不登入、不直接爬 LinkedIn 帳號。
   - 用 Bing RSS 搜尋公開索引的 `linkedin.com/jobs/view` 頁面。
   - 點職缺後回 LinkedIn 查看。

2. **Indeed**
   - 同樣用搜尋引擎公開索引作補充。
   - 不需要 Indeed API key。

3. **Official / ATS**
   - 搜尋公司官方 careers。
   - 如果搜尋結果發現 `boards.greenhouse.io/<company>`，程式會自動解析 board token，再用 Greenhouse 公開 Job Board API 擴大抓取該公司的相關職缺。
   - 如果發現 `jobs.lever.co/<company>`，會自動用 Lever public postings endpoint 擴大抓取。

4. **Academia**
   - HigherEdJobs
   - AcademicJobsOnline
   - University / academic board 搜尋

## 為什麼不是直接 LinkedIn API / Indeed API？

LinkedIn 官方 Job Posting API 是給經核准的 ATS / partner 發布職缺，不是一般個人 job-search API。
Indeed 有 Publisher / partner 整合，但需要 Indeed partner access。

因此 v6 採用：
**Official careers / public ATS > LinkedIn / Indeed indexed links**。

## 上傳

把 ZIP 解壓後的所有內容直接覆蓋到 `plant-science-job-radar` repository 根目錄。

根目錄應看到：

- `.github/`
- `data/`
- `scripts/`
- `index.html`
- `style.css`
- `app.js`
- `config.json`
- `requirements.txt`

## 第一次更新

GitHub:
`Actions → Update US plant science jobs and deploy → Run workflow`

跑完後再重新整理 Pages。

## GitHub Sync

右上角 `☁ GitHub 同步`。

建議把進度同步到獨立 private repo：
`plant-science-job-radar-data`

Fine-grained PAT 僅授權：
- 該 private repository
- Contents: Read and write

不要把 token 貼到聊天室或 commit 到 repository。

## 進階：手動指定 Greenhouse / Lever

如果你知道某家公司使用 Greenhouse 或 Lever，可在 `config.json` 填：

```json
"manual_greenhouse_boards": ["company-token"],
"manual_lever_sites": ["company-site-token"]
```

每天更新時會直接掃完整公開 job board，再只留下植物／農業相關職缺。
