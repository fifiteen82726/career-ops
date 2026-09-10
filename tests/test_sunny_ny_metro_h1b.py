import importlib.util
import math
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "data" / "tools" / "sunny_ny_metro_h1b.py"
SPEC = importlib.util.spec_from_file_location("sunny_ny_metro_h1b", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorksiteClassificationTests(unittest.TestCase):
    def test_practical_metro_allowlist(self):
        accepted = [
            ("New York", "NY"),
            ("Brooklyn", "NY"),
            ("Long Island City", "NY"),
            ("Yonkers", "NY"),
            ("White Plains", "NY"),
            ("Jersey City", "NJ"),
            ("Newark", "NJ"),
            ("Hoboken", "NJ"),
            ("Secaucus", "NJ"),
            ("Weehawken", "NJ"),
            ("Fort Lee", "NJ"),
            ("Stamford", "CT"),
        ]
        for city, state in accepted:
            with self.subTest(city=city, state=state):
                self.assertTrue(MODULE.classify_worksite(city, state)["practical_metro"])

    def test_state_and_metro_are_separate_signals(self):
        self.assertEqual(
            MODULE.classify_worksite("Buffalo", "NY"),
            {"ny_state": True, "practical_metro": False},
        )
        self.assertEqual(
            MODULE.classify_worksite("Trenton", "NJ"),
            {"ny_state": False, "practical_metro": False},
        )
        self.assertEqual(
            MODULE.classify_worksite("Hartford", "CT"),
            {"ny_state": False, "practical_metro": False},
        )


class EmployerAggregationTests(unittest.TestCase):
    def test_aggregates_qualifying_change_employer_positions(self):
        rows = [
            {
                "CASE_STATUS": "Certified",
                "VISA_CLASS": "H-1B",
                "CHANGE_EMPLOYER": 2,
                "EMPLOYER_NAME": "Example, Inc.",
                "TRADE_NAME_DBA": "Example",
                "WORKSITE_CITY": "New York",
                "WORKSITE_STATE": "NY",
            },
            {
                "CASE_STATUS": "Certified - Withdrawn",
                "VISA_CLASS": "H-1B",
                "CHANGE_EMPLOYER": 1,
                "EMPLOYER_NAME": "Example, Inc.",
                "TRADE_NAME_DBA": "Example",
                "WORKSITE_CITY": "Jersey City",
                "WORKSITE_STATE": "NJ",
            },
            {
                "CASE_STATUS": "Denied",
                "VISA_CLASS": "H-1B",
                "CHANGE_EMPLOYER": 99,
                "EMPLOYER_NAME": "Example, Inc.",
                "TRADE_NAME_DBA": "Example",
                "WORKSITE_CITY": "New York",
                "WORKSITE_STATE": "NY",
            },
        ]

        result = MODULE.aggregate_records(rows)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["transfer_positions"], 3)
        self.assertEqual(result[0]["ny_state_transfer_positions"], 2)
        self.assertEqual(result[0]["metro_transfer_positions"], 3)
        self.assertEqual(result[0]["metro_locations"], "JERSEY CITY, NJ | NEW YORK, NY")

    def test_missing_dba_nan_does_not_merge_unrelated_employers(self):
        rows = [
            {
                "CASE_STATUS": "Certified",
                "VISA_CLASS": "H-1B",
                "CHANGE_EMPLOYER": 1,
                "EMPLOYER_NAME": employer,
                "TRADE_NAME_DBA": math.nan,
                "WORKSITE_CITY": "New York",
                "WORKSITE_STATE": "NY",
            }
            for employer in ("Alpha Inc.", "Beta LLC")
        ]

        result = MODULE.aggregate_records(rows)

        self.assertEqual([row["EMPLOYER_NAME"] for row in result], ["Alpha Inc.", "Beta LLC"])
        self.assertTrue(all(row["DBA"] == "" for row in result))


if __name__ == "__main__":
    unittest.main()
