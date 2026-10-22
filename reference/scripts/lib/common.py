"""Shared helpers for site-ops scripts. Stdlib only (jsonschema optional)."""
from __future__ import annotations

import csv
import io
import json
import os
import sys
from datetime import datetime, date
from pathlib import Path

SCHEMA_VERSION = "1.0"
TOOLKIT = Path(__file__).resolve().parents[2]
SCHEMAS = TOOLKIT / "schemas"

# file path (relative to site repo) -> (schema name, format)
FILES = {
    "catalog/skus.jsonl": ("sku", "jsonl"),
    "catalog/categories.json": ("category", "jsonarray"),
    "catalog/pages.jsonl": ("page", "jsonl"),
    "inventory/latest.jsonl": ("inventory_latest", "jsonl"),
    "enrich/sku_media.csv": ("sku_media", "csv"),
    "enrich/sku_tags.csv": ("sku_tags", "csv"),
    "content/blog_index.jsonl": ("blog_post", "jsonl"),
    "content/keywords.jsonl": ("keyword", "jsonl"),
    "outreach/contacted.jsonl": ("outreach_contact", "jsonl"),
    "edm/index.jsonl": ("edm_campaign", "jsonl"),
    "logs/runs.jsonl": ("run_log", "jsonl"),
}
EVENTS_GLOB = "inventory/events/*.jsonl"
SUMMARY_FILE = "inventory/daily_summary.csv"
SUMMARY_COLS = ["date", "category", "total", "in_stock", "out_of_stock", "preorder", "unknown"]
STOCK_STATES = ["in_stock", "out_of_stock", "preorder", "unknown"]


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))


def field_order(schema_name: str) -> list[str]:
    return list(load_schema(schema_name)["properties"].keys())


def primary_key(schema_name: str) -> list[str]:
    return load_schema(schema_name).get("x-primary-key", [])


# ---------- JSON / JSONL ----------
def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{n}: invalid JSON: {e}") from e
    return rows


def _ordered(row: dict, order: list[str] | None) -> dict:
    if not order:
        return row
    out = {k: row.get(k) for k in order if k in row}
    for k, v in row.items():  # keep unknown keys at the end, never drop data
        if k not in out:
            out[k] = v
    return out


def sort_key(pk: list[str]):
    return lambda r: tuple("" if r.get(k) is None else str(r.get(k)) for k in pk)


def write_jsonl(path: Path, rows: list[dict], schema_name: str | None = None, pk: list[str] | None = None) -> None:
    order = field_order(schema_name) if schema_name else None
    pk = pk if pk is not None else (primary_key(schema_name) if schema_name else [])
    if pk:
        rows = sorted(rows, key=sort_key(pk))
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    for r in rows:
        buf.write(json.dumps(_ordered(r, order), ensure_ascii=False, separators=(",", ":")) + "\n")
    path.write_text(buf.getvalue(), encoding="utf-8", newline="\n")


# ---------- CSV ----------
def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [{k: (v if v != "" else None) for k, v in r.items()} for r in csv.DictReader(f)]


def write_csv(path: Path, rows: list[dict], cols: list[str], pk: list[str]) -> None:
    rows = sorted(rows, key=sort_key(pk))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})


def coerce_csv_row(row: dict, schema_name: str) -> dict:
    """CSV values are strings; cast ints per schema so jsonschema can validate."""
    props = load_schema(schema_name)["properties"]
    out = {}
    for k, v in row.items():
        t = props.get(k, {}).get("type")
        types = t if isinstance(t, list) else [t]
        if v is not None and "integer" in types:
            try:
                v = int(v)
            except ValueError:
                pass
        out[k] = v
    return out


# ---------- site ----------
def site_dir(arg: str) -> Path:
    p = Path(arg).resolve()
    if not (p / "site.json").exists():
        sys.exit(f"ERROR: {p} 不是站点仓库（缺少 site.json）")
    return p


def load_site(sd: Path) -> dict:
    return read_json(sd / "site.json")


def site_today(site: dict) -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(site.get("timezone", "UTC"))).date().isoformat()
    except Exception:
        return date.today().isoformat()


def now_iso(site: dict) -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(site.get("timezone", "UTC"))).isoformat(timespec="seconds")
    except Exception:
        return datetime.now().astimezone().isoformat(timespec="seconds")


def append_run_log(sd: Path, entry: dict) -> None:
    path = sd / "logs/runs.jsonl"
    rows = read_jsonl(path)
    rows = [r for r in rows if r.get("run_id") != entry["run_id"]] + [entry]
    write_jsonl(path, rows, "run_log")


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")
