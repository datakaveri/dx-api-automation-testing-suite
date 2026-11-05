# Access request scripts

```
access_request/
└── expire/   access_request_expire.py   + access_request_expire_config.json   (SQL)
```

## expire — make an approved dataset / AI-model request expire now

Takes one or more access request ids and sets their expiry to the database's
current time. After that the request and its policy show up as **EXPIRED**
in MahaAgx, and the consumer loses access straight away.

```bash
python -m pip install -r requirements.txt
cd expire
cp access_request_expire_config.json.example access_request_expire_config.json
# fill postgres.* (control-plane DB: iudx_v2_auth, schema aaa)

python access_request_expire.py --request-id <uuid> --dry-run   # show what would change
python access_request_expire.py --request-id <uuid>             # do it
python access_request_expire.py --request-id <a> --request-id <b>
```

### What it changes

EXPIRED is never stored by the control plane. `ExpiredStatusHelper` derives
it whenever a row still has its live status (`GRANTED` / `ACTIVE`) and
`expiry_at <= now`. So the script **only moves expiry columns** and leaves
every status as it is:

| Table | Column | Rows |
|---|---|---|
| `request` | `expiry_at` | `request_id = <id>` |
| `policy` | `expiry_at` | `request_id = <id>`, status `ACTIVE`. Older requests (approved before V67) have no `policy.request_id`, so it falls back to the single live policy for the same consumer + item |
| `access_rule` | `expiry_at` | `policy_id` in those policies (only group policies have rules) |
| `subscriptions` | `expiryat` | `user_id = consumer`, `entityid = item`. Without this, a streaming subscription keeps delivering until its own expiry. The server's scheduler deletes the RabbitMQ queue and read permission on its next pass once this column is in the past |

- Expiries only ever move **earlier**. A row that is already expired is left as it is, so running the script twice does nothing the second time.
- `updated_at` is set by the tables' triggers.
- Each request gets its own transaction with `SELECT … FOR UPDATE`. A request that fails a check is left completely untouched.
- `--dry-run` connects read-only (`default_transaction_read_only=on`), so it cannot write anything.

### Checks (config `checks.*`)

- Request status must be in `require_request_status` (default `GRANTED`).
- `asset_type` must be in `allowed_asset_types` (default `adex:DataBank`, `adex:AiModel`).
- At least one policy must be found (`require_policy`). If the request is already expired and no live policy is left, the result is `already-expired` and the exit code is 0.
- If the fallback finds several live policies, the script stops. Pick one with `--policy-id`.

### Time

`expiry.at: "now"` uses the database clock (`localtimestamp`). The control
plane's DB and JVM both run in UTC, and expiry columns hold naive UTC, so
this is the same clock the server compares against. To give an explicit time
instead, use `--at "YYYY-MM-DD HH:MM:SS"` (UTC). `expiry.offset_seconds`
shifts the time, e.g. `-60` puts it a minute in the past.

### Not covered

- **Access tokens that were already issued** remain valid until their own `exp` (`tokenExpirationMinutes`). That is only short-lived, and every policy check after the change fails.
- No email or audit-log entry is written. The server does not send one for a natural expiry either.

Exit codes: `0` all done, `1` at least one request failed, `2` config or connection error.
