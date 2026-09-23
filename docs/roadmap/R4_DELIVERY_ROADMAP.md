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
| R4-C1 | Execution Kernel | Completado y publicado (baseline `834a5f1`) |
| **R4-C2** | **Context Compiler & Memory Boundaries** | **Implementado sobre `834a5f1` (pendiente de auditoría; sin commit)** |
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

### 3.2 Condiciones de entrada que C2 dejó abiertas

Las cinco condiciones propuestas al cerrar C1: la (1) la resolvió C2 (§3.3).
Siguen abiertas (2) reparación de decisiones inválidas y reintentos de modelo,
(3) destino de `respond`, (4) cierre de goals y (5) primer adapter de proveedor
real.

## 3.3 R4-C2 — Context Compiler & Memory Boundaries

Pregunta: ¿puede R4 construir para cada decisión un contexto mínimo,
estructurado, reproducible, acotado por presupuesto y consciente de
autoridad/frescura, sin convertir transcript, summaries, observations, memoria y
estado de negocio en una sola fuente de verdad? Diseño:
[arquitectura §12](../architecture/R4_ARCHITECTURE.md), ADR-010…014. C2 se compone
sobre C1: no cambia claim, leases, heartbeat, fencing, ownership, recuperación
de runs, ejecución READ, durabilidad de observations, protocolo `AgentDecision`
ni terminación por budget.

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1 | Compilador independiente del proveedor | `contract/context-boundaries` (imports, sin modelo/SQL), allow-list |
| 2 | Contexto estructurado, no prompt gigante | `CompiledContext` + `ModelRequest.context`; `unit/agent-kernel/context-and-request` |
| 3 | Sources extensibles sin tocar el compilador | `unit/context-compiler/compiler` (extensibility), `integration/context-snapshots` (`external.record_state`) |
| 4 | Autoridad explícita | `AUTHORITIES_BY_KIND` en esquema; `unit/context-compiler/contracts` |
| 5 | Frescura explícita | `unit/context-compiler/freshness` (reloj inyectado, bordes) |
| 6 | Conversación/observations/memoria/estado no se confunden | secciones + validación de esquema; `contracts`, `compiler`, `long-context` |
| 7 | Summaries nunca reemplazan estado canónico | `compiler` (DERIVED vs AUTHORITATIVE), `compaction`, `long-context`, escenario `summary_degradation` |
| 8 | Budget determinístico | `compiler` (budget), `long-context` (≤ techo sobre documento completo) |
| 9 | Selección reproducible | `compiler` (determinism: mismo hash, orden independiente de las fuentes) |
| 10 | Cada llamada al modelo con snapshot durable | `integration/context-snapshots` (step ↔ snapshot, persistido antes de la llamada) |
| 11 | Snapshots inmutables | triggers; `integration/context-snapshots` (UPDATE/DELETE rechazados) |
| 12 | Recovery reutiliza el snapshot de la attempt lógica | `integration/context-snapshots` (reuse), `recovery/worker-process-crash` (SIGKILL) |
| 13 | Evidencia nueva genera snapshot nuevo | `integration/context-snapshots` (observation en iteración 2; attempt 2 al llegar memoria) |
| 14 | Fronteras de memoria explícitas | ADR-013; `contracts`, `compiler` (supersession/expiración), `context-snapshots` (append-only) |
| 15 | Compaction preserva procedencia | `compaction` (derivación completa), `context-snapshots` (compaction E2E) |
| 16 | Compaction no destruye evidencia cruda | `compaction` (fuentes intactas), `context-snapshots` (120 turnos siguen en BD) |
| 17 | Secretos no llegan al modelo | `compiler` (admission), `context-snapshots` (request, snapshot y logs sin el valor) |
| 18 | Kernel no sabe cómo se compiló | `contract/context-boundaries`, ESLint |
| 19 | Invariantes C1 intactas | suites C1 verdes (ver informe); cambios C1 listados abajo |
| 20 | Long-context sintético | `unit/context-compiler/long-context` (604 entradas de memoria, 30 observations) |
| 21–23 | Tests R4-B, C1 y C2 pasan | ver informe de cierre |
| 24 | build/lint/typecheck | ver informe de cierre |
| 25 | `git diff --check` | limpio |

**Cambios en tests existentes (C1/R4-B), todos inevitables por la extensión:**
lista esperada de migraciones/tablas (`migrations.test.ts`,
`migration-upgrade.test.ts`); allow-list de dependencias (paquete nuevo); el
test de renderizado del request (C1 lo declaraba reemplazable por C2);
`contextOf` en `tests/support` ahora proyecta el contexto estructurado; la
sesión inline de un test de kernel implementa `prepareContext`; timeout
explícito en el test de estrés de 400 iteraciones; el worker del test SIGKILL
alinea `R4_EXEC_MAX_ITERATIONS` y su capability inline con la fixture
compartida (se habían desincronizado). **Bug latente de R4-B corregido:**
`updateRun` nunca persistía `context_snapshot_ref`.

### 3.4 Ajuste previo a la aceptación de C2 — presupuesto y medición (ADR-015)

Budgeting es un mecanismo; la política de presupuesto es una decisión
empírica; la política por defecto en esta etapa es **UNBOUNDED**; el modo
acotado (**FIXED(N)**) sigue disponible para experimentos y futuros controles
productivos.

| # | Criterio | Evidencia |
|---|---|---|
| 1 | UNBOUNDED es el default | `contextCompilationPolicySchema` (default), `unit/worker/context-config` |
| 2 | Sin límite artificial global hardcodeado | `R4_CONTEXT_MAX_TOKENS` sólo con `R4_CONTEXT_BUDGET_MODE=fixed`; `DEFAULT_CONTEXT_POLICY` = unbounded |
| 3–4 | FIXED(N) completo: selección, compaction, `budget_exhausted` | suites previas bajo `fixed(N)` sin relajar aserciones; `budget-accounting` (FIXED(6000)) |
| 5 | UNBOUNDED no elimina por presupuesto | `budget-accounting` (0 exclusiones `budget`, 0 compaction) |
| 6–8 | Consumo por kind, autoridad y fuente | `ContextComposition`; conciliación exacta en `budget-accounting`; `GROUP BY` en `integration/context-snapshots` |
| 9 | Métricas de compaction | `composition.compaction` (input/output/ratio/ítems) |
| 10 | Contabilidad reproducible | `budget-accounting` (misma composición, mismo JSON) |
| 11 | Presupuesto en la equivalencia de snapshots | fingerprint incluye política + presupuesto efectivo; `integration/context-snapshots` (attempt 2 por cambio de budget) |
| 12 | Sin acoplamiento a proveedor | `contract/context-boundaries`, `core-purity` |
| 13 | C1 sin cambios | sólo el compilador, contratos C2, migración 0003 (no publicada) y worker |

**Comportamiento observado (no deficiencia genérica):** con FIXED(6000) y el
orden de selección actual, el corpus largo deja working y episodic memory con
0 ítems incluidos. Es un resultado bajo una política acotada concreta; decidir
una asignación productiva requiere evaluación empírica.

**Capacidad futura (no implementada): context engineering guiado por
evaluación** — quitar episodic memory, reducir historial conversacional,
cambiar la prioridad de working memory, distintos umbrales de compaction y
distintos presupuestos, comparados contra éxito de task, continuidad del goal,
falso éxito, preguntas repetidas, selección de capabilities, latencia, costo y
tokens. Los datos necesarios (snapshots + decisiones por ítem + composición)
ya existen.

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
| (C2) Escritura de working/episodic memory desde el loop | Requiere ampliar `AgentDecision` (congelado en C1) o productores de fases futuras | `MemoryEntry` + `PostgresMemoryStore.append` |
| (C2) Endpoint de turnos / ingestión de conversación (`/v1/turns`) | Sin canal en C2; no asumir WhatsApp | `CONVERSATIONAL` + `interactionRef` |
| (C2) Compactor basado en modelo y summaries incrementales | Sin proveedor real; C2 prueba semántica, no calidad | `ContextCompactor` seam |
| (C2) Tokenizer por proveedor | Presupuesto reproducible primero | `ContextSizer` port |
| (C2) Presupuesto productivo de contexto (valor de N, asignación por kind) | Sin evidencia: se decide con evals y consumo observado (ADR-015) | `ContextBudgetPolicy` FIXED, `kindLimits`, `ContextComposition` |
| (C2) Límite físico del modelo (envelope) | Llega con el primer adapter real; input efectivo = min(envelope, presupuesto R4) | techo por request (`budgetCeilingTokens`) |
| (C2) Activación de compaction no basada en presupuesto (umbrales, costo) | Primero observar | `ContextCompactor`, política |
| (C2) Analytics / dashboards de contexto (percentiles) | Sin consumidor; los datos existen | `context_snapshot_items` + `context_snapshots` |
| (C2) Retrieval semántico / vectorial / RAG, memoria de largo plazo | Sin necesidad demostrada | `ContextSource` |
| (C2) Fuentes de estado de dominio reales | Fuera de Core (ADR-005) | `WorkerBindings.contextSources`, kind `state` |
| (C2) Extracción automática de `assertions` desde texto | Sería un LLM decidiendo; sin él los conflictos en texto libre no se detectan | `assertions` declaradas por la fuente |
| (C2) Exponer snapshots por HTTP | Sin consumidor; la auditoría lee la BD | `PostgresContextSnapshotStore` |
| (C2) Renderizado por proveedor del `CompiledContext` | Llega con el primer adapter real | `ModelRequest.context` |
