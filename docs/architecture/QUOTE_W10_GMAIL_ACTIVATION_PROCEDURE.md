# Quote W10 — Gmail Activation and Deactivation Procedure (prepared, not executed)

Date: 2026-10-09 · Scope: §5 of the R4-J3D recovery instruction · Status: **PREPARED**. The provider is **not** enabled, no email was sent, and nothing on EC2 was read or changed.

Evidence labels: **SOURCE** = `MS-pesaschile-quote-service` at `a015e37` (deployment files `deploy/quote-v2-integration/*`, image `quote-v2-integration:6735352`); **NOT RUN** = every step below.

```
QUOTE_W10_CONFIG_PREPARED=YES   (procedure, validation and probe prepared; owner file not yet filled)
QUOTE_W10_EMAIL_SENT=NO
```

This complements `QUOTE_W10_GMAIL_E2E_REPORT.md`, which holds the contract facts and the single-send procedure. That report's §3 steps 4–8 (test principal, queue inventory, one POST, verification) still apply. This document covers the configuration lifecycle around them.

## 0. Facts this procedure relies on (SOURCE)

| Fact | Source |
|---|---|
| `gmail.pending.env` lives in the secrets directory `~/.config/quote-v2-integration/` (mode 0600). At G1 it held **7 keys, all empty**. | R1.7B-G1 report §G, §U |
| `compose.yaml` does not reference it. The `quote` service reads `./runtime.public.env` (in Git), then `${QUOTE_V2_SECRETS_DIR}/runtime.secret.env`. | `compose.yaml` |
| `runtime.public.env` sets `QUOTE_EMAIL_PROVIDER=disabled` | `runtime.public.env:15` |
| Every optional email/Gmail key is `z.string().trim().min(1).optional()`. A present but empty key (`KEY=`) fails `loadEnv` (`runtime.config_invalid`) **even with the provider disabled**. | `src/infrastructure/config/env.ts:82–88` |
| With `gmail`, these are required: `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, `GOOGLE_GMAIL_REFRESH_TOKEN`, `GOOGLE_GMAIL_USER`, `QUOTE_EMAIL_FROM_ADDRESS` and `QUOTE_EMAIL_FROM_NAME`. `QUOTE_EMAIL_REPLY_TO` is optional: delete the line if unused, never leave it empty. | `env.ts:108–125` |
| `loadEnv` and `describeConfigError` are exported. The latter reports variable **names** only, never values. | `env.ts:252, 278` |
| The sender calls `https://oauth2.googleapis.com/token`, then `…/gmail/v1/users/me/messages/send`. `GOOGLE_GMAIL_USER` is validated but unused (always `users/me`). | `gmail-mail-sender.ts:36–37` |
| Environment changes need a **recreate** of the `quote` container. `docker restart` does not re-read env files. | Compose semantics; W10 report §2 |

## 1. Owner fills the file (owner only)

On the host, as `ec2-user`, with `set +o history`:

- Edit `~/.config/quote-v2-integration/gmail.pending.env` in place. Values are unquoted `KEY=value`; Compose strips quotes but `docker run --env-file` does not, so stay unquoted.
- Keep exactly the keys you use. **Delete** `QUOTE_EMAIL_REPLY_TO` if there is no Reply-To.
- Do not put `QUOTE_EMAIL_PROVIDER` in this file. The override below sets it, so the rollback is simply "without the override".
- No copy of this file is ever created inside a Git checkout.

## 2. File hygiene and empty-entry check (no values printed)

```bash
F=~/.config/quote-v2-integration/gmail.pending.env
stat -c '%a %U %G' "$F"                                   # expect: 600 ec2-user ec2-user
ls -a "$(dirname "$F")" | grep -E '(~|\.swp|\.bak|\.orig)$' # expect: nothing
git -C "$(dirname "$F")" rev-parse --is-inside-work-tree 2>/dev/null || echo "outside git"   # expect: outside git
# Key names present (no values):
grep -E '^[A-Z0-9_]+=' "$F" | cut -d= -f1 | sort
# Empty or whitespace-only values — MUST print nothing:
grep -nE '^[A-Z0-9_]+=[[:space:]]*$' "$F" | cut -d= -f1
grep -nE '^[A-Z0-9_]+=""$|^[A-Z0-9_]+='"''"'$' "$F" | cut -d= -f1
# Unexpected keys (anything outside the 7 known names) — MUST print nothing:
grep -E '^[A-Z0-9_]+=' "$F" | cut -d= -f1 | grep -vxE 'GOOGLE_GMAIL_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|USER)|QUOTE_EMAIL_(FROM_ADDRESS|FROM_NAME|REPLY_TO)'
```

If an empty entry exists, **stop**. Fix the file. Do not attach it to Compose.

## 3. Activation design (Compose override, host-only)

Create `~/.config/quote-v2-integration/compose.gmail.yaml`. It holds no secret, but stays outside Git until the Quote owner decides to version it:

```yaml
# W10 only: attach the Gmail settings and select the provider. Rollback = recreate WITHOUT this file.
services:
  quote:
    env_file:
      - ./runtime.public.env
      - ${QUOTE_V2_SECRETS_DIR}/runtime.secret.env
      - ${QUOTE_V2_SECRETS_DIR}/gmail.pending.env
    environment:
      QUOTE_EMAIL_PROVIDER: gmail
```

- `environment` takes precedence over every `env_file`, so `runtime.public.env` keeps `disabled` for the rollback path.
- Compose merges `env_file` sequences. Listing the full sequence keeps the order explicit; later files win.
- Check the merged result **without starting anything and without printing values**:

```bash
cd ~/services/MS-pesaschile-quote-service/deploy/quote-v2-integration    # or wherever compose.yaml is deployed
export QUOTE_V2_SECRETS_DIR=~/.config/quote-v2-integration
docker compose -p quote-v2-integration -f compose.yaml -f "$QUOTE_V2_SECRETS_DIR/compose.gmail.yaml" config --format json \
  | jq -r '.services.quote.environment | keys[]' | sort                  # names only
docker compose -p quote-v2-integration -f compose.yaml -f "$QUOTE_V2_SECRETS_DIR/compose.gmail.yaml" config --format json \
  | jq -r '.services.quote.environment.QUOTE_EMAIL_PROVIDER'             # expect: gmail
```

Never run `docker compose config` without the `jq` filter: it prints resolved values.

## 4. Configuration validation without sending (NOT RUN)

A one-off container with the exact Compose environment of the override runs the deployed loader and prints names only. `run --no-deps` does not touch the running `quote` container or start Postgres. It sends nothing: `loadEnv` makes no network call.

```bash
docker compose -p quote-v2-integration -f compose.yaml -f "$QUOTE_V2_SECRETS_DIR/compose.gmail.yaml" \
  run --rm --no-deps --entrypoint node quote --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { loadEnv, describeConfigError } = await import(pathToFileURL(process.cwd() + "/dist/infrastructure/config/env.js").href);
    try {
      const env = loadEnv(process.env);
      console.log(JSON.stringify({ ok: true, emailProvider: env.QUOTE_EMAIL_PROVIDER, fromNameSet: env.QUOTE_EMAIL_FROM_NAME !== undefined, replyToSet: env.QUOTE_EMAIL_REPLY_TO !== undefined }));
    } catch (error) {
      const d = describeConfigError(error);
      console.log(JSON.stringify({ ok: false, issues: d ? d.issues.map((i) => i.path) : ["CONFIGURATION"] }));
      process.exit(1);
    }'
```

Expected: `{"ok":true,"emailProvider":"gmail",…}`. Any `ok:false` prints the offending variable names. Stop and fix.

**A well-formed configuration proves nothing about the account.** Do not declare Gmail validated at this point.

## 5. Sender, alias and OAuth authorization check (read-only, NOT RUN)

Host-only file `~/.config/quote-v2-integration/gmail-probe.mjs`. It sends no mail and prints only booleans, HTTP statuses, granted scopes and **masked** addresses. Tokens stay in memory.

```js
// W10 read-only probe: token refresh, account identity, From/alias. Never prints a token or a full address.
const e = process.env;
const mask = (a) => (typeof a === 'string' && a.includes('@') ? `${a[0]}***@${a.split('@')[1]}` : null);
const out = { tokenRefresh: null, scopes: null, profileStatus: null, account: null, accountIsGmailUser: null, fromIsAccount: null, sendAsStatus: null, fromIsVerifiedSendAs: null, replyToSet: Boolean(e.QUOTE_EMAIL_REPLY_TO) };
const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: e.GOOGLE_GMAIL_CLIENT_ID, client_secret: e.GOOGLE_GMAIL_CLIENT_SECRET, refresh_token: e.GOOGLE_GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
out.tokenRefresh = t.status;
if (!t.ok) { console.log(JSON.stringify(out)); process.exit(1); }
const { access_token: token, scope } = await t.json();
out.scopes = String(scope ?? '').split(' ').filter(Boolean);
const auth = { authorization: `Bearer ${token}` };
const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: auth });
out.profileStatus = p.status;
if (p.ok) {
  const { emailAddress } = await p.json();
  out.account = mask(emailAddress);
  out.accountIsGmailUser = emailAddress.toLowerCase() === String(e.GOOGLE_GMAIL_USER).toLowerCase();
  out.fromIsAccount = emailAddress.toLowerCase() === String(e.QUOTE_EMAIL_FROM_ADDRESS).toLowerCase();
}
const s = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', { headers: auth });
out.sendAsStatus = s.status;
if (s.ok) {
  const { sendAs = [] } = await s.json();
  const m = sendAs.find((x) => x.sendAsEmail.toLowerCase() === String(e.QUOTE_EMAIL_FROM_ADDRESS).toLowerCase());
  out.fromIsVerifiedSendAs = Boolean(m && (m.isPrimary || m.verificationStatus === 'accepted'));
}
console.log(JSON.stringify(out));
```

Run it in the deployed image, with the Gmail file only (not the database secret), on the egress network:

```bash
docker run --rm --network quote-v2-integration-edge --env-file "$QUOTE_V2_SECRETS_DIR/gmail.pending.env" \
  -v "$QUOTE_V2_SECRETS_DIR/gmail-probe.mjs:/tmp/gmail-probe.mjs:ro" --entrypoint node quote-v2-integration:6735352 /tmp/gmail-probe.mjs
```

Reading the result:

| Result | Meaning |
|---|---|
| `tokenRefresh: 200` | The client and refresh token are valid and not revoked. This mints one short-lived access token, which is used only in memory. |
| `scopes` | What the token can do. The sender needs `gmail.send` (or `mail.google.com`). |
| `profileStatus: 200`, `accountIsGmailUser: true` | The token authorizes the intended mailbox. |
| `fromIsAccount: true` or `fromIsVerifiedSendAs: true` | Gmail will accept the From address. |
| `profileStatus`/`sendAsStatus: 403` | Expected with a `gmail.send`-only grant: those reads need broader scopes. The account and From check then **falls back to inspecting the one delivered test message** (W10 report §3 step 8). Do not widen scopes just for the probe. |

Only `tokenRefresh: 200` together with a positive account and From check (here or on the delivered message) counts as "credentials validated".

## 6. Before any recreation (NOT RUN)

Record the following. Nothing in this step changes anything.

```bash
docker inspect quote-v2-integration --format '{{.Id}} {{.Image}} {{.Config.Image}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}'
docker image inspect quote-v2-integration:6735352 --format '{{.Id}}'
docker inspect quote-v2-integration --format '{{json .Mounts}}' | jq -c '[.[] | {Name, Destination, RW}]'
docker volume inspect quote-v2-integration-pgdata quote-v2-integration-documents --format '{{.Name}} {{.Mountpoint}}'
curl -fsS http://127.0.0.1:4020/health/ready | jq -c .
curl -fsS -H "authorization: Bearer $(cat "$QUOTE_V2_SECRETS_DIR/token-monitor")" http://127.0.0.1:4020/health/dependencies | jq -c '.emailProvider? // .'
docker exec -u postgres quote-v2-integration-postgres psql -d quote_v2_integration -Atc \
  "select status, origin, count(*) from quote_service.quote_deliveries group by 1,2 order by 1,2"
docker exec -u postgres quote-v2-integration-postgres psql -d quote_v2_integration -Atc \
  "select count(*) from quote_service.quote_deliveries where status in ('pending','sending')"   # MUST be 0
```

Also confirm that no principal other than the dedicated W10 test principal holds `quotes:delivery:email`. Use `jq` over `principals.json` and print principal ids and scopes only. **`r4-sales-integration` must not hold it**, and stays a separate principal from the email-test one.

Prerequisites before §7: the owner has approved the exact internal recipient, the From and Reply-To, the delivery key and the procedure owner.

## 7. Activation (NOT RUN; needs the owner's W10 go)

```bash
docker compose -p quote-v2-integration -f compose.yaml -f "$QUOTE_V2_SECRETS_DIR/compose.gmail.yaml" up -d quote   # recreates quote only
curl -fsS http://127.0.0.1:4020/health/ready | jq -c .
# dependencies must show the gmail provider and the send runner; mounts and volume names must equal §6
```

Then follow W10 report §3 steps 7–8: exactly one POST with the explicit approved recipient, then verify.

## 8. Deactivation and rollback (always; also the abort path)

```bash
docker compose -p quote-v2-integration -f compose.yaml up -d quote          # recreate WITHOUT the override
curl -fsS http://127.0.0.1:4020/health/ready | jq -c .
curl -fsS -H "authorization: Bearer $(cat "$QUOTE_V2_SECRETS_DIR/token-monitor")" http://127.0.0.1:4020/health/dependencies | jq -c .   # expect provider disabled, no send runner
docker inspect quote-v2-integration --format '{{json .Mounts}}' | jq -c '[.[] | {Name, Destination, RW}]'   # equal to §6
```

Afterwards:

- Remove `quotes:delivery:email` from the test principal: edit the registry **in place**, then `docker kill --signal=HUP quote-v2-integration`. Replacing the single-file bind mount would leave the container reading the old copy.
- Keep `gmail.pending.env` (0600) or blank it, as the owner decides. If it is kept, the override file is the only thing that activates it.
- If the recreate in §7 failed to start (`runtime.config_invalid`), the same command restores `disabled`. Named volumes are untouched by a recreate.

## 9. What was not done

No EC2 access, no file read or edited on the host, no principal provisioned, no provider enabled and no email sent. The R1.7B-G1 report says `gmail.pending.env` still has 7 empty keys, so attaching it today **would** fail startup; §2 detects that.
