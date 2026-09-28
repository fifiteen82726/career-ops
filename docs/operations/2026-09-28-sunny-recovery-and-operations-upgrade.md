# Sunny 補抓與營運升級紀錄（2026-09-28）

本次升級將 Sunny 的日常掃描、精確補抓與狀態結算串成可稽核流程。原始掃描 receipt 與既有 payload 一律保留；後續補抓只新增自己的 receipt，狀態由兩者與 controller closeout 共同判斷。

## 已完成的行為

- 掃描來源缺口使用包含原始 run、provider、board 與絕對日期窗的 identity。午後 worker 僅處理到期的精確補抓，不宣告或執行第二次 daily/global scan；會保留 Retry-After、節流與 deferred 證據。
- Jibe 與 Workday 的分頁／facet continuation 有持久 frontier。序列化 Sunny child 會保存頁面；只有 parent 將 canonical intake 寫入 job queue 後才確認頁面。child output 遺失後的 replay 會把已在 scan history 的合格 URL 再送入 queue；partial、頁面上限或未完成分區仍顯示為覆蓋缺口。
- JD 讀取具結構化結果。iCIMS、Oracle、Greenhouse wrapper、EY 與 Paylocity 的已驗證讀取路徑可區分成功、不可用、封鎖、暫時性失敗、解析失敗與權威的職缺失效。只有官方、同一職缺的 expiry 證據可關閉候選。
- source-only recovery 只有在精確 board/window、完整 receipt、完整 canonical intake、對應 resolved evidence，以及原始日的 controller final closeout 都存在時，才能清除該缺口。封存 controller 以 `scan_claim.scan_id` 對應原始 scan receipt；每個來源缺口必須各自有精確回補，不可由一個 recovery 清除兩個缺口。單獨將 queue 標為 `resolved`、probe、錯誤 board/window 或缺 closeout 都不會變綠。執行完成與 coverage completion 分開顯示。
- `build-sunny-job-search-index.mjs` 在 jobs archive 重建失敗時仍刷新 scan status，並保留上一次有效的 jobs artifact。
- NYC 與 Remote routine 以單一 scope 執行，保存 collector/request/page/continuation receipt；每一個 provider request 都在送出前重查 deadline，Built In 的內部分頁同樣受剩餘時間限制。The Muse 在頁面上限前保存 exact continuation，下一次同 scope/source invocation 會從該 frontier 繼續。later-page 或 query 失敗會保留早先 rows 並標記 partial。
- coverage gap 的「選取」本身不是驗證：它只建立含具體官方 identity/ATS 驗證下一步的 `deferred` review-work-item receipt，不會增加 attempt、寫 cooldown 或宣告 coverage complete。真正 portal CAS 失敗則由 resolver 在外層 routine 之前先寫自己的 `resolve`/`error` 終態 receipt。

## 例行操作

日常工作使用：

```sh
node data/tools/run-sunny-scheduled-daily.mjs
```

下午精確補抓使用：

```sh
node data/tools/run-sunny-scheduled-retry.mjs
```

需續跑既有 receipt 時，先提供已存在的 receipt，不重掃：

```sh
node data/tools/run-sunny-daily-work-plan.mjs --no-scan --catch-up --retry-current-once --scan-receipt FILE
```

NYC 或 Remote 擴充應各自使用一個具 UTC deadline 的有界 routine，例如：

```sh
node data/tools/run-sunny-company-routine.mjs --scope nyc --deadline-at <UTC-ISO-deadline> --max-boards 12
node data/tools/run-sunny-company-routine.mjs --scope remote --deadline-at <UTC-ISO-deadline> --max-boards 12
```

`--smoke` 僅用於一板診斷，不能和 `--max-boards` 合用。請讀取產生的 receipt、queue 與 status，而非以程序 exit 或 generic fetch error 推斷 coverage。

## 已驗證的檢查

本輪最終受影響套件為 325 passed、0 failed。它包含 source identity/window、序列化 receipt intake、Jibe/Workday continuation、午後 retry closeout、historical per-gap recovery fold、jobs rebuild failure 的 status refresh，以及 NYC/Remote scope isolation、deadline 與 collector partial retention。

在隔離資料根完成的實際 network smoke：Datadog Greenhouse 序列化 daily scan 在 2026-09-28 04:06Z 取得 HTTP 200、448 筆，產生 complete receipt；NYC 與 Remote routine 均完成 collect/resolve/backfill，並寫入 verified checkpoint。兩個 routine 如實為 partial，因 The Muse 僅使用一頁預算並留下 `{page:1}` continuation；coverage 選取也必須維持 deferred，直到實際 verification 寫入證據。這不是成功覆蓋宣告。完整 receipt 路徑與指令記錄於本輪 Terra result。

原生 daily timer 已以一次 UTC one-shot 實際投遞驗證，並讀回 NY noon 的修正排程。四個紐約時間規則以 840 個日期案例驗證；本紀錄不將此視為未來 delivery 的保證。

原生 automation 目前維持 PAUSED。daily/retry 是否恢復由 parent 在 native read-back 與本輪 source 驗證後決定；NYC/Remote 仍等待其原 target chat 的網路權限與實際 smoke 驗證。原 target、紐約週一09:00／週日10:00規則與通知設定均保留；沒有新增重複排程。

本輪 focused checks 已覆蓋 JD completeness、canonical continuation intake、Retry-After 絕對時間、replacement recovery、routine terminal receipts 與 per-gap status。完整受影響 suite 和 live smoke 的最新結果應以 single-Terra run receipt 為準；本文件不把舊的 suite 結果當成目前完成聲明。

## 仍有限制

- 此處的隔離資料根 smoke 證明目前環境的 network path，不取代其他 target chat 的網路權限或 Indeed capability discovery。那些 target chat 仍須各自取得權限後再驗證，native automation 維持 PAUSED。
- Indeed 是可選 discovery source；缺少或不可用時必須在該 execution context 記錄 capability 狀態，其他 collectors 仍可工作。
- Package 2c 驗證了一些候選 route identity，但沒有實際 portal route repair：舊 receipt 缺 provider、exact board 與絕對 window，不能安全建立補抓 selector。成功的 JD 擷取與 fixture recovery 不代表已替換舊 route。
- Grok 原生 UI 的只讀檢查顯示 Career-ops Routines 為空，且未見運行中的 Sunny writer。沒有變更 Grok 功能或網路權限；本輪原生排程的修改僅為上述 prompt 與 retry 啟用。

本文件是操作稽核紀錄，不引入新的 house rule；house rule 仍以 `modes/_custom.md` 為準。


## 最終收尾（2026-09-28 UTC）

依使用者最新指示，本次採 Terra 實作、Terra 測試與實際有界掃描作為完成依據，不再執行獨立審查循環。組合測試 325 項通過；最後 coverage／resolver 收據修正後，受影響測試 42 項通過，語法與 diff 檢查通過。日掃實際 receipt 完成；NYC／Remote 實際收集與 checkpoint 證據已保存，先前 coverage no-op 紀錄僅保留作歷史診斷，最後修正以針對性執行讀回驗證。

透過原生 automation 工具已恢復既有 `sunny-24` 每日掃描與 `sunny` 下午重試；原時間規則、目標 chat 和提示詞保留。`sunny-nyc`、`sunny-remote` 仍暫停，待原執行 chat 的網路權限可用後才啟用；此處的隔離掃描不代表其他 chat 已獲網路權限。工作流程規則留在本機 `modes/_custom.md`，不將私人資料或診斷收據提交。
