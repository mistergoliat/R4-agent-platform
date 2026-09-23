---
title: R4 — Delivery Roadmap
status: active
owner: architecture
last_reviewed: 2026-09-22
source: ../architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md §40
---

# R4 — Delivery Roadmap

Este roadmap operacionaliza el PRD §40. No autoriza avanzar de fase: cada fase
requiere autorización explícita (AGENTS.md).

## 1. Estado de fases

| Fase | Nombre | Estado |
|---|---|---|
| R4-A | Architecture Freeze | Parcial: Constitución + PRD existen; los contratos se congelaron en código en R4-B |
| R4-B | Platform Skeleton | Completado y publicado (baseline `d75cfb3`) |
| **R4-C1** | **Execution Kernel** | **Implementado (pendiente de revisión; sin commit)** |
| R4-C2 | Context + Memory (resto de R4-C) | No iniciado — requiere autorización |
| R4-D | Durable Execution | No iniciado |
| R4-E | Human Collaboration + Scheduler | No iniciado |
| R4-F | Sales Reference Application | No iniciado |
| R4-G | Quality & Learning | No iniciado |
| R4-H | Shadow Production | No iniciado |
| R4-I | Governed Production | No iniciado |
| R4-J | Sales Autonomy | No iniciado |
| R4-K | Platform Generalization Test (Marketing Analyst) | No iniciado |
| R4-L | Extended Platform | No iniciado |

## 2. R4-B — criterios de salida

| Criterio | Evidencia |
|---|---|
| Build | `npm run build` (`tsc -b`, project references) |
| Lint | `npm run lint` (typed ESLint + reglas de frontera) |
| Typecheck | `npm run typecheck` (repo completo, incluidos tests) |
| Unit | `npm run test:unit` |
| Contract / arquitectura | `npm run test:contract` |
| Integración (PostgreSQL real) | `npm run test:integration` |
| Migración desde BD vacía | `tests/integration/migrations.test.ts` |
| Restart de proceso | `tests/integration/restart-persistence.test.ts` |
| Restart del servidor PostgreSQL | `npm run test:recovery` |
| `/health`, `/ready` | tests de API + smoke documentado en README |
| Boot Docker/local y smoke de API | README |
| Documentos + ADR-001…005 | `docs/` |
| `git diff --check` | limpio |

## 3. R4-C1 — Execution Kernel

R4-C se dividió en C1 (ejecución: worker, leases, kernel, decisiones, READ,
observations, budgets, terminación, recuperación) y C2 (contexto: Context
Compiler, memoria, proyección de conversación). C1 no implementa nada de C2 ni
de fases posteriores. Diseño: [arquitectura §11](../architecture/R4_ARCHITECTURE.md),
ADR-006…009.

**Nota de alcance.** El roadmap de R4-B listaba "leases/heartbeats de runs,
detección de huérfanos" como R4-D. La tarea de C1 los requiere para que un
worker pueda ejecutar tasks de forma segura y reanudarse (exit de R4-C en el
PRD §40: "reanudarse"). No contradice Constitución ni PRD; R4-D conserva
ActionProposal, Policy, Receipts, checkpoints de efectos y cancelación
cooperativa.

### 3.1 Criterios de salida de C1

| # | Criterio | Evidencia |
|---|---|---|
| 1 | Worker ejecuta tasks automáticamente | `integration/worker-kernel` (task creada por HTTP, `worker.start()`, sin disparo manual); `integration/worker-recovery` (4 workers × 12 tasks) |
| 2 | Claiming seguro bajo concurrencia | `integration/execution-leases` (10 claimers → 1; 8 × 20 tasks sin duplicados); mutación verificada |
| 3 | Lease + heartbeat | `integration/execution-leases` (renovación, expiración real y forzada); `integration/worker-kernel` (heartbeat sano, pérdida detectada) |
| 4 | Workers stale fenced | `integration/execution-leases` (6 operaciones rechazadas, estado intacto); `integration/worker-recovery`; mutación verificada |
| 5 | Kernel provider-neutral | `contract/execution-kernel-boundaries`, `contract/provider-neutrality`, `contract/core-purity` |
| 6 | Kernel domain-neutral | `contract/core-purity`, `contract/dependency-boundaries` |
| 7 | AgentDecision tipado y validado | `unit/contracts/decision-and-execution-contracts`, `unit/agent-kernel/decision-parser` |
| 8 | Sólo READ ejecutable | `unit/agent-kernel/*`, `integration/worker-kernel` (write-class nunca ejecutada), `contract/execution-kernel-boundaries` (todas las clases no-READ rechazadas por el invoker; único call site) |
| 9 | Observation persistida antes de continuar | Observation + step en una transacción fenced; la iteración siguiente parte de `load()` |
| 10 | Kernel usa la Observation en la siguiente iteración | `contextOf(request[1]).observations` en unit, integración y SIGKILL; `complete.evidence` cita la observation |
| 11 | Task termina correctamente | `integration/worker-kernel` (E2E vía HTTP) |
| 12 | Crash + lease expiry + takeover | `integration/worker-recovery` (in-process), `recovery/worker-process-crash` (SIGKILL real) |
| 13 | Recovery no repite una invocation persistida | handler ejecutado 1 vez en ambos tests de crash; READ pendiente re-ejecutado con el mismo `invocationId` y una sola observation |
| 14 | Budget evita loops infinitos | `unit/agent-kernel/kernel`, `integration/worker-kernel` (READ infinito → `max_read_capability_calls`) |
| 15 | Toda terminación con razón estructurada | `CHECK` en `agent_runs`, `unit/.../execution-lifecycle`, tabla de mapeo en arquitectura §11.6 |
| 16 | Sin estado crítico sólo en memoria | step log + lease + observations en PostgreSQL; takeover por worker con pool/registries nuevos; SIGKILL |
| 17 | Tests R4-B siguen pasando | sólo cambió la lista esperada de migraciones/tablas en `migrations.test.ts` (inevitable al agregar `0002`) y la allow-list de dependencias (paquetes nuevos) |
| 18 | Tests C1 pasan | ver informe de cierre |
| 19 | `git diff --check` | limpio |
| 20 | Nada de C2+ | sin context compiler, memoria, writes, policy, approvals, delegación, MCP, scheduler |

### 3.2 R4-C2 — condiciones de entrada propuestas

No se inicia sin autorización. Antes de empezar conviene decidir:

1. Qué selecciona el Context Compiler desde `ExecutionContext` y cómo se hace
   observable (`contextSnapshotRef`).
2. Política de reparación de decisiones inválidas (hoy terminan el run) y de
   reintentos de modelo (hoy ninguno), con métricas de evaluación.
3. Si `respond` se entrega a algún destino (hoy sólo se registra).
4. Cómo se cierran goals (hoy `complete` no modifica goals: cerrar un goal es
   cognición y no existe decisión para ello).
5. Primer adapter de proveedor real y su suite de contrato (ADR-004).

## 4. Decisiones diferidas intencionalmente

| Tema | Por qué se difiere | Seam existente |
|---|---|---|
| Autenticación / identidad del llamador | No hay consumidor todavía; no inventar un modelo de identidad | `PrincipalResolver`; `requested_by_*`, `actor_*` |
| Endpoints cancel/resume, turns, attention, artifacts, approvals | "No inventar endpoints de features no implementadas" | `TaskRuntime.transitionTask` (interno) |
| Llamadas LLM reales y routing de modelos | C1 prueba el harness, no calidad | `ModelProvider` SPI; `WorkerBindings.modelProvider` |
| Entry point de producción del worker (`main`) | No existe proveedor real ni capabilities de Core: un `main` sería un placeholder | `runWorkerProcess(loadWorkerConfig(env), bindings)` |
| `/health`, `/ready` del worker | Sin consumidor (sin deploy); liveness observable por telemetría y `last_heartbeat_at` | `createWorkerPlatform` |
| Protocolo de acción híbrido (tool calls nativas) | Constitución §27.11 sigue abierta; C1 usa salida estructurada | `parseAgentDecision` |
| Decisiones Delegate, Wait, ProposeAction, Consult, Approval, Handoff | Fases R4-D/E | `AgentDecision` (unión discriminada) |
| Reintentos de modelo y reparación de decisiones inválidas | Política sin evidencia; afecta evaluación | `model_failure` / `invalid_decision` clasificados |
| Presupuesto de costo / tokens como política | Ownership de pricing sin decidir; `maxTokens` sí se aplica si la task lo declara | `ExecutionPolicy`, `budgetSchema` |
| Deadline de task (`deadlineAt`) aplicado por el worker | No requerido por C1 | `maxRunDurationMs` |
| Prioridades / `LISTEN/NOTIFY` en el claim | Sin necesidad demostrada (ADR-006) | índice `agent_tasks_claimable_idx` |
| ActionProposal / Policy / Receipt / writes | R4-D | Invoker rechaza no-READ con `execution_not_permitted` |
| Retries de capabilities | Requieren clasificación de errores y receipts (R4-D) | `retryPolicy` en la definición; `attempts` en provenance |
| Checkpoints de efectos (writes) | R4-D | step log (`agent_run_steps`), `invocationId` |
| Outbox durable y catálogo público de eventos | Sin consumidor aún; evita infraestructura prematura | Eventos de telemetría con nombres estables |
| Artifact | Depende del modelo de tasks/ownership (Constitución §18) | — |
| Budgets de costo | Ownership de pricing/moneda sin decidir | `budgetSchema` extensible |
| Capability registry persistente / marketplace | No hay necesidad demostrada | Registry en memoria desde código |
| Deshabilitar/retirar versiones de agentes | No hay caso de uso | Nueva versión |
| Worker con varias tasks concurrentes | Un worker = una task; paralelismo con más workers | `Worker.runOnce` |
| Imagen Docker de la API / despliegue | "No hacer deployment" | `npm start` sobre `dist` |
