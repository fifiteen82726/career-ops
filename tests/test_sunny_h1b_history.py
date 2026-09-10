import csv
import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape


MODULE_PATH = Path(__file__).parents[1] / "data" / "tools" / "sunny_h1b_history.py"
MODULE = None
if MODULE_PATH.exists():
    SPEC = importlib.util.spec_from_file_location("sunny_h1b_history", MODULE_PATH)
    MODULE = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(MODULE)

HEADERS = ["CASE_NUMBER", "CASE_STATUS", "DECISION_DATE", "VISA_CLASS",
           "EMPLOYER_NAME", "TRADE_NAME_DBA", "CHANGE_EMPLOYER", "WORKSITE_STATE",
           "ORIGINAL_CERT_DATE", "RECEIVED_DATE", "WORKSITE_CITY"]


def case(case_number="I-200-24001-000001", **changes):
    return {"CASE_NUMBER": case_number, "CASE_STATUS": "Certified",
            "DECISION_DATE": "2025-03-01", "VISA_CLASS": "H-1B",
            "EMPLOYER_NAME": "Example, Inc.", "TRADE_NAME_DBA": "Example",
            "CHANGE_EMPLOYER": 2, "WORKSITE_STATE": "NY", **changes}


def workbook(path, rows, headers=HEADERS, shared=False, date1904=False):
    """Small real OOXML workbook; no external fixture generation dependency."""
    strings = []
    xml_rows = []
    for number, values in enumerate([headers] + [[row.get(h, "") for h in headers] for row in rows], 1):
        cells = []
        for column, value in enumerate(values):
            ref = f"{chr(65 + column)}{number}"
            if isinstance(value, (int, float)):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            elif shared:
                strings.append(str(value))
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings)-1}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        xml_rows.append(f'<row r="{number}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{int(date1904)}"/><sheets><sheet name="Disclosure" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
        if shared:
            z.writestr("xl/sharedStrings.xml", f'<sst {ns}>' + ''.join(f'<si><t>{escape(s)}</t></si>' for s in strings) + '</sst>')


class HistoryIndexTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(callable(getattr(MODULE, "build_index", None)), "history index builder is not implemented")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def build(self, releases, output="result", declarations=None, **workbook_options):
        sources = []
        for index, (period, rows) in enumerate(releases):
            path = self.root / f"release-{index}.xlsx"
            workbook(path, rows, **workbook_options)
            sources.append({"period": period, "path": str(path),
                            "url": f"https://www.dol.gov/test/{period}-{index}.xlsx",
                            **(declarations or {}).get(period, {})})
        spec = {"window_start": "2024-07-01", "window_end": "2026-06-30",
                "current_period": "FY2026Q3", "sources": sources}
        target = self.root / output
        manifest = MODULE.build_index(spec, target, ingested_at="2026-09-09T00:00:00Z")
        self.db = sqlite3.connect(target / "cases.sqlite")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        with (target / "employers.tsv").open() as f:
            employers = list(csv.DictReader(f, delimiter="\t"))
        with (target / "historical-only-employers.tsv").open() as f:
            historical = list(csv.DictReader(f, delimiter="\t"))
        return employers, historical, manifest

    def test_newest_release_supersedes_before_status_visa_and_count_filters(self):
        old = [case("status"), case("visa"), case("count"), case("keep")]
        new = [case("status", CASE_STATUS="Denied"), case("visa", VISA_CLASS="E-3 Australian"),
               case("count", CHANGE_EMPLOYER=0), case("keep", CHANGE_EMPLOYER=3)]
        rows, _, manifest = self.build([("FY2025Q4", old), ("FY2026Q3", new)])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["transfer_positions"], "3")
        self.assertEqual(rows[0]["case_count"], "1")
        self.assertEqual(manifest["counts"]["observations"], 8)
        self.assertEqual(manifest["counts"]["distinct_cases"], 4)

    def test_date_window_is_inclusive_and_fiscal_not_calendar_quarters(self):
        rows, _, manifest = self.build([("FY2024Q4", [case("before", DECISION_DATE="2024-06-30"),
                  case("first", DECISION_DATE="2024-07-01")]), ("FY2026Q3", [
                  case("last", DECISION_DATE="2026-06-30"), case("after", DECISION_DATE="2026-07-01")])])
        self.assertEqual(rows[0]["transfer_positions"], "4")
        self.assertEqual(rows[0]["latest_decision_date"], "2026-06-30")
        self.assertEqual(manifest["window"]["fiscal_quarters"], ["FY2024Q4", "FY2025Q1", "FY2025Q2", "FY2025Q3", "FY2025Q4", "FY2026Q1", "FY2026Q2", "FY2026Q3"])

    def test_legal_name_dba_punctuation_and_case_remain_distinct(self):
        entities = [("Acme, Inc.", "Brand"), ("Acme, Inc.", "Other Brand"),
                    ("Acme Inc", "Brand"), ("ACME, INC.", "Brand"), ("Different LLC", "Brand")]
        rows, _, _ = self.build([("FY2026Q3", [case(str(i), EMPLOYER_NAME=legal, TRADE_NAME_DBA=dba)
                                                     for i, (legal, dba) in enumerate(entities)])])
        self.assertEqual({(r["EMPLOYER_NAME"], r["DBA"]) for r in rows}, set(entities))

    def test_exact_duplicate_and_multiple_worksites_count_case_once(self):
        rows, _, _ = self.build([("FY2026Q3", [case(), case(), case(WORKSITE_STATE="CA")])])
        self.assertEqual(rows[0]["transfer_positions"], "2")
        self.assertEqual(rows[0]["ny_transfer_positions"], "2")
        self.assertEqual(rows[0]["case_count"], "1")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 3)

    def test_withdrawn_certification_is_annotated_historical_evidence(self):
        rows, _, manifest = self.build([("FY2026Q3", [case("cw", CASE_STATUS="Certified-Withdrawn", ORIGINAL_CERT_DATE="2024-01-01"),
                case("c", CHANGE_EMPLOYER=3), case("w", CASE_STATUS="Withdrawn"), case("d", CASE_STATUS="Denied")])])
        self.assertEqual(rows[0]["transfer_positions"], "5")
        self.assertEqual(rows[0]["certified_withdrawn_case_count"], "1")
        self.assertEqual(rows[0]["certified_withdrawn_transfer_positions"], "2")
        self.assertIn("不代表", manifest["interpretation"])
        self.assertEqual(self.db.execute("SELECT original_cert_date FROM cases WHERE case_number='cw'").fetchone()[0], "2024-01-01")

    def test_missing_case_id_and_invalid_dates_are_explicit_rejects(self):
        rows, _, manifest = self.build([("FY2026Q3", [case(""), case(" "),
                  case("bad", DECISION_DATE="2026-02-30"), case("missing", DECISION_DATE=""), case("ok")])])
        self.assertEqual(rows[0]["transfer_positions"], "2")
        self.assertEqual(manifest["counts"]["rejected_observations"], 4)
        reasons = dict(self.db.execute("SELECT reason,COUNT(*) FROM rejects GROUP BY reason"))
        self.assertEqual(reasons, {"missing_case_number": 2, "invalid_decision_date": 2})

    def test_newer_invalid_record_does_not_resurrect_older_eligible_case(self):
        rows, _, _ = self.build([("FY2025Q4", [case("bad")]),
                ("FY2026Q3", [case("bad", DECISION_DATE="unknown")])])
        self.assertEqual(rows, [])
        self.assertEqual(self.db.execute("SELECT disposition FROM cases").fetchone()[0], "invalid_decision_date")

    def test_equal_vintage_conflicting_records_reject_entire_case(self):
        rows, _, _ = self.build([("FY2026Q3", [case("x")]),
                                ("FY2026Q3", [case("x", CHANGE_EMPLOYER=9)])])
        self.assertEqual(rows, [])
        self.assertEqual(self.db.execute("SELECT disposition FROM cases").fetchone()[0], "ambiguous_same_vintage")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM rejects WHERE reason='ambiguous_same_vintage'").fetchone()[0], 2)

    def test_current_history_tiers_and_exact_historical_only_diff(self):
        rows, historical, _ = self.build([("FY2024Q4", [case("old", DECISION_DATE="2024-08-01", EMPLOYER_NAME="Historical LLC")]),
          ("FY2025Q4", [case("older", EMPLOYER_NAME="Current LLC", CHANGE_EMPLOYER=4)]),
          ("FY2026Q3", [case("new", EMPLOYER_NAME="Current LLC", CHANGE_EMPLOYER=3)])])
        current = next(r for r in rows if r["EMPLOYER_NAME"] == "Current LLC")
        self.assertEqual((current["evidence_tier"], current["current_transfer_positions"], current["history_transfer_positions"]), ("A", "3", "4"))
        self.assertEqual(current["source_periods"], "FY2025Q4 | FY2026Q3")
        self.assertEqual([(r["EMPLOYER_NAME"], r["evidence_tier"]) for r in historical], [("Historical LLC", "B")])

    def test_provenance_checksums_and_selected_source_rows_survive(self):
        _, _, manifest = self.build([("FY2026Q3", [case()])])
        source = manifest["sources"][0]
        self.assertEqual(source["sha256"], hashlib.sha256((self.root / "release-0.xlsx").read_bytes()).hexdigest())
        self.assertEqual(source["period"], "FY2026Q3")
        self.assertIsNone(source["coverage_start"])
        self.assertIsNone(source["coverage_end"])
        self.assertIsNone(source["declared_coverage"])
        self.assertEqual(source["period_inferred_coverage"]["start"], "2025-10-01")
        self.assertEqual(source["period_inferred_coverage"]["end"], "2026-06-30")
        self.assertEqual(source["ingested_at"], "2026-09-09T00:00:00Z")
        row = self.db.execute("SELECT source_id,row_number,raw_json FROM observations").fetchone()
        self.assertEqual(row["row_number"], 2)
        self.assertEqual(json.loads(row["raw_json"])["EMPLOYER_NAME"], "Example, Inc.")

    def test_excel_serial_dates_and_shared_strings(self):
        serial = (date(2026, 6, 30) - date(1899, 12, 30)).days
        rows, _, _ = self.build([("FY2026Q3", [case(DECISION_DATE=serial)])], shared=True)
        self.assertEqual(rows[0]["latest_decision_date"], "2026-06-30")

    def test_1904_date_system_is_respected(self):
        serial = (date(2026, 6, 30) - date(1904, 1, 1)).days
        rows, _, _ = self.build([("FY2026Q3", [case(DECISION_DATE=serial)])], date1904=True)
        self.assertEqual(rows[0]["latest_decision_date"], "2026-06-30")

    def test_fractional_negative_and_nonfinite_positions_are_not_truncated(self):
        rows, _, manifest = self.build([("FY2026Q3", [case(str(i), CHANGE_EMPLOYER=v)
                                      for i, v in enumerate([1.5, -1, "NaN", "Infinity", "n/a"])])])
        self.assertEqual(rows, [])
        self.assertEqual(manifest["counts"]["rejected_observations"], 5)

    def test_missing_required_header_fails_without_publishing_outputs(self):
        with self.assertRaisesRegex(ValueError, "CASE_NUMBER"):
            self.build([("FY2026Q3", [case()])], headers=HEADERS[1:])
        self.assertFalse((self.root / "result").exists())

    def test_duplicate_required_header_is_explicit_failure(self):
        with self.assertRaisesRegex(ValueError, "duplicate=.*CASE_NUMBER"):
            self.build([("FY2026Q3", [case()])], headers=HEADERS + ["CASE_NUMBER"])

    def test_release_input_order_does_not_change_dedup_or_aggregation(self):
        releases = [("FY2025Q4", [case("x"), case("history", EMPLOYER_NAME="Historical LLC")]),
                    ("FY2026Q3", [case("x", CHANGE_EMPLOYER=3)])]
        first, old_first, _ = self.build(releases)
        second, old_second, _ = self.build(list(reversed(releases)), output="reverse")
        self.assertEqual(first, second)
        self.assertEqual(old_first, old_second)

    def test_newer_unambiguous_version_resolves_prior_release_conflict(self):
        rows, _, _ = self.build([("FY2025Q4", [case("x"), case("x", CHANGE_EMPLOYER=9)]),
                                ("FY2026Q3", [case("x", CHANGE_EMPLOYER=3)])])
        self.assertEqual(rows[0]["transfer_positions"], "3")

    def test_sha256_mismatch_prevents_output_publication(self):
        source = self.root / "input.xlsx"
        workbook(source, [case()])
        with self.assertRaisesRegex(ValueError, "SHA256"):
            MODULE.build_index({"window_start": "2024-07-01", "window_end": "2026-06-30",
                "sources": [{"period": "FY2026Q3", "url": "https://www.dol.gov/test.xlsx",
                             "path": str(source), "sha256": "0" * 64}]}, self.root / "bad-sha")
        self.assertFalse((self.root / "bad-sha").exists())

    def test_existing_outputs_are_never_overwritten(self):
        _, _, _ = self.build([("FY2026Q3", [case()])])
        before = (self.root / "result" / "manifest.json").read_bytes()
        with self.assertRaises(FileExistsError):
            self.build([("FY2026Q3", [])])
        self.assertEqual((self.root / "result" / "manifest.json").read_bytes(), before)

    def test_manifest_reports_missing_source_quarters_without_claiming_coverage(self):
        _, _, manifest = self.build([("FY2026Q3", [case()])])
        self.assertIn("coverage", manifest)
        self.assertEqual(manifest["coverage"]["missing_fiscal_quarters"], manifest["window"]["fiscal_quarters"])
        self.assertFalse(manifest["coverage"]["complete"])

    def test_annual_label_cannot_hide_missing_observed_quarters(self):
        _, _, manifest = self.build([
            ("FY2024Q4", [case("2024", DECISION_DATE="2024-07-01")]),
            ("FY2025Q4", [case("2025", DECISION_DATE="2025-07-01")]),
            ("FY2026Q3", [case("2026q1", DECISION_DATE="2025-10-01"),
                           case("2026q2", DECISION_DATE="2026-01-01"),
                           case("2026q3", DECISION_DATE="2026-04-01")])], declarations={
                "FY2024Q4": {"coverage_start": "2023-10-01", "coverage_end": "2024-09-30"},
                "FY2025Q4": {"coverage_start": "2024-10-01", "coverage_end": "2025-09-30"},
                "FY2026Q3": {"coverage_start": "2025-10-01", "coverage_end": "2026-06-30"}})
        self.assertFalse(manifest["coverage"]["complete"])
        self.assertEqual(manifest["coverage"]["missing_observed_fiscal_quarters"], ["FY2025Q1", "FY2025Q2", "FY2025Q3"])
        self.assertEqual(manifest["coverage"]["missing_declared_fiscal_quarters"], [])
        self.assertEqual(manifest["coverage"]["missing_fiscal_quarters"], ["FY2025Q1", "FY2025Q2", "FY2025Q3"])

    def test_adding_missing_quarters_restores_observed_and_declared_coverage(self):
        dates = ["2024-07-01", "2024-10-01", "2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01", "2026-01-01", "2026-04-01"]
        quarters = ["FY2024Q4", "FY2025Q1", "FY2025Q2", "FY2025Q3", "FY2025Q4", "FY2026Q1", "FY2026Q2", "FY2026Q3"]
        ends = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]
        declarations = {q: {"coverage_start": start, "coverage_end": end} for q, start, end in zip(quarters, dates, ends)}
        releases = [(q, [case(q, DECISION_DATE=day)]) for q, day in zip(quarters, dates)]
        _, _, manifest = self.build(releases, declarations=declarations)
        self.assertTrue(manifest["coverage"]["complete"])
        self.assertIn("observed_fiscal_quarters", manifest["coverage"])
        self.assertEqual(manifest["coverage"]["observed_fiscal_quarters"], quarters)
        self.assertEqual(manifest["coverage"]["declared_fiscal_quarters"], quarters)
        self.assertEqual(manifest["coverage"]["missing_fiscal_quarters"], [])
        # The same rows without explicit coverage declarations remain unverified.
        _, _, undeclared = self.build(releases, output="undeclared")
        self.assertFalse(undeclared["coverage"]["complete"])
        self.assertEqual(undeclared["coverage"]["missing_observed_fiscal_quarters"], [])
        self.assertEqual(undeclared["coverage"]["missing_declared_fiscal_quarters"], quarters)

    def test_source_observation_counts_include_rejected_duplicates_and_out_of_window_rows(self):
        _, _, manifest = self.build([("FY2026Q3", [
            case("repeat", DECISION_DATE="2026-04-01", CASE_STATUS="Denied"),
            case("repeat", DECISION_DATE="2026-04-01", CASE_STATUS="Denied"),
            case("", DECISION_DATE="2026-05-01"),
            case("outside", DECISION_DATE="2026-07-01"),
            case("bad", DECISION_DATE="invalid")])])
        source = manifest["sources"][0]
        self.assertIn("observed_coverage", source)
        observed = source["observed_coverage"]
        self.assertEqual(observed["decision_date_min"], "2026-04-01")
        self.assertEqual(observed["decision_date_max"], "2026-07-01")
        self.assertEqual(observed["valid_decision_date_rows"], 4)
        self.assertEqual(observed["invalid_decision_date_rows"], 1)
        self.assertEqual(observed["month_counts"], {"2026-04": 2, "2026-05": 1, "2026-07": 1})
        self.assertEqual(observed["fiscal_quarter_counts"], {"FY2026Q3": 3, "FY2026Q4": 1})
        self.assertEqual(observed["window_fiscal_quarter_counts"], {"FY2026Q3": 3})

    def test_explicit_quarter_declaration_is_not_overwritten_by_period_inference(self):
        _, _, manifest = self.build([("FY2025Q4", [case(DECISION_DATE="2025-07-01")]), ("FY2026Q3", [])],
            declarations={"FY2025Q4": {"coverage_start": "2025-07-01", "coverage_end": "2025-09-30"}})
        source = manifest["sources"][0]
        self.assertEqual(source["coverage_start"], "2025-07-01")
        self.assertEqual(source["declared_coverage"]["start"], "2025-07-01")
        self.assertEqual(source["period_inferred_coverage"]["start"], "2024-10-01")

    def test_partial_quarter_declaration_does_not_count_as_a_full_requested_quarter(self):
        _, _, manifest = self.build([("FY2026Q3", [case(DECISION_DATE="2026-05-01")])],
             declarations={"FY2026Q3": {"coverage_start": "2026-05-01", "coverage_end": "2026-05-31"}})
        self.assertEqual(manifest["coverage"].get("declared_fiscal_quarters"), [])
        self.assertEqual(manifest["coverage"]["observed_fiscal_quarters"], ["FY2026Q3"])

    def test_invalid_original_certification_date_is_auditable(self):
        rows, _, manifest = self.build([("FY2026Q3", [case(ORIGINAL_CERT_DATE="not a date")])])
        self.assertEqual(rows, [])
        self.assertEqual(manifest["counts"]["case_dispositions"], {"invalid_original_cert_date": 1})

    def test_cli_writes_real_artifacts_with_expected_manifest(self):
        path = self.root / "cli.xlsx"
        workbook(path, [case()])
        spec = self.root / "sources.json"
        spec.write_text(json.dumps({"window_start": "2024-07-01", "window_end": "2026-06-30",
          "sources": [{"period": "FY2026Q3", "url": "https://www.dol.gov/test.xlsx", "path": str(path)}]}))
        import sys
        result = subprocess.run([sys.executable, str(MODULE_PATH), "--source-manifest", str(spec),
                                 "--output-dir", str(self.root / "cli-result")], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["counts"]["eligible_cases"], 1)


if __name__ == "__main__":
    unittest.main()
