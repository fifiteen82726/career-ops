# Sunny 每日排程執行修復 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This authorized run uses the established approved-execute plan review → Terra medium implementation → independent review workflow.

**Goal:** 修復排程空跑、舊診斷阻塞今日掃描、昨日完成誤擋今日三個問題；驗證並 commit 到 main，再實際執行 2026-09-26 排程。

**Architecture:** 每日掃描 claim 依紐約日期建立，與可跨日存在的不可變工作批次分開。跨日保留舊 controller 證據，讓新的正常工作先處理，之後恢復保留的 exception batch；不刪除或假裝解決異常。排程以專用入口真正呼叫 planner 並留下每次執行收據，heartbeat 首要动作必須執行此入口。

**Tech Stack:** Node.js ESM、node:test、JSON durable state、Codex heartbeat automation API。

---

## 授權、基線與範圍

- 使用者已明確授權本計畫、三項修復、commit 和補跑；不再等待二次同意。
- 正式 checkout：`/Users/coda/Documents/ChatGPT/career-ops`，main，起始 HEAD `093f6f2f09ed153afa166dbd3282c69d058b27f5`。
- 基線及備份：`/Users/coda/Documents/ChatGPT/career-ops-scheduler-fix-20260926-exIS96/`；原 tracked/index 乾淨。保留既存未追蹤暫存與備份，不加入提交。
- 原因證據：`/Users/coda/Documents/ChatGPT/career-ops-daily-20260925-cc87m1w2/schedule-analysis-20260926/`。
- 保持 heartbeat、原 target thread、紐約中午規則及本機發布；不轉 cron，不推送，不投遞／聯絡、不寫 Google Sheet。
- 舊 46 筆診斷為 27 source + 19 candidate，必須保持可讀、可恢復；本次不以逐筆解決所有外部 ATS 問題作為今日掃描的前置條件。
- 原喚醒時間和設定不符的底層原因未確認；重存同一時區規則，記錄讀回；不得聲稱已驗證未來 timer delivery。

## 驗收

1. 排程入口實際呼叫 planner，啟動前持久化 invocation receipt；成功／錯誤均有 cwd、日期、版本／HEAD、結果或錯誤證據。空的 `DONT_NOTIFY` 不構成執行成功。
2. 昨天仍有 diagnosis batch 時，今天可以且只會掃描一次；新正常候選優先，原 batch ID、members、outcomes、payload path 及 bytes 保留，正常工作結束後可恢復原批次。
3. 昨天 COMPLETE／final_closeout 且無 pending 時，今天仍掃描；同一天重入不重掃。紐約日期邊界依實際時區，不能用 UTC 日替代。
4. 同日或跨日未完成 normal publication 保留 payload 和操作進度，不重評、不遺失；`--no-scan` 和 catch-up 不偷偷啟動掃描。未有收據的 scan claim 不被無聲丟棄。
5. unresolved／waiting exceptions 不會變成已解決，也不能偽造 COMPLETE；partial scan 的有效 URL 仍正常進隊列。既有 controller／planner／queue 測試通過。
6. 修復 commit 後以 Terra medium 跑正式入口，取得今天 receipt；繼續正常候選處理並更新本機 archive/index，真實回報正常處理及例外 backlog。

## Task 1 — 回歸測試與每日 rollover

**Files:**
- Modify: `data/tools/sunny-daily-run-state.mjs`
- Modify: `data/tools/run-sunny-daily-work-plan.mjs`
- Test: `tests/sunny-daily-run-state.test.mjs`
- Test: `tests/sunny-daily-work-plan.test.mjs`

- [x] 先新增 failing regressions：昨日診斷→今日 scan 1 次→normal；昨日 final_closeout→今日 scan；跨日 exception payload bytes 保留。RED evidence: scheduler-fix run directory `terra-red-work-plan.log` (exit 1)。
- [x] 用 injected `scan` 和 temporary dataRoot 驗證，不碰正式 queue 或網路；GREEN evidence: `terra-green-rollover.log`（33 passed，exit 0）。

```sh
node --test tests/sunny-daily-work-plan.test.mjs tests/sunny-daily-run-state.test.mjs
```

- [x] 在 controller 的既有鎖內實作跨日 rollover，保留 history artifact、未完成 payload 與 `suspended_batches`；suspended batches 不視為已 close。
- [x] 每日 scan 先依 NY day claim／adopt，再判斷 open batch；跨日未接收 claim 進 recovery，不靜默重掃。
- [x] exception batch 有 normal pending 時 durable suspend；normal 清空後恢復 exact batch；final closeout 只在同一 NY day terminal。
- [ ] final_closeout 的 terminal shortcut 限制為當日；stop/close 的 COMPLETE 條件也檢查尚有 suspended batch。不要改變 immutable payload、operation ledger 與 canonical disposition 的驗證。

Controller/planner ordering contract:

```text
validate catch-up input
reconcile receipts
if runScan: recover old unreceived claim; claim/adopt today's scan (preserve old run evidence)
if normal pending and current batch is exception: suspend it durably
if current batch: resume unchanged
if normal pending: select normal
if suspended batch: restore exact batch
if same-day final closeout and no remaining work: terminal
otherwise use existing retry / diagnosis / final closeout selection
```

- [ ] 測試中比較 exception queue before/after、payload bytes、batch ID/members/outcomes，而非只比 phase。檢查每天最多一次 scanner、原 failure attempt IDs 不因 rollover 變動。

## Task 2 — 可核對的排程入口與 heartbeat

**Files:**
- Create: `data/tools/run-sunny-scheduled-daily.mjs`
- Create: `tests/sunny-scheduled-daily.test.mjs`
- Modify: `modes/_custom.md`（流程規則唯一使用者層）
- Modify through native tool only: automation `sunny-24`

- [x] 新增可注入 planner 的 `runScheduledDaily` 入口；預設 dataRoot 使用 path resolver，CLI 輸出 planner JSON 與 execution receipt path。
- [x] planner 前先寫 started invocation receipt，成功／失敗更新 planned／failed；既有 job receipt 仍是掃描證據。
- [x] 新增可觀察 scheduled-entry 測試；RED `terra-red-scheduled.log`，GREEN `terra-green-scheduled.log`（2 passed）。
- [x] `_custom.md` 明訂每日首次入口、先執行後通知、normal 優先及 `--no-scan` 續接規則。
- [ ] coordinator 透過 automation_update 更新完整原設定，保留原 heartbeat kind、target、ACTIVE、NY noon rrule 及其餘 prompt。首段要求本輪先執行新入口，不得只輸出 DONT_NOTIFY；若工具不可用或失敗，回報 failure。修正 prompt 中「任何舊 batch 都禁止今日 scan」為依新 planner 行為。讀回設定並保存前後 evidence。

## Task 3 — 檢查、紀錄、commit、實際補跑

**Files:**
- Create: `docs/operations/2026-09-26-sunny-scheduler-execution-fix.md`
- Update: this plan checklist with actual evidence

- [x] 在 `state-before/` 的 46 筆 diagnosis 複本重現今日 scan，注入 scanner；原 diagnosis batch ID 保留，正式四個 operational state SHA-256 前後一致。evidence: `production-copy-fixture.log`、`production-state-before.sha256`、`production-state-after.sha256`。
- [x] 執行 8 個相關 Node suites：101 passed，exit 0；證據 `terra-final-relevant-tests.log`。`node --check` 三個 source 與 `git diff --check` 均 exit 0。
- [ ] 以 HEAD + changed file hashes 固定實作版本，fresh independent reviewer 檢查本驗收；必要修正仍由 fresh Terra medium 實作。
- [ ] 將三個根因、解法、checks、migration/preservation、外部 provider 限制寫進 operations 記錄。只 stage 明確相關 source/tests/docs；commit 到 main，不 push。
- [ ] 記錄 commit SHA 後，Terra medium 在正式 cwd 執行：

```sh
node data/tools/run-sunny-scheduled-daily.mjs
```

- [ ] 依回傳 immutable batches 處理今日正常候選，保留既有語意資格、DOL、日期、LinkedIn company mapping 與 local-only publication 規則；用 canonical adapters/checkpoint/close 記錄 durable outcomes。
- [ ] 正常候選清空後，保留真實 exception backlog，不強制未到期重試。執行 `node data/tools/build-sunny-job-search-index.mjs`，讀回 jobs/status；以實際 scan receipt、queue counts、publication archive 報告 COMPLETE 或 PARTIAL，不能僅因命令完成宣稱全綠。

## Review standard

以使用者要求的三個正常執行問題與相關回歸為準，不擴展成一般安全／架構稽核。不因外部網站 404/429、既有供應商截斷或未來 timer 尚未可驗證而掩飾真實執行結果。
