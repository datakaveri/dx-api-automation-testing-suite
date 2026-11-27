# Delegation scripts

```
delegation/
└── expire/   delegation_expire.py   + delegation_expire_config.json   (SQL)
```

## expire — make an active delegation expire now

Takes one or more delegation ids and sets their expiry to the database's
current time. After that the delegation shows up as **expired**, and the
delegate can no longer act for the delegator.

```bash
python -m pip install -r requirements.txt
cd expire
cp delegation_expire_config.json.example delegation_expire_config.json
# fill postgres.* (control-plane DB: iudx_v2_auth, schema aaa)

python delegation_expire.py --delegation-id <uuid> --dry-run   # show what would change
python delegation_expire.py --delegation-id <uuid>             # do it
python delegation_expire.py --delegation-id <a> --delegation-id <b>
```

### What it changes

The control plane never stores `expired`. `DelegationGrant.effectiveStatus`
derives it whenever a grant is still `active` and `expiry_at <= now`. So the
script **only moves expiry columns** and leaves the status as it is:

| Table | Column | Rows |
|---|---|---|
| `delegation_grants` | `expiry_at` | `delegation_id = <id>` |
| `delegation_scope_constraints` | `expiry_at` | `delegation_id = <id>` (every role/scope row of the grant) |

Both tables are needed. `findActiveDelegationWithScopes` requires the grant's
expiry **and** the constraint's expiry to be in the future.
`DelegationAccessEvaluator` and `DelegationResolverImpl` check the grant's.

Do not set `status = 'expired'` by hand. The list API rewrites an `expired`
filter to "`active` and `expiry_at <= now`", so a row stored as `expired`
would drop out of both the active list and the expired list.

- Expiries only ever move **earlier**. A row that is already expired is left as it is, so running the script twice does nothing the second time (`already-expired`, exit code 0).
- The tables have no triggers and no `updated_at` column.
- Each delegation gets its own transaction with `SELECT … FOR UPDATE`. A delegation that fails a check is left completely untouched.
- `--dry-run` connects read-only (`default_transaction_read_only=on`), so it cannot write anything.
- `delegation_grants` has a unique index on (delegator, delegate, justification, expiry_at) for `active` rows. If another active grant with the same three values already sits at exactly the target time, the script moves the target back by one microsecond at a time until it is free.

### Checks (config `checks.*`)

- The stored status must be in `require_grant_status` (default `active`). `revoked`, `rejected` and `deleted` grants are refused.
- `require_constraints` (default off): stop if the grant has no scope constraints. Otherwise it only warns and expires the grant alone.
- `refuse_future_expiry` (default on): refuse an `expiry.at` later than the DB clock, because the delegation would stay active until then.
- Pending `delegation_update_requests` are reported but not touched. The server does not implement approving them yet.

### Time

`expiry.at: "now"` uses the database clock (`localtimestamp`), which is UTC
on the control plane, and `expiry_at` holds naive UTC. To give an explicit
time instead, use `--at "YYYY-MM-DD HH:MM:SS"` (UTC). `expiry.offset_seconds`
shifts the time, e.g. `-60` puts it a minute in the past.

`DelegationResolverImpl` reads `expiry_at` as IST, so it sees the new value
5½ hours earlier than the other checks do. That makes no difference here, because
the value is already in the past either way.

### Not covered

- **Tokens that were already issued** stay valid until their own `exp`. That is only short-lived, and every delegation check after the change fails.
- No email or audit-log entry is written.

Exit codes: `0` all done, `1` at least one delegation failed, `2` config or connection error.
