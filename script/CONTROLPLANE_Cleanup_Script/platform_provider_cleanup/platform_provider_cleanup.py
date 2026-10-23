#!/usr/bin/env python3
"""Roll one account's platform provider request back, so it can be made again.

Usage:
    python platform_provider_cleanup.py                    # platform_provider_cleanup_config.json beside this script
    python platform_provider_cleanup.py my_config.json
    python platform_provider_cleanup.py --username someone@example.invalid
    python platform_provider_cleanup.py --inventory-only   # read everything, change nothing
    python platform_provider_cleanup.py --dry-run          # DB delete runs and rolls back: real counts

The Platform Provider Requests API (`/iudx/v2/auth/user/platform/provider-requests`
and `/iudx/v2/auth/admin/platform/provider-requests/{id}`) has no way back from
an approval:

    what                         endpoint                                              actor
    ----                         --------                                              -----
    submit                       POST   /auth/user/platform/provider-requests          consumer
    own request (pending only)   GET    /auth/user/platform/provider-requests          consumer
    withdraw (pending only)      DELETE /auth/user/platform/provider-requests          consumer
    list (any status)            GET    /auth/admin/platform/provider-requests         cos_admin
    approve / reject             PATCH  /auth/admin/platform/provider-requests/{id}    cos_admin

The DELETE answers 400 "Only pending platform provider role requests can be
deleted" once the request is granted or rejected, and the PATCH refuses
anything that is not pending, so a granted request cannot be put back either.
The submit (ProviderRoleServiceImpl.createProviderRequest in dx-controlplane)
answers 409 "A pending or granted provider role request already exists for this
user" whenever `provider_requests` holds a pending or granted row for the user
— of *either* provider_type, org or platform. So after one approved run, every
rerun of the collection with the same account fails at the submit.

What the approval wrote, and how this script takes it back:

    provider_requests row (provider_type=platform)   DELETE ... WHERE id AND user_id   postgres
    the `provider` realm role                         DELETE role-mappings/realm        Keycloak Admin API

That is all of it: the approval updates the row's status and adds the realm
role (KeycloakUserService.addRoleToUser), nothing references provider_requests,
and the emails and audit rows are logs, not state. KYC is left as it is, since
the submit needs it again on the rerun.

The role is only revoked when nothing else still grants it: no pending/granted
provider_requests row of any type is left, and the account has no
organization_users row (an org provider or org admin gets the same role from
its organisation).

Exit codes:
    0  rolled back — a rerun's submit will not answer 409
    1  a step failed, or a row that would cause the 409 is still there
    2  configuration error
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    import requests
except ModuleNotFoundError:  # allows --help before install
    requests = None  # type: ignore[assignment]

try:
    import psycopg2
except ModuleNotFoundError:  # only the database route needs it
    psycopg2 = None  # type: ignore[assignment]

LOG = logging.getLogger("platform_provider_cleanup")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2

# The statuses createProviderRequest treats as "already exists" — the 409.
BLOCKING_STATUSES = ("pending", "granted")

DEFAULT_CONFIG: dict[str, Any] = {
    "control_plane": {
        "base_url": "",
        "timeout_seconds": 30,
        "verify_tls": True,
    },
    "keycloak": {
        "url": "",
        "realm": "",
        "user_client_id": "postman-client",
        "user_client_secret": "",
        # The username -> user_id lookup and the role revoke.
        "admin_client_id": "",
        "admin_client_secret": "",
        "timeout_seconds": 30,
        "verify_tls": True,
    },
    # The account that raised the platform provider request. Only the
    # username or the user id is needed; a password or token adds the
    # account's own view of its request to the read-back, and lets a pending
    # request be withdrawn through the API when there is no database.
    "target": {
        "username": "",
        "user_id": "",
        "password": "",
        "token": "",
    },
    # Optional: the API view of the request, any status, and the read-back
    # Postman's own listing would see.
    "actors": {
        "cos_admin": {"username": "", "password": "", "token": ""},
    },
    "clean": {
        # Delete the account's provider_requests rows directly — what the
        # withdraw endpoint does, for a granted or rejected row too. Needs the
        # `postgres` block; with it empty only a pending request can go.
        "requests_via_database": True,
        # The 409 counts org rows as well. They belong to an organisation's
        # provider flow, so they are only reported unless this is on.
        "include_org_requests": False,
        # Keycloak: take the `provider` realm role back off the account, unless
        # an org request or membership still grants it.
        "revoke_provider_role": True,
        "provider_role_name": "provider",
        # Revoke even while an org request or membership is left. Off: that
        # would strip a real org provider.
        "revoke_even_if_org_provider": False,
        "list_page_size": 50,
        "list_max_pages": 20,
        # Read everything back once the deletes are done.
        "verify": True,
    },
    "postgres": {
        "host": "",
        "port": 5432,
        "database": "",
        "schema": "aaa",
        "user": "",
        "password": "",
        "sslmode": "prefer",
        "connect_timeout_seconds": 10,
    },
    "endpoints": {
        "kc_token": "/realms/{realm}/protocol/openid-connect/token",
        "kc_users": "/admin/realms/{realm}/users",
        "kc_realm_role": "/admin/realms/{realm}/roles/{role}",
        "kc_role_mappings": "/admin/realms/{realm}/users/{user_id}/role-mappings/realm",
        "cp_user_info": "/iudx/v2/auth/user",
        "cp_own_platform_request": "/iudx/v2/auth/user/platform/provider-requests",
        "cp_admin_platform_requests": "/iudx/v2/auth/admin/platform/provider-requests",
    },
    "logging": {
        "level": "INFO",
        "print_responses": False,
        "response_preview_chars": 1000,
    },
}


class ConfigError(ValueError):
    """A required configuration value is absent or invalid."""


class ApiError(RuntimeError):
    """Keycloak or ControlPlane rejected a request."""


# --------------------------------------------------------------------- config

_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def expand_env(value: Any) -> Any:
    """Resolve ${VAR} / ${VAR:-fallback} anywhere in the config tree."""
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
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return deep_merge(DEFAULT_CONFIG, expand_env(raw))


def require(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{name} is required")
    return value.strip()


def endpoint(config: dict[str, Any], name: str, **fields: str) -> str:
    template = config["endpoints"].get(name)
    if not isinstance(template, str) or not template:
        raise ConfigError(f"'endpoints.{name}' must be a non-empty string")
    return template.format(**fields)


# ----------------------------------------------------------------------- http

class Http:
    """One host, JSON in and JSON out, with the status handed back."""

    def __init__(self, base_url: str, timeout: float, verify_tls: bool, log_conf: dict[str, Any]):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.verify = verify_tls
        self.log_conf = log_conf

    def request(self, method: str, path: str, label: str, token: str = "",
                json_body: Any = None, params: dict[str, Any] | None = None,
                form: dict[str, str] | None = None,
                expect: tuple[int, ...] = (200,)) -> tuple[int, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        LOG.debug("%s: %s %s %s", label, method, url, json_body or params or "")
        try:
            response = self.session.request(
                method, url, json=json_body, data=form, params=params,
                headers=headers, timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise ApiError(f"{label}: {method} {url} failed: {exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
        if self.log_conf.get("print_responses"):
            text = payload if isinstance(payload, str) else json.dumps(payload)
            LOG.info("%s -> %s %s", label, response.status_code,
                     text[: int(self.log_conf.get("response_preview_chars") or 1000)])
        if response.status_code not in expect:
            text = payload if isinstance(payload, str) else json.dumps(payload)
            raise ApiError(
                f"{label}: {method} {url} returned {response.status_code}, "
                f"expected {' or '.join(str(code) for code in expect)}: {text[:400]}"
            )
        return response.status_code, payload


def detail_of(payload: Any) -> str:
    if isinstance(payload, dict):
        return str(payload.get("detail") or payload.get("title") or "")
    return str(payload or "")


def result_of(payload: Any) -> Any:
    return payload.get("result") if isinstance(payload, dict) else None


# ------------------------------------------------------------------- keycloak

class Keycloak:
    """Token grants, plus the Admin API calls for the lookup and the revoke."""

    def __init__(self, config: dict[str, Any]):
        block = config["keycloak"]
        self.config = config
        self.realm = str(block.get("realm") or "")
        self.user_client_id = str(block.get("user_client_id") or "")
        self.user_client_secret = str(block.get("user_client_secret") or "")
        self.admin_client_id = str(block.get("admin_client_id") or "")
        self.admin_client_secret = str(block.get("admin_client_secret") or "")
        self.http = (
            Http(str(block.get("url") or ""), float(block.get("timeout_seconds") or 30),
                 bool(block.get("verify_tls", True)), config["logging"])
            if block.get("url") else None
        )
        self._admin_token = ""

    @property
    def available(self) -> bool:
        return self.http is not None and bool(self.realm)

    @property
    def admin_available(self) -> bool:
        return self.available and bool(self.admin_client_id)

    def path(self, name: str, **fields: str) -> str:
        return endpoint(self.config, name, realm=self.realm, **fields)

    def user_token(self, username: str, password: str) -> str:
        if not self.available:
            raise ConfigError("keycloak.url and keycloak.realm are needed to sign in")
        form = {
            "grant_type": "password",
            "client_id": self.user_client_id,
            "username": username,
            "password": password,
        }
        if self.user_client_secret:
            form["client_secret"] = self.user_client_secret
        _, payload = self.http.request(  # type: ignore[union-attr]
            "POST", self.path("kc_token"), f"token for {username}", form=form,
        )
        return payload["access_token"]

    def admin_token(self) -> str:
        if not self.admin_available:
            raise ConfigError(
                "keycloak.admin_client_id / admin_client_secret are needed for this step"
            )
        if self._admin_token:
            return self._admin_token
        _, payload = self.http.request(  # type: ignore[union-attr]
            "POST", self.path("kc_token"), "keycloak admin token",
            form={
                "grant_type": "client_credentials",
                "client_id": self.admin_client_id,
                "client_secret": self.admin_client_secret,
            },
        )
        self._admin_token = payload["access_token"]
        return self._admin_token

    def admin(self, method: str, path: str, label: str, json_body: Any = None,
              params: dict[str, Any] | None = None,
              expect: tuple[int, ...] = (200,)) -> tuple[int, Any]:
        return self.http.request(  # type: ignore[union-attr]
            method, path, label, token=self.admin_token(),
            json_body=json_body, params=params, expect=expect,
        )

    def find_user(self, username: str) -> dict[str, Any] | None:
        _, matches = self.admin(
            "GET", self.path("kc_users"), f"find user {username}",
            params={"username": username, "exact": "true"},
        )
        return matches[0] if isinstance(matches, list) and matches else None

    def realm_roles(self, user_id: str) -> list[str]:
        _, mapped = self.admin(
            "GET", self.path("kc_role_mappings", user_id=user_id), "read realm roles"
        )
        return sorted(role["name"] for role in mapped) if isinstance(mapped, list) else []

    def remove_realm_role(self, user_id: str, role_name: str) -> None:
        _, role = self.admin(
            "GET", self.path("kc_realm_role", role=role_name), f"read role {role_name}"
        )
        self.admin(
            "DELETE", self.path("kc_role_mappings", user_id=user_id),
            f"revoke {role_name}", json_body=[{"id": role["id"], "name": role["name"]}],
            expect=(204,),
        )


# --------------------------------------------------------------------- state

class Run:
    """What the run found, what it changed, and what it could not reach."""

    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.done: list[str] = []
        self.leftovers: list[str] = []
        self.problems: list[str] = []

    def did(self, message: str) -> None:
        self.done.append(message)
        LOG.info("%s%s", "DRY RUN — would " if self.dry_run else "", message)

    def left(self, message: str) -> None:
        self.leftovers.append(message)
        LOG.warning("Left behind: %s", message)

    def failed(self, message: str) -> None:
        self.problems.append(message)
        LOG.error("%s", message)


# ------------------------------------------------------------------ database

def database_ready(config: dict[str, Any]) -> bool:
    """True when the `postgres` block is filled in and psycopg2 is installed."""
    pg = config["postgres"]
    return psycopg2 is not None and all(
        str(pg.get(key) or "").strip() for key in ("host", "database", "user", "password")
    )


def pg_schema(config: dict[str, Any]) -> str:
    schema = str(config["postgres"].get("schema") or "aaa")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ConfigError(f"postgres.schema {schema!r} is not a plain identifier")
    return schema


def pg_connect(config: dict[str, Any]):
    pg = config["postgres"]
    return psycopg2.connect(
        host=pg["host"], port=int(pg.get("port") or 5432), dbname=pg["database"],
        user=pg["user"], password=pg["password"], sslmode=pg.get("sslmode") or "prefer",
        connect_timeout=int(pg.get("connect_timeout_seconds") or 10),
    )


def db_state(config: dict[str, Any], user_id: str) -> tuple[list[dict[str, Any]], int]:
    """The account's provider_requests rows, and how many organization_users rows it has."""
    schema = pg_schema(config)
    connection = pg_connect(config)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"SELECT id, provider_type, status, organization_id, created_at "
                f"FROM {schema}.provider_requests WHERE user_id = %s ORDER BY created_at",
                (user_id,),
            )
            rows = [
                {"id": str(row[0]), "provider_type": row[1], "status": row[2],
                 "organization_id": str(row[3]) if row[3] else "", "created_at": str(row[4])}
                for row in cursor.fetchall()
            ]
            cursor.execute(
                f"SELECT count(*) FROM {schema}.organization_users WHERE user_id = %s",
                (user_id,),
            )
            memberships = int(cursor.fetchone()[0])
    finally:
        connection.close()
    return rows, memberships


def db_delete_requests(config: dict[str, Any], run: Run, user_id: str,
                       rows: list[dict[str, Any]]) -> None:
    """What DELETE /user/platform/provider-requests does, for any status.

    The handler (ProviderRoleHandler.deletePlatformUserProviderRequest) finds
    the caller's pending platform row and calls
    providerRequestDAO.delete(id) — one row out of provider_requests — then
    writes an audit row. The ownership check is kept as `AND user_id`, the
    provider_type as `AND provider_type`; the pending check is what this skips,
    since nothing takes a grant back. All rows go in one transaction, so a
    failure leaves the account exactly as it was; a dry run executes the
    deletes for the counts and rolls them back.
    """
    schema = pg_schema(config)
    connection = pg_connect(config)
    try:
        with connection.cursor() as cursor:
            for row in rows:
                cursor.execute(
                    f"DELETE FROM {schema}.provider_requests "
                    f"WHERE id = %s AND user_id = %s AND provider_type = %s",
                    (row["id"], user_id, row["provider_type"]),
                )
                label = (f"{row['provider_type']} provider request {row['id']} "
                         f"(status {row['status']})")
                if cursor.rowcount:
                    run.did(f"{'delete' if run.dry_run else 'deleted'} {label} "
                            f"from {schema}.provider_requests")
                else:
                    LOG.info("%s was already gone", label)
        if run.dry_run:
            connection.rollback()
        else:
            connection.commit()
    except psycopg2.Error as exc:
        connection.rollback()
        run.failed(f"could not delete from {schema}.provider_requests — nothing was "
                   f"changed: {exc}")
    finally:
        connection.close()


# ----------------------------------------------------------------------- api

def account_token(kc: Keycloak, target: dict[str, str]) -> str:
    """The account's own token, or "" — it is optional for everything here."""
    if target["token"]:
        return target["token"]
    if not target["username"] or not target["password"]:
        return ""
    try:
        return kc.user_token(target["username"], target["password"])
    except (ApiError, ConfigError) as exc:
        LOG.warning("Could not sign in as the account (%s) — carrying on without it", exc)
        return ""


def cos_admin_token(config: dict[str, Any], kc: Keycloak) -> str:
    block = config["actors"].get("cos_admin") or {}
    if block.get("token"):
        return str(block["token"])
    if not block.get("username"):
        return ""
    try:
        return kc.user_token(require(block.get("username"), "actors.cos_admin.username"),
                             require(block.get("password"), "actors.cos_admin.password"))
    except (ApiError, ConfigError) as exc:
        LOG.warning("No cos_admin token (%s) — the admin listing is skipped", exc)
        return ""


def api_platform_requests(config: dict[str, Any], cp: Http, admin_token: str,
                          user_id: str) -> list[dict[str, Any]]:
    """The cos_admin listing for one user, any status — what Postman's admin GET sees."""
    clean = config["clean"]
    size = int(clean.get("list_page_size") or 50)
    found: list[dict[str, Any]] = []
    for page in range(1, int(clean.get("list_max_pages") or 20) + 1):
        _, payload = cp.request(
            "GET", endpoint(config, "cp_admin_platform_requests"),
            f"list platform provider requests (page {page})", token=admin_token,
            params={"page": page, "size": size, "userId": user_id},
        )
        rows = result_of(payload)
        if not isinstance(rows, list) or not rows:
            break
        found.extend(
            {"id": str(row.get("id") or ""), "provider_type": "platform",
             "status": str(row.get("status") or "")}
            for row in rows
            if isinstance(row, dict) and str(row.get("user_id") or "") == user_id
        )
        pagination = payload.get("paginationInfo") or {} if isinstance(payload, dict) else {}
        if not pagination.get("hasNext") or len(rows) < size:
            break
    return found


def api_own_request(config: dict[str, Any], cp: Http, token: str) -> dict[str, Any] | None:
    """The account's own pending platform request, or None (the GET answers 404)."""
    status, payload = cp.request(
        "GET", endpoint(config, "cp_own_platform_request"),
        "read own platform provider request", token=token, expect=(200, 404),
    )
    result = result_of(payload) if status == 200 else None
    return result if isinstance(result, dict) else None


def api_withdraw(config: dict[str, Any], cp: Http, run: Run, token: str,
                 rows: list[dict[str, Any]]) -> None:
    """The withdraw endpoint, for the no-database route. Pending only."""
    for row in rows:
        label = f"platform provider request {row['id']} (status {row['status']})"
        if row["status"] != "pending":
            run.left(f"{label} — the API only withdraws a pending request; fill the "
                     f"postgres block to delete it")
            continue
        if not token:
            run.left(f"{label} — withdrawing it is the account's own endpoint; give "
                     f"target.password or target.token")
            continue
        if run.dry_run:
            run.did(f"withdraw {label}")
            continue
        try:
            status, payload = cp.request(
                "DELETE", endpoint(config, "cp_own_platform_request"),
                f"withdraw {label}", token=token, expect=(200, 204, 400, 404),
            )
        except ApiError as exc:
            run.failed(f"{label}: {exc}")
            continue
        if status in (200, 204):
            run.did(f"withdrew {label}")
        elif status == 404:
            LOG.info("%s was already gone", label)
        else:
            run.left(f"{label} — the API refused ({status} {detail_of(payload)})")


# --------------------------------------------------------------------- steps

def revoke_role(config: dict[str, Any], kc: Keycloak, run: Run, user_id: str,
                still_granted_by: list[str]) -> None:
    clean = config["clean"]
    role = str(clean.get("provider_role_name") or "provider")
    try:
        roles = kc.realm_roles(user_id)
    except (ApiError, ConfigError) as exc:
        run.failed(f"could not read the realm roles: {exc}")
        return
    if role not in roles:
        LOG.info("The account does not carry the %s role (has: %s)", role,
                 ", ".join(roles) or "none")
        return
    if still_granted_by and not clean.get("revoke_even_if_org_provider", False):
        run.left(
            f"the {role} realm role — still granted by {', '.join(still_granted_by)}; "
            f"set clean.revoke_even_if_org_provider to take it anyway"
        )
        return
    if run.dry_run:
        run.did(f"revoke the {role} realm role from {user_id}")
        return
    try:
        kc.remove_realm_role(user_id, role)
    except (ApiError, ConfigError) as exc:
        run.failed(f"could not revoke the {role} role: {exc}")
        return
    run.did(f"revoked the {role} realm role")


def blocking(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The rows that make POST /user/platform/provider-requests answer 409."""
    return [row for row in rows if row["status"] in BLOCKING_STATUSES]


def describe(rows: list[dict[str, Any]]) -> str:
    return ", ".join(f"{row['provider_type']}:{row['status']}:{row['id']}" for row in rows) or "none"


# ----------------------------------------------------------------------- run

def run_cleanup(config_path: Path, args: argparse.Namespace) -> int:
    config = load_config(config_path)
    logging.getLogger().setLevel(
        str(args.log_level or config["logging"].get("level") or "INFO").upper()
    )
    if requests is None:
        raise ConfigError(
            "the 'requests' package is not installed: pip install -r ../requirements.txt"
        )

    clean = config["clean"]
    if args.include_org:
        clean["include_org_requests"] = True
    if args.keep_role:
        clean["revoke_provider_role"] = False

    target_conf = config["target"]
    username = (args.username or str(target_conf.get("username") or "")).strip()
    user_id = (args.user_id or ("" if args.username else str(target_conf.get("user_id") or ""))).strip()
    target = {
        "username": username,
        "user_id": user_id,
        "password": (args.password or str(target_conf.get("password") or "")).strip(),
        "token": str(target_conf.get("token") or "").strip(),
    }
    if not username and not user_id:
        raise ConfigError("no account to roll back: pass --username or set "
                          "'target.username' or 'target.user_id'")

    cp_conf = config["control_plane"]
    cp = Http(require(cp_conf.get("base_url"), "control_plane.base_url"),
              float(cp_conf.get("timeout_seconds") or 30),
              bool(cp_conf.get("verify_tls", True)), config["logging"])
    kc = Keycloak(config)
    run = Run(bool(args.dry_run))
    token = account_token(kc, target)

    # The user id is what the table, the admin listing and the role key on.
    if not user_id and kc.admin_available and username:
        found = kc.find_user(username)
        if not found:
            raise ApiError(f"no Keycloak account named {username}")
        user_id = str(found.get("id") or "")
    if not user_id and token:
        _, info = cp.request("GET", endpoint(config, "cp_user_info"), "read own user info",
                             token=token)
        result = result_of(info) or {}
        user_id = str(result.get("sub") or result.get("userId") or result.get("user_id") or "")
    if not user_id:
        raise ConfigError("could not resolve the user id: set target.user_id, or fill "
                          "keycloak.admin_client_* so the username can be looked up")
    LOG.info("Rolling back the platform provider request of %s (%s)", username or "?", user_id)

    # ---------------------------------------------------------- inventory
    in_db = bool(clean.get("requests_via_database", True)) and database_ready(config)
    if not in_db:
        LOG.warning("No database route (clean.requests_via_database / postgres block) — only "
                    "a pending request can be withdrawn, and org rows cannot be seen")
    admin_token = cos_admin_token(config, kc)

    rows: list[dict[str, Any]] = []
    memberships = 0
    if in_db:
        try:
            rows, memberships = db_state(config, user_id)
        except psycopg2.Error as exc:
            raise ApiError(f"could not read provider_requests: {exc}") from exc
    elif admin_token:
        rows = api_platform_requests(config, cp, admin_token, user_id)
    elif token:
        own = api_own_request(config, cp, token)
        rows = [{"id": str(own.get("id")), "provider_type": "platform",
                 "status": str(own.get("status"))}] if own else []
    else:
        raise ConfigError("nothing can read the request: fill the postgres block, "
                          "actors.cos_admin, or target.password")

    LOG.info("provider_requests: %s", describe(rows))
    if in_db:
        LOG.info("organization_users rows: %d", memberships)
    if kc.admin_available:
        try:
            LOG.info("Realm roles: %s", ", ".join(kc.realm_roles(user_id)) or "none")
        except (ApiError, ConfigError) as exc:
            LOG.debug("could not read the realm roles: %s", exc)
    if admin_token and in_db:
        try:
            listed = api_platform_requests(config, cp, admin_token, user_id)
            LOG.info("cos_admin listing: %s", describe(listed))
        except ApiError as exc:
            LOG.warning("cos_admin listing failed: %s", exc)

    if args.inventory_only:
        stuck = blocking(rows)
        LOG.info("%s", "-" * 70)
        if stuck:
            LOG.warning("A submit now would answer 409 — blocked by %s", describe(stuck))
        else:
            LOG.info("A submit now would not answer 409")
        return EXIT_OK

    # -------------------------------------------------------------- clean
    types = {"platform"} | ({"org"} if clean.get("include_org_requests", False) else set())
    to_delete = [row for row in rows if row["provider_type"] in types]
    kept_org = [row for row in rows if row["provider_type"] not in types]
    if not to_delete:
        LOG.info("No platform provider request to delete")
    elif in_db:
        db_delete_requests(config, run, user_id, to_delete)
    else:
        api_withdraw(config, cp, run, token, to_delete)

    # Whatever is left after the delete that still hands out the role.
    deleted_ok = in_db and not run.problems
    remaining = kept_org if deleted_ok else rows
    still_granted_by = [f"{row['provider_type']} request {row['id']} ({row['status']})"
                        for row in blocking(remaining)]
    if memberships:
        still_granted_by.append(f"{memberships} organization_users row(s)")
    for row in kept_org:
        if row["status"] in BLOCKING_STATUSES:
            run.left(f"org provider request {row['id']} (status {row['status']}, org "
                     f"{row.get('organization_id') or '?'}) — it also makes the submit "
                     f"answer 409; pass --include-org to delete it")

    if clean.get("revoke_provider_role", True):
        if kc.admin_available:
            revoke_role(config, kc, run, user_id, still_granted_by)
        else:
            run.failed("revoke_provider_role needs keycloak.admin_client_*")

    # ------------------------------------------------------------- verify
    if clean.get("verify", True) and not run.dry_run:
        try:
            if in_db:
                after, _ = db_state(config, user_id)
            elif admin_token:
                after = api_platform_requests(config, cp, admin_token, user_id)
            else:
                after = [row for row in to_delete if row["status"] != "pending"]
        except (ApiError, psycopg2.Error if psycopg2 else ApiError) as exc:
            run.failed(f"could not read the requests back: {exc}")
        else:
            stuck = blocking(after)
            if stuck:
                run.failed(f"a rerun's submit will still answer 409 — blocked by {describe(stuck)}")
            else:
                LOG.info("Read back: no pending or granted provider request — the submit "
                         "will not answer 409")
        if token:
            try:
                own = api_own_request(config, cp, token)
            except ApiError as exc:
                LOG.warning("could not read the account's own request: %s", exc)
            else:
                if own:
                    run.failed(f"the account still sees its request {own.get('id')} "
                               f"(status {own.get('status')})")
        role = str(clean.get("provider_role_name") or "provider")
        if clean.get("revoke_provider_role", True) and kc.admin_available and not still_granted_by:
            try:
                if role in kc.realm_roles(user_id):
                    run.failed(f"the account still carries the {role} realm role")
            except (ApiError, ConfigError) as exc:
                LOG.warning("could not read the realm roles back: %s", exc)

    # ------------------------------------------------------------- report
    LOG.info("%s", "-" * 70)
    if run.done:
        LOG.info("Done (%d):", len(run.done))
        for line in run.done:
            LOG.info("  - %s", line)
    if run.leftovers:
        LOG.info("Left behind (%d):", len(run.leftovers))
        for line in run.leftovers:
            LOG.info("  - %s", line)
    if run.problems:
        LOG.info("Problems (%d):", len(run.problems))
        for line in run.problems:
            LOG.info("  - %s", line)
    LOG.info("A fresh sign-in is needed for the account's token to lose the role; "
             "the collection's own sign-in does that.")
    return EXIT_FAILED if run.problems else EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "config", nargs="?", type=Path,
        default=Path(__file__).with_name("platform_provider_cleanup_config.json"),
        help="JSON config path (default: platform_provider_cleanup_config.json beside this script)",
    )
    parser.add_argument("--username", help="the account whose request is rolled back "
                                           "(the config's user_id is then ignored)")
    parser.add_argument("--user-id", dest="user_id", help="its Keycloak user id")
    parser.add_argument("--password", help="that account's password (optional)")
    parser.add_argument("--inventory-only", action="store_true",
                        help="read the request, the roles and the 409 state, change nothing")
    parser.add_argument("--dry-run", action="store_true",
                        help="run the DB delete and roll it back; print the rest")
    parser.add_argument("--include-org", dest="include_org", action="store_true",
                        help="also delete the account's org provider requests")
    parser.add_argument("--keep-role", dest="keep_role", action="store_true",
                        help="leave the provider realm role on the account")
    parser.add_argument("--log-level", help="DEBUG, INFO, WARNING, ERROR")
    args = parser.parse_args()

    logging.basicConfig(format="%(asctime)s %(levelname)-7s %(message)s", level=logging.INFO)
    try:
        return run_cleanup(args.config, args)
    except ConfigError as exc:
        LOG.error("Configuration error: %s", exc)
        return EXIT_CONFIG
    except ApiError as exc:
        LOG.error("%s", exc)
        return EXIT_FAILED
    except KeyboardInterrupt:
        LOG.error("Interrupted")
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
