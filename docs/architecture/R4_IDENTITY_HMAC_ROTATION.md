# Rotation of `R4_PROD_IDENTITY_HASH_KEY` (identity HMAC)

**State:** `R4_IDENTITY_HMAC_ROTATION_TOOLING`. This is the tooling and runbook for **future** rotations of the key. It is updated for the conversation model of 2026-11-18 (lane `sales-production@22`, case idle close, quote recovery, prior-conversation carry-over) and rehearsed end to end on a local throwaway copy (§6).

**Every run needs its own, fresh owner authorization.** Nothing here authorizes a run, and nothing in this document has been run in production by its author.

**History:**
- **2026-11-11:** the key was rotated in production with the earlier version of these tools (§10).
- **2026-11-18:** the owner accepted that rotation as verified and **decided against a second rotation**. This PR is merged as the tooling for the next one.

## 1. What the key is and what derives from it

`conversationKey = HMAC-SHA256(key as UTF-8, channel \0 accountRef \0 conversationRef)`, 64 lowercase hex (`packages/live-ops/src/rollout.ts`). For WhatsApp: `whatsapp`, the business number's `phone_number_id`, the normalised wa_id.

Every place that stores or derives a conversation key on main (2026-11-18), and how the rotation treats it:

| Derived value | Used for | Treatment |
|---|---|---|
| `channel_conversation_bindings.conversation_key` | Routing (one open binding per key), **and all lineage**: `earlierConversationTurns` (prior turns, R7-4), `earlierConversationTasks` (quote recovery, #85), the idle sweep's candidates (#97). All three join bindings on `(channel, conversation_key)` | **Migrated, every verifiable row, open and closed** (idle-closed cases included), in one transaction |
| `R4_PROD_ROLLOUT_ALLOWLIST`, `_DENYLIST`, `R4_PROD_LANE_ALLOWLIST` | Who is autonomous; who opens on the lane (`@22`) | **Recalculated** from verified identities; written into the env files atomically |
| Cohort bucket (`rolloutBucket`, first 8 hex) and `laneRoute` (#90, not deployed) | Percentage cohort and cohort lane | Decided when a binding opens and frozen on it. The rotation refuses unless the percentage is **0 or 100** (the only values a new key cannot reshuffle). Production: 0 % |
| `conversationLockKey` | Advisory lock | Computed at runtime, never stored |
| `inbound_events.conversation_key` | Settled rows: history. `received` rows: routed later; the idle sweep skips a binding with a `received` row | Must be **zero** `received` (abort condition) |
| `identity_verification.expectations.conversation_key` | Live expectation and open protection window, looked up by key; `latestForBinding` by binding id | Must be **zero** live or protected (abort condition). Terminal rows keep the old key as history; nothing reads them by key. Only `sales-production@8` uses this schema; on 2026-11-11 it was absent in production |
| `task_inputs.actor_ref` (`whatsapp:` + 32 hex), `request_hash`, `memory_entries`, `context_snapshots`, settled inbound | Immutable history | **Kept** (rewriting would break their hashes; nothing compares them across tasks: quote counters are per task, quote recovery reads quotes by task id) |

Checked by reading the code: no Sales table, outbound row or external call (Quote V2, Checkout) carries a conversation key. Lineage lives only in the bindings table, so migrating every verifiable binding keeps it whole.

## 2. What changed since #71 was written, and what the procedure does about it

| Change | Effect on a rotation | What the procedure does now |
|---|---|---|
| Lane is `sales-production@22` (2026-11-18) | Lane allowlist is recomputed like the others | Precondition `LANE=<lane profile>` (same check as `deploy.sh`) |
| Case idle close (#97, 24 h) | Closed `idle_timeout` bindings must stay in their conversation's lineage | Every verifiable closed row is rewritten; **new abort**: an unverifiable row that shares a verified row's key (it would be cut out of the lineage) |
| Quote recovery (#85), prior turns (R7-4) | Found through binding lineage | **New** `continuity.mjs`: snapshot before, check after, with the deployed code's own queries (§5) |
| Allowlists as 64-hex keys | Must be recomputed, and no stale copy may survive | Recomputed; **new abort** if any active file (`secrets/*.env`, `run-*.sh`, other `~/.config/r4/*.env`, `~/r4-lane-switch-v2.sh`, `~/r4-inbound-media/`, `~/r4-deploy.sh`) holds the old key or an old list entry, or defines a managed variable outside `production.env` / `production-lane.env` |
| Web QA (`r4-web-qa-*`, `r4-web-qa-canary-postgres`) | Its deploy script generates **its own** key (`openssl rand -hex 32` into `~/.config/r4-web-qa/web.env`), its own database, channel `web`, rollout 100 %, no lists. #71 only listed web QA files by name | **New abort** if any web QA file holds a production value; then rotate web QA separately (§8) |
| Deploys (`deploy.sh`) and the lane switch | Neither rewrites the key or the lists; but every deploy backup holds the key | Runbook: never restore an env file from a pre-rotation backup (§7.8) |
| (found) `rollback-production.sh` had no database URL for its swapped apply | The #71 rollback could never have run | Fixed; rehearsed (§6) |
| (found) Autonomy was turned back on only after the gateway was up | Messages in that gap were held for a person | Autonomy is restored before the gateway starts (§6) |
| (found) A refused apply left production stopped; the lists were written only after the commit | A certain no-op looked like an unknown outcome; an apply dying after the commit left no lists | `rotate.mjs apply` exits **3** only when COMMIT was never sent and ROLLBACK succeeded (the script then restores production); the lists are written inside the transaction, before COMMIT |
| (found) Only `dump.pm2` was checked, and only for the key | pm2 keeps `dump.pm2.bak`; list entries could survive | Two saves, then every `dump.pm2*` is checked for the key **and** the old list entries |
| (found) The rollback turned autonomy on unconditionally and dropped list entries added after the rotation | Wrong state after a rollback | It restores autonomy as found before it stopped anything, and takes the lists the env files hold now |

## 3. What is lossy, and what needs an owner decision

1. **History keeps old-derived values** (`actor_ref`, settled inbound keys, terminal identity-verification rows). Nothing reads them for routing or lineage. Tying an old `actor_ref` to a contact needs the old key, which is kept only for the rollback window. *Decision: accept (recommended), or keep the old key sealed longer for audit.*
2. **Unverifiable bindings** (a stored key that does not match its own inputs). Open: the rotation refuses. Closed and sharing a verified key: refuses (new). Closed with a key of its own: left as is; it is outside every lineage already. Expected count: 0 (24/24 verified on 2026-11-11).
3. **An allowlisted tester with no binding** (never wrote) has no verifiable identity: the plan refuses. *Decision: drop that entry, or have the tester write once before the rotation.* After the rotation, a number can be re-derived under the new key with `npm run -s production:sales -- --identity-key <wa_id>`; it prints a derived key to the terminal.
4. **Rollout percentage** must be 0 or 100 at rotation time (0 % on 2026-11-18). *A percentage in between blocks the rotation.*
5. **Pre-rotation copies of the key** stay readable until shredded:
   - every `~/backups/r4-production/<ts>/production.env`;
   - the `.bak*` env files;
   - the pm2 folder;
   - earlier rotation folders. The 2026-11-11 folder's `new.key` is the key in use since then.

   *Decision per run: the shred list and date (§7.9).*
6. **`recipient_ref` holds the wa_id in plain text** (finding of 2026-11-11, still open): the rotation protects the pseudonyms that leave the database, not a dump. Encrypting `recipient_ref` is separate work.

## 4. Tools (`ops/r4-identity-rotation/`)

- `rotation.mjs`: the logic. Plan, apply in **one transaction** (binding table locked, identity trigger disabled only inside it, every row re-verified before commit), verify.
- `rotate.mjs`: CLI (`plan`, `apply`, `install`, `verify`, `export-key [--values-out]`). Prints counts only; lists go to 0600 files.
- `continuity.mjs`: `snapshot` / `check [--require-message]` (§5).
- `rotate-production.sh`: the host procedure (§7). `PREFLIGHT_ONLY=1` runs steps 0–2 only.
- `rollback-production.sh`: the rollback (§7.7).
- `local-rehearsal.sh`: runs both scripts against a seeded throwaway copy (§6).
- `restored-copy-test.sh`: the same on a fresh restored copy of production, on the host. Optional; it now also runs the continuity snapshot and checks.

The tools load `pg` and the lineage queries from `R4_REPO` (default `~/R4-agent-platform`), so they can run from a 0700 folder outside the repository.

## 5. Continuity verification (`continuity.mjs`)

**Snapshot** (taken with production stopped, just before the apply). For every conversation identity whose bindings verify, it records:
- its bindings, and its open binding and task;
- the earlier tasks of its newest task (`ProductionStore.earlierConversationTasks`, quote recovery's lineage);
- the quotes quote recovery finds there (`PostgresSalesStore.conversationQuotes`);
- the earlier turns carried to it (`ProductionStore.earlierConversationTurns`; count and digest);
- its input count;
- the lists it is in.

Subjects are identified by binding id only. The snapshot holds no key, wa_id or derived key.

**Check** (after the rotation, and after a rollback: it works under whatever key the env files hold). For each subject it recomputes the key from the binding's own inputs and **fails** when:
- a snapshot binding left the conversation (lineage cut);
- a binding was opened for the same contact **under another key** after the snapshot (a process still runs with the old key);
- the earlier tasks, recovered quotes or carried turns differ;
- the subject is not in exactly the same lists, or a list changed size;
- a newer case (opened after the snapshot, e.g. after an idle close) does not see the earlier tasks, quotes and turns;
- a message reached the gateway for the subject but no task input (held or refused).

Per subject it prints where the next message goes or went: `same open binding and task`, `new case with lineage`, or `case closed since`. With `--require-message` it also fails unless at least one listed subject (a tester) wrote after the snapshot.

The four questions of the mandate map to:
- **next message lands on the same binding/task, or a new one with lineage** → `message after the snapshot: landed on …`, plus the stale-key and held checks;
- **quote recovery still finds its quotes** → recovered quotes;
- **prior turns are carried** → carried turns;
- **testers stay allowlisted** → list membership.

**Proof that it works** (`tests/integration/identity-hmac-rotation-continuity.test.ts`). An isolated `sales-production@22` canary (real ingress, worker and delivery; scripted model) does this:
1. Issues a quote. The case closes idle. The owner comes back in a new case.
2. The key is rotated with the CLI and the runtime restarts under the new key and lists. The owner's next message lands on the **same task**. The agent is shown the earlier quote (`earlierTask: true`) and the same prior-conversation episode.
3. After another idle close, the new case carries both earlier tasks and the quote. The tester's new case is autonomous (still allowlisted).
4. A rollback as the script does it restores identical env files and the same continuity.
5. A binding inserted under the other key is caught.

Two mutants (closed bindings not rewritten, by skip or by omission) both fail the test.

## 6. Local rehearsal (2026-11-18, `local-rehearsal.sh`)

**Setup:** throwaway database on the local `r4-agent-platform-postgres`, seeded by the continuity test at its snapshot point:
- 3 bindings (1 open, 2 closed `idle_timeout`);
- 3 tasks, 1 issued quote;
- 2 allowlisted testers, one on the lane list.

The production file layout is rebuilt in a temporary folder. `pm2` and the gateway `/health` are stand-ins: they record state and the injected key. Autonomy and the database are real. The two scripts ran unmodified, with paths overridden by environment.

| Check | Result |
|---|---|
| Managed variable also defined in `secrets/*.env` | Refused at preflight; nothing changed |
| Old values in an active ops folder | Refused at preflight |
| Web QA config holding the production key | Refused at preflight |
| Clean preflight | Ready; the historical `.bak` copy is listed by name; key files shredded |
| Failure while stopping (stand-in `pm2 stop` of the gateway fails) | Trap restored the processes and autonomy; bindings unchanged; attempt files shredded |
| Rotation | 3 bindings rewritten; verify ok; continuity ok before and after the restart; 0 holds |
| After the rotation | Workers and gateway carry the new key, the scheduler none; 0 old values in the env files and the pm2 dump; no key, list entry or contact in the output; new key file 0600 |
| Rollback | Every binding back to its original key; env files hold the old key; continuity ok; workers and gateway on the old key; autonomy as found before the rollback |
| Rollback after an apply that died before install (database rotated, env files still on the old key; run 3) | Nothing installed; every binding back to its original key |
| pm2 dumps (run 3: `dump.pm2` and `dump.pm2.bak` both held the old key before) | 0 old values in any `dump.pm2*` after the rotation |
| Leftovers | Database dropped; files removed |

**Timings** (three runs on a Windows workstation; most of it is `npm run production:sales:control` start-up and the scripts' fixed waits):

| | Run 1 | Run 2 | Run 3 (after the review fixes) |
|---|---|---|---|
| `rotate-production.sh` total | 56 s | 68 s | 42 s |
| Gateway down (no ingestion; Meta retries) | 27 s | 37 s | 22 s |
| Autonomy off (inside the gateway-down window) | 22 s | 30 s | 18 s |
| Database work (backup, plan, snapshot, apply, install, verify, continuity) | ≈5 s | ≈5 s | ≈3 s |
| `rollback-production.sh` total | — | 46 s (gateway down 30 s) | 39 s (gateway down 22 s) |

On the host the 2026-11-11 window was about 40 s. Expect 30–60 s with the gateway down, and autonomy off for less than that.

**Must ingestion be paused?** Yes, from just before the apply until the gateway restarts under the new key. A gateway still holding the old key in memory would derive the old key for a returning contact. It would find no binding and open a second one, cutting the lineage; `continuity.mjs` reports it as "opened under another key". Pausing is the gateway stop: Meta retries the webhooks, so nothing is lost; messages sent in the window arrive late by Meta's retry delay.

**Must autonomy be off?** Only as a guard while the database changes. The script now restores autonomy *before* starting the gateway, so no inbound can arrive while autonomy is off. That means no `held:autonomy_disabled` holds, which #71's order (gateway first, autonomy after) could create.

**Not rehearsed locally:** real pm2, real `/proc` environments and nginx/Meta retries, which are host-only. Also not rehearsed through the script: the end-to-end tester message, and the refused-apply path (exit 3; nothing changes). Both are covered by the integration tests.

## 7. Host runbook (for a future, separately authorized run)

Placeholders: `<DEPLOYED_SHA>` is the short SHA production runs (`git -C ~/R4-agent-platform rev-parse --short HEAD`). `<LANE>` is the lane profile in `production.env` (`R4_PROD_LANE_PROFILE`). `<TOOLS_SHA>` is the full SHA of a commit **on main** that contains this tooling.

### 7.1 Preconditions

- [ ] **A fresh, explicit owner authorization for this run** (date, reason, operator). No earlier authorization carries over.
- [ ] One tester is reachable for the closing message.
- [ ] Production at `<DEPLOYED_SHA>`, lane `<LANE>`. `r4-channel-gateway`, `r4-sales-worker`, `r4-sales-worker-lane` and `r4-scheduler` are online. Any processes deliberately stopped stay stopped. Autonomy readable (normally enabled). Rollout 0 or 100 %.
- [ ] The deployed build contains quote recovery (#85): `continuity.mjs` imports its lineage queries from `~/R4-agent-platform` dist.
- [ ] Nobody else is deploying, switching the lane, or running an L3 on the host.
- [ ] More than 1 GB free disk (the dump).
- [ ] Quiet moment: no tester mid-conversation.
- [ ] A terminal multiplexer: run every script below inside `tmux` (or `screen`). An SSH drop must not kill a script mid-window and leave production stopped unnoticed:
  - `tmux new -s rotation` to start;
  - `tmux attach -t rotation` after a reconnect.

  Without tmux, use `nohup … > log 2>&1 &` and `tail -f` the log.

### 7.2 Install the reviewed tools from main (no change to the production checkout)

```bash
H=<TOOLS_SHA>                                   # a main commit, e.g. git -C ~/R4-agent-platform rev-parse origin/main after a fetch
D=~/r4-identity-rotation-$H; install -d -m 700 "$D"
cd ~/R4-agent-platform && git fetch -q origin main && git merge-base --is-ancestor "$H" origin/main && echo "on main"
for f in rotation.mjs rotate.mjs continuity.mjs rotate-production.sh rollback-production.sh; do git show "$H:ops/r4-identity-rotation/$f" > "$D/$f"; done
chmod 600 "$D"/*; git status --short   # expected: empty (the checkout is untouched)
```

### 7.3 Preflight (read-only, production running)

```bash
tmux new -s rotation
PREFLIGHT_ONLY=1 SHA=<DEPLOYED_SHA> LANE=<LANE> bash "$D/rotate-production.sh"
```

Expected output:
- `autonomy: "autonomy": "enabled"`;
- `historical copies … : <names>` (keep the list for §7.9);
- plan JSON with:
  - `"ready": true` and `"blockers": []`;
  - `bindings.verified` equal to `bindings.total`, and `lineageOrphans: 0`;
  - every list with `unmapped: 0`;
  - `identityVerification: "schema_absent"` or `{ protectedOrLive: 0 }`;
- last line `PREFLIGHT ONLY: ready`.

Any `ABORT` stops here with nothing changed (§7.5).

### 7.4 Rotation

```bash
# inside the tmux session
SHA=<DEPLOYED_SHA> LANE=<LANE> bash "$D/rotate-production.sh" 2>&1 | tee ~/identity-rotation-$(date -u +%Y%m%dT%H%M%SZ).log
```

The new key is generated inside the script (`crypto.randomBytes(32)`, 64 hex) into `$B/new.key`, where `B=~/backups/r4-production/identity-rotation-<ts>`. That folder is 0700, every file 0600 (`umask 077`). The key is never echoed.

It goes into `production.env` by atomic rename (mode kept). The processes get it from the env files their run scripts source. pm2's remembered environment is **replaced** by a minimal one: HOME, PATH and the key. A child shell reads the key from the file, so it never appears on a command line. The scheduler gets no key.

Expected output, step by step:

| Step | Expected |
|---|---|
| 0 | `autonomy: "autonomy": "enabled"` |
| 1 | `historical copies …` (names) |
| 2 | plan JSON as in §7.3 |
| 3 | no output; workers stopped, outbound drained, gateway stopped, kill switch on |
| 4 | backup folder path |
| 5 | `continuity.mjs snapshot` JSON: `subjects` = number of contacts, `listedSubjects` = list sizes, `unverifiedBindings: 0` |
| 6 | `"rewritten": N`, with N equal to the plan's `bindings.verified` |
| 7 | `installed: [R4_PROD_IDENTITY_HASH_KEY, R4_PROD_ROLLOUT_ALLOWLIST, R4_PROD_LANE_ALLOWLIST]` (plus the denylist if set) |
| 8 | verify `"ok": true`, `rewrittenVerified: N`; one continuity line per contact, then `"failures": [], "ok": true` |
| 9 | `autonomy now: "autonomy": "enabled"`; four processes `online`; `gateway /health 200` |
| 10 | `kill-switch holds since …: 0`; continuity `"ok": true` |

The script ends with `window: gateway down ≈30–60 s; autonomy off …` and `ROTATION DONE` followed by the tester check command.

### 7.5 Abort points (what happens)

| Where | Condition | Result |
|---|---|---|
| 0–2 (production running) | Wrong SHA or lane; a process not online; `/health` not 200; the autonomy status cannot be read; an unsettled action or outbound; a managed variable defined outside the two env files; an active file or web QA holding old values; any plan blocker (unverifiable open binding, collision, lineage orphan, unsettled inbound, live/protected identity verification, unmapped list entry, rollout not 0/100, bad env shape, role cannot disable the trigger) | Nothing stopped, nothing changed; attempt files shredded |
| 3–5 (production stopped, before the commit) | Outbound does not drain in 60 s; kill switch not engaged; R4 sessions do not close in 30 s; unsettled action/outbound/inbound; plan blocked with production stopped | Trap: workers started, autonomy as found, gateway started; database unchanged; attempt files shredded |
| 6 (apply refused) | `rotate.mjs apply` exits **3**: an error before COMMIT was sent and the ROLLBACK succeeded (a blocker found inside the transaction, a lock timeout, a lists file that cannot be written, no connection) | Nothing changed for certain: `ABORT: apply refused and rolled back`; the trap restores production and shreds the attempt files |
| 6 (outcome unknown) | Any other apply failure (exit 1: the connection or process died during or after COMMIT) | Production **stays stopped**. The lists file exists, because it is written before COMMIT. The script prints the two `verify` commands that tell which key the bindings verify under: rotated → rollback (§7.7), which skips the install because the env files still hold the old key; not rotated → start the processes and set autonomy as it was |
| 7–10 (after the commit) | install, verify, continuity, pm2 dump files, process, `/health` failure | `DATABASE ROTATED`: run the rollback (§7.7) |

### 7.6 After: the tester's message (closes the rotation)

Tell the owner/tester: *"Send one message in your existing WhatsApp chat with the store (for example: «hola, sigo aquí»)."* Then:

```bash
R4_REPO=~/R4-agent-platform node "$B/tool/continuity.mjs" check --env-file ~/.config/r4/production.env --env-file ~/.config/r4/production-lane.env --repo ~/R4-agent-platform --snapshot "$B/continuity.json" --require-message
```

Expected:
- the tester's line reads `message after the snapshot: landed on the same binding and task` (or `on a new case with lineage` if the case had closed idle);
- `"testersWrote": 1` or more, `"ok": true`.

The reply should come from the same conversation. If the tester had a quote, the agent may refer to it.

**Rollback triggers:** any failure line, especially `opened for this contact under another key` or `none reached the conversation's tasks`.

### 7.7 Rollback

```bash
# inside tmux
B=~/backups/r4-production/identity-rotation-<ts> bash "$D/rollback-production.sh"
```

What it does:
1. Checks the backup checksums.
2. Records the autonomy state (refuses if unreadable) and which key the env files hold.
3. Stops the workers, drains the outbound, stops the gateway and engages the kill switch. It waits for R4 sessions, with a loud timeout, and checks that actions, outbound and inbound are settled.
4. Applies with the keys swapped. Bindings opened after the rotation are included: they verify under the new key.
   - The input lists are the ones the env files hold **now**, so entries added after the rotation are carried back. An added entry with no binding blocks, as in a rotation.
   - If the env files still hold the old key (the rotation died before installing), the rotation's own key and lists are the input.
5. Writes the old key and lists back into the env files, only those lines. Nothing is installed if the files already hold the old key.
6. Verifies under the key the files then hold, and checks continuity against the rotation's snapshot.
7. Restarts the workers with the old key. Restores autonomy **as found before the rollback stopped anything**: if it found autonomy off although the rotation had found it on, it says so and leaves it off for a person. Then it starts the gateway and checks every `dump.pm2*` for the rotated key.

A trap names the state on any failure: production untouched, stopped with the database still rotated, stopped with the database back under the old key, or failed while restarting. It prints what to do next.

Expected:
- two `"ok": true`;
- `window: gateway down …`;
- `ROLLBACK DONE`.

Measured locally: 39–46 s, 22–30 s with the gateway down.

Last resort (owner decision): `pg_restore` of `$B/r4_production.dump`. It loses everything after the rotation.

**Never** run the rollback of an older rotation folder once a newer rotation has run. It would refuse anyway: its "new" key is no longer the one in use.

### 7.8 Rules from now on

- **Never restore `production.env` or `production-lane.env` from a pre-rotation backup.** Every deploy backup holds the old key. A gateway started with it opens duplicate bindings (stale key) and drops the testers out of the allowlist.
- Lane switches and deploys do not touch the key or the lists. A new tester is added by deriving their key under the **current** key.

### 7.9 Retention: where the old key lives, and for how long

| Item | Holds | Keep until |
|---|---|---|
| `$B/old.key`, `$B/old.values` (0600, in a 0700 folder) | Old key and old list entries | Rollback window closes: owner's call; recommended 72 h after a successful tester check. Then `shred -u` |
| `$B/new.key` | Copy of the live key | Same date (`production.env` holds the live value). Then `shred -u` |
| `$B/r4_production.dump`, `$B/production*.env`, `$B/dump.pm2` | Old key in the env copies; plaintext wa_ids in the dump | Normal backup retention, 0600. The env copies can be shredded with the keys |
| `~/.pm2/dump.pm2*` (including `dump.pm2.bak`) | Checked clean by step 9; older copies elsewhere in `~/.pm2` are listed by step 1 | Shred any listed copy with the keys |
| Earlier rotation folders (e.g. `identity-rotation-20261111T211343Z`) | Their `new.key` is the key in use until this run; their `old.key` an older one | Shred their key files and env copies once this run's rollback window closes |
| Historical copies listed in step 1 | Old key | Shred with the keys, or keep at 0600 if they are needed backups |

### 7.10 What to tell the testers

- **Before:** *"Between <hh:mm> and <hh:mm> (about 2 minutes) we are doing maintenance. If you write then, the reply will take a few extra minutes."* Nothing else changes for them: same number, same chat, no re-registration.
- **After:** the closing message (§7.6).
- **If a rollback is needed:** nothing changes for them either.

## 8. Web QA

The web QA deployment generated its own key at deploy time (`prestashop-local/qa/deploy-r4-web-qa.sh`). It has its own database (`r4-web-qa-canary-postgres`), channel `web`, rollout 100 % and no lists. Its run scripts read only `R4_MODEL_*`/`R4_SHIPPING_*` from `production.env`. So by construction it does **not** share the production key, and the production rotation leaves it alone. Step 1 checks this: if any `~/.config/r4-web-qa` file holds a production value, the rotation refuses.

**If it does, or the owner wants its key rotated too**, use the same tool against its own files. Rollout 100 % is accepted; web sessions are not allowlisted. With the web QA processes stopped:

```bash
W=~/.config/r4-web-qa; Q=~/backups/r4-web-qa/identity-rotation-$(date -u +%Y%m%dT%H%M%SZ); install -d -m 700 "$Q"
export R4_REPO=~/r4-web-qa
pm2 stop r4-web-qa-gateway r4-web-qa-worker r4-web-qa-scheduler
cp -p "$W/web.env" "$Q/"
node "$D/rotate.mjs" export-key --env-file "$W/web.env" --out "$Q/old.key"
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$Q/new.key"
node "$D/rotate.mjs" plan    --env-file "$W/web.env" --new-key-file "$Q/new.key"        # "ready": true
node "$D/continuity.mjs" snapshot --env-file "$W/web.env" --repo ~/r4-web-qa --out "$Q/continuity.json"
node "$D/rotate.mjs" apply   --env-file "$W/web.env" --new-key-file "$Q/new.key" --out "$Q/lists.env"
node "$D/rotate.mjs" install --env-file "$W/web.env" --new-key-file "$Q/new.key" --lists "$Q/lists.env" --old-env-file "$Q/web.env"
node "$D/rotate.mjs" verify  --env-file "$W/web.env" --key-from-env                     # "ok": true
node "$D/continuity.mjs" check --env-file "$W/web.env" --repo ~/r4-web-qa --snapshot "$Q/continuity.json"   # "ok": true
pm2 restart r4-web-qa-scheduler r4-web-qa-worker r4-web-qa-gateway
```

`continuity.mjs` needs the web QA checkout built with quote recovery (#85). If `~/r4-web-qa` is older, skip the two continuity lines; `verify` still proves the routing.

## 9. Exposure and access control

- **Plaintext wa_ids.** `channel_conversation_bindings.recipient_ref` holds the wa_id in plain text (it is the delivery address). `inbound_events.conversation_ref` holds it transiently. The rotation protects:
  - the lists in configuration;
  - the actor refs that reach the model;
  - log prefixes.

  It does not protect a dump.
- Keep needed backups at 0700/0600, and shred per §7.9.
- Limit SSH access to the operators.

## 10. History: first production rotation (2026-11-11 21:13–21:14 UTC)

Run with the earlier tools on 788f1f9.
- **Bindings:** 24/24 verified and rewritten (3 identities).
- **Window:** about 40 s, 0 holds.
- **Old key:** found in no process environment, no pm2 dump and no active env file.
- **Continuity:** confirmed by the owner's message at 21:29.
- **Restored-copy rehearsal** before it: 47 tables checksummed; only the bindings changed; the rollback restored them identically.
- **Backup:** `identity-rotation-20261111T211343Z` (see §7.9).

## 11. Tests

- `tests/integration/identity-hmac-rotation.test.ts` (real gateway, CLI):
  - the blockers;
  - the env shape;
  - rotation with the same bindings and tasks;
  - rollback;
  - the trigger back in force;
  - no secret printed.
- `tests/integration/identity-hmac-rotation-continuity.test.ts`: conversation continuity (§5). It needs `npm run build`: `continuity.mjs` runs the built lineage queries.
- `ops/r4-identity-rotation/local-rehearsal.sh`: both scripts end to end (§6).
