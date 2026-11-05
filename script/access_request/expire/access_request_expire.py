#!/usr/bin/env python3
"""Expire an approved (GRANTED) dataset / AI-model access request immediately,
directly in the control-plane database.

Usage:
    python access_request_expire.py                                  # uses access_request_expire_config.json
    python access_request_expire.py my_config.json
    python access_request_expire.py --request-id <uuid> [--request-id <uuid> ...]
    python access_request_expire.py --request-id <uuid> --dry-run
    python access_request_expire.py --request-id <uuid> --policy-id <uuid>   # pin the policy

How the control plane decides "expired" (dx-controlplane, dev branch,
org.cdpg.dx.common.util.ExpiredStatusHelper): EXPIRED is never stored. A row
keeps its live status (request GRANTED, policy ACTIVE) and is reported, listed
and enforced as expired once `expiry_at <= now`. So this script changes only
expiry columns and leaves every status alone:

    request        expiry_at  WHERE request_id = <id>
    policy         expiry_at  WHERE request_id = <id>   (fallback below)
    access_rule    expiry_at  WHERE policy_id IN (<policy ids>)
    subscriptions  expiryat   WHERE user_id = consumer AND entityid = item
                   — the scheduler deletes the RabbitMQ queue and the read
                     permission once this passes; without it a streaming
                     subscription keeps delivering data until its own expiry.

Every UPDATE only ever moves an expiry *earlier*: rows already expired (or
expiring before the target time) are left untouched. `updated_at` is set by
the tables' own triggers.

Requests approved before V67 have no `policy.request_id`. When
`policy_lookup.fallback_by_consumer_item` is on, the script then looks for the
one ACTIVE, unexpired policy for the same consumer + item; if it finds none or
several it stops and asks for `--policy-id`.

Each request is handled in its own transaction (rows locked FOR UPDATE).
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


LOG = logging.getLogger("access_request_expire")
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_NAME = "access_request_expire_config.json"

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
        # Request ids to expire; --request-id on the command line replaces this.
        "request_ids": [],
        # Optional: pin the policy instead of looking it up (single request only).
        "policy_id": "",
    },
    "expiry": {
        # "now" = the database clock (localtimestamp). The control plane's JVM
        # and the DB both run in UTC and expiry columns are naive UTC, so the
        # DB clock is the one the server compares against. Or an explicit
        # naive timestamp "YYYY-MM-DD HH:MM:SS" in that same (DB) time.
        "at": "now",
        # Added to the time above. Negative puts it slightly in the past.
        "offset_seconds": 0,
    },
    "checks": {
        # Only proceed when the request currently has one of these statuses.
        "require_request_status": ["GRANTED"],
        # Only these request.asset_type values; empty = any.
        "allowed_asset_types": ["adex:DataBank", "adex:AiModel"],
        # Only policies in these statuses are expired.
        "policy_statuses": ["ACTIVE"],
        # Stop if no policy is found for the request (otherwise only warn).
        "require_policy": True,
    },
    "policy_lookup": {
        # For requests without policy.request_id (approved before V67).
        "fallback_by_consumer_item": True,
    },
    "steps": {
        "request": True,
        "policy": True,
        "access_rule": True,
        "subscriptions": True,
    },
    "tables": {
        "request": "request",
        "policy": "policy",
        "access_rule": "access_rule",
        "subscriptions": "subscriptions",
    },
    "columns": {
        "request_id": "request_id",
        "request_status": "status",
        "request_expiry": "expiry_at",
        "request_consumer_id": "consumer_id",
        "request_item_id": "item_id",
        "request_asset_type": "asset_type",
        "request_asset_name": "asset_name",
        "request_consumer_email": "consumer_email_id",
        "policy_id": "_id",
        "policy_request_id": "request_id",
        "policy_status": "status",
        "policy_expiry": "expiry_at",
        "policy_consumer_id": "consumer_id",
        "policy_item_id": "item_id",
        "policy_type": "policy_type",
        "rule_id": "_id",
        "rule_policy_id": "policy_id",
        "rule_status": "status",
        "rule_expiry": "expiry_at",
        "sub_id": "id",
        "sub_queue": "queue_name",
        "sub_user_id": "user_id",
        "sub_entity_id": "entityid",
        "sub_expiry": "expiryat",
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
    if at.lower() == "now":
        cur.execute("SELECT localtimestamp AS ts, current_setting('TimeZone') AS tz")
        row = cur.fetchone()
        LOG.info("Database clock: %s (%s)", fmt(row["ts"]), row["tz"])
        return row["ts"] + offset
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(at, pattern) + offset
        except ValueError:
            continue
    raise ConfigError(f"'expiry.at' must be \"now\" or a naive timestamp, got {at!r}")


def derived(status: Any, expiry: Any, live: str, ts: datetime) -> str:
    """The status the control plane reports (ExpiredStatusHelper.effectiveStatus)."""
    if str(status).upper() == live and expiry is not None and expiry <= ts:
        return "EXPIRED"
    return str(status)


# --------------------------------------------------------------------- steps

def load_request(cur: Any, config: dict[str, Any], request_id: str, lock: bool) -> dict[str, Any]:
    c = lambda k: col(config, k)  # noqa: E731
    statement = sql.SQL(
        "SELECT {rid} AS request_id, {st}::text AS status, {exp} AS expiry_at, "
        "{cons} AS consumer_id, {item} AS item_id, {atype}::text AS asset_type, "
        "{aname} AS asset_name, {email} AS consumer_email "
        "FROM {t} WHERE {rid} = %s" + (" FOR UPDATE" if lock else "")
    ).format(
        rid=c("request_id"), st=c("request_status"), exp=c("request_expiry"),
        cons=c("request_consumer_id"), item=c("request_item_id"),
        atype=c("request_asset_type"), aname=c("request_asset_name"),
        email=c("request_consumer_email"), t=tbl(config, "request"),
    )
    rows = fetch_all(cur, statement, (request_id,))
    if not rows:
        raise DbError(f"request {request_id} not found")
    return rows[0]


def check_request(config: dict[str, Any], req: dict[str, Any]) -> None:
    checks = config["checks"]
    allowed_status = [s.upper() for s in checks.get("require_request_status") or []]
    if allowed_status and str(req["status"]).upper() not in allowed_status:
        raise DbError(
            f"request {req['request_id']} has status {req['status']}; "
            f"checks.require_request_status allows {allowed_status}"
        )
    allowed_types = checks.get("allowed_asset_types") or []
    if allowed_types and req["asset_type"] not in allowed_types:
        raise DbError(
            f"request {req['request_id']} is for asset_type {req['asset_type']}; "
            f"checks.allowed_asset_types allows {allowed_types}"
        )


def find_policies(cur: Any, config: dict[str, Any], req: dict[str, Any], pinned: str,
                  ts: datetime, lock: bool) -> list[dict[str, Any]]:
    c = lambda k: col(config, k)  # noqa: E731
    statuses = list(config["checks"].get("policy_statuses") or ["ACTIVE"])
    base = sql.SQL(
        "SELECT {pid} AS policy_id, {st}::text AS status, {exp} AS expiry_at, "
        "{prq} AS request_id, {ptype}::text AS policy_type FROM {t} WHERE "
    ).format(
        pid=c("policy_id"), st=c("policy_status"), exp=c("policy_expiry"),
        prq=c("policy_request_id"), ptype=c("policy_type"), t=tbl(config, "policy"),
    )
    lock_sql = sql.SQL(" FOR UPDATE" if lock else "")

    if pinned:
        rows = fetch_all(cur, base + sql.SQL("{pid} = %s").format(pid=c("policy_id")) + lock_sql,
                         (pinned,))
        if not rows:
            raise DbError(f"policy {pinned} (--policy-id) not found")
        return rows

    rows = fetch_all(
        cur,
        base + sql.SQL("{prq} = %s AND {st}::text = ANY(%s)").format(
            prq=c("policy_request_id"), st=c("policy_status")) + lock_sql,
        (req["request_id"], statuses),
    )
    if rows or not config["policy_lookup"].get("fallback_by_consumer_item"):
        return rows

    LOG.info("    no policy carries request_id %s; trying consumer + item fallback", req["request_id"])
    rows = fetch_all(
        cur,
        base + sql.SQL(
            "{cons} = %s AND {item} = %s AND {st}::text = ANY(%s) "
            "AND ({exp} IS NULL OR {exp} > %s)"
        ).format(cons=c("policy_consumer_id"), item=c("policy_item_id"),
                 st=c("policy_status"), exp=c("policy_expiry")) + lock_sql,
        (req["consumer_id"], req["item_id"], statuses, ts),
    )
    if len(rows) > 1:
        ids = ", ".join(str(r["policy_id"]) for r in rows)
        raise DbError(
            f"{len(rows)} live policies match consumer {req['consumer_id']} + item "
            f"{req['item_id']} ({ids}); rerun with --policy-id to pick one"
        )
    return rows


def run_update(cur: Any, statement: Any, params: Any, dry_run: bool, label: str) -> int:
    log_sql(cur, statement, params, "UPDATE (dry-run, not executed)" if dry_run else "UPDATE")
    if dry_run:
        return 0
    cur.execute(statement, params)
    LOG.info("    %s: %d row(s) updated", label, cur.rowcount)
    return cur.rowcount


def expire_one(conn: Any, config: dict[str, Any], request_id: str, pinned_policy: str,
               dry_run: bool) -> dict[str, Any]:
    steps = config["steps"]
    c = lambda k: col(config, k)  # noqa: E731
    lock = not dry_run
    summary: dict[str, Any] = {"request_id": request_id}

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        ts = resolve_expiry(cur, config)
        summary["expiry_at"] = fmt(ts)

        req = load_request(cur, config, request_id, lock)
        LOG.info("Request %s", request_id)
        for key in ("status", "expiry_at", "asset_type", "asset_name", "consumer_email",
                    "consumer_id", "item_id"):
            LOG.info("    %-15s %s", key, fmt(req[key]))
        LOG.info("    %-15s %s", "reported as", derived(req["status"], req["expiry_at"], "GRANTED", ts))
        check_request(config, req)

        policies = find_policies(cur, config, req, pinned_policy, ts, lock)
        policy_ids = [str(p["policy_id"]) for p in policies]
        for p in policies:
            LOG.info("    policy %s  status=%s type=%s expiry_at=%s", p["policy_id"], p["status"],
                     p["policy_type"], fmt(p["expiry_at"]))
        already_expired = derived(req["status"], req["expiry_at"], "GRANTED", ts) == "EXPIRED"
        if not policies:
            message = f"no {config['checks'].get('policy_statuses')} policy found for request {request_id}"
            if already_expired:
                LOG.info("    request is already expired and no live policy is left; nothing to do")
                conn.rollback()
                summary["result"] = "already-expired"
                return summary
            if config["checks"].get("require_policy", True):
                raise DbError(message + " (set checks.require_policy=false to expire the request alone)")
            LOG.warning("    %s; expiring the request only", message)

        counts: dict[str, int] = {}

        if steps.get("request", True):
            counts["request"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {rid} = %s AND ({exp} IS NULL OR {exp} > %s)"
            ).format(t=tbl(config, "request"), exp=c("request_expiry"), rid=c("request_id")),
                (ts, request_id, ts), dry_run, "request")

        if steps.get("policy", True) and policy_ids:
            counts["policy"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {pid}::text = ANY(%s) AND ({exp} IS NULL OR {exp} > %s)"
            ).format(t=tbl(config, "policy"), exp=c("policy_expiry"), pid=c("policy_id")),
                (ts, policy_ids, ts), dry_run, "policy")

        if steps.get("access_rule", True) and policy_ids:
            rules = fetch_all(cur, sql.SQL(
                "SELECT {id} AS id, {st}::text AS status, {exp} AS expiry_at FROM {t} "
                "WHERE {pid}::text = ANY(%s)"
            ).format(id=c("rule_id"), st=c("rule_status"), exp=c("rule_expiry"),
                     pid=c("rule_policy_id"), t=tbl(config, "access_rule")), (policy_ids,))
            LOG.info("    access_rule rows linked: %d", len(rules))
            counts["access_rule"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {pid}::text = ANY(%s) AND ({exp} IS NULL OR {exp} > %s)"
            ).format(t=tbl(config, "access_rule"), exp=c("rule_expiry"), pid=c("rule_policy_id")),
                (ts, policy_ids, ts), dry_run, "access_rule")

        if steps.get("subscriptions", True):
            subs = fetch_all(cur, sql.SQL(
                "SELECT {id} AS id, {q} AS queue_name, {exp} AS expiry_at FROM {t} "
                "WHERE {uid}::text = %s AND {eid}::text = %s"
            ).format(id=c("sub_id"), q=c("sub_queue"), exp=c("sub_expiry"), uid=c("sub_user_id"),
                     eid=c("sub_entity_id"), t=tbl(config, "subscriptions")),
                (str(req["consumer_id"]), str(req["item_id"])))
            for s in subs:
                LOG.info("    subscription %s queue=%s expiry=%s", s["id"], s["queue_name"],
                         fmt(s["expiry_at"]))
            counts["subscriptions"] = run_update(cur, sql.SQL(
                "UPDATE {t} SET {exp} = %s WHERE {uid}::text = %s AND {eid}::text = %s AND {exp} > %s"
            ).format(t=tbl(config, "subscriptions"), exp=c("sub_expiry"), uid=c("sub_user_id"),
                     eid=c("sub_entity_id")),
                (ts, str(req["consumer_id"]), str(req["item_id"]), ts), dry_run, "subscriptions")

        if dry_run:
            conn.rollback()
            summary["result"] = "dry-run"
            return summary

        conn.commit()

        after = load_request(cur, config, request_id, lock=False)
        LOG.info("    after: request expiry_at=%s, reported as %s", fmt(after["expiry_at"]),
                 derived(after["status"], after["expiry_at"], "GRANTED", ts))
        conn.rollback()
        summary.update(result="expired", updated=counts, policies=policy_ids)
        return summary


# ---------------------------------------------------------------------- main

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Expire a GRANTED dataset/model access request now (request, policy, "
                    "access_rule, subscriptions) in the control-plane database.")
    parser.add_argument("config", nargs="?", default=str(SCRIPT_DIR / DEFAULT_CONFIG_NAME),
                        help=f"config JSON (default: {DEFAULT_CONFIG_NAME} beside the script)")
    parser.add_argument("--request-id", action="append", default=[],
                        help="access request id; repeatable. Replaces target.request_ids")
    parser.add_argument("--policy-id", default="",
                        help="pin the policy to expire (only with a single request)")
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

        raw_ids = args.request_id or list(config["target"].get("request_ids") or [])
        if not raw_ids:
            raise ConfigError("no request id: pass --request-id or set target.request_ids")
        request_ids = [require_uuid(r, "request id") for r in raw_ids]
        pinned = args.policy_id or str(config["target"].get("policy_id") or "")
        if pinned:
            pinned = require_uuid(pinned, "policy id")
            if len(request_ids) != 1:
                raise ConfigError("--policy-id / target.policy_id needs exactly one request id")

        pg = config["postgres"]
        LOG.info("Target %s:%s/%s schema=%s%s", pg.get("host"), pg.get("port"), pg.get("database"),
                 pg.get("schema"), "  [DRY RUN]" if args.dry_run else "")
        conn = connect(config, read_only=args.dry_run)
    except (ConfigError, DbError) as exc:
        LOG.error("%s", exc)
        return 2

    results, failed = [], 0
    try:
        for request_id in request_ids:
            try:
                results.append(expire_one(conn, config, request_id, pinned, args.dry_run))
            except (DbError, psycopg2.Error) as exc:
                conn.rollback()
                failed += 1
                LOG.error("request %s: %s — nothing changed for it", request_id, exc)
                results.append({"request_id": request_id, "result": "failed", "error": str(exc)})
    finally:
        conn.close()

    LOG.info("Summary:\n%s", json.dumps(results, indent=2, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
