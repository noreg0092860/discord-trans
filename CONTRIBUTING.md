# 貢獻指南

歡迎貢獻。這份文件說明怎麼跑起專案、送出改動前該通過什麼，以及本專案幾條不能違反的底線。

> **English**: Contributions are welcome. Issues and pull requests may be written in English or Traditional Chinese. The essentials: Node 22+, `npm test` must pass, and the four safety invariants in [不可違反的底線](#不可違反的底線) are enforced by CI.

## 回報問題前

- **絕對不要貼出你的 DeepL API 金鑰**，也不要貼含金鑰的畫面截圖或網路請求內容。金鑰外洩等於別人可以耗光你的額度。
- **不要貼真實的 Discord 訊息內容、使用者名稱、頭像或伺服器邀請連結**。那是其他人的個人資料。要示範畫面，請用專案內附的仿真頁：`npm run screenshots`。
- 翻譯突然整個失效時，多半是 Discord 改版讓錨點失效。請先照 [README 的「Discord 改版時的修法」](README.md#discord-改版時的修法) 跑一次 `window.__DT_DEBUG()`，把輸出貼進 issue，這對定位幫助最大。

## 開發環境

需要 Node 22 以上（`node --test` 的 glob 參數需要）。

```bash
git clone https://github.com/noreg0092860/discord-trans.git
cd discord-trans
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

若本機沒有 Playwright 用的 Chromium，跑端對端測試前先裝：

```bash
npx playwright install chromium
```

載入擴充元件：`chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `extension/` 資料夾。改完程式碼要回這頁按**重新載入**，再重整 Discord 分頁。

## 送出改動前

```bash
npm test        # 靜態檢查 + 單元測試 + 端對端測試，三者都要綠
```

拆開跑：

| 指令 | 內容 | 何時會用到 |
|---|---|---|
| `npm run check` | 語法、manifest 權限範圍、安全底線、錨點規則 | 改任何 `extension/` 下的程式碼 |
| `npm run test:unit` | `node:test` 純函式測試，零依賴、跑得很快 | 改 `lib/shared.js` |
| `npm run test:e2e` | Playwright 實際載入擴充元件，對 mock DeepL 跑 | 改 content script、background、popup |
| `npm run screenshots` | 重產 README 的三張截圖 | 改動影響到畫面外觀 |

測試不需要真實的 DeepL 金鑰，全程對本機的假 DeepL 伺服器（`tests/mock-deepl.js`）跑。

同樣的檢查會在 GitHub Actions 上跑一次（單元測試另外測 Node 22 與 24），設定在 `.github/workflows/tests.yml`。

## 不可違反的底線

這四條由 `npm run check` 強制執行，CI 會擋下違反的 PR。它們不是風格偏好，而是這個擴充元件敢要求使用者填入金鑰的理由：

1. **content script 不得讀取金鑰值，也不得直接連網。** 所有 DeepL 呼叫留在 background service worker。content script 可以知道金鑰「變了」（用來重試失敗的訊息），但不能知道它「是什麼」。
2. **不得以 HTML 字串寫入譯文。** 一律 `textContent`。譯文來自外部服務，用 `innerHTML` 等於開一個 XSS 破口。
3. **選擇器不得使用 Discord 的 hash class**（形如 `messageContent_c19a55`）。那種 class 每次 Discord 部署都會變。錨點只能用穩定的 id 前綴，且集中在 `extension/content/content.js` 頂部的 `SELECTORS`。
4. **manifest 權限不得擴張。** 權限維持 `["storage"]`，host 權限維持兩個 DeepL 網域。要加權限請先開 issue 討論。

另外兩條寫在程式註解裡、同樣重要：

- **不要用 `getElementById` 找訊息元素。** 回覆引用列內部會重複使用被引用訊息的 id，同一頁會有多個相同 id。只能用 observer 交付的元素參照。
- **抓訊息文字時要跳過螢幕閱讀器專用的隱藏文字。** Discord 在「(已編輯)」標記旁放了完整日期，混進正文會讓 DeepL 誤判來源語言。

## 程式風格

- 純 Vanilla JS（ES2022），**執行期零依賴、無建置步驟**。devDependencies 只有 Playwright。加入任何執行期依賴前請先開 issue。
- 檔案開頭一行說明用途；註解寫「為什麼」，不寫「做了什麼」。
- 使用者看得到的文字用繁體中文。
- 跟隨周圍程式碼的既有寫法，不要順手重排無關的程式碼。

## 送 PR

1. 從 `main` 開分支。
2. 一個 PR 做一件事。修 bug 的 PR 請順手把它固化成一條測試，這樣它不會再回來。
3. 確認 `npm test` 全綠，並把結果貼進 PR 描述。
4. 改動若影響畫面，附上 `npm run screenshots` 產生的圖或你自己的截圖（記得遮掉金鑰與他人訊息）。

commit 訊息用祈使句，說明「為什麼」而不只是「改了什麼」。中英文皆可。

## 回報安全問題

若你發現的是安全問題（例如金鑰可能外流、XSS），**請不要開公開 issue**。請透過 GitHub 的 [Security Advisories](https://github.com/noreg0092860/discord-trans/security/advisories/new) 私下回報。

## 授權

送出貢獻即表示同意你的改動以 [MIT 授權](LICENSE) 釋出。
