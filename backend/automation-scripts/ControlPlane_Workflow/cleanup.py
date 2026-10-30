"""The part of the harness's ControlPlane_Workflow/cleanup.py that compute_credit_cleanup.py imports.

Copied verbatim from dx-api-automation-testing-suite/script/ControlPlane_Workflow/cleanup.py.
Only the statements for that script's DB_ONLY_TABLES are here.
"""

import re

SWEEP_STATEMENTS = [
    (
        "credit_transactions",
        "DELETE FROM {schema}.credit_transactions "
        "WHERE user_id = ANY(%(user_ids)s::uuid[])",
    ),
    (
        "credit_requests",
        "DELETE FROM {schema}.credit_requests WHERE user_id = ANY(%(user_ids)s::uuid[])",
    ),
    (
        "user_credits",
        "DELETE FROM {schema}.user_credits WHERE user_id = ANY(%(user_ids)s::uuid[])",
    ),
    (
        "kyc_transactions",
        "DELETE FROM {schema}.kyc_transactions WHERE user_id = ANY(%(user_ids)s::uuid[])",
    ),
]


_COLUMN_REF = re.compile(r"(\w+)\s*(?:=|LIKE)\s*(?:ANY\s*\()?\s*%\(")


def _split_top_level(clause, separator):
    """Split on `separator` only where parentheses are balanced."""
    parts, depth, current, i = [], 0, [], 0
    width = len(separator)
    while i < len(clause):
        char = clause[i]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if depth == 0 and clause[i:i + width].upper() == separator.upper():
            parts.append("".join(current))
            current = []
            i += width
            continue
        current.append(char)
        i += 1
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _wraps_all(clause):
    """True when a leading '(' is the one closed by the trailing ')'."""
    if not (clause.startswith("(") and clause.endswith(")")):
        return False
    depth = 0
    for i, char in enumerate(clause):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return i == len(clause) - 1
    return False


def _schema_columns(cursor, schema):
    """{table: {column, ...}} for one schema, or None if it cannot be read."""
    try:
        cursor.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = %(schema)s",
            {"schema": schema},
        )
    except Exception:  # noqa: BLE001 - without this the sweep just runs unguarded
        cursor.connection.rollback()
        return None
    columns = {}
    for table, column in cursor.fetchall():
        columns.setdefault(table, set()).add(column)
    return columns


def _adapt_to_schema(sql, schema, columns):
    """Rewrite one DELETE for this deployment, or None to skip it.

    Returns (sql, dropped_columns). Only ever narrows what the statement
    matches, never widens it.
    """
    match = re.match(
        r"\s*DELETE FROM %s\.(\w+)\s+WHERE\s+(.*)" % re.escape(schema),
        sql,
        re.S | re.I,
    )
    if not match:
        return sql, []
    table, where = match.group(1), match.group(2)
    if table not in columns:
        return None, []
    present = columns[table]

    groups, dropped = [], []
    for group in _split_top_level(where, " AND "):
        wrapped = _wraps_all(group)
        inner = group[1:-1].strip() if wrapped else group
        kept = []
        for term in _split_top_level(inner, " OR "):
            missing = [c for c in _COLUMN_REF.findall(term) if c not in present]
            if missing:
                dropped.extend(missing)
            else:
                kept.append(term)
        if not kept:
            # An emptied group means either no subject or no anchor left.
            # Running the rest would widen the statement, so drop it whole.
            return None, dropped
        joined = " OR ".join(kept)
        groups.append("(%s)" % joined if len(kept) > 1 else joined)

    return "DELETE FROM %s.%s WHERE %s" % (schema, table, " AND ".join(groups)), dropped
