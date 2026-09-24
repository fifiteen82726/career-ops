# Career-Ops 1.34 升級與 Sunny 功能保留 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次文件只規劃；尚未執行升級或驗收測試。

**Goal:** 將目前的 Sunny 客製版本整合至官方 v1.34.0，保留現有功能、資料、履歷版型與排程行為，經過隔離驗證及還原演練才切換正式環境。

**Architecture:** 固定官方 release commit，依官方 system/user 清單逐檔整合；私人資料及 Sunny 專用模組保留，雙方都改過的共用程式做三方合併。先在獨立 checkout 與資料副本驗證，正式環境只接收審核過的程式差異；升級不執行資料清空、重評分、公司擴充或整批重掃。

**Tech Stack:** Node.js ESM、現有 npm lockfile、Git、YAML/JSON/TSV、node:test 與專案測試 runner、Playwright、現有 Python/uv 環境。

---

## 1. 已查證的起點與範圍

- 正式專案：`/Users/coda/Documents/ChatGPT/career-ops`。
- 規劃時 HEAD：`a6a7f170f2f48b9a1d61193653be61bf1e81dfe9`；版本標記 `1.32.0`。
- 上次 system update commit：`401108cc25a50ed3ffd43ad05363beaaa69ca592`；其後已有 66 個本機提交。這個數字是查核快照，執行前要重新記錄。
- 目標 tag：`career-ops-v1.34.0`；固定 commit：`de7f7fe8fe65852b9743bbdce94f0304101a749e`。
- 目前 HEAD 與目標的真正共同祖先：`aff8be85b4d5691f4535696c90e17ab77c3016c6`。`401108cc` 是上次安裝快照，不能假設它是乾淨 upstream 或 Git 共同祖先。
- [官方 v1.34.0 release](https://github.com/career-ops-hq/career-ops/releases/tag/career-ops-v1.34.0)；已具有的 `fetch-jd.mjs`、`audit-portals.mjs` 等功能也須保留。
- 工作目錄有既有修改與未追蹤檔案，包括 `.gitignore`、公司 mapping、`cv-template/`、Balanced Education 測試、規劃文件等。這些不是可丟棄的暫存。

**升級定義：** 目標 release 的 system manifest 每個檔案均有明確的 `adopt / merge / retain-local / reviewed-delete` 結果；所有 Sunny 驗收通過。單純改 `VERSION`、跳過衝突檔、或更新器退出碼為 0，都不算完成。

### 不包含在本次升級

不改目標職類、評分權重、H-1B 門檻、公司名單或履歷事實；不開啟新來源、不重設佇列、不重新評分歷史職缺、不重新投遞、不傳送內推訊息。新增 provider 程式可以安裝，但不因此修改 `portals.yml` 的啟用設定。

## 2. 必須保留的功能與驗收矩陣

| ID | 必須保留的行為 | 主要程式／資料 | 驗收證據 |
|---|---|---|---|
| P01 | 八季度 DOL `CHANGE_EMPLOYER`、Tier A/B、exact employer/ATS identity；不要求 PERM；Meta/FDE 排除 | `profiles/`、`modes/_custom.md`、`data/tools/sunny-ats-identity-gate.mjs`、`sunny-company-expansion.mjs` | profile/portals 雜湊不變；H-1B、identity、company expansion 測試 |
| P02 | NYC Metro 與 U.S. remote、兩個履歷職類、broad title discovery 後讀 JD；缺發布日不進每日合格結果 | `profiles/sunny-search-criteria.md`、`scan.mjs`、Sunny discovery 工具 | title、NY metro、date/window 測試；凍結候選的資格判斷逐筆比較 |
| P03 | 每日紐約中午、三天重疊；由 daily planner 控制、每個 run 最多一次 scan | `run-sunny-daily-work-plan.mjs`、`sunny-daily-run-state.mjs` | 同日第二次 resume 不重掃；scan claim 和 receipt 一致 |
| P04 | 精確 board 的固定 14 天補掃視窗、partial 可重試；company/daily 共用 lease、掃描共用 lock | `run-sunny-serialized-scan.mjs`、`sunny-company-state.mjs`、`sunny-routine-runtime.mjs` | exact-board、並行鎖、partial receipt、日期邊界測試 |
| P05 | history 只代表發現；pending 不因 history 存在而消失；terminal 不重評、不重發 | `sunny-job-queue.mjs`、history/pipeline/archive | 重播相同 receipt 兩次，job identity、terminal disposition、發布筆數不變 |
| P06 | normal 優先；candidate/source 例外各自保存；第三次失敗後個別診斷；不把 timeout 當關閉 | exception store/adapters/diagnose、daily planner | retry 計數、到期時間、normal-first、404/timeout 分流測試 |
| P07 | immutable batch/payload、operation ledger、unfinished operations 可續跑；無證據不宣稱完成 | `sunny-daily-run-state.mjs` 與 payload artifacts | 中斷後同 batch/member/payload 重發；拒絕不完整 closeout |
| P08 | 合格職缺保存到本機 archive，網站可搜尋／依日期與優先序篩選，低優先歷史列不遺失 | `data/sunny-job-search-archive.json`、`build-sunny-job-search-index.mjs`、`local/sunny-job-search/` | canonical URL + scanDate 集合、欄位值、歷史列與 UI 測試 |
| P09 | 最近 Connections、同公司多職缺訊息、可編輯及複製、篩掉職缺同步取消選取 | `local/sunny-job-search/app.js`、referrals/identity modules | 網站 browser tests；跨公司不得合併；篩選和 clipboard 行為 |
| P10 | Brave Connections headline-only、最多 50 張卡、exact/accepted alias、有限候選、一次 retry、fail-soft | LinkedIn capture/DOM/alias/title modules 與 private ledger | 使用 fixture；不需真實登入，不開 profile，不發訊息；mode 0600 與隱私規則保留 |
| P11 | 掃描狀態綠／黃／紅、完整證據、tooltip、昨日完成狀態保留；jobs 失敗仍刷新 status | `build-sunny-scan-status.mjs`、`scan-status.js` | `sunny-scan-status.test.mjs`、網站 browser tests；零結果、部分失敗與跨日案例 |
| P12 | 一頁 A4、Arial 10.2pt/最低10pt、黑白、教育兩列、Skills 最後、無 Summary；兩份履歷變體 | `output/cv-template-balanced-a4.html`、`cv-template/`、`profiles/sunny-data-*.md` | 固定既有 payload 渲染、頁數/文字/事實/ATS/視覺比對；不改內容以掩蓋排版退化 |
| P13 | PDF 與職缺 mapping 保留所有版本，不因產生 PDF 改變投遞狀態 | `data/resume-application-map.tsv`、PDF index、reports/output | 雜湊、版本集合與 application reference 不變 |
| P14 | 所有已新增 ATS 支援、host pacing、retry、日期抽取、Ashby hosted fallback | `providers/`、`verify-portals.mjs` | 全 provider suite 加 Sunny coverage 測試，不能只跑 upstream 新測試 |
| P15 | 排程單一 owner；原 PAUSED 排程維持 PAUSED；現有 Grok 邏輯保留 | Codex `sunny-24`、`sunny-nyc`、`sunny-remote`；實際 runner 設定 | 原始設定快照、切換前後逐欄比較、沒有重複 writer |

### 已發現、必須在切換前處理的既有不一致

`modes/_custom.md` 已要求只發布至本機、不寫 Google Sheet，但目前 `sunny-24` 儲存的 prompt 仍有舊的 Sheet 寫入與 Sheet-first 流程。controller 測試也保留舊 sink 名稱。這是現況差異，不能在升級時忽略或據此重新啟用 Sheets。

以最新 `_custom.md` 的本機發布規則為保留目標；保留既有 ledger 的歷史欄位與證據，不清除或重寫 open batch。Task 8 先驗證 local-only closeout 是否已支援；若不支援，將最小相容修正與測試獨立成提交，並在切換紀錄中清楚標成既有差異修復。未完成前不得恢復會要求 Sheet 寫入的排程。

## 3. 檔案處理地圖

所有下列路徑均相對於正式專案根目錄；隔離執行時改以 candidate 根目錄解析。

**逐位元保留：** Data Contract 的 user layer，加上 `config/local-paths.txt`、`profiles/`、`outputs/`、`cv-template/`、`.env`/私人設定、`local/sunny-job-search/data/`、私人 referral/capture/alias state、所有未追蹤的使用者檔案。`config/cv-facts.json` 也必須明列，不能只相信 updater 的較短 `USER_PATHS` 陣列。

**保留 Sunny 模組：** `data/tools/`、`local/sunny-job-search/` 的程式及測試、`tests/sunny-*.test.mjs`、`tests/test_sunny_ny_metro_h1b.py`、`tests/balanced-education-layout.test.mjs`、Sunny template/example 檔案、既有規劃文件。必要的介面相容修正須單獨列出、測試、審閱。

**人工合併優先清單：**

| 檔案 | 合併要求 |
|---|---|
| `providers/workday.mjs` | 保留既有 host/tenant、日期、pacing、facet/分頁與覆蓋邏輯；整合 upstream 多地點與 detail endpoint 修補 |
| `providers/ashby.mjs` | 同時保留 hosted-page 404 fallback、locationName 支援，加入 compensation tier 修補 |
| `providers/avature.mjs` | 保留本機動態分頁與 partial 告警；合併 upstream facet/filter 保留與 parse error 行為 |
| `providers/icims.mjs`、`providers/lever.mjs` | 保留 retry/URL 修補，整合 host 與 timeout 變更 |
| `scan-ats-full.mjs`、`verify-portals.mjs` | 保留既有 title/identity/host 行為；不把 full scan 接回每日預設流程 |
| `package.json`、`package-lock.json` | 保留 Sunny 實際用到的依賴，包含 `hyparquet`、`hyparquet-compressors`；鎖檔必須與 manifest 一致 |
| `.gitignore` | 規劃時已有未提交修改；不把它夾進升級 commit。新的必要忽略規則可先放 `.git/info/exclude`，並把待合併差異記錄清楚 |
| `web/src/lib/run-prompts.mjs` | 若三方結果與目前相同則保留；若不同則驗證原有 prompt 契約，不能改掉 Sunny local-only 規則 |

**可採用 upstream、仍需驗證：** `scan.mjs`、`liveness-api.mjs`、`liveness-core.mjs`、`browser-extract.mjs`、`generate-pdf.mjs`、`build-cv-html.mjs`、`verify-cv-facts.mjs`、`update-system.mjs`、shared modes 及其他官方 manifest 檔案。不得用這份示例清單取代完整 manifest。

## Task 1：建立一致、可還原的正式基線

**建立：** 專案外的私有 evidence/backup；本階段不修改正式程式。

- [ ] 重新讀取 `AGENTS.md`、`modes/_custom.md`，記錄當下 HEAD、branch、完整 porcelain status、staged/unstaged diff、untracked/ignored 清單與 Node/npm 版本。記錄 data root/marker/各 `CAREER_OPS_*` 路徑覆寫；不輸出 API key 或 token。
- [ ] 用以下變數建立本次升級工作區；後續命令在同一 shell 使用這些變數。若 session 改變，先從私有記錄重新載入這些路徑。

```bash
UPGRADE_SOURCE=/Users/coda/Documents/ChatGPT/career-ops
UPGRADE_AREA=$(mktemp -d /Users/coda/Documents/ChatGPT/career-ops-upgrade-134.XXXXXX)
UPGRADE_EVIDENCE="$UPGRADE_AREA/evidence"
UPGRADE_TREE="$UPGRADE_AREA/candidate"
UPGRADE_BASELINE="$UPGRADE_AREA/baseline"
UPGRADE_TARGET=de7f7fe8fe65852b9743bbdce94f0304101a749e
UPGRADE_PRE_HEAD=$(git -C "$UPGRADE_SOURCE" rev-parse HEAD)
umask 077
mkdir -p "$UPGRADE_EVIDENCE"
git -C "$UPGRADE_SOURCE" status --porcelain=v1 -z > "$UPGRADE_EVIDENCE/status-before.z"
git -C "$UPGRADE_SOURCE" diff --binary > "$UPGRADE_EVIDENCE/unstaged-before.patch"
git -C "$UPGRADE_SOURCE" diff --cached --binary > "$UPGRADE_EVIDENCE/staged-before.patch"
git -C "$UPGRADE_SOURCE" bundle create "$UPGRADE_EVIDENCE/pre-upgrade.bundle" HEAD
git -C "$UPGRADE_SOURCE" bundle verify "$UPGRADE_EVIDENCE/pre-upgrade.bundle"
```

- [ ] 在短暫 snapshot 時段保存 Sunny 相關排程的完整設定及 ACTIVE/PAUSED 狀態。透過 scheduler 的正式工具只暫停原本 ACTIVE 的相關 writer，讓現有執行正常結束。確認 company/daily/referral/resume 或 Grok writer 沒有寫入；不要刪 lock 或強殺未完成批次。
- [ ] 保存完整工作目錄，包括 ignored/untracked、檔案 mode 和 symlink。先確認空間足夠；若 data root 或 symlink 指向專案外，另做同規格備份並記錄映射。不能以 Git bundle 取代 user-data 備份。

```bash
tar --exclude='./.git' --exclude='./node_modules' --exclude='./web/node_modules' \
  -cpf "$UPGRADE_EVIDENCE/workspace-before.tar" -C "$UPGRADE_SOURCE" .
shasum -a 256 "$UPGRADE_EVIDENCE/workspace-before.tar" > "$UPGRADE_EVIDENCE/archive.sha256"
mkdir "$UPGRADE_AREA/restore-check"
tar -xpf "$UPGRADE_EVIDENCE/workspace-before.tar" -C "$UPGRADE_AREA/restore-check"
rsync -anic --delete --exclude='.git' --exclude='node_modules' \
  "$UPGRADE_SOURCE/" "$UPGRADE_AREA/restore-check/" > "$UPGRADE_EVIDENCE/restore-check.txt"
```

Expected：archive SHA 可重算一致；test extraction 成功；`restore-check.txt` 無差異。外部 data root 同樣要 test-extract/checksum。備份、bundle 和 logs 保持私有，不能提交。

- [ ] 記錄 protected files 的 SHA-256、mode、symlink target；snapshot 中必須包含 archive、網站兩份 JSON、daily controller、其 payload artifacts、三種 queue、receipts、scan history、DOL index、LinkedIn 私人 state、履歷與 mapping。現有 `createSunnyCheckpoint()` 可作額外保障，但不是完整 upgrade backup。
- [ ] 備份驗證後立即恢復原本 ACTIVE 的排程，讓正式版本在隔離測試期間照常運作；原本 PAUSED 的 `sunny-nyc`、`sunny-remote` 保持 PAUSED。記錄恢復時間。

## Task 2：建立真正隔離的基線與候選環境

**建立：** `$UPGRADE_BASELINE`、`$UPGRADE_TREE`；使用 using-git-worktrees 技能。

- [ ] 固定 release tag 與 commit；不跟隨 `main`，也不默默換成未來新版。

```bash
git -C "$UPGRADE_SOURCE" fetch --no-tags https://github.com/career-ops-hq/career-ops.git refs/tags/career-ops-v1.34.0
test "$(git -C "$UPGRADE_SOURCE" rev-parse 'FETCH_HEAD^{commit}')" = "$UPGRADE_TARGET"
git -C "$UPGRADE_SOURCE" worktree add --detach "$UPGRADE_BASELINE" "$UPGRADE_PRE_HEAD"
git -C "$UPGRADE_SOURCE" worktree add -b codex/upgrade-career-ops-134 "$UPGRADE_TREE" "$UPGRADE_PRE_HEAD"
tar -xpf "$UPGRADE_EVIDENCE/workspace-before.tar" -C "$UPGRADE_BASELINE"
tar -xpf "$UPGRADE_EVIDENCE/workspace-before.tar" -C "$UPGRADE_TREE"
```

Expected：兩份副本包含相同的本機修改與私人測試資料；`.git` 仍是各自 worktree 指標。如果 branch 已存在，先檢查其用途，改用本次 run 唯一分支名，不能覆蓋舊工作。

- [ ] 副本中的 data root 指向副本自身；外部 data root 也複製到私有副本。清除副本 `.env` 中指向正式環境的 path override，改寫副本中的 `.career-ops-data`；所有測試 subprocess 明確設定 `CAREER_OPS_ROOT`、`CAREER_OPS_DATA_DIR`、`CAREER_OPS_TRACKER`、`CAREER_OPS_PORTALS`、`CAREER_OPS_SCAN_HISTORY`、`CAREER_OPS_PIPELINE` 為副本路徑。
- [ ] 檢查 controller 中的絕對 `payload_path` 與任何資料 symlink：只在副本重映射到副本，保留原映射以供比較；不能讓 resume 讀寫正式 payload。不要直接沿用會掛載正式資料的 runtime symlink helper。
- [ ] 掃描副本設定及啟動參數，確認沒有可寫路徑落到 `$UPGRADE_SOURCE` 或正式外部 data root。測試中的 browser 使用 fixture/headless Chromium；不連接既有 Brave profile、不讀取正式排程、不呼叫 Sheets 寫入或付費 LLM。
- [ ] 各副本用自己的依賴目錄與原 lockfile 執行 `npm ci --ignore-scripts`。不要共用正式 `node_modules` symlink。需要 browser binary 時使用既有可用 runtime或在副本安裝指定版本，不升級整台機器的 Node。

## Task 3：記錄升級前驗收結果

**讀取／測試：** Task 2 的 baseline 副本；輸出 logs 至 evidence。

- [ ] 在 `$UPGRADE_BASELINE` 執行既有 Sunny/provider 與網站測試，保存完整退出碼、失敗名稱及耗時。

```bash
node test-all.mjs --only sunny-
node test-all.mjs --only providers/
node --test local/sunny-job-search/tests/*.test.mjs
node tests/balanced-education-layout.test.mjs
node test-all.mjs
```

Expected：P01–P15 對應測試有實際結果。`--only` 不代表全套通過；網站 `local/` 測試及 Python 測試也不會自動被 `tests/` runner 全部涵蓋。Python 測試使用專案現有 uv 環境執行 `tests/test_sunny_ny_metro_h1b.py`，先依 python-uv-project 技能確認環境，不能臨時改全域套件。

- [ ] 對每個既有失敗建立 baseline issue，記錄精確測試名、stdout/stderr、原因與影響。升級後必須零新增失敗；核心 Sunny 行為若原本失敗也不能直接宣稱保留成功，需修復或保持未驗收狀態。
- [ ] 特別記錄已從原始碼看出的測試整合差異：未追蹤的 `tests/balanced-education-layout.test.mjs` 呼叫 `finish()`，而 `test-all.mjs` 明確拒絕 discovered suite 自行呼叫它。先跑 baseline 確認實際結果；在 candidate 將這支私人測試改為 `node:test` assertions 或 runner 相容格式，保留全部版型 assertion 與私人 fixture。切換前不修改正式檔；切換時如需套用這項測試修正，先備份原始內容、保留未追蹤狀態並只套用該差異。不提交私人履歷 payload；這項測試修正獨立記錄，不能直接略過它。
- [ ] 用既有 fixture 固定日期、時區、輸入資料；記錄 job identity/disposition、backfill window、retry state、batch payload、網站歷史列與兩份履歷渲染結果。不要把即時網站筆數當成 deterministic baseline。

## Task 4：完整 system manifest 與三方差異分類

**讀取：** 兩版 `update-system.mjs`、`DATA_CONTRACT.md`、Git trees。
**建立：** 私有 `system-paths.json`、`file-decisions.json`、逐檔 patch/merge evidence。

- [ ] 用現有 `extractArrayFromSource()` 讀兩版的 `SYSTEM_PATHS` 與 `USER_PATHS`，只解析文字，不執行下載的 updater。從固定 commit 的 Git tree 展開 directory manifest 到實際檔案。結合 Data Contract、`config/local-paths.txt` 與本計劃保留清單；private data 的保護不能因新 manifest 變寬而消失。

```bash
cd "$UPGRADE_TREE"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractArrayFromSource } from './update-system.mjs';
const ref = 'de7f7fe8fe65852b9743bbdce94f0304101a749e';
const local = readFileSync('update-system.mjs', 'utf8');
const remote = execFileSync('git', ['show', `${ref}:update-system.mjs`], { encoding: 'utf8' });
const result = Object.fromEntries(['SYSTEM_PATHS', 'USER_PATHS'].map(name => [name, {
  local: extractArrayFromSource(local, name), remote: extractArrayFromSource(remote, name),
}]));
writeFileSync('../evidence/system-paths.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
JS
```

- [ ] 對每個實際路徑記錄 local/base/target blob、處理方式、理由、保護狀態、測試與預期差異；同時包含 upstream 新增、刪除與 symlink/file-mode 變動。
- [ ] 共同祖先重新以 `git merge-base "$UPGRADE_PRE_HEAD" "$UPGRADE_TARGET"` 計算；沒有足夠歷史時先 fetch 必要歷史，不能把空白檔當成共同祖先。
- [ ] upstream 從未提供過的本機檔案一律保留。只有 upstream 確實曾提供、目標已刪除、沒有 Sunny 引用、且本機沒有額外修改時才准刪除；要記錄證據。新增檔若碰到未追蹤本機檔，按 add/add 衝突處理。
- [ ] 固定目標逐檔整合，不在正式環境直接跑舊 `apply`。舊 updater 追 `main`，而「保留修改」不會自動合併；`--force`、整個目錄 checkout、`git reset --hard` 和 `git clean` 均不作此計劃的捷徑。

## Task 5：依相依順序整合官方程式與本機修補

**修改：** Task 4 決策清單內的 system files；Sunny 模組僅在介面必要時作最小調整。

- [ ] 先整合 `lib/`、provider shared helpers、path resolver 及 package 依賴，再逐個 provider、scanner/liveness、PDF、modes/updater。每一組維持可測試狀態；不整批覆蓋 `providers/` 或 `tests/`。
- [ ] 未修改且沒有本機行為依賴的檔案採用 target blob；雙方修改的文字檔以真正共同祖先做三方合併。以下是 Workday 的完整操作範例，其他路徑逐檔照決策清單執行，並記錄各自結果：

```bash
cd "$UPGRADE_TREE"
UPGRADE_MERGE_BASE=$(git merge-base "$UPGRADE_PRE_HEAD" "$UPGRADE_TARGET")
mkdir -p "$UPGRADE_EVIDENCE/merge-workday"
cp providers/workday.mjs "$UPGRADE_EVIDENCE/merge-workday/local.mjs"
git show "$UPGRADE_MERGE_BASE:providers/workday.mjs" > "$UPGRADE_EVIDENCE/merge-workday/base.mjs"
git show "$UPGRADE_TARGET:providers/workday.mjs" > "$UPGRADE_EVIDENCE/merge-workday/upstream.mjs"
git merge-file -p "$UPGRADE_EVIDENCE/merge-workday/local.mjs" \
  "$UPGRADE_EVIDENCE/merge-workday/base.mjs" "$UPGRADE_EVIDENCE/merge-workday/upstream.mjs" \
  > "$UPGRADE_EVIDENCE/merge-workday/candidate.mjs"
```

Expected：exit 0 表示文字可合併；exit 1–127 表示衝突，須逐段結合本機行為与 upstream 修補；工具錯誤則停止該檔。候選合併結果先審閱，不能直接因 exit 0 就視為語意正確。不存在 base、新增、刪除、binary、symlink 要照 Task 4 的對應分類，不能套用上述文字範例。

- [ ] Workday、Ashby、Avature 各自跑 P14 既有測試與對應 upstream 新測試。必要介面修正先加具體 regression case，確認修正前失敗、修正後通過；不能刪 assertion 或更新 golden 值掩蓋回歸。
- [ ] 保留 `_host-pacer.mjs`、MobiCloud、Paycom、Paylocity、UKG、Jobvite、SmartRecruiters、Workable、Dayforce 等本機功能，連同其測試及 import；upstream 沒有的檔案不是 obsolete。
- [ ] shared mode／評分指令合併後，以 `profiles/sunny-search-criteria.md` 的現有 100 分規則與兩個履歷職類驗證 prompt 契約。上游一般評分規則不能覆蓋 Sunny 權重、資格門檻或產物欄位；`_profile.md`、`_custom.md` 和主要資料來源保持優先。
- [ ] 合併 `package.json` 的依賴後在 candidate 重建相應 lockfile，執行 `npm ci --ignore-scripts` 與 `npm run lint`。不要把 npm 大版本／無關依賴升級混進來。
- [ ] 每組完成後只提交明列的程式及測試；commit 前檢查 staged diff。原本未提交的 `.gitignore`、mapping、私人資料與其他規劃檔不加入提交。版本 metadata 在完整 manifest 處理完成後才納入最後一組。

## Task 6：驗證 scanner 與 Sunny 佇列的相容性

**測試：** `tests/scan-*.test.mjs`、`tests/providers/`、`tests/sunny-*.test.mjs`、liveness suites。

- [ ] 執行下列命令；新增測試檔應已由目標 manifest 安裝，缺檔是整合不完整，不可略過。

```bash
node test-all.mjs --only scan-
node test-all.mjs --only liveness
node test-all.mjs --only providers/
node test-all.mjs --only sunny-
```

- [ ] 明確核對 `tests/scan-json-receipt.test.mjs`、`tests/scan-unverified-zero.test.mjs`、`tests/scan-dedup-requisition.test.mjs`、`tests/liveness-api-more-rungs.test.mjs`、`tests/providers/workday-multi-location.test.mjs`、`tests/providers/ashby-compensation-tiers.test.mjs` 有被執行。
- [ ] 比較 receipt `version`、`added_urls`、`errors`、warnings/partial、exit code，以及 `data/scan-runs.tsv` 欄位讀取。新欄位向後相容，不重寫歷史 TSV；unverified zero 不能在 wrapper 中變成 complete/green。
- [ ] 在合成暫存資料上重播 complete/partial/error/empty receipt、同名不同 requisition、同板別名、NY 午夜、14 天 backfill 和三天 daily 視窗；保留實際有用 URL，來源例外分開記錄。
- [ ] 跑 controller 中斷／resume 與原始 payload 測試：一次 scan claim、相同 immutable batch、terminal 不重評、normal-first、第三次失敗診斷、waiting retry 不強制執行。比較 baseline 與 candidate 的 identities 和 dispositions，逐筆解釋任何差異。

## Task 7：驗證網站、內推、掃描狀態與履歷

**測試／保留：** `local/sunny-job-search/`、snapshot builders、Balanced A4 輸出及 mapping。

- [ ] 在 candidate 執行：

```bash
node --test local/sunny-job-search/tests/*.test.mjs
node tests/balanced-education-layout.test.mjs
node test-all.mjs --only cv-
node test-all.mjs --only generate-pdf
node test-all.mjs --only verify-cv-facts
npm run test:cv-visual
```

Expected：UI/clipboard/filter/tooltip、referral fail-soft、privacy、歷史 scan status 與 CV rendering 全部通過；Playwright 不得以缺少 browser 為由記成 pass。不能執行 `test:cv-visual:update` 自動接受變更。

- [ ] 用同一份私人 archive/referral/receipts 副本、同一個 `now`，分別呼叫 baseline/candidate 的 `buildSnapshot()`／`buildScanStatusSnapshot()`；比較 job identities、14 欄值、referral matches 和歷史完成日。輸出留在 evidence，不覆寫正式 snapshots。
- [ ] 測試 `jobs.json` 更新失敗時保留舊快照且 status 仍更新；跨日 controller rollover 不抹掉昨日狀態；partial/unverified 不能變綠。
- [ ] 用既有兩份 resume 變體及固定、已核實 payload 重新渲染到 candidate 輸出目录。依 pdf 技能檢查 A4/一頁、文字抽取順序、所有 bullet、教育兩列、最小字級、邊界、Skills 最後、無 Summary、黑白；逐頁視覺比對現有核准版本。
- [ ] 不為了修好版型改履歷事實；若 PDF reading-order 修補與教育 CSS 衝突，保留 payload 語意並做最小模板相容修正，新增對應檢查。正式模板、舊 PDF、resume-application map 在 cutover 前保持原樣。

## Task 8：排程契約與 local-only 發布對齊

**讀取／必要調整：** `sunny-daily-run-state.mjs`、daily planner、相關測試；只在切換時更新既有 `sunny-24`，不建立重複排程。

- [ ] 在副本重播真實 controller 結構，檢查 local-only archive/index/queue disposition 是否能完成 closeout；歷史 Sheet operation 名稱需仍可讀，不能刪欄位、假造 done 或把失敗 sink 標成不適用。
- [ ] 若現有 controller 缺少 local-only 契約，先補測試：新 local-only batch 以實際 archive/index/queue read-back 完成；缺任一證據必須拒絕 complete；既有 open batch 保留 ID/payload/unfinished operations，不能重評或偷偷重開。再以最小 adapter/closeout policy 修正通過測試。
- [ ] 準備可審閱的 `sunny-24` 完整 prompt 差異：移除已被 `_custom.md` 停用的 Sheet 寫入要求，使用現有 daily planner／typed batch／local publisher／兩份 snapshot，保留三天視窗、H-1B/JD gate、LinkedIn fail-soft 及禁止投遞/聯絡。
- [ ] 保存 name、id、target task、timezone、schedule、status 與 notification 設定；除了上述既有衝突，不改其他設定。`sunny-nyc`、`sunny-remote` 維持原狀；檢查實際 Grok writer，不改其功能或啟動第二個 owner。

## Task 9：整體驗收與還原演練

**測試：** candidate 全套；輸出 `acceptance.md`、差異清單與 rollback evidence。

- [ ] 執行以下完整驗證，保存實際輸出與 exit code。先後順序固定，避免測試互相污染；若修改程式，重跑受影響測試後再補全套。

```bash
npm run lint
node test-all.mjs
node updater-migration-tests.mjs
node --test local/sunny-job-search/tests/*.test.mjs
npm run test:cv-visual
node doctor.mjs --json
node verify-pipeline.mjs
git diff --check
```

Expected：核心 Sunny 測試全通過、零新增失敗；full runner 必須走到真正的全套結尾，逐檔核對既有與新測試都被執行，不能只看退出碼。`verify-pipeline` 的既有資料問題與升級問題分開記錄；不能為了讓它綠而自動重寫 tracker。缺少未使用的 CLI/MCP 可記成既有環境限制；實際需要的 browser/runtime 缺失屬未驗收。

- [ ] 對照 P01–P15 填上測試命令／結果／artifact；所有 `retain-local` 都有理由與測試。protected data hash/mode 差異必須為零，副本中允許的 root remap 和测试产物獨立列出。
- [ ] 在第三個 disposable copy 演練：保留一份未完成 batch、一次發布後的新增 job、最新 archive/index，還原舊程式後仍可讀／續跑。升級預設不做資料 schema migration；若需要不相容 migration，先增加雙向相容／還原設計，不能跳過演練。
- [ ] 不把測試中生成的公司、候選或 referral PII 帶回正式環境。固定 fixture 對比才用 exact counts；即時 ATS 結果只做 bounded diagnostic，不以今日/昨日數量相等判斷正確性。

## Task 10：短暫停止寫入、套用已驗證的程式差異

**修改：** 正式 checkout 的審閱過 system/code paths；已對齊的既有 scheduler 設定。

- [ ] 執行前確認本計劃已獲授權進入實作；重新比對正式 HEAD/status。若隔離期間其他任務改了程式，重新整合該差異並重跑受影響測試，不能覆蓋對方修改。
- [ ] 暫停原本 ACTIVE 的 Sunny writers 並等待 in-flight batch 到安全 checkpoint；保存新鮮的正式資料/設定備份和 checksums。測試期間正式資料會繼續前進，所以不能用 Task 1 的舊資料覆蓋當前資料。
- [ ] 根據已審阅 commit 的精確 file list 導入程式差異，採用 Git 的三方套用／scoped commits；不用整份 candidate 目錄覆蓋正式專案。使用者先前 staged/unstaged/untracked 狀態保持不動；衝突逐一解決。
- [ ] 如 Task 8 有確認的相容修正，同步套用那個獨立提交，再用 automation_update 更新已核對 id 的原排程完整設定。此時保持暫停，先做 local-only smoke check。
- [ ] 在正式環境只做不觸發新 scan/發布的檢查：module import/syntax、doctor、controller status、網站 read-back、protected hashes；不為了 smoke test 執行每日 planner 的預設 scan。
- [ ] 比較 cutover 前後 protected 檔案 SHA/mode、queue/job/receipt identity、controller/payload、archive 歷史列、舊 PDFs/mapping、排程設定。沒有授權的私人資料變動必須為零。

## Task 11：恢復原排程與完成一次實際驗收

- [ ] 恢復原 ACTIVE 且契約已對齊的 writer；原 PAUSED 保持 PAUSED。保留 America/New_York 中午時程；不額外建立 recurring automation。
- [ ] 保留舊程式及 cutover 備份，透過既有排程的下一個正常執行驗證 once-per-day claim、receipt、正常與例外佇列、local archive/index、獨立 scan-status closeout。若必須人工驗證，先確認該日 claim，按既有 resume/no-scan 契約續跑，不另起重複 scan。
- [ ] `COMPLETE` 只能由真實 durable evidence 得出；若仍有 open batch、待處理工作或 source coverage 問題，照實報 PARTIAL/FAILED，保留 resume command，不把正常 zero jobs 誤判成故障或成功。
- [ ] 最終交付：實際版本/commit、upstream 採用/合併/保留清單、P01–P15 結果、與 baseline 比較、既有問題、scheduler 差異、私有備份路徑、rollback 路徑。直到本次實際執行完成，狀態仍是「程式已切換，運行驗收待完成」。

## 4. 回復條件與操作

**立即停止切換／恢復舊程式：** protected data 意外變動、歷史職缺/內推/履歷遺失、同日重複 scan、terminal 重新評分、open batch 無法 resume、partial 假綠、local-only 流程被迫寫 Sheet、核心 provider/網站/履歷回歸、必要測試仍失敗。

1. 暫停本次恢復的相關 writers，保留錯誤 logs 和當前最新資料快照，讓 in-flight batch 安全停下。
2. 以 cutover 前 commit 與精確修改清單恢复程式，保留原有未提交修改；不用 `reset --hard`、`git clean` 或整包覆蓋。
3. **優先只回復程式。** 自切換後增加的有效職缺、controller/checkpoint、referral 和履歷不能回到舊日期。如果有確實資料毀損，先保存壞資料，再只還原受損檔，依 operation ledger/receipts 重播切換後合法操作並驗證 identity；禁止用舊備份直接抹掉整個 `data/`。
4. 恢復 cutover 前已核對的排程契約與原 ACTIVE/PAUSED 狀態；若原 prompt 有 Sheet 衝突，保留 writer 暫停到 local-only 相容路徑可用，不能恢復已知錯誤寫入。
5. 重跑核心 queue/controller、snapshot、網站與資料完整性檢查，確認可續跑後再恢復 writer。因本計劃是逐檔整合，不能假設官方 `update-system.mjs rollback` 足以恢復所有客製、WIP 和排程。

## 5. 計劃自查與完成門檻

- [x] 已查對目前程式路徑、既有 Sunny 測試、upstream release commit 與主要重疊檔案。
- [x] P01–P15 都對應到備份、整合或驗收 task。
- [x] 明確處理未追蹤/ignored 資料、外部 data root、絕對 payload 路徑、隔離測試與正式資料前進。
- [x] 明確保留新版掃描狀態、immutable batch、dual queues、內推 UI 與 Balanced A4。
- [x] 將排程的 Sheet 舊指令列為既有差異；規劃驗證與最小修正，未在本次規劃時更改排程。
- [ ] 備份 test-extract/checksum、baseline 測試、完整 manifest 決策、所有合併與 P01–P15 驗收完成。
- [ ] 回復演練完成，正式切換零未授權資料變動，原排程的一次實際運行通過。

**目前狀態：計劃完成，實作未開始。** 不把這份文件或既有測試檔的存在當作功能已通過驗證。
