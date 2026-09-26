# Career-Ops v1.34 升級與 Sunny 功能保留 Spec

## 使用者授權與順序

使用者已要求以 approved-execute 進行 spec writing 與執行既有升級計劃，並最新明確縮小範圍為「只要先專注在升級計劃」。本次只完成升級；來源錯誤、來源警告與 JD 無法讀取的修復不在本次執行範圍。

對應計劃：`docs/superpowers/plans/2026-09-24-career-ops-134-preserve-sunny.md`。初始執行 HEAD 為 `2bc543bf735b5f72182036e474be229934f1496b`。完整 approval evidence 與未提交修改快照保存在專案外的 approved-execute run directory。

## 結果

正式專案整合固定官方 release `career-ops-v1.34.0`（`de7f7fe8fe65852b9743bbdce94f0304101a749e`），現有 Sunny 功能及私人資料繼續可用。每個官方 system 檔案都須記錄採用、合併、保留或有依據的刪除；不能只改版本號。

本階段的成功不是把既有黃色狀態改綠。既有來源／JD 問題需保留真實證據；升級必須不增加回歸、漏掃、重複發布或資料損失。

## 選定設計

採用隔離 checkout、私人資料副本、固定 release 的逐檔整合。官方更新器的直接覆蓋或只保留整個客製舊檔，均無法完整取得修補並保留 Sunny 的行為；因此衝突檔以真正共同祖先和目前檔案逐段合併。

正式資料在隔離實作期間繼續前進。只在一致備份與正式切換時短暫暫停相關 writer，切換只導入已審阅的程式差異，不用測試副本覆蓋現行資料。失敗時優先回復程式，保存切換後新增的有效資料。

## 必須保留的契約

1. H-1B 八季度 `CHANGE_EMPLOYER`、Tier A/B、exact employer/ATS identity；現有 NYC Metro／U.S. remote、兩種履歷職類與 100 分評分規則；Meta/FDE 與 JD 明示不贊助等門檻。
2. 日常 planner 的紐約日曆日、三天重疊、一次 scan claim；精確 board 的固定補掃視窗及共用鎖／lease。
3. 發現紀錄與已處理結果分離；pending 不被 history 吃掉，terminal 不重評、不重發。
4. normal 優先、candidate/source 例外分離、保留重試與第三次失敗診斷；只有官方關閉證據可關閉職缺。
5. immutable batch、原 payload、operation ledger、unfinished operation、receipt 與 resume；沒有 read-back 證據不能宣稱 COMPLETE。
6. 本機 archive、網站歷史職缺、搜尋／篩選、最近 Connections、同公司多職缺內推訊息與編輯／複製。
7. LinkedIn headline-only、有限候選、exact/accepted alias、一次重試、fail-soft、私人 state 與既有保留期限；不登入、不開人員 profile、不聯絡或投遞。
8. 真實的掃描狀態、歷史完成日、tooltip；jobs snapshot 失敗不阻止 status snapshot 更新，partial/unverified 不得變綠。
9. Balanced A4 一頁、字型／字級／黑白／教育兩列／Skills 最後／無 Summary，以及舊 PDF、履歷變體與 application mapping。
10. 所有本機 ATS 支援、pacing、重試、日期與分頁改善；不能因 upstream 沒有某個檔案就刪除。
11. 原排程 owner、時區、執行時間與 ACTIVE/PAUSED 狀態；不新增重複排程、不改 Grok 功能。

## 已知相容問題

最新 `modes/_custom.md` 已要求只發布至本機，saved `sunny-24` prompt 仍有舊 Sheet-first 指令。升級需驗證並對齊 local-only 契約，保留歷史 Sheet ledger 欄位和 open batch 的真實證據；不得假造 done 或重新啟用已停用的外部寫入。

未追蹤的 Balanced Education 測試使用 `finish()`，與全套 runner 的 discovered-suite 規則不一致。先記錄 baseline 結果，必要時只調整測試接入方式，保留所有版型 assertion 及私人 fixture。

## 資料與變更邊界

保護 Data Contract user layer、額外 local paths、未提交／未追蹤檔案、外部 data root、私人設定、controller 的絕對 payload 路徑、網站 snapshots、referral state、DOL index、receipts、queue 與履歷歷史。不得清理現有佇列或用重評分掩蓋不相容。

依賴只做版本整合必要的調整；保留 Sunny 用到的套件。評分、來源啟用、公司範圍與履歷內容不擴張。本次不處理來源錯誤／警告／JD 修復，也不順手改其狀態。

## 驗收

- 官方 manifest 完整處置，版本及來源 commit 可追溯。
- 對應計劃 P01–P15 各有實際執行的驗證結果，不以測試檔存在或退出碼 0 代替證據。
- 基線與候選環境使用同一份固定輸入與日期；核心 Sunny 測試通過，零新增回歸。既有全套／資料問題分開列出，不自動修改 tracker 以求測試綠燈。
- 網站、內推、掃描狀態及兩份既有履歷變體均經適當功能／視覺驗證。
- 備份 test-extract/checksum 與程式回復演練通過；切換期間沒有未授權的私人資料變動。
- 切換後觀察正常執行／安全 resume，確認 receipt、queue、controller、archive/index 與 status 契約保留。既有來源錯誤可以仍真實存在，不能被當作升級已修好或隱藏。
- 獨立 smart-reviewer 對確切最終 change snapshot 給出 PASS，完成本次升級任務。

## 執行治理

approved-execute：fresh Astra/xhigh plan review → fresh Terra/medium 實作 → fresh Astra/xhigh 實作審查；如有具體問題，fresh Terra 修正後再由 fresh reviewer 審查。父 agent 只負責規劃、交接與證據保存，不實作正式程式。

既有批准的計劃包含隔離整合、必要 scheduler 切換與 scoped commits；不得遠端 push、傳送訊息或投遞申請。review 以本 spec 與使用者可見契約為界，不新增無關的安全／架構工程。
