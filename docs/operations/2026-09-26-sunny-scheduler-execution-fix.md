# Sunny 每日排程執行修復（2026-09-26）

## 問題與修復

本次修復三個互相相關的排程問題：open 的舊 diagnosis/retry batch 會讓 planner 在當日 scan 前提前返回；前一紐約日的 final closeout 會被誤認為今日 terminal；heartbeat 沒有可核對的「確實呼叫 planner」證據。

`sunny-daily-run-state.mjs` 現在會在新紐約日 claim 前把前一 state 存到 `data/company-discovery/daily-run-history/`。未完成的 exception batch 會完整移到 `suspended_batches`，保留原 batch ID、members、outcomes、payload path 和 payload bytes。未完成 normal batch 保持為 current batch。若前一天的 scan claim 沒有已接收 receipt，planner 進入 recovery，不會丟掉 claim 或偷偷重掃。

`run-sunny-daily-work-plan.mjs` 先 reconcile、處理當日 claim/receipt，再決定 current batch。新 normal 候選存在時，exception batch 被 durable suspend，normal 先處理；normal 清空後才恢復完全相同的 suspended batch。final closeout 的 terminal 判斷只適用同一紐約日，且 suspended batch 也會阻止 `complete`。

`run-sunny-scheduled-daily.mjs` 是 heartbeat 的執行入口。它以 `since=3`、`normalLimit=20`、`exceptionLimit=20` 呼叫 planner，並在呼叫前先將 started receipt 寫到 `data/company-discovery/scheduled-invocations/`。相同 receipt 隨後記錄 `planned` 或 `failed`、紐約日期、cwd、data root、Git HEAD、run/scan/batch ID、counts 或錯誤。invocation receipt 不取代 serialized scan 的 job receipt。

## 驗證

- RED：`node --test tests/sunny-daily-work-plan.test.mjs`，exit 1。新增的跨日 diagnosis 與前日 final closeout 測試各自失敗，證明原本沒有執行今日 scan。詳見 scheduler-fix run directory 的 `terra-red-work-plan.log`。
- RED：`node --test tests/sunny-scheduled-daily.test.mjs`，exit 1。新入口尚不存在而無法 import；詳見 `terra-red-scheduled.log`。
- GREEN：`node --test tests/sunny-daily-run-state.test.mjs tests/sunny-daily-work-plan.test.mjs`，exit 0，33 passed。詳見 `terra-green-rollover.log`。
- GREEN：`node --test tests/sunny-scheduled-daily.test.mjs`，exit 0，2 passed。詳見 `terra-green-scheduled.log`。
- 擴大相關檢查：`node --test tests/sunny-daily-run-state.test.mjs tests/sunny-daily-work-plan.test.mjs tests/sunny-scheduled-daily.test.mjs tests/sunny-job-queue.test.mjs tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs tests/sunny-scan-status.test.mjs tests/sunny-serialized-scan.test.mjs`，exit 0，101 passed。詳見 `terra-final-relevant-tests.log`。

測試一律使用 temporary `dataRoot` 和 injected scanner；沒有執行正式 scanner、沒有改寫正式 queue、沒有寫 Google Sheet 或傳送訊息。payload 回歸明確逐位元組比較 rollover 前後 payload artifact。另以 `state-before/` 的 46 筆 diagnosis 複本執行 injected 2026-09-26 scan：保留原 diagnosis batch ID；正式四個 operational state 檔案的 SHA-256 前後一致。詳見 `production-copy-fixture.log`、`production-state-before.sha256`、`production-state-after.sha256`。

## 排程設定與限制

原 heartbeat 已透過 native automation tool 更新為使用新入口；修復期間暫停，保留原 heartbeat kind、target、America/New_York noon 規則。當時的設定讀回證據由 coordinator 保存在 scheduler-fix run directory 的 `automation-readback-paused.json` 與 `automation-after-paused.toml`。獨立 review 與 commit 後已恢復 ACTIVE 並實際補跑，結果見下節。功能測試與手動補跑都不證明未來 timer delivery。

`modes/_custom.md` 的本機程序規則新增如下兩點：

- 每日首次排程執行必須先在 repository root 執行 `node data/tools/run-sunny-scheduled-daily.mjs`。此入口先寫本機 invocation receipt，再真正呼叫 planner；不得只輸出 `DONT_NOTIFY` 當作已執行。若入口或 planner 失敗，回報 failure 與 receipt 路徑。
- 正常候選和每日 scan 優先於舊 exception backlog。舊的 diagnosis／retry batch 會被 durable suspend，待正常候選清空後以原 batch、members、payload 和 outcomes 恢復；續接已存在工作時使用既有 planner 的 `--no-scan` 規則。

外部 ATS 404、429、partial/truncated 等既有 provider 限制仍依 durable exception queue 保存；本修復不強制 retry、不假裝解決 unresolved/waiting exception，也不把它們關成 COMPLETE。

## 獨立審查後補正

第一輪獨立審查另外重現三個同範圍的續跑缺口，已由新的 Terra medium worker 補正：跨日未掛回的有效舊 receipt 先採納再 claim 今日掃描；同日 COMPLETE 後新增正常工作保留原 run／scan claim；`stopRun(complete)` 也拒絕仍有 waiting retry 的狀態。

最終相關檢查包含原八組 suites 與新的 scheduled-entry suite，共 106 tests passed、0 failed，exit 0；`git diff --check` exit 0。完整命令、輸出與修復 SHA-256 存在 `/Users/coda/Documents/ChatGPT/career-ops-scheduler-fix-20260926-exIS96/repair-v1/`。實際定時喚醒及正式補跑結果另以 runtime receipt 為準，不將 fixture 測試當成今日已執行。

## R4 跨夜續接補正

若舊 run 已把 diagnosis／retry batch 暫存到 `suspended_batches`，但當前 normal batch 在紐約日切換後已關閉，controller 現在仍會續用原 run，而不會建立空白的新 run。這會保留原始 `ny_day`、scan claim、history 指標、suspended batch 的 ID／members／outcomes／payload path，以及 payload 檔案位元組；`claimDailyScan` 仍是唯一處理每日 rollover 的位置。

新增 temporary-root 回歸以 injected scanner 建立兩個 normal jobs（`normalLimit=1`），在紐約午夜前後分別完成兩個 normal batch。測試確認 scanner 僅呼叫一次，接著恢復完全相同的 diagnosis batch 和 payload bytes，並確認 exception queue 未被 normal 續接改寫。R4 全部九組相關 suite 為 107 passed、0 failed，`git diff --check` 通過；沒有執行正式 scanner、沒有改寫正式 queue、沒有變更 automation。

## Commit 後正式補跑結果

修復已於正式 repository 的 `main` commit：`08578f1a1c652e040f823f4fafe65c4ede7eea1b`。既有排程 chat 以要求的 `gpt-5.6-terra`／`medium` 設定手動觸發相同每日流程。invocation receipt 讀回確認實際 cwd、data root 均為 `/Users/coda/Documents/ChatGPT/career-ops`，執行 Git HEAD 為上述修復 commit，沒有使用舊 worktree。

- 今日 scan 實際執行於 `2026-09-26T21:56:09.333Z` 至 `2026-09-26T22:25:11.461Z`，約 29 分鐘；3,541 個 portals、265,260 筆原始職缺、19 筆新增候選。
- 19 筆正常候選完成處理，canonical queue 讀回為 19 rejected、0 published、0 normal pending。本機 index 已重建並可解析，保留 146 筆既有職缺。
- scan 有 20 個來源錯誤與 37 個警告，因此 scan receipt 的 completion status 為 `error`。有效新增 URL 已保存並處理；整體 controller 保持 `PARTIAL`，沒有把來源失敗算作全數成功。
- 原 46 筆 diagnosis batch 在正常候選完成後完整恢復，另有 28 筆等待重試、2 筆來源已到期。舊待辦不再阻止今日 scan，但其診斷並未在本次修復中假裝完成。
- heartbeat `sunny-24` 已恢復 `ACTIVE`，保留紐約中午 12 點規則。此次證據確認手動補跑成功啟動與執行；未來定時喚醒仍須以當次 invocation receipt 確認。

最後複核補齊四筆原先 JD 抽取失敗的官方內容（Davis Wright Tremaine、American Express、Centauri、NYU），排除結果不變。American Express 原本僅依金融犯罪職稱的分類不準確，已透過 canonical queue adapter 更正為官方明示不提供 sponsorship；其他三筆改用完整職責佐證。這次更正保留 closed batch 的原始 payload 與歷史，並另存補充審核證據；未修改共用 JD extractor。

執行收據：

- `data/company-discovery/scheduled-invocations/sunny-scheduled-2026-09-26-09dc87da-10e4-4075-9afa-3c9af142e3e3.json`
- `data/company-discovery/receipts/daily-2026-09-26-fa947b4b-ca82-45d2-84ee-494c23c61007.json`

完整補跑與最後讀回證據位於 `/Users/coda/Documents/ChatGPT/career-ops-scheduler-fix-20260926-exIS96/daily-rerun/`：`result.json`、`final-coordinator-verification.json`、`post-run-jd-verification/verification-result.json`。後續續接舊待辦時使用 `node data/tools/run-sunny-daily-work-plan.mjs --since 3 --no-scan --normal-limit 20 --exception-limit 20`，不需重掃今日。
