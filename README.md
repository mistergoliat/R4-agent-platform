# R4 Agent Platform

Plataforma agéntica reutilizable e independiente del CRM. Fases implementadas:
**R4-B — Platform Skeleton** (contratos, persistencia durable, API mínima,
telemetría), **R4-C1 — Execution Kernel** (worker con leases/heartbeats/fencing,
Agent Kernel, `AgentDecision`, capabilities READ, observations, budgets y
recuperación) y **R4-C2 — Context Compiler & Memory Boundaries** (contexto
estructurado, acotado y reproducible por decisión; autoridad y frescura
explícitas; memoria task-scoped; compaction no autoritativa; `ContextSnapshot`
durable antes de cada llamada al modelo). **R4-D — Governed Execution**:
el agente propone efectos
(`propose_action`); una Policy Engine determinista decide; la plataforma crea
un comando con execution key propia, lo ejecuta mediante un `ActionExecutor`
separado, se recupera de crashes sin duplicar efectos y sólo informa el
resultado con un `ActionReceipt` inmutable. **R4-E — Temporal + Human Runtime**:
esperas durables (`WAIT_FOR_INPUT`,
`WAIT_UNTIL` interrumpible por input), scheduler como proceso independiente,
consultation / approval / handoff (también iniciado por un operador),
reconciliación durable de efectos inciertos, cancelación honesta, goals con raíz
y foco y continuidad conversacional entre runs.

**R4-F — Sales Reference Application** (publicado; R4-F BASELINE `1927499`) es el primer workload y vive **fuera de Core**: el Sales Agent Pack
(`agents/sales`), ports de dominio con fixtures (`adapters/domains`) y el primer
adapter de modelo real (`adapters/models/openai-compatible`). Core no contiene
ningún concepto de ventas ni de proveedor; no hay writes de dominio de
producción (los servicios reales no están documentados aquí: sus adapters live
están pendientes).

**R4-G — Quality & Learning** (**completado**; baseline R4-F
LIVE-VALIDATED `001b7a8`): evaluación post-hoc de trayectorias terminadas —
findings, taxonomía de fallos, outcomes separados, métricas, grounding,
regresiones, benchmarks con repeticiones y experimentos — fuera de la ejecución
de Core y sin modificar agentes (ADR-025, ADR-026).

**R4-H — Shadow / E2E** (**cerrado**; R4-H BASELINE `80a1733`; baseline
R4-G `4a54b2c`): workloads realistas sobre el runtime real con modelo real y
efectos sólo shadow — modo shadow explícito, bindings declarados, side-effect
manifest, outbound sink sin entrega, corpus de workloads y suites evaluadas
por R4-G (ADR-027).

**Post-H Architecture Gap Review** (gate humano, no una fase): GAP-H-001
confirmado y **resuelto** (ADR-028, `dd06a68`):
una run que falla por `invalid_decision` o por un `model_failure` reintentable
ya no termina la task — una run nueva con contexto recién compilado la
continúa (acotado, default 1); al agotarse, o ante un fallo no reintentable, la
task queda `blocked` con un handoff de plataforma en `/v1/attention`.

**R4-I — Governed Production** (**en progreso**, pendiente de auditoría;
R4 POST-H RECOVERY BASELINE `dd06a68`): modo producción explícito y
fail-closed, ingress canónico de un canal real (WhatsApp Cloud API, número
canary propio), binding durable conversación → task, entrega durable e
idempotente con un único dueño y resultados `unknown` honestos, rollout
estable (default 0 %), kill switch durable (default deshabilitado), plano de
operador por API y validación offline reproducible (ADR-029). Sin despliegue ni
tráfico real de clientes.

El número productivo existente y su historia operacional siguen en
CRM-Customer-360. Para el número canary que recibe directamente R4, R4 conserva
el estado operacional necesario para ejecutar su Task, incluido inbound,
binding, inputs/hilo y lifecycle outbound. La identidad maestra y el historial
CRM de largo plazo siguen externos; R4-I no sincroniza el hilo con CRM.

Lectura obligatoria antes de cambios de arquitectura: [AGENTS.md](AGENTS.md),
[Constitución](docs/architecture/R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md),
[PRD](docs/architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md),
[Arquitectura](docs/architecture/R4_ARCHITECTURE.md),
[Ownership](docs/architecture/OWNERSHIP_MATRIX.md),
[Roadmap](docs/roadmap/R4_DELIVERY_ROADMAP.md), [ADRs](docs/adr/).

## Requisitos

- Node.js ≥ 20.19 (`.nvmrc`), npm 10
- Docker (sólo para PostgreSQL local)

## Arranque local

```bash
npm install
npm run db:up           # PostgreSQL 16 en 127.0.0.1:55432 (docker compose)
cp .env.example .env    # valores sólo para desarrollo local
npm run build
npm run db:migrate      # explícito: la API nunca migra sola
npm start               # http://127.0.0.1:8080
```

Variables (ver `.env.example`):

| Variable | Default | Descripción |
|---|---|---|
| `R4_DATABASE_URL` | — (obligatoria) | `postgres://…` |
| `R4_HTTP_HOST` | `127.0.0.1` | La API no tiene autenticación en R4-B: no exponer fuera de loopback/red privada |
| `R4_HTTP_PORT` | `8080` | |
| `R4_LOG_LEVEL` | `info` | |
| `R4_AGENT_DEFINITIONS_DIR` | `./agents` | Busca `*.agent.json` recursivamente |
| `R4_DB_POOL_MAX` | `10` | |

Si el esquema no está al día, la API no arranca (`schema_not_current`).

### Worker (R4-C1)

El worker es un proceso separado de la API que sólo comparte PostgreSQL. Se
compone con `runWorkerProcess(loadWorkerConfig(process.env), { modelProvider,
capabilities })`: C1 no incluye proveedor de modelo real ni capabilities de Core,
por lo que todavía no hay un `main` de producción (ver roadmap §4). Los tests lo
ejecutan con `FakeModelProvider` y la capability sintética
`platform_test.get_test_fact`, incluido un proceso real terminado con SIGKILL.

| Variable | Default | Descripción |
|---|---|---|
| `R4_WORKER_ID` | `host:pid:random` | Identidad del worker en leases y logs |
| `R4_WORKER_LEASE_MS` | `30000` | Duración del lease |
| `R4_WORKER_HEARTBEAT_MS` | `10000` | Debe ser ≤ lease/2 |
| `R4_WORKER_POLL_MS` | `1000` | Intervalo de polling cuando no hay trabajo |
| `R4_EXEC_MAX_ITERATIONS` | `50` | Techo por run (el budget de la task puede reducirlo) |
| `R4_EXEC_MAX_MODEL_CALLS` | `50` | 〃 |
| `R4_EXEC_MAX_READ_CALLS` | `50` | 〃 |
| `R4_EXEC_MAX_RUN_DURATION_MS` | `900000` | 〃 (incluye tiempo huérfano tras un crash) |
| `R4_EXEC_MODEL_CALL_TIMEOUT_MS` | `60000` | Por llamada; acotado por la duración restante |
| `R4_EXEC_MAX_RUN_RECOVERIES` | `3` | Takeovers antes de abandonar un run (`lease_lost`) |
| `R4_EXEC_MAX_RUN_FAILURE_RECOVERIES` | `1` | (ADR-028) Runs nuevas tras fallos recuperables consecutivos (`invalid_decision`, `model_failure` reintentable) antes de pasar la task a un humano; `0` = handoff al primer fallo |
| `R4_EXEC_MAX_WRITE_ACTIONS` | `0` | (D) Acciones de escritura por task (el `maxWrites` de la task puede reducirlo). `0` = el worker no escribe; con `0` las capabilities de escritura ni se ofrecen al modelo |
| `R4_CONTEXT_BUDGET_MODE` | `unbounded` | Presupuesto de contexto (ADR-015): `unbounded` = R4 no impone límite propio (nada se excluye ni compacta por presupuesto); `fixed` = acotado |
| `R4_CONTEXT_MAX_TOKENS` | — | Obligatorio sólo con `fixed`: techo en tokens estimados. `contextPolicy.maxContextTokens` del agente puede ajustarlo en ambos modos |
| `R4_CONTEXT_RECENT_TURNS` | `20` | Turnos recientes que se mantienen crudos cuando hay que compactar (sólo `fixed`) |
| `R4_CONTEXT_COMPACTION_CHUNK` | `10` | El prefijo compactado crece en bloques de N turnos |
| `R4_CONTEXT_EXPIRED_EVIDENCE` | `include` | `include`: evidencia expirada queda como `history` (nunca como verdad actual); `exclude`: se omite |

La compaction (sólo con presupuesto `fixed`) requiere un `ContextCompactor` en los bindings del worker
(`{ modelProvider, capabilities, compactor?, contextSources? }`); C2 sólo trae
el determinístico. `contextSources` registra fuentes adicionales (p. ej. estado
de dominio fuera de Core) sin modificar el compilador.

(R4-D) Las capabilities de escritura se registran con `registry.registerWrite({
definition, recovery: 'idempotent_replay' | 'reconcile_before_retry', input,
output, execute, reconcile? })`: el handler recibe la execution key de la
plataforma y debe aplicar a lo sumo un efecto por clave. La política se inyecta
con `actionPolicy` en los bindings (default `DEFAULT_ACTION_POLICY`: reversible
autónomo; irreversible, financiero y comunicación externa requieren aprobación
o identidad verificada; privilegiado denegado). `REQUIRE_APPROVAL` deja la task
en `requires_approval` hasta que un humano decide (R4-E); un resultado que no
puede establecerse deja la task `blocked` y la ejecución `needs_reconciliation`,
con su trabajo de reconciliación creado en la misma transacción (R4-E). Cada
worker, antes de reclamar tasks, resuelve la reconciliación despachada por el
scheduler con sus capabilities (`reconcile`, misma execution key).

### Scheduler (R4-E)

Proceso separado que sólo comparte PostgreSQL y sólo posee el tiempo: reclama
schedules vencidos (esperas hasta una fecha, expiraciones, backoff de
reintentos, reconciliación) y despierta o despacha. Sin modelo ni capabilities.

```bash
npm run build
R4_DATABASE_URL=postgres://r4:r4_local_only@127.0.0.1:55432/r4 \
R4_RECONCILIATION_MAX_ATTEMPTS=5 R4_RECONCILIATION_INITIAL_BACKOFF_MS=1000 \
R4_RECONCILIATION_MAX_BACKOFF_MS=60000 R4_RECONCILIATION_DEADLINE_MS=86400000 \
npm run start:scheduler
```

| Variable | Default | Uso |
|---|---|---|
| `R4_SCHEDULER_ID` | `scheduler-<host>-<pid>` | Owner de los leases de schedules |
| `R4_SCHEDULER_LEASE_MS` | `30000` | Lease de un schedule reclamado |
| `R4_SCHEDULER_POLL_MS` | `1000` | Ritmo de sondeo (no afecta qué vence) |
| `R4_RECONCILIATION_MAX_ATTEMPTS`, `_INITIAL_BACKOFF_MS`, `_MAX_BACKOFF_MS`, `_DEADLINE_MS` | **sin default** | Política de reconciliación: el proceso no arranca sin ella |

Para detener PostgreSQL: `npm run db:down` (el volumen `r4-postgres-data` se conserva).

### Sales Reference Application (R4-F)

Agent Pack fuera de Core ([arquitectura §15](docs/architecture/R4_ARCHITECTURE.md),
[ADR-023](docs/adr/ADR-023-sales-reference-application.md),
[ADR-024](docs/adr/ADR-024-openai-compatible-model-provider.md)). Su estado
(esquema `sales`) tiene migración propia:

```bash
npm run build
npm run db:migrate && npm run sales:migrate     # Core, luego el pack
npm run sales:e2e                               # sin modelo: escenario central scripted (offline)
npm run sales:e2e -- --scenario S06             # cualquier escenario S01–S17 / CENTRAL, scripted
npm run sales:e2e -- --interactive --customer cust-demo-001   # conversación real (requiere R4_MODEL_*)
npm run sales:live                              # escenarios representativos contra el modelo configurado
```

`sales:e2e` y `sales:live` crean una base desechable por ejecución con
`R4_SALES_ADMIN_DATABASE_URL` / `R4_TEST_DATABASE_URL` (default: el PostgreSQL
local de `docker compose`). `sales:live` escribe artifacts JSON (turnos,
decisiones, capabilities, observations, goals, workspace, receipts, tokens,
latencia, contexto por kind) en `artifacts/sales-live/<timestamp>/` (ignorado por
git); sin credenciales imprime `live provider smoke not executed: credentials
unavailable` y termina con 0. Las diferencias de comportamiento de un modelo
real nunca fallan CI.

Modelo (configuración de despliegue; la AgentDefinition no tiene proveedor ni secreto):

| Variable | Default | Descripción |
|---|---|---|
| `R4_MODEL_PROVIDER` | — | `openai_compatible` activa el adapter; ausente = sin modelo real |
| `R4_MODEL_BASE_URL` | — | Endpoint OpenAI-compatible (hospedado, vLLM, servidor local) |
| `R4_MODEL_API_KEY` | — | Opcional; sólo viaja en el header `Authorization` |
| `R4_MODEL_NAME` | — | Modelo lógico del endpoint |
| `R4_MODEL_PROFILE` | `default` | Nombre de perfil en telemetría (`openai-compatible.<profile>`) |
| `R4_MODEL_CONTEXT_WINDOW_TOKENS` | — | Envelope físico: lo que no cabe se rechaza (`model_envelope_exceeded`), nunca se trunca |
| `R4_MODEL_MAX_OUTPUT_TOKENS` | `2048` | Salida reservada |
| `R4_MODEL_TIMEOUT_MS` | `120000` | Deadline de transporte del adapter |
| `R4_MODEL_RESPONSE_FORMAT` | `json_object` | `json_object` \| `none` |
| `R4_MODEL_TEMPERATURE` | — | Opcional |

### Quality & Learning (R4-G, completado)

Evaluación post-hoc de trayectorias terminadas (ADR-025/026): `packages/evaluation`
(framework puro), `apps/evaluator` (lector durable, artifacts, juez sobre el
ModelGateway) y el evaluator pack de Sales (`agents/sales/src/evaluations`).
Nunca dentro del loop del agente; sin score global.

```bash
npm run build
npm run eval:sales              # offline: corpus de fixtures + 12 regresiones (sin credenciales)
npm run eval:sales -- --scripted  # + escenarios reales del harness con modelo scripted (PostgreSQL local)
npm run benchmark:sales         # S02,S03,S04,S11,CENTRAL × N=3 (fixture); --source scripted|live, --repetitions N
npm run experiment:sales        # baseline vs candidate (deltas, sin ganador)
npm run eval:sales:live         # smoke live pequeño (S02 × 1) si hay R4_MODEL_*; si no, "not executed"
npm run regression:promote -- --evaluation <dir> --finding <id> --id REG-00NN --title "…" --fixture <fixture>
npm run test:evaluation         # tests de evaluación (unit + contract)
npm run test:mutation:evaluation
```

El juez live usa `R4_EVAL_MODEL_*` (mismas variables que `R4_MODEL_*`) o, si no
está definido, el mismo modelo configurado; ambos perfiles quedan registrados.
Artifacts en `artifacts/{evaluations,benchmarks,experiments}` (ignorados por git).

### Shadow / E2E (R4-H, cerrado)

Workloads realistas sobre el runtime real, con modelo real opcional y efectos
**sólo shadow** (ADR-027): `packages/shadow` (framework puro), bindings,
corpus y ejecutor de Sales en `agents/sales/src/shadow`. Un run es shadow sólo
si se declara (`R4_EXECUTION_MODE=shadow` o `--execution-mode shadow`, que los
scripts npm pasan); sin declaración nada se compone. Ningún binding
`production` puede componerse; `respond` sólo llega al `ShadowOutboundSink`
(`actualDelivery = false`); `quote.create` pasa por la Policy de R4-D y se
materializa en un Quote owner record-only (`COT-9xxxxx`, sin documento).

```bash
npm run build
npm run shadow:sales -- --plan       # plan: casos, repeticiones, perfil de modelo, bindings, writes, outbound disabled
npm run shadow:sales                 # offline: corpus completo (35 casos, incl. H08A–H08I de ADR-028) × 1, modelo scripted, PostgreSQL local, sin red
R4_SHADOW_ALLOW_LIVE_MODEL=true npm run shadow:sales:smoke   # modelo real (R4_MODEL_*): H01, H04, H05 × 1
R4_SHADOW_ALLOW_LIVE_MODEL=true npm run shadow:sales:live -- --set repeated --repetitions 3 --concurrency 3
npm run test:shadow                  # suite offline completa como test (PostgreSQL real)
npm run test:mutation:shadow         # 9 mutaciones de seguridad shadow: todas deben ser detectadas
```

| Variable / flag | Default | Descripción |
|---|---|---|
| `R4_EXECUTION_MODE` | — | `shadow` o nada (fail-closed); no existe `production` |
| `R4_SHADOW_ALLOW_LIVE_MODEL` | `false` | Opt-in explícito para llamar al modelo real |
| `R4_SHADOW_ALLOW_LIVE_READ` | `false` | Opt-in para bindings live read-only con contrato documentado (ninguno disponible hoy) |
| `R4_SHADOW_ARTIFACTS_DIR` | `artifacts/shadow` | Destino de artifacts (inmutables, ignorados por git) |
| `--cases ID,…` / `--set h-reference\|repeated\|smoke\|all` | `all` | Selección de casos |
| `--repetitions N` / `--concurrency N` | `1` / `1` | Live con N > 3 o > 60 ejecuciones exige `--allow-large` |
| `--max-model-calls` / `--max-input-tokens` / `--max-output-tokens` | 6000 offline / 1500 live | Cost guard de la suite: al alcanzarlo, lo restante queda `not_run_due_to_budget` |
| `--no-judge` | juez activo en live | El juez usa `R4_EVAL_MODEL_*` o, si no existe, el modelo configurado |

Artifacts en `artifacts/shadow/<suiteRunId>/` (manifest, plan, resultados por
ejecución, side effects, outbound, llamadas al modelo, resumen de evaluación,
agregados, candidatos de gap, `report.md`, `benchmark/`, `evaluations/`).

### Governed Production (R4-I, en progreso)

Producción gobernada de un **número canary propio de R4** (el número productivo
sigue en CRM-Customer-360; ver la [auditoría](docs/architecture/R4-I_CRM_WHATSAPP_AUDIT.md)
y ADR-029). `packages/live-ops` (modo producción, perfil, rollout, kill
switch, ingress canónico, **único dueño de la entrega**), `apps/channel-gateway`
(webhooks + dispatcher: el único proceso que habla con el proveedor),
`adapters/channels/whatsapp-cloud` y la composición de producción del pack en
`agents/sales/src/production`. `respond` ≠ entregado: cada respuesta aceptada
es un `OutboundMessage` durable con su ciclo (`pending → dispatching →
accepted → delivered → read`, `failed`, `unknown`, `cancelled`); un timeout o
un crash durante el envío queda `unknown` y **nunca** se reintenta a ciegas.
El hilo canary se proyecta desde estado durable de R4. Customer master e
historia CRM de largo plazo no están integrados, y R4-I no sincroniza esos
hilos con CRM.
La autonomía nace **deshabilitada** (kill switch en la migración 0007) y el
rollout en **0 %**.

```bash
npm run build && npm run db:migrate && npm run sales:migrate
npm run test:production                    # unit + contract + integración de R4-I (PostgreSQL real, proveedor fake local, sin red)
npm run test:mutation:production           # 21 mutaciones de seguridad de producción: todas deben ser detectadas
npm run production:sales:validate          # validación offline completa → artifacts/production-validation/<id>/
R4_EXECUTION_MODE=production … npm run production:sales:plan    # qué correría (modelo, canal, identidad redactada, rollout, kill switch, bindings) — no envía nada
R4_EXECUTION_MODE=production … npm run production:sales:gateway # proceso de canal (webhook público + dispatcher)
R4_EXECUTION_MODE=production … npm run production:sales:worker  # worker de producción (modelo real; R4_PROD_ALLOW_NETWORK=true)
R4_EXECUTION_MODE=production … npm run production:sales:smoke   # smoke real con identidad allowlisted; nunca habilita autonomía
npm run test:mutation:worker-readiness     # 14 mutaciones de readiness del worker: todas deben ser detectadas

curl -s $GATEWAY/health     # liveness del proceso gateway
curl -s $GATEWAY/ready      # readiness del CANAL (BD, esquema, controles, canal) — nunca depende de workers; la del balanceador
curl -s $GATEWAY/ready/r4   # readiness AGREGADA: canal + ≥ 1 worker de producción fresco y compatible (checks.execution.status)
```

| Variable | Default | Descripción |
|---|---|---|
| `R4_EXECUTION_MODE` | — | `production` explícito (ausente = test; `shadow` = R4-H) |
| `R4_PROD_POLICY_PROFILE` | — (obligatorio) | Perfil compuesto esperado (`sales-production@1`) |
| `R4_PROD_ROLLOUT_PERCENT` | — (obligatorio, explícito) | Cohorte estable por hash de conversación; canary: `0` + allowlist |
| `R4_PROD_ROLLOUT_ALLOWLIST` / `_DENYLIST` | vacío | Claves de conversación (HMAC; `--identity-key <wa_id>` las calcula) — nunca teléfonos |
| `R4_PROD_IDENTITY_HASH_KEY` | — (obligatorio, ≥ 32) | Llave del hash de identidades |
| `R4_PROD_ALLOW_NETWORK` | — (obligatorio `true`/`false`) | Opt-in de llamadas reales (modelo, proveedor); con `false` sólo URLs loopback |
| `R4_PROD_OUTBOUND_MAX_ATTEMPTS` / `_MAX_AGE_MS` / `_LEASE_MS` | 3 / 600000 / 30000 | Presupuesto de reintento (sólo "no enviado"), antigüedad máxima, lease de despacho |
| `R4_PROD_PROVIDER_TIMEOUT_MS` | 10000 | Timeout de envío (vencido ⇒ `unknown`) |
| `R4_WHATSAPP_APP_SECRET` / `_VERIFY_TOKEN` / `_ACCESS_TOKEN` / `_PHONE_NUMBER_ID` | — | Secretos del número canary (nunca persistidos) |
| `R4_WHATSAPP_GRAPH_VERSION` / `_GRAPH_BASE_URL` | `v25.0` / Graph | Contrato oficial de la Cloud API |
| `R4_GATEWAY_HOST` / `R4_GATEWAY_PORT` / `R4_GATEWAY_DISPATCH` | `127.0.0.1` / 8090 / `true` | Proceso gateway |

Operador (sólo API, identidad por `TrustedHumanContext`):
`GET /v1/production/{conversations,attention,metrics,controls}`,
`POST /v1/production/controls` (kill switch, scope `autonomy.control`),
`GET /v1/tasks/:id/thread?after=<cursor>` (hilo incremental),
`GET /v1/tasks/:id/outbound`, `GET /v1/outbound/:id`,
`POST /v1/tasks/:id/operator-messages` (respuesta manual: toma la conversación
y cancela envíos pendientes del agente), `POST /v1/outbound/:id/resolve`
(resolver `unknown` con evidencia), `POST /v1/outbound/:id/cancel`, además de
take over / release de R4-E.

## API smoke

```bash
B=http://127.0.0.1:8080

curl -s $B/health                       # {"status":"ok"}
curl -s $B/ready                        # 200 ready | 503 not_ready + checks
curl -s $B/v1/agents                    # {"agents":[{"agentId":"platform-probe",…}]}
curl -s $B/v1/agents/platform-probe     # definición completa (?version=N opcional)

curl -s -X POST $B/v1/tasks \
  -H 'content-type: application/json' \
  -H 'idempotency-key: smoke-1' \
  -H 'x-correlation-id: smoke-trace-1' \
  -d '{"taskType":"probe.echo","agentId":"platform-probe",
       "goal":{"description":"Smoke test task"},"input":{"message":"hello"}}'
# 201 + {task, goals, runs}; repetir el mismo request → 200 + header idempotency-replayed: true

curl -s $B/v1/tasks/<taskId>            # 200 | 400 id inválido | 404
curl -s $B/v1/runs/<runId>              # 200 | 404

# R4-E: input canónico (idempotente por externalKey) — cualquier canal
curl -s -X POST $B/v1/tasks/<taskId>/inputs -H 'content-type: application/json' \
  -d '{"externalKey":"evt-1","content":"hello","sourceRef":"smoke","occurredAt":"2026-09-23T12:00:00Z"}'
```

Las operaciones humanas (`/v1/tasks/:id/{cancel,handoff,temporal}`,
`/v1/human-requests/:id/respond`, `/v1/executions/:id/reconciliation/reschedule`,
`/v1/attention`) requieren un `TrustedHumanContext` del adapter de
autenticación (`humanContext` en `createPlatform`). R4 no incluye IAM
productivo: sin adapter responden 422 `trusted_human_required`.

Errores: `{"error":{"code","message","details?","correlationId"}}` con
400 validación · 404 no encontrado · 409 conflicto · 415 media type ·
422 precondición · 503 no disponible · 500 interno (sin detalles).

## Calidad

```bash
npm run build           # tsc -b (project references)
npm run lint            # ESLint tipado + reglas de frontera de arquitectura
npm run typecheck       # repo completo, incluidos tests
npm run test:unit       # sin dependencias externas
npm run test:contract   # pureza de Core, fronteras de dependencias, neutralidad de proveedor
npm run test:integration  # requiere `npm run db:up`; crea y borra BDs efímeras
npm run test:recovery   # detiene/arranca el contenedor PostgreSQL y mata workers y schedulers reales (SIGKILL, incl. tras un efecto externo, a mitad de una reconciliación y (H) un worker Sales shadow a mitad de una conversación; ADR-028: un worker a mitad de una run de recuperación); requiere `npm run build`; correr aislado
npm run test:sales      # (F) escenarios S01–S17 + CENTRAL: modelo scripted, dominio fixture, PostgreSQL real; (G) evaluación de trayectorias durables
npm run test:evaluation # (G) framework de evaluación + evaluator pack de Sales + fronteras de Quality
npm run test:mutation:evaluation  # (G) 6 mutaciones de invariantes críticos: todas deben ser detectadas
npm run test:shadow     # (H) suite shadow offline completa: runtime real, modelo scripted, PostgreSQL real, sin red
npm run test:mutation:shadow  # (H) 9 mutaciones de seguridad shadow: todas deben ser detectadas
npm run test:mutation:recovery  # (post-H, ADR-028) 14 mutaciones de la recuperación a nivel de run: todas deben ser detectadas
npm test                # unit + contract + integration + sales + shadow
npm run check           # build + lint + typecheck + test
```

Los tests de integración usan `R4_TEST_DATABASE_URL`
(default `postgres://r4:r4_local_only@127.0.0.1:55432/postgres`) y fallan
—no se omiten— si PostgreSQL no está disponible. Ningún test usa red externa
ni proveedores de modelos: `FakeModelProvider` los reemplaza (el adapter
OpenAI-compatible se prueba con un `fetch` falso).

## Estructura

```text
apps/api                     HTTP /v1 + composition root + CLI de migraciones
apps/worker                  worker: claim, lease/heartbeat, kernel (R4-C1); (E) reconciliación despachada
apps/scheduler               scheduler: schedules durables, wake/dispatch; sin modelo ni capabilities (R4-E)
apps/evaluator               (G) runtime de evaluación: lector de trayectorias (sólo lectura), artifacts, juez sobre el ModelGateway
packages/contracts           esquemas/tipos de primitivas
packages/observability       logs estructurados, correlación, eventos
packages/model-gateway       ModelGateway + FakeModelProvider
packages/capability-runtime  registry, discovery, invocación READ, observations; (D) writes + ActionExecutor
packages/task-runtime        AgentTask / AgentRun / Goal (sobre ports); (D) ActionRuntime: propuesta → decisión → comando → intentos → receipt; (E) TemporalRuntime: esperas, input, humanos, handoff, cancelación, goals
packages/agent-registry      AgentDefinitions versionadas e inmutables
packages/agent-kernel        loop model → decisión → READ | propose_action → observation (R4-C1, R4-D)
packages/context-compiler    contexto estructurado por decisión: sources, autoridad, frescura, budget, compaction (R4-C2)
packages/policy-engine       autorización determinista de acciones: reglas tipadas, versión + hash (R4-D)
packages/persistence-postgres  migraciones + stores PostgreSQL
packages/evaluation          (G) framework de Quality: subject, findings, outcomes, evaluadores, benchmark, experiment (puro, sin dominio)
agents/platform-probe        agente sonda sin dominio
agents/sales                 (F) Sales Agent Pack: definición, capabilities, workspace (esquema sales), harness y CLIs — fuera de Core; (G) src/evaluations
adapters/domains             (F) ports Customer/Catalog/Shipping/Quote + fixtures deterministas; sin dependencia de R4
adapters/models/openai-compatible  (F) primer ModelProvider real (chat-completions genérico)
tests/                       unit · contract · integration · recovery · sales · mutation (G)
```
