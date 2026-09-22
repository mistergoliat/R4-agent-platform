# R4 Agent Platform

Plataforma agéntica reutilizable e independiente del CRM. Fase actual:
**R4-B — Platform Skeleton** (contratos, persistencia durable, API mínima,
telemetría y tests). No contiene todavía cognición, llamadas LLM reales ni
ningún agente de negocio.

Lectura obligatoria antes de cambios de arquitectura: [AGENTS.md](AGENTS.md),
[Constitución](docs/architecture/R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md),
[PRD](docs/architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md),
[Arquitectura R4-B](docs/architecture/R4_ARCHITECTURE.md),
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
```

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
npm run test:recovery   # detiene/arranca el contenedor PostgreSQL: correr aislado
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
packages/contracts           esquemas/tipos de primitivas
packages/observability       logs estructurados, correlación, eventos
packages/model-gateway       ModelGateway + FakeModelProvider
packages/capability-runtime  registry, discovery, invocación, observations
packages/task-runtime        AgentTask / AgentRun / Goal (sobre ports)
packages/agent-registry      AgentDefinitions versionadas e inmutables
packages/persistence-postgres  migraciones + stores PostgreSQL
agents/platform-probe        agente sonda sin dominio
tests/                       unit · contract · integration · recovery
```
