# US Plant Science Career Radar v8 — Job Validation

v8 先把資料品質做好，不再盲目增加來源。

## 三層驗證

1. **職稱必須像職位**
   - Scientist
   - Professor
   - Researcher
   - Specialist
   - Agronomist
   - Pathologist
   - Postdoc
   - Product / Field Development

2. **頁面必須像招聘頁**
   - LinkedIn / Indeed
   - HigherEdJobs / APS / AcademicJobsOnline
   - Greenhouse / Lever / SmartRecruiters / Workday
   - URL 含 jobs / careers / position / posting / requisition
   - 或頁面有 JobPosting structured data

3. **直接排除明顯非職缺網站**
   - Chrome Web Store
   - YouTube
   - Wikipedia
   - Amazon
   - Facebook / Instagram
   - Reddit / Medium
   - GitHub

## 舊誤判也會清理

v8 每次更新也會重新驗證 GitHub 上既有的 `data/jobs.json`。
因此像 `Chrome Web Store` 這種已經進資料庫的誤判，下一輪 Actions 會被移除。

## Data-safe

v8 ZIP 不包含：
- `data/jobs.json`
- `data/status.json`
- `data/application-progress.json`

所以直接覆蓋程式檔，不會先把現有職缺清空。

## 更新方法

1. 解壓 v8。
2. 直接把內容上傳到 repository 根目錄，不用先刪同名檔。
3. 保留 GitHub 上原本的 `data/jobs.json` / `data/status.json`。
4. Actions → `Update US plant science jobs and deploy` → `Run workflow`。
5. 綠色完成後重新整理網站。

首頁「來源健康狀態」上方會顯示本輪排除的非職缺數量。
