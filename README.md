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
resultado con un `ActionReceipt` inmutable. **R4-E — Temporal + Human Runtime**
(en el working tree, pendiente de auditoría): esperas durables (`WAIT_FOR_INPUT`,
`WAIT_UNTIL` interrumpible por input), scheduler como proceso independiente,
consultation / approval / handoff (también iniciado por un operador),
reconciliación durable de efectos inciertos, cancelación honesta, goals con raíz
y foco y continuidad conversacional entre runs. No contiene llamadas LLM reales,
writes de dominio de producción ni ningún agente de negocio.

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
npm run test:recovery   # detiene/arranca el contenedor PostgreSQL y mata workers y schedulers reales (SIGKILL, incl. tras un efecto externo y a mitad de una reconciliación); requiere `npm run build`; correr aislado
npm test                # unit + contract + integration
npm run check           # build + lint + typecheck + test
```

Los tests de integración usan `R4_TEST_DATABASE_URL`
(default `postgres://r4:r4_local_only@127.0.0.1:55432/postgres`) y fallan
—no se omiten— si PostgreSQL no está disponible. Ningún test usa red externa
ni proveedores de modelos: `FakeModelProvider` los reemplaza.

## Estructura

```text
apps/api                     HTTP /v1 + composition root + CLI de migraciones
apps/worker                  worker: claim, lease/heartbeat, kernel (R4-C1); (E) reconciliación despachada
apps/scheduler               scheduler: schedules durables, wake/dispatch; sin modelo ni capabilities (R4-E)
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
agents/platform-probe        agente sonda sin dominio
tests/                       unit · contract · integration · recovery
```
