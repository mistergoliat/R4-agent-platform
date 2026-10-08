# R4 — CRM-Customer-360 Legacy Dependency & Decommission Audit

- **Date:** 2026-10-08, live evidence collected 19:07–19:30 UTC.
- **Mode:** read-only. Nothing was stopped, restarted, removed, reconfigured, committed or pushed.
- **EC2 access:** the same operator path used by earlier audits (`R4-J1D_PRODUCTION_CATALOG_CLOSURE.md:440`): `ssh ec2-user@98.80.166.131`, key `crm.pem`, `StrictHostKeyChecking=yes`.
- **How secrets were handled:**
  - No credential or raw env value was printed.
  - Env files were reduced to variable **names** plus a coarse target class (for example `[r4-postgres:55432]`).
  - Secret comparisons were done on the host and reported only as `EQUAL`/`DIFFERENT`.
  - DB queries were aggregate `SELECT`s on metadata and timestamps only. Phone numbers in logs were masked.
  - Temporary scripts were copied to `/tmp/r4audit_*.sh` and deleted after each run.

---

## A. Current Git baseline

| Repository | Local HEAD | Remote reference | Deployed on EC2 |
|---|---|---|---|
| R4-agent-platform | `aa974b7` (main, docs-only on top of `ae76a9e`) | origin/main = `aa974b7` | `ae76a9e` main, clean. `R4_BUILD_REF` in `production.env` still says `3d566cd`, an ancestor of `ae76a9e`, so the label is stale |
| CRM-Customer-360 | `8298723` (develop, 2026-09-25) | origin/develop = `8298723`; origin/main = `7ec0488` (stale since 2026-07-08) | `b2fd0c5` develop (2026-09-16), **13 dirty files** |
| MS-pesaschile-catalog-service | `3c1e9c4` | — | `b19fe20` (2 dirty files) |
| MS-pesaschile-customer-profile | `23a2ef3` | — | `23a2ef3` |
| MS-pesaschile-quote-service | `6735352` | — | `b504f75` (2 dirty files), process stopped |

All claims about the code below refer to the local HEADs above. All claims about the runtime refer to the deployed SHAs.

---

## B. CRM service inventory (live, EC2 `ip-172-31-1-183`, Amazon Linux 2023)

The host has 2 vCPU, 3835 MB RAM (1642 MB available) and no swap. Root FS is 10 GB with **1.9 GB free (81 % used)**.

### PM2 processes (user `ec2-user`, daemon PM2 v7.0.3; `dump.pm2` saved 2026-10-04 lists all 11)

| pm2 name | Status | Started / restarts | Command | RSS of process tree |
|---|---|---|---|---|
| `crm-web` | online | 2026-09-16 / 2 | `npm start` → `next-server v15.5.19`, listens `*:3000` | ≈ 350 MB (npm 78 + next 273) |
| `crm-outbox` | online | 2026-09-16 / 0 | `npm run worker:outbox --batch-size=1 --poll-ms=3000` → `npx tsx scripts/autonomous-outbox-worker.ts` | ≈ 370 MB (npm 77 + npm exec 91 + tsx 61 + node 141) |
| `crm-turn-settle` | online | 2026-09-16 / 5 | `npm run worker:turn-settle` → `npx tsx scripts/autonomous-turn-settle-worker.ts` | ≈ 380 MB (79 + 87 + 60 + 154) |
| `crm-followup` | **stopped** | 2026-09-11 / 20 | `npm run worker:followup` | 0 |
| `crm-commercial-work` | **stopped** | 2026-09-11 / 1 | `npm run worker:commercial-work` | 0 |

RSS sums overlap on shared pages. Treat ≈ 1.1 GB as an upper bound for CRM process RAM.

### Containers, configuration and files

| Item | Detail |
|---|---|
| Docker container `crm-customer-360-mariadb` | mariadb:11.4. Compose project `infra`, from `/home/ec2-user/CRM-Customer-360/infra/docker-compose.dev.yml` with `infra/.env`. Listens `127.0.0.1:3306`. Volume `infra_main_management_mariadb_data` (419 MB). `restart=unless-stopped`. RSS ≈ 210 MB |
| nginx (`/etc/nginx/nginx.conf`, single file, Certbot TLS for `98-80-166-131.sslip.io`) | `location = /v1/channels/whatsapp/webhook` → `127.0.0.1:8090` (R4 gateway). `location /` → `127.0.0.1:3000` (**crm-web**) |
| Checkout `/home/ec2-user/CRM-Customer-360` | 1.3 GB |
| Cron / systemd / timers | **None** for CRM. No user or root crontab and no CRM systemd units. Only OS timers exist |

### Other tenants on the same host (not CRM)

| Item | Detail |
|---|---|
| `r4-channel-gateway` | `:8090` |
| `r4-sales-worker` | — |
| `r4-scheduler` | — |
| `r4-production-postgres` | `127.0.0.1:55432`, compose dir `~/.config/r4` |
| `catalog-service` | `127.0.0.1:4010`. Reads PrestaShop MariaDB on a private VPC host `172.31.24.181:3306` |
| `customer-profile` | `*:3010` |
| `quote-service` | pm2 stopped, 2595 restarts |
| `pesaschile-quote-service-postgres` | Exited (255) 3 weeks ago |

**There is no n8n, Redis or Woo/PrestaShop DB on this host.**

---

## C. R4 dependency graph

```
Meta Cloud API ──HTTPS──> nginx :443 ──(location = /v1/channels/whatsapp/webhook)──> r4-channel-gateway 127.0.0.1:8090
                                                                                  │  verify token / X-Hub-Signature-256 / phone_number_id filter
                                                                                  ▼
                                                     r4-production-postgres 127.0.0.1:55432 (inbound_events, bindings, tasks, outbound_messages…)
                                                                                  ▲
         r4-sales-worker ── model (R4_MODEL_*) ── catalog-service 127.0.0.1:4010 ── pc-carrier (https, R4_SHIPPING_*)
         r4-scheduler    ── wakes / expiries / reconciliation
r4-channel-gateway ── DeliveryDispatcher ──HTTPS──> graph.facebook.com /{phone_number_id}/messages
```

There is **no edge from R4 to crm-web (:3000), the CRM MariaDB (:3306), CRM workers or CRM tables.**

**Code evidence (R4 @ aa974b7)**

- `eslint.config.js:13` forbids imports of `**/CRM-Customer-360/**` (ADR-001). `tests/contract/core-purity.test.ts` fails if `crm` appears in Core.
- The code reads no `CRM_*` or `HUB_*` env vars, contains no CRM URL, and has no mysql2/mariadb/redis client. The only DB is `pg` on `R4_DATABASE_URL`.
- The remaining CRM mentions are comments ("semantics audited from CRM-Customer-360 native webhook … never imported", `adapters/channels/whatsapp-cloud/src/config.ts:18`, `package.json:5`), test names, and docs.
- **No legacy fallback flag exists:** there is no `LEGACY_*`, `CRM_FALLBACK` or dual-run setting. `adapters/channels/whatsapp-cloud/src/inbound.ts:9` states explicitly that the CRM fallback is not ported. Rollback to CRM is a manual Meta-side runbook (`R4-I_PRODUCTION_CUTOVER_READINESS.md:212-219`), not a code path.

**Runtime evidence (`ss -tnp`, 19:07 UTC)**

- R4 pids 629556 (worker), 629602 (gateway) and 2662367 (scheduler) hold connections **only** to `127.0.0.1:55432`.
- The only host clients of `:3306` are pid 5716 (`crm-outbox`) and pid 133941 (`crm-turn-settle`).
- R4 `production.env` target classes: `R4_DATABASE_URL [r4-postgres:55432]`, `R4_CATALOG_BASE_URL [catalog:4010]`, `R4_WHATSAPP_GRAPH_BASE_URL [meta-graph]`, `R4_SHIPPING_BASE_URL [other-url]`, `R4_MODEL_BASE_URL [other-url]`. None of them points to CRM.

**Step-by-step owner of the production flow**

| Step | Owner / runtime | Evidence |
|---|---|---|
| WhatsApp inbound HTTP | nginx → R4 gateway | nginx `location =` rule. 964 Meta `POST /v1/channels/whatsapp/webhook` → 200 between 2026-09-28 and 2026-10-08 |
| Authentication and parsing | `@r4-adapters/whatsapp-cloud` (`inbound.ts:43-86`) | — |
| Ingress, dedup, autonomy decision | `packages/live-ops/src/ingress.ts` | `inbound_events`: 66 ingested, 183 rejected |
| Task / agent runtime | `r4-sales-worker` (`agents/sales/dist/cli/production.js --worker`) | — |
| Capabilities | catalog-service :4010, pc-carrier (https), `sales.workspace.update` (R4 PG) | — |
| Persistence | `r4-production-postgres` (21 MB DB) | — |
| Outbound | R4 gateway `DeliveryDispatcher` → Graph | `outbound_messages`: 52 `read`, 3 `cancelled`. Last 2026-10-07 21:42 UTC |
| Scheduling | `r4-scheduler` | — |

---

## D. WhatsApp ingress and outbound ownership

### Meta callback

Meta stopped sending to the CRM webhook on 2026-09-28:

- **Last** Meta `POST /api/integrations/whatsapp/webhook` (CRM): **2026-09-28 22:15:15 UTC**. The CRM `hub_audit_log` has its last `whatsapp.inbound.rejected` at `2026-09-28 18:15:15` local time, the same second.
- R4's `GET` verification was on 2026-09-28. The R4 kill switch was enabled at 2026-09-28 22:47 UTC ("controlled production smoke; rollout remains allowlist-only").
- From that point **all** Meta webhook traffic for the app reaches R4, and the CRM webhook receives nothing.
- Caveat: nginx logs on the host only go back to 2026-09-28 because of logrotate retention.

### Numbers and shared secrets

Comparisons were made on the host and only the result is shown.

| R4 var | CRM var | Result |
|---|---|---|
| `R4_WHATSAPP_PHONE_NUMBER_ID` | `META_WHATSAPP_DEFAULT_PHONE_NUMBER_ID` | **EQUAL** |
| `R4_WHATSAPP_ACCESS_TOKEN` | `META_ACCESS_TOKEN` | **EQUAL** |
| `R4_WHATSAPP_ACCESS_TOKEN` | `META_WHATSAPP_ACCESS_TOKEN` | DIFFERENT |
| `R4_WHATSAPP_APP_SECRET` | `META_WHATSAPP_APP_SECRET` | **EQUAL** |
| `R4_WHATSAPP_VERIFY_TOKEN` | `META_WHATSAPP_VERIFY_TOKEN` | **EQUAL** |

R4 now serves the business number that CRM was configured for. The two systems still **share Meta credentials**: CRM holds a token identical to R4's, plus a second token. Either system could send on that number. This is a single-writer risk. It is not a dependency.

### Second business number

The same Meta app delivers events for exactly **one other business number**:

| System | Period | Events for the other number | Distinct senders | Outcome |
|---|---|---|---|---|
| CRM | 2026-07-07 → 2026-09-28 | 458 | 154 | All rejected as `sender_not_allowed` |
| R4 | since 2026-09-28 | 183 | — | All rejected as `foreign_business_number` |

- Neither CRM nor R4 has ever served that number via this app. CRM retirement therefore changes nothing for it.
- Who answers those customers (WhatsApp Business app, n8n through another subscription, or nobody) is **not visible from this host**. See N-1.

### Number R4 serves

- All 66 ingested inbound events come from **1 distinct conversation key**.
- Rollout settings: `R4_PROD_ROLLOUT_PERCENT=0`, allowlist with 1 entry, `sales-production@3`.
- Event mix: 60 `autonomous`, 5 `human_owned`, 1 `held:autonomy_disabled`.

### CRM outbound state

| Item | Status |
|---|---|
| `crm-outbox` | Online with `BRAIN_OUTBOX_WORKER_ENABLED=true`, `BRAIN_META_SEND_ENABLED=true`, `BRAIN_OUTBOX_WORKER_ALLOW_REAL_SEND=true` |
| `brain_message_outbox` | 199 `sent`, 2 `failed`, 4 `cancelled`, **0 pending**. Last send 2026-09-16 19:14:07, which is also the last log line in `crm-outbox-out.log` |
| `conversation_message` | Last inbound 2026-09-16 19:13:58, last outbound 2026-09-14. **0 rows since 2026-09-17** |
| Other CRM send paths | Can still send with the shared token: operator manual reply (`/api/cases/[id]/reply`, `/api/conversations/[id]/reply`), `/api/brain/messaging/send-test`, `lib/meta.ts`. They are behind the hub session or the admin bypass token |

---

## E. Database and identity ownership

| Store | Owner | Users / consumers (evidence) | R4 use |
|---|---|---|---|
| `r4-production-postgres` (`r4_production`, 21 MB) | R4 | R4 gateway, worker and scheduler only | Sole R4 store |
| MariaDB `main_management` (42 tables, 9.9 MB) | CRM | `crm_app` (crm-web, crm-outbox, crm-turn-settle). **customer-profile** `CRM_DB_*` → local MariaDB / `main_management` | none |
| MariaDB `rfm_snapshot` (21 tables, 146.7 MB) | Customer Intelligence (customer-profile). User `rfm_boss` | **customer-profile** `RFM_SNAPSHOT_DB_*`, `CLUSTER_DB_*`, `ANALYTICS_DB_*` → local MariaDB / `rfm_snapshot` | none |
| MariaDB `crm_test` (53 tables, 5.8 MB), `crm_dev`, `crm_legacy_fixture` (empty) | CRM dev/test | Grants to `crm_app` / `crm_dev_admin` | none |
| PrestaShop / pc_pos | external (RDS / VPC host) | catalog-service, customer-profile, CRM (optional) | indirect, via catalog-service only |

### Customer identity

- **R4:** R4 does not resolve customer identity. `agents/sales/src/production/composition.ts:160-163` sets `customerRef: null`, and `profile.ts:31` declares Customer UNAVAILABLE. The only identity R4 uses is an HMAC of `(channel, phone_number_id, wa_id)` stored in `channel_conversation_bindings`.
- **CRM:** the identity tables (`customer_external_identity`, 13 rows, last write 2026-09-14; `master_customer`) are CRM-owned and have no R4 consumer.
- **Conclusion:** R4 needs no CRM identity resolution, because the current profile has none by design.

---

## F. Shared infrastructure

| Resource | Shared by | Classification consequence |
|---|---|---|
| MariaDB container, image and volume | CRM **and customer-profile** (`main_management` + `rfm_snapshot`) | **Cannot be retired with CRM** |
| Compose project for MariaDB | Lives in the CRM checkout (`CRM-Customer-360/infra/docker-compose.dev.yml` + `infra/.env`) | Removing the checkout orphans the MariaDB compose definition. The definition must be kept or moved first |
| nginx `nginx.conf` | R4 webhook location + CRM catch-all | Edit only the `location /` block. The R4 webhook location must stay byte-identical |
| Meta app (callback URL, app secret, verify token) | R4 (active), CRM (holds identical copies) | Rotate before retiring, then remove CRM's copies |
| Meta access token | R4 = CRM `META_ACCESS_TOKEN` | Revoking "CRM's token" **revokes R4's**. Issue a new token to R4 first |
| catalog-service :4010 | R4, CRM, customer-profile | Unaffected |
| customer-profile :3010 (bound `*`) | CRM web (`CUSTOMER_PROFILE_API_URL`, `MARKETING_COPILOT_*`) | Unaffected by CRM retirement. It loses one consumer |
| `~/.npm` cache (502 MB `_cacache`, 62 MB `_npx` incl. `tsx@4.20.5` used by CRM workers) | All Node services | Not CRM-exclusive. Do not count it as recoverable |
| `/var/lib/docker`, journald, root FS | All | — |
| Redis | none on host | — |
| n8n | not on host. CRM `N8N_BASE_URL [n8n]` is a health ping only. n8n is a *caller* of CRM `/api/brain/process-inbound`, `/api/ai/orchestrate` | nginx shows **0** such calls since 2026-09-28. Direct `:3000` callers: 0 in 6 samples. Retention is too short to prove absence → N-3 |

---

## G. Live runtime evidence (CRM web consumers)

nginx access logs cover 2026-09-28 → 2026-10-08. Scanner 404 traffic was excluded.

| Path (CRM web) | Hits | Client | Last seen |
|---|---|---|---|
| `POST /api/auth/login` 200 | 6 | browser (one operator IP) | 2026-10-07 |
| `GET /api/catalog/products/search` 200 | 11 | browser | 2026-10-07 |
| `GET /api/catalog/products/:id/context` 200 | 17 | browser | 2026-10-07 |
| `GET /api/audiences/schema` 200 | 1 | browser | 2026-09-30 |
| `POST /api/integrations/whatsapp/webhook` 200 | 12 | Meta | 2026-09-28 |
| `/api/brain/*`, `/api/ai/orchestrate`, `/api/brain/outbox/worker` | 0 | — | — |
| UI pages (non-API 200s) | 19–151 per day | browser | 2026-10-08 |

- **crm-web still has a human user.** It is used for catalog lookup and Customer Intelligence (audiences). It is not used for WhatsApp.
- `crm-web-error.log` (277 lines) contains only the known `Failed to find Server Action` noise.

---

## H. Disk and RAM assessment (measured 2026-10-08)

Root FS: `/dev/nvme0n1p1` 10 G, 8.1 G used, **1.9 G available**. Inodes 5 %. Everything (Docker included) is on this FS.

| Consumer | Size | Owner | Exclusive? |
|---|---|---|---|
| `/usr` | 2.6 G | OS | — |
| `/home/ec2-user/CRM-Customer-360` | **1.3 G**: `node_modules` 592 M, `.next` 541 M, `.git` 50 M, `docs` 34 M, `tmp` 15 M, `artifacts` 2.3 M | CRM | yes, except `infra/` (MariaDB compose) |
| `/var/lib/docker/containers/a9947f6d…` (`pesaschile-quote-service-postgres` json log, **989 179 937 B**, last write 2026-09-14, container Exited) | **944 M** | **Quote Service** (not CRM) | yes |
| `/var/lib/docker/overlay2` + images (postgres:16-alpine 294 M, mariadb:11.4 334 M) | 626 M | shared | no |
| Volume `infra_main_management_mariadb_data` | 419 M | **shared** (CRM + customer-profile) | no |
| Volume `r4-production-postgres-data` | 76 M | R4 | yes |
| Volume `ms-pesaschile-quote-service_postgres-data` | 47 M | Quote | yes |
| Volume `r4-agent-platform_r4-postgres-data` (**0 links**, R4 dev-compose leftover) | 46 M | R4 | yes |
| `~/services/*` (catalog 202 M, customer-profile 252 M, quote 192 M) | 645 M | services | — |
| `~/.npm` | 563 M | shared cache | no |
| `/var/log/journal` | 304 M | OS | — |
| `~/R4-agent-platform` | 163 M | R4 | — |
| `~/.pm2/logs` (CRM share ≈ 15 M: `crm-followup-error.log` 11.4 M, `crm-followup-out.log` 3.4 M) | 23 M | mixed | — |

**Docker logging** uses the `json-file` driver with no `max-size`, and there is no `/etc/docker/daemon.json`. Any new container (Quote V2) will grow its log without bound unless log options are set.

**RAM**

| Item | RAM |
|---|---|
| CRM processes (≈ 1.1 G upper bound) | crm-web ≈ 350 M, crm-outbox ≈ 370 M, crm-turn-settle ≈ 380 M |
| MariaDB (shared, stays) | 210 M |
| Recoverable by retiring CRM workers only | ≈ 0.75 G |
| Recoverable by retiring crm-web as well | ≈ 1.1 G |

Stopping processes recovers **no disk**.

---

## I. Decommission classification

| # | Component | Class | Consumers | Proof | Disk / RAM recoverable |
|---|---|---|---|---|---|
| 1 | pm2 `crm-followup` (stopped) | **RETIRE_NOW** | none | Stopped since 2026-09-11. Not needed by anything | 0 disk (logs ≈ 15 M) / 0 RAM |
| 2 | pm2 `crm-commercial-work` (stopped) | **RETIRE_NOW** | none | Stopped since 2026-09-11. `crm_commercial_work` has 2 stale rows (1 ACTIVE, 1 WAITING_CUSTOMER), untouched since 2026-09-16 | 0 / 0 |
| 3 | pm2 `crm-outbox` | **RETIRE_NOW** | none | 0 pending rows. Last send 2026-09-16. No inbound since 2026-09-28 (Meta → R4). It holds the real-send flags on the shared number, so stopping it **reduces** dual-writer risk | ≈ 370 M RAM |
| 4 | pm2 `crm-turn-settle` | **RETIRE_NOW** | none | Settles CRM inbound turns. 0 inbound since 2026-09-16 (DB) / 2026-09-28 (Meta) | ≈ 380 M RAM |
| 5 | CRM WhatsApp webhook route + inline agent loop (inside crm-web) | **RETIRE_NOW (functionally inert)** | none | Meta callback points to R4. The nginx exact-match location sends the webhook to R4, and the CRM route has received 0 hits since 2026-09-28 22:15 UTC. Retired together with #6 | — |
| 6 | pm2 `crm-web` (Next.js :3000, nginx `location /`) | **KEEP_TEMPORARILY → MIGRATE_FIRST** | operator browser: login, `/catalog`, catalog API, audiences, UI pages through 2026-10-08; possibly n8n (unproven) | nginx log (§G) | ≈ 350 M RAM; enables #7 |
| 7 | CRM checkout build output (`.next` 541 M, `node_modules` 592 M) | **KEEP_TEMPORARILY** (follows #6) | crm-web, CRM workers | — | **≈ 1.13 G disk** |
| 8 | CRM checkout source + `.git` + `infra/` | **KEEP_TEMPORARILY** | MariaDB compose definition lives in `infra/` | docker labels | ≈ 0.1 G |
| 9 | MariaDB container + image + volume | **SHARED_DO_NOT_DELETE** | customer-profile (`main_management`, `rfm_snapshot`), CRM | §E | 0 |
| 10 | MariaDB schemas `crm_test`, `crm_dev`, `crm_legacy_fixture` in prod | **UNKNOWN_BLOCKED** (owner) | none observed | Test/dev data in a prod instance | ≈ 6 M, negligible |
| 11 | CRM copies of Meta secrets (`META_ACCESS_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`, app secret, verify token, `BRAIN_META_*`) | **MIGRATE_FIRST** | R4 shares identical values | §D | — |
| 12 | Second business number events (other `phone_number_id`) | **UNKNOWN_BLOCKED** (owner) | served by neither system via this app | §D | — |
| 13 | nginx `location /` → :3000 | **KEEP_TEMPORARILY** (follows #6) | operator UI | — | — |

### Procedures per item

**Items 1–2**

- Retire: `pm2 delete crm-followup crm-commercial-work && pm2 save`.
- Recover:
  - `pm2 start npm --name crm-followup --cwd ~/CRM-Customer-360 -- run worker:followup -- --poll-ms=5000 --limit=1`
  - `pm2 start npm --name crm-commercial-work --cwd ~/CRM-Customer-360 -- run worker:commercial-work`
  - Then `pm2 save` (args recorded in §B).
- STOP if `pm2 ls` shows any R4 or other process changing state.

**Items 3–4**

- Retire: `pm2 stop crm-outbox crm-turn-settle` and observe. `pm2 delete` + `pm2 save` only after the observation window.
- Recover: `pm2 start crm-outbox crm-turn-settle`.
- STOP before stopping if `brain_message_outbox` has any non-terminal row, or if `conversation_message` has any row newer than 2026-09-17. Either means the live CRM has resumed receiving traffic.
- STOP after stopping if crm-web or customer-profile errors increase.

**Item 6**

- Retire only after the operator's catalog and audiences use has a replacement. Then:
  1. `pm2 stop crm-web`.
  2. Change nginx `location /` to `return 410;`, keeping the R4 webhook block unchanged. Run `nginx -t && systemctl reload nginx`.
- Recover: restore `nginx.conf` from a pre-change copy, run `pm2 start crm-web`, then reload nginx.
- STOP if the R4 webhook returns anything other than 200 for Meta POSTs, or `nginx -t` fails.

**Item 7**

- Retire: archive off-host first (`.env`, `infra/.env`, `.git`). Then remove `.next` and `node_modules` only.
- Recover: `npm ci && npm run build` (needs ≈ 1.2 G free).
- STOP if crm-web is still running.

**Item 11**

1. Issue a **new** token held only in R4's `production.env`, and restart the R4 gateway.
2. Verify that R4 outbound succeeds on the allowlisted smoke recipient.
3. Revoke the old token.
4. Remove the Meta keys from the CRM `.env`.

STOP if R4 outbound returns 401/403 after step 1.

---

## J. Reversible validation strategy (R4 without CRM)

Production already demonstrates this. Since 2026-09-28, R4 has handled 66 inbound and 52 delivered outbound events with **zero** TCP connections to `:3000` or `:3306` and no CRM inbound. The test below makes that proof explicit and repeatable without touching live CRM.

### Isolated test (local or a throwaway EC2 shell; no prod services touched)

1. **Network isolation.** Create `docker network create --internal r4-iso`. On it, run only:
   - a disposable `postgres:16-alpine`;
   - R4 gateway, worker and scheduler built from `ae76a9e`;
   - a stub HTTP server playing Graph, catalog and pc-carrier.

   Nothing on `r4-iso` can resolve or reach a CRM host. Also add `crm` and `mariadb` hostnames that point to a sink, which records any connection attempt as a test failure.
2. **Startup and readiness.** Run `db:migrate → sales:migrate → production:sales:bootstrap`, start the three processes, and check that `/ready/r4` is 200.
3. **Recovery.** Seed a running task and a pending `task_wait`. Kill the worker and scheduler, restart them, and assert that the Task and Goal resume. The lease is reclaimed and the wake fires.
4. **Inbound.** POST a signed webhook fixture (test app secret) to the gateway. Assert `inbound_events` and the binding are written. Also post a foreign `phone_number_id` and assert it is rejected.
5. **Outbound.** Assert `outbound_messages` → stub Graph `POST /{id}/messages` → `read` status callback → `outbound_delivery_events`.
6. **Identity.** Assert `customerRef = null` and that no customer lookup is attempted. The current profile requires none.
7. **Capabilities.** Assert that the worker calls the catalog and shipping stubs and the `sales.workspace.update` capability.
8. **No silent fallback.** The sink records **0** connections to any CRM or MariaDB hostname or port. Also grep the process environment for `CRM_`, `DATABASE_HOST`, `META_` = none.

**Rollback:** `docker network rm r4-iso` plus removing the containers. Nothing persists.

### Production confirmation (passive, read-only)

- Before and after stopping the CRM workers (§K step 2), sample the following over 72 h:
  - `ss -tnp` for R4 pids;
  - nginx 2xx for the R4 webhook;
  - `outbound_messages` delivery;
  - `pm2 ls` restart counts.
- R4 must be unchanged.

---

## K. Ordered retirement procedure

1. **Preflight (read-only).** Re-run §D checks:
   - `brain_message_outbox` has 0 non-terminal rows;
   - `conversation_message` has no rows after 2026-09-17;
   - nginx has no Meta POST to `/api/integrations/whatsapp/webhook`.

   Snapshot `pm2 jlist` (names and args only) and `nginx -T`.
2. `pm2 stop crm-outbox crm-turn-settle`. Observe for 72 h (§J). Then `pm2 delete crm-outbox crm-turn-settle crm-followup crm-commercial-work && pm2 save`. *(Engine retired; ≈ 0.75 G RAM recovered.)*
3. **Credential separation (§I item 11).** Run this before or together with step 2. Until it is done, CRM can still send on R4's number through crm-web operator replies.
4. **Owner decisions N-1…N-4.**
5. **Migrate operator use of crm-web** (catalog lookup, audiences, Customer Intelligence UI) to its new home.
6. Stop crm-web and switch nginx `location /` to 410. Keep the R4 location intact.
7. **Move MariaDB compose ownership** out of `CRM-Customer-360/infra` (for example to `~/.config/mariadb`). Use the same project name `infra` and the same volume name so `docker compose` adopts the existing container without recreating it. Validate with `docker compose config`, without `up`.
8. Archive the CRM `.env` files and `.git` off-host. Remove `.next` and `node_modules`. *(≈ 1.13 G disk.)*
9. Keep MariaDB, `main_management` and `rfm_snapshot` until customer-profile's owner migrates or accepts the store.

---

## L. Expected capacity recovered

| Action | Disk | RAM | Blocked by |
|---|---|---|---|
| Retire CRM workers (step 2) | ≈ 0 (logs ≈ 15 M) | ≈ 0.75 G | nothing (preflight only) |
| Retire crm-web + build output (steps 6–8) | ≈ 1.13 G (1.25 G with docs/tmp) | ≈ 0.35 G | operator UI migration, N-2/N-3 |
| **CRM total** | **≈ 1.1–1.3 G** | **≈ 1.1 G** | |
| MariaDB | 0 (shared) | 0 | — |

**Non-CRM items** (other owners, listed only because they dominate disk):

| Item | Disk | Owner |
|---|---|---|
| Exited `pesaschile-quote-service-postgres` container log | 944 M | Quote |
| Orphan `r4-agent-platform_r4-postgres-data` volume | 46 M | R4 |
| Journald | 304 M | OS |

---

## M. Quote V2 deployment implications

**Headroom needed for a 1.12 GB image pull on a single 10 GB FS**

| Component | Size |
|---|---|
| Extracted image | 1.12 G |
| Compressed layers held during pull | ≈ 0.4–0.6 G transient (unknown how much is shared with `postgres:16-alpine`) |
| Container writable layer + first-week logs | ≈ 0.1 G (log size must be capped) |
| Safety floor | ≥ 1.0 G (10 % of FS) for MariaDB, R4 Postgres and journald writes |
| **Required free before pull** | **≥ 3.0 G** |

**Measured free: 1.9 G → NOT READY.**

**Paths to ≥ 3.0 G free**

| Path | Free afterwards | Blocked by | Owner |
|---|---|---|---|
| A. CRM-only (§K steps 6–8) | ≈ 3.0–3.2 G | operator UI migration | CRM owner |
| B. Quote-owned: remove the exited legacy `pesaschile-quote-service-postgres` **container**, keeping its named volume (`docker rm`, not `-v`) | ≈ 2.85 G | Quote owner decision | Quote owner |
| C. B plus journald limit (`journalctl --vacuum-size=100M`) | ≈ 3.0 G | OS admin decision | OS admin |

Path A is CRM-only. Path B frees 944 MB of log while preserving data, and Quote V2 likely supersedes that container. Path C is OS-level.

**Conclusion:** Path B+C is the **only route that reaches the threshold without waiting for a CRM migration**. In every case, set `--log-opt max-size=50m --log-opt max-file=3` (or a `daemon.json`) for the Quote V2 container.

Quote V2 also needs its own Postgres. The exited container's volume is 47 M, and the deployment must account for its growth.

---

## N. Blockers and required owner decisions

| # | Decision | Why it blocks |
|---|---|---|
| N-1 | **Second business number.** 154 customers since July have written to a number that this Meta app delivers but neither CRM nor R4 serves. Who answers them (WhatsApp Business app, n8n through another app or override, nobody)? | Not a CRM retirement blocker, since CRM never served it. It is a business-visible gap that this audit surfaced |
| N-2 | Who uses crm-web today (one operator IP: login, catalog lookup, audiences), and where those functions move | Blocks full CRM retirement |
| N-3 | Does any n8n workflow still call CRM (`/api/brain/process-inbound`, `/api/ai/orchestrate`, other) directly or through nginx? Logs only cover 10 days. Confirm in n8n itself | Blocks full CRM retirement |
| N-4 | Meta credential separation: new R4-only token, revoke shared token, remove CRM copies. App secret and verify token are also shared | Single-writer guarantee (`R4-I_PRODUCTION_CUTOVER_READINESS.md:79-83`) is **not** met today |
| N-5 | MariaDB ownership after CRM: customer-profile depends on `main_management` and `rfm_snapshot`; compose definition must move out of the CRM checkout | Blocks deleting the CRM checkout |
| N-6 | Quote owner: may the exited legacy Quote Postgres container (944 M log) be removed, keeping its volume? | Fastest disk path for Quote V2 |
| N-7 | Doc drift: `R4-I_PRODUCTION_CUTOVER_READINESS.md` / README still say "BLOCKED / número productivo en CRM". Live state: Meta callback → R4 since 2026-09-28, R4 on CRM's configured number, rollout allowlist-only. `R4_BUILD_REF` label is stale | Governance. Not a runtime blocker |

---

## Final flags

```
R4_DEPENDS_ON_CRM_RUNTIME=NO
R4_DEPENDS_ON_CRM_DATABASE=NO
R4_DEPENDS_ON_CRM_WHATSAPP=NO
CRM_LEGACY_ENGINE_RETIREMENT_READY=YES
CRM_FULL_DEPLOYMENT_RETIREMENT_READY=NO
QUOTE_DEPLOYMENT_DISK_CAPACITY_READY=NO
```

**Basis for each flag**

- **R4_DEPENDS_ON_CRM_RUNTIME=NO:** no code path, env target or live TCP connection from R4 to CRM. R4 runs with the CRM engine inert since 2026-09-16.
- **R4_DEPENDS_ON_CRM_DATABASE=NO:** R4 pids connect only to `:55432`.
- **R4_DEPENDS_ON_CRM_WHATSAPP=NO:** R4 receives directly through nginx and sends directly to Graph. It shares **credentials** with CRM (N-4), but it depends on nothing that CRM runs.
- **CRM_LEGACY_ENGINE_RETIREMENT_READY=YES:** applies to the workers (`crm-outbox`, `crm-turn-settle`, `crm-followup`, `crm-commercial-work`) and the inert webhook loop, subject to the §K step 1 preflight.
- **CRM_FULL_DEPLOYMENT_RETIREMENT_READY=NO:** crm-web has a live human user, MariaDB is shared with customer-profile, and N-3 and N-4 are open.
- **QUOTE_DEPLOYMENT_DISK_CAPACITY_READY=NO:** 1.9 G free against a ≥ 3.0 G requirement.

**Smallest safe next action:**

1. Run the §K step 1 preflight.
2. Then run `pm2 stop crm-outbox crm-turn-settle` on EC2. This is reversible with `pm2 start`, recovers ≈ 0.75 G RAM, and removes the only running process that holds real-send rights on R4's number.
3. In parallel, ask the Quote owner for N-6. That is the only disk path to Quote V2 that does not wait on CRM migration.
