#!/usr/bin/env python3
"""Expire an active delegation immediately, directly in the control-plane
database.

Usage:
    python delegation_expire.py                                     # uses delegation_expire_config.json
    python delegation_expire.py my_config.json
    python delegation_expire.py --delegation-id <uuid> [--delegation-id <uuid> ...]
    python delegation_expire.py --delegation-id <uuid> --dry-run
    python delegation_expire.py --delegation-id <uuid> --at "2026-11-27 00:00:00"

How the control plane decides "expired" (dx-controlplane, dev branch,
org.cdpg.dx.aaa.delegation.models.DelegationGrant#effectiveStatus): the
stored status is never moved from 'active' to 'expired'. An active grant whose
`expiry_at` has passed is reported, listed and enforced as expired. So this
script changes only expiry columns and leaves the status alone:

    delegation_grants             expiry_at  WHERE delegation_id = <id>
    delegation_scope_constraints  expiry_at  WHERE delegation_id = <id>

Both are needed: findActiveDelegationWithScopes requires grant AND constraint
expiry to be in the future, DelegationAccessEvaluator and
DelegationResolverImpl check the grant's expiry.

Writing status = 'expired' instead would be wrong: the list API rewrites a
status filter of 'expired' to "active AND expiry_at <= now", so a row stored as
'expired' would drop out of both the active and the expired lists.

Every UPDATE only ever moves an expiry *earlier*: rows already expired (or
expiring before the target time) are left untouched. The tables have no
triggers and no updated_at column.

`delegation_grants` has a unique index on (delegator_id, delegate_id,
justification, expiry_at) WHERE status = 'active'. If another active grant
of the same delegator/delegate/justification already sits at exactly the
target time (e.g. expired by this script earlier), the target is moved back by
one microsecond at a time until it is free.

Each delegation is handled in its own transaction (rows locked FOR UPDATE).
`--dry-run` opens a read-only session, runs the SELECTs and prints the
UPDATEs it would run. Values in the config may reference the environment as
${VAR} or ${VAR:-fallback}.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2 import sql
except ModuleNotFoundError:  # Allows --help and config validation before install.
    psycopg2 = None  # type: ignore[assignment]
    sql = None  # type: ignore[assignment]


LOG = logging.getLogger("delegation_expire")
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_NAME = "delegation_expire_config.json"
LIVE_STATUS = "active"

DEFAULT_CONFIG: dict[str, Any] = {
    # The control plane's database (dx-controlplane flyway target).
    "postgres": {
        "host": "",
        "port": 5432,
        "database": "iudx_v2_auth",
        "schema": "aaa",
        "user": "",
        "password": "",
        "sslmode": "require",
        "connect_timeout_seconds": 10,
    },
    "target": {
        # Delegation ids to expire; --delegation-id on the command line replaces this.
        "delegation_ids": [],
    },
    "expiry": {
        # "now" = the database clock (localtimestamp, UTC on the control plane).
        # Or an explicit naive timestamp "YYYY-MM-DD HH:MM:SS" in that same time.
        "at": "now",
        # Added to the time above. Negative puts it slightly in the past.
        "offset_seconds": 0,
    },
    "checks": {
        # Only proceed when the grant currently has one of these stored statuses.
        "require_grant_status": ["active"],
        # Stop if the grant has no scope constraints (otherwise only warn).
        "require_constraints": False,
        # Refuse an expiry.at later than the database clock (it would not expire now).
        "refuse_future_expiry": True,
        # Max microseconds stepped back to dodge the active-unique index.
        "max_unique_steps": 1000,
    },
    "steps": {
        "grant": True,
        "scope_constraints": True,
    },
    "tables": {
        "grant": "delegation_grants",
        "constraint": "delegation_scope_constraints",
        "update_request": "delegation_update_requests",
    },
    "columns": {
        "grant_id": "delegation_id",
        "grant_delegator": "delegator_id",
        "grant_delegate": "delegate_id",
        "grant_justification": "justification",
        "grant_status": "status",
        "grant_expiry": "expiry_at",
        "grant_created": "created_at",
        "constraint_id": "id",
        "constraint_delegation_id": "delegation_id",
        "constraint_role": "role",
        "constraint_scope": "scope",
        "constraint_entity_id": "entity_id",
        "constraint_entity_type": "entity_type",
        "constraint_expiry": "expiry_at",
        "ureq_id": "request_id",
        "ureq_delegation_id": "delegation_id",
        "ureq_status": "status",
        "ureq_requested_expiry": "requested_expiry",
    },
    "logging": {
        "level": "INFO",
        "print_sql": True,
    },
}


class ConfigError(ValueError):
    """A required configuration value is absent or invalid."""


class DbError(RuntimeError):
    """The database refused, or holds something other than expected."""


# --------------------------------------------------------------------- config

_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def expand_env(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: expand_env(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_env(item) for item in value]
    if isinstance(value, str):
        return _ENV_REF.sub(
            lambda m: os.environ.get(m.group(1), m.group(2) if m.group(2) is not None else ""),
            value,
        )
    return value


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ConfigError(f"config file not found: {path} (copy the .json.example beside it)")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return deep_merge(DEFAULT_CONFIG, expand_env(raw))


def require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"'{field_name}' must be a non-empty string")
    return value.strip()


def require_uuid(value: Any, field_name: str) -> str:
    text = require_string(value, field_name)
    try:
        return str(uuid.UUID(text))
    except ValueError as exc:
        raise ConfigError(f"'{field_name}' is not a UUID: {text!r}") from exc


def ident(config: dict[str, Any], section: str, key: str) -> Any:
    return sql.Identifier(require_string(config[section].get(key), f"{section}.{key}"))


def tbl(config: dict[str, Any], key: str) -> Any:
    return ident(config, "tables", key)


def col(config: dict[str, Any], key: str) -> Any:
    return ident(config, "columns", key)


# ------------------------------------------------------------------- output

PRINT_SQL = {"on": True}


def log_sql(cursor: Any, statement: Any, params: Any, prefix: str = "SQL") -> None:
    if not PRINT_SQL["on"]:
        return
    try:
        text = " ".join(cursor.mogrify(statement, params).decode().split())
    except Exception:
        text = str(statement)
    LOG.info("    %s: %s", prefix, text)


def fmt(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return "" if value is None else str(value)


# ------------------------------------------------------------------ database

def connect(config: dict[str, Any], read_only: bool) -> Any:
    if psycopg2 is None:
        raise ConfigError(
            "missing Python dependency 'psycopg2'; run 'python -m pip install -r ../requirements.txt'"
        )
    pg = config["postgres"]
    options = []
    schema = (pg.get("schema") or "").strip()
    if schema:
        options.append(f"-c search_path={schema}")
    if read_only:
        options.append("-c default_transaction_read_only=on")
    try:
        conn = psycopg2.connect(
            host=require_string(pg.get("host"), "postgres.host"),
            port=int(pg.get("port") or 5432),
            dbname=require_string(pg.get("database"), "postgres.database"),
            user=require_string(pg.get("user"), "postgres.user"),
            password=pg.get("password") or None,
            sslmode=pg.get("sslmode") or "prefer",
            connect_timeout=int(pg.get("connect_timeout_seconds") or 10),
            options=" ".join(options) or None,
        )
    except psycopg2.Error as exc:
        raise DbError(f"cannot connect to {pg.get('host')}/{pg.get('database')}: {exc}") from exc
    conn.autocommit = False
    return conn


def fetch_all(cur: Any, statement: Any, params: Any) -> list[dict[str, Any]]:
    log_sql(cur, statement, params, "SELECT")
    cur.execute(statement, params)
    return [dict(row) for row in cur.fetchall()]


def resolve_expiry(cur: Any, config: dict[str, Any]) -> datetime:
    settings = config["expiry"]
    at = str(settings.get("at") or "now").strip()
    offset = timedelta(seconds=float(settings.get("offset_seconds") or 0))
    cur.execute("SELECT localtimestamp AS ts, current_setting('TimeZone') AS tz")
    row = cur.fetchone()
    db_now = row["ts"]
    LOG.info("Database clock: %s (%s)", fmt(db_now), row["tz"])
    if at.lower() == "now":
        ts = db_now + offset
    else:
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M",
                        "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
            try:
                ts = datetime.strptime(at, pattern) + offset
                break
            except ValueError:
                continue
        else:
            raise ConfigError(f"'expiry.at' must be \"now\" or a naive timestamp, got {at!r}")
    if ts > db_now and config["checks"].get("refuse_future_expiry", True):
        raise ConfigError(
            f"expiry {fmt(ts)} is after the database clock {fmt(db_now)}; the delegation would "
            "stay active until then (set checks.refuse_future_expiry=false to allow)")
    return ts


def derived(status: Any, expiry: Any, ts: datetime) -> str:
    """The status the control plane reports (DelegationGrant.effectiveStatus)."""
    if str(status).lower() == LIVE_STATUS and expiry is not None and expiry <= ts:
        return "expired"
    return str(status)


# --------------------------------------------------------------------- steps

def load_grant(cur: Any, config: dict[str, Any], delegation_id: str, lock: bool) -> dict[str, Any]:
    c = lambda k: col(config, k)  # noqa: E731
    statement = sql.SQL(
        "SELECT {id} AS delegation_id, {dor} AS delegator_id, {dee} AS delegate_id, "
        "{just} AS justification, {st}::text AS status, {exp} AS expiry_at, "
        "{cr} AS created_at FROM {t} WHERE {id} = %s" + (" FOR UPDATE" if lock else "")
    ).format(
        id=c("grant_id"), dor=c("grant_delegator"), dee=c("grant_delegate"),
        just=c("grant_justification"), st=c("grant_status"), exp=c("grant_expiry"),
        cr=c("grant_created"), t=tbl(config, "grant"),
    )
    rows = fetch_all(cur, statement, (delegation_id,))
    if not rows:
        raise DbError(f"delegation {delegation_id} not found in {config['tables']['grant']}")
    return rows[0]


def load_constraints(cur: Any, config: dict[str, Any], delegation_id: str,
                     lock: bool) -> list[dict[str, Any]]:
    c = lambda k: col(config, k)  # noqa: E731
    statement = sql.SQL(
        "SELECT {id} AS id, {role}::text AS role, {scope} AS scope, {eid} AS entity_id, "
        "{etype}::text AS entity_type, {exp} AS expiry_at FROM {t} WHERE {did} = %s "
        "ORDER BY {role}, {scope}" + (" FOR UPDATE" if lock else "")
    ).format(
        id=c("constraint_id"), role=c("constraint_role"), scope=c("constraint_scope"),
        eid=c("constraint_entity_id"), etype=c("constraint_entity_type"),
        exp=c("constraint_expiry"), did=c("constraint_delegation_id"),
        t=tbl(config, "constraint"),
    )
    return fetch_all(cur, statement, (delegation_id,))


def pending_update_requests(cur: Any, config: dict[str, Any], delegation_id: str) -> list[dict[str, Any]]:
    c = lambda k: col(config, k)  # noqa: E731
    statement = sql.SQL(
        "SELECT {id} AS request_id, {rexp} AS requested_expiry FROM {t} "
        "WHERE {did} = %s AND {st}::text = 'pending'"
    ).format(id=c("ureq_id"), rexp=c("ureq_requested_expiry"), did=c("ureq_delegation_id"),
             st=c("ureq_status"), t=tbl(config, "update_request"))
    return fetch_all(cur, statement, (delegation_id,))


def free_expiry(cur: Any, config: dict[str, Any], grant: dict[str, Any], ts: datetime) -> datetime:
    """Step ts back until no other active grant of the same delegator/delegate/
    justification sits at exactly that expiry (delegation_grants_active_unique_idx)."""
    c = lambda k: col(config, k)  # noqa: E731
    statement = sql.SQL(
        "SELECT 1 FROM {t} WHERE {dor} = %s AND {dee} = %s AND {just} = %s AND {exp} = %s "
        "AND {st}::text = %s AND {id} <> %s"
    ).format(t=tbl(config, "grant"), dor=c("grant_delegator"), dee=c("grant_delegate"),
             just=c("grant_justification"), exp=c("grant_expiry"), st=c("grant_status"),
             id=c("grant_id"))
    steps = int(config["checks"].get("max_unique_steps") or 1000)
    candidate = ts
    for _ in range(steps):
        cur.execute(statement, (grant["delegator_id"], grant["delegate_id"],
                                grant["justification"], candidate, LIVE_STATUS,
                                grant["delegation_id"]))
        if cur.fetchone() is None:
            if candidate != ts:
                LOG.info("    another active grant already expires at %s; using %s",
                         fmt(ts), fmt(candidate))
            return candidate
        candidate -= timedelta(microseconds=1)
    raise DbError(f"no free expiry within {steps} µs before {fmt(ts)} (active unique index)")


def run_update(cur: Any, statement: Any, params: Any, dry_run: bool, label: str) -> int:
    log_sql(cur, statement, params, "UPDATE (dry-run, not executed)" if dry_run else "UPDATE")
    if dry_run:
        return 0
    cur.execute(statement, params)
    LOG.info("    %s: %d row(s) updated", label, cur.rowcount)
    return cur.rowcount


def expire_one(conn: Any, config: dict[str, Any], delegation_id: str, dry_run: bool) -> dict[str, Any]:
    steps, checks = config["steps"], config["checks"]
    c = lambda k: col(config, k)  # noqa: E731
    lock = not dry_run
    summary: dict[str, Any] = {"delegation_id": delegation_id}

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        ts = resolve_expiry(cur, config)

        grant = load_grant(cur, config, delegation_id, lock)
        LOG.info("Delegation %s", delegation_id)
        for key in ("status", "expiry_at", "delegator_id", "delegate_id", "justification",
                    "created_at"):
            LOG.info("    %-14s %s", key, fmt(grant[key]))
        LOG.info("    %-14s %s", "reported as", derived(grant["status"], grant["expiry_at"], ts))

        allowed = [s.lower() for s in checks.get("require_grant_status") or []]
        if allowed and str(grant["status"]).lower() not in allowed:
            raise DbError(f"delegation {delegation_id} has status {grant['status']}; "
                          f"checks.require_grant_status allows {allowed}")

        constraints = load_constraints(cur, config, delegation_id, lock)
        for k in constraints:
            LOG.info("    constraint %s  role=%s scope=%s entity=%s (%s) expiry_at=%s", k["id"],
                     k["role"], k["scope"], k["entity_id"], k["entity_type"], fmt(k["expiry_at"]))
        if not constraints:
            if checks.get("require_constraints"):
                raise DbError(f"delegation {delegation_id} has no scope constraints "
                              "(checks.require_constraints is on)")
            LOG.warning("    no scope constraints; expiring the grant only")

        grant_live = grant["expiry_at"] is None or grant["expiry_at"] > ts
        live_constraints = [k for k in constraints if k["expiry_at"] is None or k["expiry_at"] > ts]
        if not grant_live and not live_constraints:
            LOG.info("    grant and all constraints already expire at or before %s; nothing to do",
                     fmt(ts))
            conn.rollback()
            summary.update(result="already-expired", expiry_at=fmt(grant["expiry_at"]))
            return summary

        for r in pending_update_requests(cur, config, delegation_id):
            LOG.warning("    pending update request %s asks for expiry %s; it is left as it is",
                        r["request_id"], fmt(r["requested_expiry"]))

        if grant_live and steps.get("grant", True):
            ts = free_expiry(cur, config, grant, ts)
        summary["expiry_at"] = fmt(ts)
        counts: dict[str, int] = {}

        if steps.get("grant", True):
            counts["grant"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {id} = %s AND ({exp} IS NULL OR {exp} > %s)"
            ).format(t=tbl(config, "grant"), exp=c("grant_expiry"), id=c("grant_id")),
                (ts, delegation_id, ts), dry_run, "delegation_grants")

        if steps.get("scope_constraints", True) and constraints:
            counts["scope_constraints"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {did} = %s AND ({exp} IS NULL OR {exp} > %s)"
            ).format(t=tbl(config, "constraint"), exp=c("constraint_expiry"),
                     did=c("constraint_delegation_id")),
                (ts, delegation_id, ts), dry_run, "delegation_scope_constraints")

        if dry_run:
            conn.rollback()
            summary["result"] = "dry-run"
            return summary

        conn.commit()

        after = load_grant(cur, config, delegation_id, lock=False)
        left = [k for k in load_constraints(cur, config, delegation_id, lock=False)
                if k["expiry_at"] > ts]
        LOG.info("    after: grant expiry_at=%s, reported as %s; constraints still live: %d",
                 fmt(after["expiry_at"]), derived(after["status"], after["expiry_at"], ts), len(left))
        conn.rollback()
        summary.update(result="expired", updated=counts)
        return summary


# ---------------------------------------------------------------------- main

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Expire an active delegation now (delegation_grants and "
                    "delegation_scope_constraints) in the control-plane database.")
    parser.add_argument("config", nargs="?", default=str(SCRIPT_DIR / DEFAULT_CONFIG_NAME),
                        help=f"config JSON (default: {DEFAULT_CONFIG_NAME} beside the script)")
    parser.add_argument("--delegation-id", action="append", default=[],
                        help="delegation id; repeatable. Replaces target.delegation_ids")
    parser.add_argument("--at", default=None,
                        help='override expiry.at: "now" or "YYYY-MM-DD HH:MM:SS" (DB time, UTC)')
    parser.add_argument("--dry-run", action="store_true",
                        help="read-only session: run the SELECTs, print the UPDATEs, change nothing")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    try:
        config = load_config(Path(args.config))
        LOG.setLevel(str(config["logging"].get("level") or "INFO").upper())
        PRINT_SQL["on"] = bool(config["logging"].get("print_sql", True))
        if args.at is not None:
            config["expiry"]["at"] = args.at

        raw_ids = args.delegation_id or list(config["target"].get("delegation_ids") or [])
        if not raw_ids:
            raise ConfigError("no delegation id: pass --delegation-id or set target.delegation_ids")
        delegation_ids = list(dict.fromkeys(require_uuid(d, "delegation id") for d in raw_ids))

        pg = config["postgres"]
        LOG.info("Target %s:%s/%s schema=%s%s", pg.get("host"), pg.get("port"), pg.get("database"),
                 pg.get("schema"), "  [DRY RUN]" if args.dry_run else "")
        conn = connect(config, read_only=args.dry_run)
    except (ConfigError, DbError) as exc:
        LOG.error("%s", exc)
        return 2

    results, failed = [], 0
    try:
        for delegation_id in delegation_ids:
            try:
                results.append(expire_one(conn, config, delegation_id, args.dry_run))
            except ConfigError as exc:
                conn.rollback()
                LOG.error("%s", exc)
                return 2
            except (DbError, psycopg2.Error) as exc:
                conn.rollback()
                failed += 1
                message = str(exc).strip()
                if delegation_id not in message:
                    message = f"delegation {delegation_id}: {message}"
                LOG.error("%s — nothing changed for it", message)
                results.append({"delegation_id": delegation_id, "result": "failed", "error": str(exc)})
    finally:
        conn.close()

    LOG.info("Summary:\n%s", json.dumps(results, indent=2, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
