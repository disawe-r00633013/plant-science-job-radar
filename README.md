# US Plant Science Career Radar v5

只搜尋美國的 Academia + Industry 植物科學相關工作，並加入 Job Search CRM 與 GitHub 進度同步。

## v5 新功能：GitHub Sync

收藏、已申請、隱藏、申請日期、申請狀態、deadline、下一次面試與備註，可同步至 GitHub：

`data/application-progress.json`

每筆職缺都包含 `updatedAt`，不同電腦同步時會依每筆資料的最後修改時間合併，而不是整份直接覆蓋。

網站上的「☁ GitHub 同步」可以：
- 儲存同步設定
- 從 GitHub 拉取進度
- 立即同步
- 已連線後，每次變更收藏／已申請／備註時自動同步

## ⚠️ Public repository 隱私

你目前的主 repository 如果是 Public，放在同一個 repo 的
`data/application-progress.json` 也會公開。

如果備註、面試日期或求職進度不希望公開，建議：
1. 保持網站主 repository 為 Public。
2. 另外建立一個 **Private repository**，例如 `plant-science-job-radar-data`。
3. 在網站「GitHub 同步」中把 Repository 改成這個 private repo。
4. Token 只給該 private repo 的 Contents read/write 權限。

如果使用 private data repo，網站必須透過 GitHub token 讀寫，所以新裝置第一次使用時需要輸入 token。

## 建立 fine-grained token

GitHub：
`Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token`

建議：
- Resource owner：你的 GitHub 帳號
- Repository access：Only select repositories
- 只選要存進度的 repository
- Repository permissions：
  - **Contents: Read and write**
- 不需要 Actions、Administration 或 Workflows 權限
- 建議設定 expiration

### Token 在網頁的保存方式

預設不勾「記住 token」：
- token 只存 `sessionStorage`
- 關閉該瀏覽器分頁／session 後需要重新輸入

勾選「記住 token 在這台裝置」：
- token 會存於該瀏覽器的 `localStorage`
- 比較方便，但任何能在該頁面執行的 JavaScript 理論上都可能讀到它

因此請務必使用只限定單一 repo、只有 Contents read/write 的 fine-grained token。

**Token 永遠不會被寫進 `application-progress.json` 或 commit 到 repository。**

## 上傳方式

將 ZIP 解壓後的內容覆蓋到既有 repository 根目錄。

根目錄應直接看到：
- `.github/`
- `data/`
- `scripts/`
- `index.html`
- `style.css`
- `app.js`
- `config.json`
- `requirements.txt`

其中 `data/` 會多：
- `jobs.json`
- `status.json`
- `application-progress.json`

## GitHub Pages

`Settings → Pages → Build and deployment → Source → GitHub Actions`

接著：
`Actions → Update US plant science jobs and deploy → Run workflow`

如果 application progress 寫進同一個主 repo，瀏覽器透過 API commit 後會觸發既有 push workflow，Pages 也會重新部署。

## CRM 流程

- 🔎 新職缺
- ♡ 收藏
- ✓ 已申請
- 🚫 隱藏

已申請可追蹤：
- Applied
- HR screening
- Interview
- Final interview
- Offer
- Rejected
- Withdrawn

## 搜尋更新

每天台灣時間 07:15 執行 GitHub Actions 搜尋美國職缺。
