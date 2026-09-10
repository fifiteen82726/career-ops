#!/usr/bin/env python3
"""Build Sunny's NY State + practical NYC Metro H-1B employer universe.

The input is the cached DOL FY2026 Q3 LCA disclosure workbook.  Output keeps
NY State and practical Metro worksite evidence as separate signals so Albany or
Buffalo can remain in the requested 2,359-identity NY pool without being
mislabelled as commutable NYC Metro.
"""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Mapping


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "data" / "cache" / "dol" / "LCA_Disclosure_Data_FY2026_Q3.xlsx"
DEFAULT_OUTPUT = ROOT / "data" / "cache" / "dol" / "sunny-ny-metro-h1b-employers-fy2026q3.tsv"

METRO_CITIES = {
    "NY": {
        "NEW YORK",
        "NEW YORK CITY",
        "NYC",
        "MANHATTAN",
        "BROOKLYN",
        "QUEENS",
        "BRONX",
        "STATEN ISLAND",
        "LONG ISLAND CITY",
        "YONKERS",
        "WHITE PLAINS",
    },
    "NJ": {"JERSEY CITY", "NEWARK", "HOBOKEN", "SECAUCUS", "WEEHAWKEN", "FORT LEE"},
    "CT": {"STAMFORD"},
}

QUALIFYING_STATUSES = {"CERTIFIED", "CERTIFIED - WITHDRAWN"}


def normalize_text(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip().upper()
    if text == "NAN":
        return ""
    return " ".join(text.split())


def clean_cell(value: object) -> str:
    if value is None:
        return ""
    try:
        if value != value:  # pandas/numpy NaN without importing pandas in pure helpers
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    return "" if text.upper() in {"NAN", "<NA>"} else text


def classify_worksite(city: object, state: object) -> dict[str, bool]:
    normalized_city = normalize_text(city)
    normalized_state = normalize_text(state)
    return {
        "ny_state": normalized_state == "NY",
        "practical_metro": normalized_city in METRO_CITIES.get(normalized_state, set()),
    }


def _position_count(value: object) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return max(0, int(number))


def is_qualifying_record(row: Mapping[str, object]) -> bool:
    status = normalize_text(row.get("CASE_STATUS"))
    visa_class = normalize_text(row.get("VISA_CLASS"))
    return (
        status in QUALIFYING_STATUSES
        and visa_class == "H-1B"
        and _position_count(row.get("CHANGE_EMPLOYER")) > 0
    )


def aggregate_records(rows: Iterable[Mapping[str, object]]) -> list[dict[str, object]]:
    groups: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not is_qualifying_record(row):
            continue
        employer_name = clean_cell(row.get("EMPLOYER_NAME"))
        dba = clean_cell(row.get("TRADE_NAME_DBA"))
        if not employer_name:
            continue
        key = (employer_name, dba)
        if key not in groups:
            groups[key] = {
                "EMPLOYER_NAME": employer_name,
                "DBA": dba,
                "transfer_positions": 0,
                "ny_state_transfer_positions": 0,
                "metro_transfer_positions": 0,
                "metro_locations": set(),
            }

        positions = _position_count(row.get("CHANGE_EMPLOYER"))
        flags = classify_worksite(row.get("WORKSITE_CITY"), row.get("WORKSITE_STATE"))
        group = groups[key]
        group["transfer_positions"] += positions
        if flags["ny_state"]:
            group["ny_state_transfer_positions"] += positions
        if flags["practical_metro"]:
            group["metro_transfer_positions"] += positions
            city = normalize_text(row.get("WORKSITE_CITY"))
            state = normalize_text(row.get("WORKSITE_STATE"))
            group["metro_locations"].add(f"{city}, {state}")

    output = []
    for group in groups.values():
        if not group["ny_state_transfer_positions"] and not group["metro_transfer_positions"]:
            continue
        ny_count = int(group["ny_state_transfer_positions"])
        metro_count = int(group["metro_transfer_positions"])
        output.append(
            {
                **group,
                "ny_transfer_positions": ny_count,
                "metro_locations": " | ".join(sorted(group["metro_locations"])),
                "geography_scope": "NY_STATE_AND_METRO" if ny_count and metro_count else ("NY_STATE" if ny_count else "METRO_ONLY"),
            }
        )

    return sorted(
        output,
        key=lambda row: (
            -int(row["metro_transfer_positions"]),
            -int(row["ny_state_transfer_positions"]),
            -int(row["transfer_positions"]),
            str(row["EMPLOYER_NAME"]).lower(),
            str(row["DBA"]).lower(),
        ),
    )


def build_universe(input_path: Path) -> list[dict[str, object]]:
    import pandas as pd

    columns = [
        "CASE_STATUS",
        "VISA_CLASS",
        "CHANGE_EMPLOYER",
        "EMPLOYER_NAME",
        "TRADE_NAME_DBA",
        "WORKSITE_CITY",
        "WORKSITE_STATE",
    ]
    frame = pd.read_excel(input_path, usecols=columns)
    return aggregate_records(frame.to_dict(orient="records"))


def write_tsv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "EMPLOYER_NAME",
        "DBA",
        "transfer_positions",
        "ny_transfer_positions",
        "ny_state_transfer_positions",
        "metro_transfer_positions",
        "metro_locations",
        "geography_scope",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, delimiter="\t", extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    rows = build_universe(args.input)
    write_tsv(args.output, rows)
    ny_rows = sum(1 for row in rows if int(row["ny_state_transfer_positions"]) > 0)
    metro_rows = sum(1 for row in rows if int(row["metro_transfer_positions"]) > 0)
    metro_only = sum(1 for row in rows if row["geography_scope"] == "METRO_ONLY")
    print({"rows": len(rows), "ny_state_rows": ny_rows, "metro_rows": metro_rows, "metro_only_rows": metro_only, "output": str(args.output)})


if __name__ == "__main__":
    main()
