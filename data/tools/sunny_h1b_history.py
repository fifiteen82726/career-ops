#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""從明確指定的本地 DOL XLSX 建立按案件去重的 H-1B 歷史證據索引。

Run with uv (no pip or network/download code):
    uv run --python 3.14 data/tools/sunny_h1b_history.py \
        --source-manifest data/company-discovery/dol-sources.json \
        --output-dir data/cache/dol/history-2026-09-09

Input JSON: {"window_start":"2024-07-01", "window_end":"2026-06-30",
"current_period":"FY2026Q3", "sources":[{"period":"FY2024_Q4",
"path":"data/cache/dol/LCA_Disclosure_Data_FY2024_Q4.xlsx",
"url":"https://www.dol.gov/...xlsx", "sha256":"optional expected hash",
"coverage_start":"2024-07-01", "coverage_end":"2024-09-30"}]}.
Paths are relative to the command's working directory, never the manifest path.
Optional source `sheet` chooses one exact worksheet; otherwise exactly one
worksheet is required. Appendices are never automatically joined.
Declare source coverage explicitly after verifying the actual release; a Q4
filename is not proof of annual coverage. Completion requires observations in
each requested quarter AND explicit source declarations covering the window.
This is a quarter-presence check, not proof of daily completeness or market size.

The OOXML reader streams selected columns, with shared strings in a temporary
SQLite database and a bounded LRU. Observations, rejects, and authoritative cases
are retained on disk. Memory is bounded by XML chunks, 8,192 cached strings,
SQLite's 32 MiB page cache, and one employer group's source periods. Sorting and
grouping use SQLite's disk temp store. This is deliberately slower than loading
a complete workbook into a dataframe; input workbooks are never materialized.

Release fiscal period determines precedence, NOT file order/mtime/ingestion time.
All rows participate before any eligibility filter. Equal-period conflicting
case-level fields reject the entire case; repeated worksite rows can differ in
geography but never multiply CHANGE_EMPLOYER. NYC/NY coverage is not inferred
from employers' headquarters or undisclosed additional worksites.
"""

from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import json
import posixpath
import re
import sqlite3
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from contextlib import closing
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REQUIRED_COLUMNS = ("CASE_NUMBER", "CASE_STATUS", "DECISION_DATE", "VISA_CLASS",
                    "EMPLOYER_NAME", "TRADE_NAME_DBA", "CHANGE_EMPLOYER", "WORKSITE_STATE")
OPTIONAL_COLUMNS = ("ORIGINAL_CERT_DATE", "RECEIVED_DATE", "WORKSITE_CITY")
SELECTED_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
EMPLOYER_COLUMNS = ("EMPLOYER_NAME", "DBA", "transfer_positions", "ny_transfer_positions",
                    "current_transfer_positions", "history_transfer_positions", "evidence_tier",
                    "current_or_historical_window", "latest_decision_date", "case_count",
                    "current_case_count", "history_case_count", "certified_withdrawn_case_count",
                    "certified_withdrawn_transfer_positions", "source_periods", "decision_periods")
INTERPRETATION = (
    "此索引是 DOL LCA 歷史申報證據，不代表 USCIS 核准、目前職缺願意辦理轉雇主，或市場完整規模。"
    "Certified 與 Certified-Withdrawn 依既有政策納入；後者另列案件與職位數。"
    "DECISION_DATE 是最後重大事件／決定日期，可能是撤回日期；ORIGINAL_CERT_DATE 另行保留。"
    "Tier A 表示當期累計披露檔內有合格證據，並不表示近期取得認證；Tier B 僅有歷史窗口證據。"
    "CHANGE_EMPLOYER 是申報職位數，不是已完成轉雇主的人數。ny_transfer_positions 僅依披露的第一工作地點，"
    "不能視為完整 NY／NYC Metro 地點涵蓋。法律名稱及 DBA 使用精確值，未合併關係企業或品牌。"
)


def clean(value):
    return "" if value is None else str(value).strip()


def period_info(value):
    match = re.fullmatch(r"FY(\d{4})_?Q([1-4])", clean(value))
    if not match:
        raise ValueError(f"無效 fiscal period: {value!r}")
    year, quarter = map(int, match.groups())
    month = quarter * 3 - 3 if quarter > 1 else 12
    end_year = year if quarter > 1 else year - 1
    return {"period": f"FY{year}Q{quarter}", "vintage": year * 4 + quarter,
            "coverage_start": f"{year - 1}-10-01",
            "coverage_end": date(end_year, month, calendar.monthrange(end_year, month)[1]).isoformat()}


def fiscal_period(day):
    return f"FY{day.year + (day.month >= 10)}Q{((day.month + 2) % 12) // 3 + 1}"


def fiscal_quarters(start, end):
    periods = []
    day = start
    while day <= end:
        period = fiscal_period(day)
        if period not in periods:
            periods.append(period)
        day += timedelta(days=1)
    return periods


def parse_date(value, date1904=False):
    if value is None or clean(value) == "":
        return None
    if isinstance(value, (int, float)):
        try:
            # A fractional serial is a time within the same calendar day.
            day = date(1904, 1, 1) if date1904 else date(1899, 12, 30)
            return (day + timedelta(days=int(value))).isoformat()
        except (ValueError, OverflowError):
            return None
    text = clean(value)
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def position_count(value):
    try:
        number = Decimal(clean(value))
        if not number.is_finite() or number < 0 or number != number.to_integral_value():
            return None
        # SQLite INTEGER is signed 64-bit; real LCA counts are far below this.
        return int(number) if number < 2**63 else None
    except (InvalidOperation, ValueError):
        return None


def _xml_records(handle, record_name):
    """Yield one completed XML record and remove it from its parent immediately."""
    stack = []
    for event, element in ET.iterparse(handle, events=("start", "end")):
        if event == "start":
            stack.append(element)
        else:
            if element.tag == NS + record_name:
                yield element
                element.clear()
                if len(stack) > 1:
                    stack[-2].remove(element)
            stack.pop()


def iter_xlsx_rows(path, scratch_dir, sheet=None):
    """Yield (Excel row number, selected raw cells, date1904) without full XLSX load."""
    with zipfile.ZipFile(path) as archive, tempfile.TemporaryDirectory(prefix="strings-", dir=scratch_dir) as temp:
        with closing(sqlite3.connect(Path(temp) / "strings.sqlite")) as strings:
            strings.execute("PRAGMA journal_mode=OFF")
            strings.execute("PRAGMA cache_size=-8192")
            strings.execute("CREATE TABLE strings(id INTEGER PRIMARY KEY,value TEXT NOT NULL)")
            if "xl/sharedStrings.xml" in archive.namelist():
                with archive.open("xl/sharedStrings.xml") as handle:
                    strings.executemany("INSERT INTO strings VALUES (?,?)", (
                        (index, "".join(node.itertext()))
                        for index, element in enumerate(_xml_records(handle, "si"))
                        for node in [element]
                    ))
                strings.commit()

            @lru_cache(maxsize=8192)
            def shared(index):
                row = strings.execute("SELECT value FROM strings WHERE id=?", (int(index),)).fetchone()
                if row is None:
                    raise ValueError(f"無效 XLSX shared-string index: {index}")
                return row[0]

            book = ET.fromstring(archive.read("xl/workbook.xml"))
            properties = book.find(NS + "workbookPr")
            date1904 = properties is not None and properties.get("date1904") in {"1", "true"}
            sheets = book.findall(f"{NS}sheets/{NS}sheet")
            chosen = [s for s in sheets if s.get("name") == sheet] if sheet else sheets
            if len(chosen) != 1:
                raise ValueError(f"請指定唯一 worksheet；可用: {[s.get('name') for s in sheets]}")
            relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            relation = next((r for r in relationships if r.get("Id") == chosen[0].get(REL + "id")), None)
            if relation is None or relation.get("TargetMode") == "External":
                raise ValueError("XLSX worksheet relationship 無效")
            target = relation.get("Target", "")
            sheet_path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))

            def cell_value(cell):
                kind = cell.get("t")
                if kind == "inlineStr":
                    return "".join(cell.find(NS + "is").itertext()) if cell.find(NS + "is") is not None else ""
                value = cell.findtext(NS + "v", "")
                if kind == "s":
                    return shared(value)
                if kind in {"str", "d", "e", "b"} or value == "":
                    return value
                try:
                    return float(value) if any(c in value for c in ".eE") else int(value)
                except ValueError:
                    return value

            selected = None
            with archive.open(sheet_path) as handle:
                for row in _xml_records(handle, "row"):
                    number = int(row.get("r", "0"))
                    if selected is None:
                        headers = [(re.sub(r"\d+$", "", c.get("r", "")), clean(cell_value(c))) for c in row if c.tag == NS + "c"]
                        missing = set(REQUIRED_COLUMNS) - {name for _, name in headers}
                        duplicates = [name for name in SELECTED_COLUMNS if sum(h == name for _, h in headers) > 1]
                        if missing or duplicates:
                            raise ValueError(f"XLSX headers 無效；missing={sorted(missing)} duplicate={duplicates}")
                        selected = {column: name for column, name in headers if name in SELECTED_COLUMNS}
                        continue
                    values = {name: "" for name in SELECTED_COLUMNS}
                    for cell in row:
                        column = re.sub(r"\d+$", "", cell.get("r", ""))
                        if column in selected:
                            values[selected[column]] = cell_value(cell)
                    if any(clean(v) for v in values.values()):
                        yield number, values, date1904
            if selected is None:
                raise ValueError("XLSX 缺少 header row: CASE_NUMBER")
            shared.cache_clear()


def _schema(db):
    db.executescript("""
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA cache_size=-32768;
      PRAGMA temp_store=FILE;
      CREATE TABLE sources(source_id INTEGER PRIMARY KEY,period TEXT,vintage INTEGER,
        path TEXT,url TEXT,sha256 TEXT,coverage_start TEXT,coverage_end TEXT,ingested_at TEXT);
      CREATE TABLE observations(observation_id INTEGER PRIMARY KEY,source_id INTEGER,
        vintage INTEGER,row_number INTEGER,case_number TEXT,status TEXT,visa_class TEXT,
        decision_date TEXT,original_cert_date TEXT,employer_name TEXT,dba TEXT,
        positions INTEGER,ny_worksite INTEGER,fingerprint TEXT,validation_error TEXT,raw_json TEXT);
      CREATE TABLE rejects(observation_id INTEGER,case_number TEXT,reason TEXT,
        UNIQUE(observation_id,reason));
    """)


def _observation(source, row_number, row, date1904):
    case_number = clean(row["CASE_NUMBER"])
    status = re.sub(r"\s*-\s*", " - ", clean(row["CASE_STATUS"]).upper())
    visa = clean(row["VISA_CLASS"]).upper()
    decision = parse_date(row["DECISION_DATE"], date1904)
    original = parse_date(row.get("ORIGINAL_CERT_DATE"), date1904)
    name, dba = clean(row["EMPLOYER_NAME"]), clean(row["TRADE_NAME_DBA"])
    positions = position_count(row["CHANGE_EMPLOYER"])
    error = ("missing_case_number" if not case_number else
             "invalid_decision_date" if decision is None else
             "invalid_original_cert_date" if clean(row.get("ORIGINAL_CERT_DATE")) and original is None else
             "invalid_change_employer" if positions is None else
             "missing_employer_name" if not name else "")
    core = (status, visa, decision, original, name, dba, positions, error)
    fingerprint = hashlib.sha256(json.dumps(core, ensure_ascii=False).encode()).hexdigest()
    return (source["source_id"], source["vintage"], row_number, case_number, status, visa,
            decision, original, name, dba, positions, int(clean(row["WORKSITE_STATE"]).upper() == "NY"),
            fingerprint, error, json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _resolve_cases(db, start, end, current_vintage):
    db.executescript("""
      CREATE INDEX observations_case_vintage ON observations(case_number,vintage);
      CREATE TABLE case_heads AS SELECT case_number,MAX(vintage) vintage
        FROM observations WHERE case_number!='' GROUP BY case_number;
      CREATE UNIQUE INDEX case_heads_id ON case_heads(case_number);
      CREATE TABLE cases AS
        SELECT o.case_number,o.vintage,MIN(o.status) status,MIN(o.visa_class) visa_class,
          MIN(o.decision_date) decision_date,MIN(o.original_cert_date) original_cert_date,
          MIN(o.employer_name) employer_name,MIN(o.dba) dba,MIN(o.positions) positions,
          MAX(o.ny_worksite) ny_worksite,COUNT(DISTINCT o.fingerprint) variants,
          MAX(o.validation_error) validation_error,COUNT(*) latest_observation_count,
          '' disposition
        FROM observations o JOIN case_heads h ON o.case_number=h.case_number AND o.vintage=h.vintage
        GROUP BY o.case_number,o.vintage;
      CREATE UNIQUE INDEX cases_id ON cases(case_number);
    """)
    db.execute("""UPDATE cases SET disposition=CASE
      WHEN variants>1 THEN 'ambiguous_same_vintage'
      WHEN validation_error!='' THEN validation_error
      WHEN visa_class!='H-1B' THEN 'excluded_visa_class'
      WHEN status NOT IN ('CERTIFIED','CERTIFIED - WITHDRAWN') THEN 'excluded_status'
      WHEN positions<=0 THEN 'excluded_nonpositive_change_employer'
      WHEN decision_date<? OR decision_date>? THEN 'outside_decision_window'
      ELSE 'eligible' END""", (start, end))
    # Retain invalid rows even if superseded, without reviving their older values.
    db.execute("INSERT OR IGNORE INTO rejects SELECT observation_id,case_number,validation_error FROM observations WHERE validation_error!=''")
    db.execute("""INSERT OR IGNORE INTO rejects
      SELECT o.observation_id,o.case_number,'ambiguous_same_vintage'
      FROM observations o JOIN cases c ON c.case_number=o.case_number AND c.vintage=o.vintage
      WHERE c.disposition='ambiguous_same_vintage'""")
    db.execute("""CREATE TABLE employers AS
      SELECT employer_name AS EMPLOYER_NAME,dba AS DBA,SUM(positions) transfer_positions,
        SUM(positions*ny_worksite) ny_transfer_positions,
        SUM(CASE WHEN vintage=? THEN positions ELSE 0 END) current_transfer_positions,
        SUM(CASE WHEN vintage!=? THEN positions ELSE 0 END) history_transfer_positions,
        MAX(decision_date) latest_decision_date,COUNT(*) case_count,
        SUM(vintage=?) current_case_count,SUM(vintage!=?) history_case_count,
        SUM(status='CERTIFIED - WITHDRAWN') certified_withdrawn_case_count,
        SUM(CASE WHEN status='CERTIFIED - WITHDRAWN' THEN positions ELSE 0 END) certified_withdrawn_transfer_positions
      FROM cases WHERE disposition='eligible' GROUP BY employer_name,dba""", (current_vintage,) * 4)
    db.execute("CREATE INDEX cases_employer ON cases(employer_name,dba,disposition)")
    db.commit()


def _employers(db, spec):
    db.row_factory = sqlite3.Row
    for row in db.execute("SELECT * FROM employers ORDER BY EMPLOYER_NAME COLLATE BINARY,DBA COLLATE BINARY"):
        result = dict(row)
        result["evidence_tier"] = "A" if row["current_transfer_positions"] else "B"
        result["current_or_historical_window"] = (
            f"current:{spec['current_period']};history:{spec['window_start']}..{spec['window_end']}"
            if result["evidence_tier"] == "A" else f"historical-only:{spec['window_start']}..{spec['window_end']}"
        )
        periods, decision_periods = set(), set()
        for case in db.execute("SELECT vintage,decision_date FROM cases WHERE employer_name=? AND dba=? AND disposition='eligible'", (row["EMPLOYER_NAME"], row["DBA"])):
            year, q0 = divmod(case["vintage"] - 1, 4)
            periods.add(f"FY{year}Q{q0+1}")
            decision_periods.add(fiscal_period(date.fromisoformat(case["decision_date"])))
        result["source_periods"] = " | ".join(sorted(periods))
        result["decision_periods"] = " | ".join(sorted(decision_periods))
        yield result


def _prepare_sources(spec, ingested_at):
    sources = []
    for item in spec["sources"]:
        inferred = period_info(item["period"])
        source = {**item, "period": inferred["period"], "vintage": inferred["vintage"]}
        declared_start, declared_end = clean(item.get("coverage_start")), clean(item.get("coverage_end"))
        if bool(declared_start) != bool(declared_end):
            raise ValueError("來源 coverage_start 與 coverage_end 必須同時提供")
        if declared_start:
            first, last = date.fromisoformat(declared_start), date.fromisoformat(declared_end)
            if first > last:
                raise ValueError("來源 coverage_start 不得晚於 coverage_end")
            declared_start, declared_end = first.isoformat(), last.isoformat()
        source.update(coverage_start=declared_start or None, coverage_end=declared_end or None,
                      declared_coverage={"start": declared_start, "end": declared_end,
                                         "basis": "explicit_source_manifest"} if declared_start else None,
                      period_inferred_coverage={"start": inferred["coverage_start"], "end": inferred["coverage_end"],
                                                "basis": "period_name_only_not_verified"})
        path = Path(item["path"]).resolve(strict=True)
        if not clean(item.get("url")):
            raise ValueError("每個 source 必須有來源 URL")
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if item.get("sha256") and item["sha256"].lower() != digest:
            raise ValueError(f"SHA256 不符: {path}")
        source.update(path=str(path), sha256=digest, ingested_at=ingested_at)
        sources.append(source)
    sources.sort(key=lambda s: (s["vintage"], s["path"], s["url"], s["sha256"]))
    for index, source in enumerate(sources, 1):
        source["source_id"] = index
    if not sources or spec["current_period"] not in {s["period"] for s in sources}:
        raise ValueError("sources 必須包括 current_period")
    return sources


def _observe_date(observed, decision, start, end):
    """Count source rows before case dedup, status, visa, or position filtering."""
    if decision is None:
        observed["invalid_decision_date_rows"] += 1
        return
    observed["valid_decision_date_rows"] += 1
    observed["decision_date_min"] = min(observed["decision_date_min"] or decision, decision)
    observed["decision_date_max"] = max(observed["decision_date_max"] or decision, decision)
    month = decision[:7]
    quarter = fiscal_period(date.fromisoformat(decision))
    observed["month_counts"][month] += 1
    observed["fiscal_quarter_counts"][quarter] += 1
    if start <= decision <= end:
        observed["window_month_counts"][month] += 1
        observed["window_fiscal_quarter_counts"][quarter] += 1


def _coverage_summary(sources, start, end):
    quarters = fiscal_quarters(start, end)
    ranges = sorted((max(start, date.fromisoformat(s["coverage_start"])),
                     min(end, date.fromisoformat(s["coverage_end"])))
                    for s in sources if s["declared_coverage"])
    declared, observed = set(), set()
    for quarter in quarters:
        last = date.fromisoformat(period_info(quarter)["coverage_end"])
        cursor = max(start, date(last.year, last.month - 2, 1))
        last = min(end, last)
        for low, high in ranges:
            if high < cursor:
                continue
            if low > cursor:
                break
            if high >= last:
                declared.add(quarter)
                break
            cursor = high + timedelta(days=1)
    for source in sources:
        observed.update(source["observed_coverage"]["window_fiscal_quarter_counts"])
    covered = declared & observed
    missing = [quarter for quarter in quarters if quarter not in covered]
    return {"complete": not missing, "missing_fiscal_quarters": missing,
            "covered_fiscal_quarters": [q for q in quarters if q in covered],
            "declared_fiscal_quarters": [q for q in quarters if q in declared],
            "observed_fiscal_quarters": [q for q in quarters if q in observed],
            "missing_declared_fiscal_quarters": [q for q in quarters if q not in declared],
            "missing_observed_fiscal_quarters": [q for q in quarters if q not in observed],
            "basis": "每個請求財季均有窗口內 DECISION_DATE 來源列，且明確來源宣告涵蓋該季請求範圍；檔名推測不計入。",
            "limitation": "觀測計數涵蓋去重及資格篩選前的來源列，可能重複；complete 僅表示各季出現及宣告涵蓋，不保證逐日、逐列或市場完整度。"}


def build_index(spec, output_dir, *, ingested_at=None, progress=None):
    """Build atomically into a NEW output directory; return its source/run manifest."""
    spec = dict(spec)
    start, end = date.fromisoformat(spec["window_start"]), date.fromisoformat(spec["window_end"])
    if start > end:
        raise ValueError("window_start 不得晚於 window_end")
    current = period_info(spec.get("current_period", fiscal_period(end)))
    spec["current_period"] = current["period"]
    output_dir = Path(output_dir).resolve()
    if output_dir.exists():
        raise FileExistsError(f"輸出目錄已存在，請使用新的 run 目錄: {output_dir}")
    timestamp = ingested_at or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    sources = _prepare_sources(spec, timestamp)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".h1b-build-", dir=output_dir.parent) as temp:
        staging = Path(temp) / "result"
        staging.mkdir()
        with closing(sqlite3.connect(staging / "cases.sqlite")) as db:
            _schema(db)
            for source in sources:
                if progress:
                    progress(f"匯入 {source['period']}: {source['path']}")
                db.execute("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)", tuple(source[k] for k in
                    ("source_id", "period", "vintage", "path", "url", "sha256", "coverage_start", "coverage_end", "ingested_at")))
                count = 0
                observed = {"decision_date_min": None, "decision_date_max": None,
                            "valid_decision_date_rows": 0, "invalid_decision_date_rows": 0,
                            "month_counts": Counter(), "fiscal_quarter_counts": Counter(),
                            "window_month_counts": Counter(), "window_fiscal_quarter_counts": Counter()}

                def records():
                    nonlocal count
                    for row_number, row, date1904 in iter_xlsx_rows(source["path"], temp, source.get("sheet")):
                        count += 1
                        if progress and count % 100000 == 0:
                            progress(f"{source['period']}: {count:,} 筆來源列")
                        record = _observation(source, row_number, row, date1904)
                        _observe_date(observed, record[6], spec["window_start"], spec["window_end"])
                        yield record

                db.executemany("""INSERT INTO observations(source_id,vintage,row_number,case_number,status,
                  visa_class,decision_date,original_cert_date,employer_name,dba,positions,ny_worksite,
                  fingerprint,validation_error,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", records())
                source["row_count"] = count
                source["observed_coverage"] = {key: dict(sorted(value.items())) if isinstance(value, Counter) else value
                                               for key, value in observed.items()}
                db.commit()
            if progress:
                progress("依最新披露期去重並彙整雇主證據")
            _resolve_cases(db, start.isoformat(), end.isoformat(), current["vintage"])
            historical_count = 0
            with (staging / "employers.tsv").open("w", encoding="utf-8", newline="") as all_file, \
                 (staging / "historical-only-employers.tsv").open("w", encoding="utf-8", newline="") as history_file:
                all_writer = csv.DictWriter(all_file, EMPLOYER_COLUMNS, delimiter="\t", lineterminator="\n")
                history_writer = csv.DictWriter(history_file, EMPLOYER_COLUMNS, delimiter="\t", lineterminator="\n")
                all_writer.writeheader()
                history_writer.writeheader()
                for employer in _employers(db, spec):
                    all_writer.writerow(employer)
                    if employer["evidence_tier"] == "B":
                        history_writer.writerow(employer)
                        historical_count += 1
            counts = {"observations": db.execute("SELECT COUNT(*) FROM observations").fetchone()[0],
                      "distinct_cases": db.execute("SELECT COUNT(*) FROM cases").fetchone()[0],
                      "eligible_cases": db.execute("SELECT COUNT(*) FROM cases WHERE disposition='eligible'").fetchone()[0],
                      "employers": db.execute("SELECT COUNT(*) FROM employers").fetchone()[0],
                      "historical_only_employers": historical_count,
                      "rejected_observations": db.execute("SELECT COUNT(DISTINCT observation_id) FROM rejects").fetchone()[0],
                      "case_dispositions": dict(db.execute("SELECT disposition,COUNT(*) FROM cases GROUP BY disposition ORDER BY disposition"))}
            db.execute("PRAGMA user_version=2")
            db.commit()
        quarters = fiscal_quarters(start, end)
        manifest = {"schema_version": 2, "ingested_at": timestamp,
                    "window": {"start": start.isoformat(), "end": end.isoformat(), "date_field": "DECISION_DATE",
                               "inclusive": True, "fiscal_quarters": quarters},
                    "coverage": _coverage_summary(sources, start, end),
                    "current_period": spec["current_period"], "sources": sources, "counts": counts,
                    "deduplication": "CASE_NUMBER; newest fiscal release wins before filtering; equal-vintage conflicts reject; worksite-only differences union once",
                    "status_policy": ["CERTIFIED", "CERTIFIED - WITHDRAWN"],
                    "identity_policy": "exact legal EMPLOYER_NAME + exact TRADE_NAME_DBA; trim outer whitespace only",
                    "diff_baseline": f"eligible authoritative cases in supplied {spec['current_period']} disclosure; exact legal + DBA",
                    "geography": "WORKSITE_STATE: disclosed first worksite; not complete worksites or NYC Metro coverage",
                    "interpretation": INTERPRETATION,
                    "outputs": {"employers": "employers.tsv", "historical_only_employers": "historical-only-employers.tsv",
                                "case_provenance_and_rejects": "cases.sqlite"}}
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging.rename(output_dir)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.source_manifest.read_text(encoding="utf-8"))
    result = build_index(spec, args.output_dir, progress=lambda message: print(message, file=sys.stderr, flush=True))
    print(json.dumps({"output_dir": str(args.output_dir.resolve()), "counts": result["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
