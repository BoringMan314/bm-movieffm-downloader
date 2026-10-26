# [B.M] MovieFFM Downloader

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3/)
[![Site](https://img.shields.io/badge/site-MovieFFM-e53249)](https://www.mvffm.net/)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](manifest.json)

適用於 [MovieFFM](https://www.mvffm.net/) 電影頁面的瀏覽器擴充功能。按下「下載」後，會依序嘗試可用的播放來源，並顯示來源與下載進度。

*适用于 MovieFFM 电影页面的浏览器扩展。点击“下载”后会依次尝试可用的播放来源，并显示来源和下载进度。*<br>
*MovieFFM の映画ページ向けブラウザー拡張機能です。「ダウンロード」を押すと、利用可能な再生ソースを順番に試し、ソースと進捗を表示します。*<br>
*A browser extension for MovieFFM movie pages. Select **Download** to try available playback sources in order and view the source and download progress.*

> **聲明**：本專案為第三方工具，與 MovieFFM 官方無關。請遵守網站服務條款及適用的著作權規範，並僅下載你有權保存的內容。

---

## 目錄

- [功能](#功能)
- [系統需求](#系統需求)
- [安裝方式](#安裝方式)
- [使用方式](#使用方式)
- [權限說明](#權限說明)
- [本機開發](#本機開發)
- [技術概要](#技術概要)
- [專案結構](#專案結構)
- [版本與多語系](#版本與多語系)
- [隱私說明](#隱私說明)

---

## 功能

- 在目前的 MovieFFM 電影頁面讀取影片標題和可用播放來源，並依序嘗試來源。
- 若播放器正在播放且能辨識目前來源，優先沿用該來源。
- 顯示目前片名、來源、進度，以及嘗試來源所經過的時間。
- 下載期間可暫停、恢復或停止；關閉擴充功能面板後，下載仍會在背景繼續。
- 一般模式與無痕模式的下載狀態分開保存。無痕模式須先在瀏覽器的擴充功能設定中允許使用本擴充功能。
- 對每個來源分別嘗試，不會把不同來源的影片片段混在同一個檔案中；檔名會附上 `_片源XX`。
- 依播放來源格式保存為 MP4、FLV 或 TS；HLS 播放清單依其媒體片段格式產生檔案。

---

## 系統需求

- 支援 **Manifest V3** 的 Chromium 瀏覽器，例如 **Google Chrome** 或 **Microsoft Edge**。
- 可存取 [MovieFFM](https://www.mvffm.net/) 影片頁面及該影片使用的來源主機。

---

## 安裝方式

### 從原始碼載入

1. 取得本專案原始碼並解壓縮（若已在本機，直接使用專案資料夾）。
2. 在 Chrome 開啟 `chrome://extensions`；在 Edge 開啟 `edge://extensions`。
3. 開啟「**開發人員模式**」，選擇「**載入未封裝項目**」。
4. 選取包含 [`manifest.json`](manifest.json) 的專案根目錄。
5. 開啟 MovieFFM 電影頁面，點擊工具列中的擴充功能圖示即可使用。

---

## 使用方式

1. 在 MovieFFM 開啟要下載的電影頁面。
2. 點擊擴充功能圖示，再按「**下載**」。
3. 首次連線至影片來源時，依 Chrome 提示允許存取必要的來源主機。
4. 面板會顯示目前正在嘗試的來源；找到可用來源後，Chrome 會開始下載並顯示進度。
5. 下載中可按「**暫停**」／「**恢復**」或「**停止**」。停止後再次按下載會重新開始來源嘗試。

「開啟 MovieFFM」會在新分頁開啟網站首頁。下載進度按一般模式或無痕模式分開保存，不依目前切換到哪個分頁區分。

---

## 權限說明

| 權限 | 用途 |
|------|------|
| `activeTab` | 使用者點擊擴充功能時讀取目前分頁。 |
| `scripting` | 從 MovieFFM 頁面和播放器讀取片名及播放來源。 |
| `downloads` | 建立、暫停、恢復、停止及追蹤下載。 |
| `storage` | 保存一般／無痕模式各自的下載狀態。 |
| `offscreen` | 在面板關閉後繼續處理串流下載及進度。 |
| 選用的 HTTP／HTTPS 網站存取權 | 使用者啟動下載後，請求存取偵測到的影片來源主機；不會預先要求所有來源網站的存取權。 |

---

## 本機開發

本專案不需建置步驟。修改程式後，到 `chrome://extensions` 或 `edge://extensions` 重新載入擴充功能，再重新整理 MovieFFM 分頁確認變更。

---

## 技術概要

- **面板** [`popup.html`](popup.html)、[`popup.css`](popup.css)、[`popup.js`](popup.js)：讀取目前 MovieFFM 分頁、呈現下載狀態，並提供下載控制。
- **背景服務工作者** [`service-worker.js`](service-worker.js)：建立下載用的 offscreen 文件、呼叫 Chrome Downloads API，並將進度保存到 `chrome.storage.local`。
- **串流下載器** [`downloader.html`](downloader.html)、[`downloader.js`](downloader.js)：取得播放清單與媒體片段，依來源格式產生單一下載檔案；不同來源分開處理。
- **多語系** [`_locales/`](_locales/)：提供擴充功能名稱、描述及介面文字。

---

## 專案結構

| 路徑 | 說明 |
|------|------|
| [`manifest.json`](manifest.json) | Manifest V3 設定、權限、工具列圖示及背景服務工作者。 |
| [`popup.html`](popup.html)、[`popup.css`](popup.css)、[`popup.js`](popup.js) | 擴充功能面板與操作介面。 |
| [`service-worker.js`](service-worker.js) | 下載管理、模式狀態保存及 offscreen 文件管理。 |
| [`downloader.html`](downloader.html)、[`downloader.js`](downloader.js) | 串流來源解析與下載處理。 |
| [`_locales/`](_locales/) | `zh_TW`、`zh_CN`、`ja`、`en_US` 介面字串。 |
| [`icons/`](icons/) | 擴充功能圖示。 |

---

## 版本與多語系

- **版本**：以 [`manifest.json`](manifest.json) 的 `version` 為準，目前為 `0.1.0`。
- **預設語系**：`zh_TW`。
- **內建語系**：`zh_TW`、`zh_CN`、`ja`、`en_US`；實際介面依瀏覽器語言設定顯示。

---

## 隱私說明

擴充功能會讀取目前 MovieFFM 頁面的片名與播放來源，並連線至影片來源主機以取得及下載影片資料。程式未實作廣告追蹤、分析或將影片／瀏覽記錄上傳至其他服務的功能。下載請求會依影片來源網站的回應與瀏覽器下載設定處理。
