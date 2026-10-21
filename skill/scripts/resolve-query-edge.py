#!/usr/bin/env python3
"""Print regional edge base URLs for an APL query, one per line.

Order matches the MCP client: the dataset's edge, the last successful edge,
the environment default, then every other edge. Field references in quotes are
ignored because they are not dataset names.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

QUOTED_DATASET = re.compile(r"\[\s*(['\"])((?:\\.|(?!\1).)+)\1\s*\]")
RESERVED_DATASETS = {"stitch-events", "stitch-service-map-rollup"}


def unescape(value: str) -> str:
    return re.sub(r"\\(['\"\\])", r"\1", value).strip()


def normalize(domain: str) -> str:
    domain = (domain or "").strip().rstrip("/")
    if not domain:
        return ""
    if "://" not in domain:
        return "https://" + domain
    return domain


def quoted_datasets(apl: str, explicit: str) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    if explicit and explicit not in seen:
        seen.add(explicit)
        names.append(explicit)
    for match in QUOTED_DATASET.finditer(apl or ""):
        name = unescape(match.group(2))
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def load_json(path: str, fallback):
    if not path:
        return fallback
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return fallback


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apl", default="")
    parser.add_argument("--dataset", default="")
    parser.add_argument("--regions-file", required=True)
    parser.add_argument("--datasets-file", default="")
    parser.add_argument("--cached-base", default="")
    args = parser.parse_args()

    regions_doc = load_json(args.regions_file, {})
    datasets = load_json(args.datasets_file, [])
    if not isinstance(regions_doc, dict):
        regions_doc = {}
    if not isinstance(datasets, list):
        datasets = []

    region_map: dict[str, str] = {}
    default_region = None
    for region in regions_doc.get("axiom") or []:
        if not isinstance(region, dict):
            continue
        region_id = region.get("id")
        domain = normalize(str(region.get("domain") or ""))
        if not region_id or not domain:
            continue
        region_map[str(region_id)] = domain
        if region.get("environmentDefault"):
            default_region = str(region_id)

    if not region_map:
        return 2

    by_name = {
        dataset.get("name"): dataset
        for dataset in datasets
        if isinstance(dataset, dict) and dataset.get("name")
    }
    names = quoted_datasets(args.apl, args.dataset.strip())

    chosen = None
    for name in names:
        dataset = by_name.get(name)
        if dataset is None:
            continue
        region = dataset.get("edgeDeployment")
        if not region or region_map.get(str(region)) is None:
            chosen = None
            break
        chosen = region_map[str(region)]
        break
    else:
        if any(name in RESERVED_DATASETS for name in names):
            counts: dict[str, int] = {}
            for dataset in datasets:
                if not isinstance(dataset, dict):
                    continue
                region = dataset.get("edgeDeployment")
                if region:
                    counts[str(region)] = counts.get(str(region), 0) + 1
            if counts:
                home = max(counts, key=counts.get)
                chosen = region_map.get(home)

    candidates: list[str] = []

    def add(url: str | None) -> None:
        normalized = normalize(url or "")
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    add(chosen)
    add(args.cached_base)
    if default_region:
        add(region_map.get(default_region))
    for domain in region_map.values():
        add(domain)

    if not candidates:
        return 2
    print("\n".join(candidates))
    return 0


if __name__ == "__main__":
    sys.exit(main())
