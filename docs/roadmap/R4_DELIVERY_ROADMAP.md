---
title: R4 — Delivery Roadmap
status: active
owner: architecture
last_reviewed: 2026-10-27
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
| R4-C2 | Context Compiler & Memory Boundaries | Completado y publicado (baseline `67a124a`) |
| R4-D | Governed Execution (PRD §40: "Durable Execution") | Completado sobre `67a124a` (gate SIGKILL tras efecto externo verificado) |
| R4-E | Temporal + Human Runtime (PRD §40: "Human Collaboration + Scheduler") | Completado y publicado (baseline `74ed8e7`) |
| R4-F | Sales Reference Application | Completado y publicado (R4-F BASELINE `1927499`; fuera de Core, §3.7) |
| R4-G | Quality & Learning | Completado (sobre R4-F LIVE-VALIDATED BASELINE `001b7a8`) |
| R4-H | Shadow / E2E (PRD §40: "Shadow Production") | Cerrado (R4-H BASELINE `80a1733`) |
| R4-I | Governed Production | **En progreso** — implementado sobre R4 POST-H RECOVERY BASELINE `dd06a68`; pendiente de auditoría (§3.11) |
| R4-J | Sales Autonomy | **En progreso**: J3 cerrado (2026-10-15, `main` `b5fd288`); J4 en progreso, prioridad P0 (`main` `4c97ba0`, 2026-10-26); hitos en §1.1 |
| R4-K | Platform Generalization Test (Marketing Analyst) | No iniciado |
| R4-L | Extended Platform | No iniciado |

**Post-H Architecture Gap Review** (gate humano, **no** una fase): GAP-H-001
confirmado y **resuelto** (ADR-028, §3.10; publicado en `dd06a68`). No se abrió
R4-H.5 ni ninguna fase nueva.

### 1.1 Hitos de R4-J vigentes tras el cierre de J3 (owner, 2026-10-15)

Sin fechas. Cada hito requiere autorización explícita; ninguno se inicia
automáticamente.

| Hito | Estado | Alcance |
|---|---|---|
| J3 — Quote Integration & Autonomous Issuance | **CLOSED** (`CLOSED_WITH_RESCOPED_ACCEPTANCE`) | Integración comercial y emisión autónoma. [Registro de cierre](../acceptance/R4_J3_CLOSURE_RECORD.md) |
| J4 — Customer Profile | **IN PROGRESS** (**P0**). R1–R4 y SEC-OTP integrados en sintético; J4-R5 ejecutado el 2026-10-26 (integración en verde, confiabilidad conversacional en FAIL). **J4-R6: `J4_R6_BLOCKED`** (2026-10-27; [decisión](../acceptance/R4_J4_R6_FINAL_DECISION_RECORD.md)) | Integración y acceso a Customer Profile vía CIA. Desglose en §1.2 |
| J4.5 — Catalog | **PLANNED** | Optimización e integración de Catalog; después se reevalúa la eficiencia del agente (aceptación J3 §17) |
| J5 — Sales Autonomy | **PLANNED** (confirmado por el owner, 2026-10-22; no iniciado) | Comportamiento del modelo con Customer: cuándo verificar, uso del historial, personalización, estrategia comercial. Parte de `sales-production@8` (J4-R4) |
| J6 — Benchmark & Reviewer | **PLANNED** (confirmado por el owner, 2026-10-22; no iniciado) | Benchmark y evaluación comercial; revisión de calidad |
| R4 Media & Communications | **DEFERRED** | Capacidades multimedia y entrega de documentos (J3F, §4.2) |
| J7 — Production Readiness | **NOT PRODUCTION READY** | Gobernanza operacional y habilitación de clientes reales (gates del registro de brechas J3). Hereda los gates de datos reales de J4 (§1.2), el paquete [J7-CP](../architecture/R4_J7_CUSTOMER_PROFILE_PRODUCTION_DATA_BACKLOG.md) (Customer Profile con datos reales, no autorizado) y el rollout de `@8` desde el perfil productivo vigente |

**Separación normativa** (owner, 2026-10-22, mandato `R4-J4-R4-COMPOSITION-AND-PROFILE-09`).
Ningún hito se inicia sin autorización explícita. Esta tabla no declara entregables implementados.

| Hito | Resuelve | No incluye |
|---|---|---|
| J4 | Integración y acceso gobernado a Customer Profile vía CIA; perfil `sales-production@8` y definición Sales v8 (J4-R4); canary aislado sintético y su rollback (J4-R5/R6) | Comportamiento comercial del modelo; evaluación comercial; datos o clientes reales; producción |
| J5 — Sales Autonomy | Comportamiento del agente con Customer: estrategia, personalización, objetivos, prompts | Integración, contratos y adaptadores (J4) |
| J6 — Benchmark & Reviewer | Benchmark y evaluación comercial; revisión | Activación productiva |
| J7 — Production Readiness | Activación productiva, datos y clientes reales, rollout de `@8` desde `@3` con rollback propio | — |
| Checkout / R4-L | Desarrollo paralelo e independiente (cuenta, carrito, pago, orden) | No bloquea J4. No forma parte de los hitos R4-J |

Pendiente del owner: la secuencia de J4.5 (Catalog) respecto de J5 y la revisión de la rama sin
fusionar `docs/r4-j55-roadmap-registration` (`d8a6b94`), que usa J5.5 como identificador provisional
de Checkout. Por decisión del owner, Checkout pertenece a R4-L.

### 1.2 J4 — Customer Profile: desglose (auditoría cruzada, 2026-10-22)

Fuente: [informe de auditoría cruzada](../architecture/R4_J4_CROSS_REPO_ROADMAP_REBASE_REPORT.md).
Definición original: `R4-J4-R1_DESIGN_REPORT.md` §5 y ADR-039 §8–§10.

**DONE** exige código en `main`. Todos los entregables DONE se probaron solo con servicios locales e
identidades sintéticas.

| Entregable | Estado | Evidencia | Pendiente |
|---|---|---|---|
| J4-R1A — Diseño del consumidor | **DONE** (diseño) | ADR-039 aceptado (interno R4) | Actualizar el bloque de estado del informe de diseño |
| J4-R1B — Contratos externos | **PARTIAL** | CIA v1-d2 aceptado solo para interop sintética (CIA `7525395`); CP sales-context v1-rc2 `candidate` (CP `bbd766e`) | G-16 y AP-* (owner CP); contratos `approved` (datos reales) |
| J4-R2 — Adaptador CP | **DONE** (sintético) | PR #11; pin v1-rc2 en PR #12 | — |
| J4-R3 — Resolver CIA y grant | **DONE** (sintético) | PR #12 (`ad2c39b`) | — |
| SEC-OTP S1–S7 | **DONE** (sintético) | PR #15, #16, #17 (`caa3926`); campaña S7 41/41 ×3 | Gates de datos reales (abajo) |
| J4-R4 — Capacidades y perfil | **DONE (sintético)**. `J4_R4_SYNTHETIC_ACCEPTED` por el owner, 2026-10-22 | PR #19 (`main` `3e04b4f`). [Informe](../architecture/R4_J4_R4_PROFILE_V8_IMPLEMENTATION_REPORT.md) | Ver el estado por dimensión abajo |
| J4-R5 — Canary aislado | **EXECUTED, NOT PASS** (2026-10-26, EC2 único, aislado, sintético). Integración en verde; `J4_R5_CONVERSATION_RELIABILITY_FAIL` (F-1 P0) | RR-1 R-4: PR #21 (`b18113f`). Tooling `@8`: PR #22 (`4c97ba0`). Ejecución: PR #25 (`e6debe8`, revisado 2026-10-27, merge pendiente del owner). [Informe de ejecución](../architecture/R4_J4_R5_INTEGRATED_CANARY_REPORT.md) | Fix P0 (PR #27, ADR-041) revisado y fusionado; repetir el canary; evidencia desplegada faltante (BG-3 de la [decisión J4-R6](../acceptance/R4_J4_R6_FINAL_DECISION_RECORD.md)) |
| J4-R6 — Rollback y aceptación del canary | **BLOCKED** (`J4_R6_BLOCKED`, 2026-10-27) | Rollback `@8 → @7` protegido y purga ejecutados en J4-R5. [Decisión](../acceptance/R4_J4_R6_FINAL_DECISION_RECORD.md); [auditoría CP](../architecture/R4_J4_R6_CUSTOMER_PROFILE_STATE_AUDIT.md) | BG-1 G-16 ([registro preparado, sin firmar](../acceptance/R4_J4_G16_CP_ACCEPTANCE_RECORD.md)); BG-2 J4-R5 PASS; BG-3 evidencia desplegada; BG-4 regresión sobre el candidato final; BG-5 registro firmado. El rollback productivo es J7 |

**Estado de J4-R4 por dimensión** (2026-10-22):

| Dimensión | Estado |
|---|---|
| Código integrado | **Sí**: `sales-production@8`, definición Sales v8, política `sales-production-autonomous-policy@2`, composición fail-closed del worker y del gateway (PR #19, `3e04b4f`) |
| Perfil disponible para composición | **Sí, solo sintético**: los dominios `customer` y `customer-identity` son `REAL`, **APPROVED** por el owner. `REAL` describe la disponibilidad del dominio y no habilita datos reales: siguen exigidos `R4_CUSTOMER_MODE=synthetic`, credenciales `synthetic-` y la restricción de red vigente. Ninguna configuración productiva selecciona `@8` |
| Evaluación sintética | **Aceptada**: regresión completa, interop 41/41, mutaciones 8/8, matriz de degradación, comparación pareada `@7`/`@8` con modelo real (técnica, no comercial) |
| Canary | **Ejecutado** (J4-R5, 2026-10-26): integración en verde; confiabilidad conversacional en FAIL (F-1) |
| Datos reales | **Bloqueados** (J7) |

**Limitación conocida de `@7`** (`ACCEPTED_AS_KNOWN_LIMITATION`, owner, 2026-10-22):
- **Qué ocurre:** la definición Sales v7 menciona `customer.get_context`, pero `sales-production@7` no la registra. Ante una solicitud de Customer, el modelo puede invocarla y la run falla con `unknown_capability`. ADR-028 la recupera, como se observó 2 veces en 17 llamadas en la comparación J4-R4 §7.
- **Qué no se hace:** ni v7 ni sus huellas se modifican.
- **Cómo se cubre:** el rollback `@8 → @7` (J4-R6) lleva una prueba específica de este comportamiento.

**Decisiones del owner para el canary J4** (2026-10-22). No se aplican a producción.

- **`R4_CONTEXT_EXPIRED_EVIDENCE=exclude`** solo en el worker del canary J4.
  - Es una variable del proceso worker (`apps/worker/src/config.ts:39`), no del perfil.
  - **Efecto global:** dentro del canary, toda observación vencida de cualquier capacidad sale del
    contexto del modelo. Esto incluye Catalog, Shipping y Quote, no solo Customer. Sigue persistida (ADR-039 F8).
  - El default `include` y el valor de producción **no cambian**.
- **D7 del canary:**
  - datos exclusivamente sintéticos;
  - base de datos y servicios aislados de producción;
  - purga verificable de la base del canary al cierre, con evidencia de 0 filas remanentes y de 0 clientes reales procesados.
  - La retención productiva (D7 de R4) sigue abierta para J7.
- **RR-1 R-4** (inmutabilidad de bindings) es **requisito obligatorio antes de J4-R5**.

**Gates.**
- **Para el cierre técnico sintético de J4:** G-16 y AP-* (siguen pendientes de aceptación formal del
  owner de CP). J4-R4 ya está aceptado en sintético.
- **Para el canary aislado:** RR-1 R-4 (cumplido, PR #21); desplegabilidad de CIA y CP; X5–X7; la purga D7 del canary;
  procedimiento contra réplicas mixtas; autorización EC2.
- **Solo para datos reales (J7):**
  - de R4: RR-1 R-1..R-3; RS-01..04; BA-01..06; OA-10; D7 productivo;
  - de CP: L-1;
  - de CIA: DEP-2/3/5/6/10 y OD-CIA-2..5;
  - versión de PrestaShop (1.7.8.3 vs 8.2.3) sin validar.

**Condiciones de `J4_RELEASE_CANDIDATE_ACCEPTED`:** informe §9. No habilita datos reales ni producción.

**Restricciones productivas vigentes.**
- Producción sigue en `ef5a354`. El perfil documentado es `sales-production@3`, pero el preflight J4-R5 observó
  `sales-production@2` en el host (F-5, sin re-verificar). Lo resuelve el owner antes de cualquier rollout J7.
- `PRODUCTION_ROLLOUT=NOT_AUTHORIZED`.
- `R4_CUSTOMER_MODE=real` está rechazado por los adaptadores.
- No hay datos reales, despliegue, cuentas PrestaShop ni envíos de correo u OTP reales sin autorización J7.

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

## 3.5 R4-D — Governed Execution

Pregunta: ¿puede un agente proponer una mutación, permitir que la plataforma
determine si está autorizada, ejecutarla de manera durable e idempotente y
volver a observar un resultado verificable, sin que el modelo controle
permisos, ejecución ni verdad transaccional? Diseño:
[arquitectura §13](../architecture/R4_ARCHITECTURE.md), ADR-016…020. D se
compone sobre C1/C2: no cambia claim, leases, heartbeat, fencing (reutilizado),
lifecycle del run (sólo agrega el estado terminal `suspended`), Context
Compiler ni contabilidad de contexto.

**Alcance vs. PRD §40.** El PRD lista para R4-D también "optimistic concurrency
contracts" (cubierto: `expectedVersion` es del dominio, R4 lo transporta y un
conflicto es un receipt `rejected`), "checkpoints" y "recovery" (cubiertos) y
"cancellation": D garantiza que una cancelación durante una llamada en vuelo
deja la ejecución `needs_reconciliation` y rechaza la respuesta tardía; la
cancelación **cooperativa** de un efecto en curso queda diferida (§4).

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1 | `AgentDecision` soporta `propose_action` | `contracts/decision.ts`; `unit/agent-kernel/kernel-actions`; `contract/execution-kernel-boundaries` |
| 2 | Propuesta durable antes de ejecutar | `ExecutionRuntime.recordStep` (step + propuesta, 1 tx); ventana A en `integration/governed-execution-recovery` |
| 3 | Política determinista e independiente del modelo | `packages/policy-engine` (sólo contracts + zod); `unit/policy-engine` (determinismo) |
| 4 | El modelo no concede permisos | `contract/governed-execution-boundaries` (campos confiables); `integration/governed-execution` (escalamiento) |
| 5 | Ningún write evita la Policy Engine | FK compuesta comando→ALLOW; `ActionExecutor.resolve`; `contract/governed-execution-boundaries`; mutación 2 |
| 6 | Identidad de ejecución de la plataforma | `executionKeyFor` (único generador); `unit/task-runtime/action-lifecycle`; SIGKILL |
| 7 | Semántica de recuperación explícita | `registerWrite` + `writeRecovery`; `unsafe_write_semantics`; `unit/capability-runtime/action-executor` |
| 8 | ActionExecution durable | `action_executions` + `action_execution_attempts`; ventanas B/B′/C |
| 9 | Receipt durable e inmutable | `action_receipts` + triggers; `integration/governed-execution` (UPDATE/DELETE rechazados) |
| 10 | El receipt es la evidencia | resuelto ⇒ receipt (constraint trigger); éxito observado ⇒ receipt (CHECK + contrato) |
| 11 | La observation llega al siguiente ContextSnapshot | `integration/governed-execution` (probe), ventana D (snapshot de iteración 2) |
| 12 | Crash tras el efecto no duplica | `recovery/governed-write-crash` (SIGKILL real); ventana C in-process |
| 13 | Worker stale no persiste resultados | 3 tests de "stale worker protection"; mutación 3 |
| 14 | Resultado desconocido nunca se adivina | "uncertain outcomes are never guessed" (needs_reconciliation, sin observation, task `blocked`) |
| 15 | Conflicto de concurrencia no se reintenta a ciegas | "optimistic concurrency" (1 intento, receipt `rejected`, `action_rejected`) |
| 16 | REQUIRE_APPROVAL impide ejecutar | `integration/governed-execution` (0 llamadas; run `suspended`; task `requires_approval`) |
| 17 | Sin workflow de aprobación prematuro | sin ApprovalRequest/API/UI; `requires_approval` no es reclamable |
| 18 | Budget de writes | `unit/agent-kernel/kernel-actions`; `integration/governed-execution` (`max_write_actions`) |
| 19–20 | Invariantes C1 y C2 intactas | suites C1/C2 verdes; cambios listados abajo |
| 21–23 | Tests previos, de D y recovery pasan | ver informe de cierre |
| 24 | build/lint/typecheck | ver informe de cierre |
| 25 | `git diff --check` | limpio |
| 26 | Nada de R4-E | sin approvals humanos, scheduler, consultation, handoff, delegación, MCP |

**Pruebas de mutación** (temporales, revertidas): clave nueva por intento → 12
tests fallan (incl. SIGKILL); política evitada (todo ALLOW) → 7; fencing del
ActionRuntime sin verificación de lease → 3; `reconcile_before_retry` que
reintenta sin reconciliar → 4.

**Cambios en tests existentes (R4-B/C1/C2), todos inevitables por la
extensión:** listas de migraciones/tablas (`migrations`, `migration-upgrade`,
`migration-upgrade-c2`); allow-list de dependencias (paquete nuevo); la lista
de tipos de decisión y los nombres del JSON Schema en dos tests de contrato;
la tabla de clases de falla (dos razones nuevas); dos tests que usaban
`propose_action` como ejemplo de tipo *desconocido* (ahora `delegate`); los
literales de `ExecutionPolicy`/`ExecutionUsage` (campo nuevo) y la expectativa
exacta de límites; `MemorySession`, `InMemoryObservationStore` y una sesión
inline de un test del kernel implementan/estrechan los puertos extendidos.
`TEST_POLICY.maxWriteActions = 0`, igual que un worker con entorno vacío, de
modo que C1/C2 corren sin writes y sus snapshots no cambian de forma.
**Endurecimiento de C1:** `observations` ahora es inmutable también en la BD
(trigger); ningún código ni test la modificaba.

## 3.6 R4-E — Temporal + Human Runtime

Pregunta: ¿puede una AgentTask permanecer coherente durante minutos, horas o
días; esperar tiempo, input o intervención humana; reanudarse después de
crashes; preservar su objetivo; resolver ejecuciones inciertas y transferir
temporalmente autoridad a humanos sin convertir el runtime en un workflow
determinístico? Diseño: [arquitectura §14](../architecture/R4_ARCHITECTURE.md),
ADR-021, ADR-022. Baseline R4-D: `3990652`. La migración `0005` pertenece a este
milestone no publicado: se corrigió en su lugar durante R4-E y queda congelada
al hacer commit.

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1–3 | build / lint / typecheck | ver informe de cierre |
| 4 | Tests previos pasan | suites unit / contract / integration / recovery verdes; cambios listados abajo |
| 5 | Tests nuevos de E pasan | `integration/{temporal-waits,human-collaboration,reconciliation,temporal-api}`, `unit/{context-compiler/temporal-sources,contracts/temporal-contracts,scheduler/config,agent-kernel/protocol-overhead}`, `contract/temporal-boundaries`, aprobación en `unit/policy-engine` |
| 6 | Recovery incluye procesos de E | `recovery/temporal-process-crash` (scheduler SIGKILL tras claim; worker SIGKILL a mitad de `reconcile`; reinicio de worker y API) |
| 7–8 | Continuidad cross-run agente/usuario; pregunta + respuesta de consultation | `platform.interaction`; `temporal-waits` (pregunta propia + respuesta, en orden), `human-collaboration` (consultation) |
| 9 | Rechazo de aprobación ligado a `proposalId` | Observation `approval_rejected` con `proposalId` + `approvalRequestId` (`human-collaboration`) |
| 10–11 | `WAIT_UNTIL` despierta antes por input; el timer no duplica | `temporal-waits` (interruptible; timer cancelado; 0 disparos después) |
| 12–14 | Scheduler proceso independiente, sin dependencia del worker, recuperable tras crash | `apps/scheduler/src/main.ts`, `npm run start:scheduler`; allow-list; `temporal-process-crash` |
| 15–18 | Reconciliación programada durablemente, sin escaneo, vía ActionRuntime, misma executionKey | trigger + constraint diferido de 0005; `reconciliation` (ambos caminos, backoff, misma clave); contrato de intentos |
| 19 | Salida operativa tras agotamiento | `POST /v1/executions/:id/reconciliation/reschedule` (`reconciliation`, `temporal-api`) |
| 20–23 | Handoff iniciado por operador; bloquea ownership autónoma; race; release reanuda | `human-collaboration` (takeover de un agente trabajando, race con claims, gate aislado, release) |
| 24–26 | Referencias de goal inválidas recuperables; goal sobrevive espera y reinicio; raíz/foco | `temporal-waits`, `temporal-process-crash` |
| 27 | Espera larga determinista con frescura | `temporal-waits` (tres días en `r4_now()` + reloj inyectado; evidencia expirada a `history`; snapshot nuevo) |
| 28 | Cancelación de approval / handoff | `human-collaboration` |
| 29 | Endpoints HTTP con cobertura | `temporal-api` (validación, idempotencia, not found, ciclo de vida inválido, frontera del contexto humano) |
| 30 | Tests de contrato de fronteras | `contract/temporal-boundaries`, allow-list del scheduler |
| 31 | Mutaciones significativas | abajo |
| 32 | Docs | arquitectura §14, ownership §1e, ADR-021/022, README |
| 33 | `git diff --check` | limpio |

**Pruebas de mutación** (temporales, revertidas y verificadas byte a byte):
dedupe del claim del scheduler quitado → 1 test; fencing del token del
schedule quitado → 1; aprobación que salta la re-evaluación de Policy → 1
integración + 1 contrato; guarda de ownership del handoff (trigger + runtime,
juntos o por separado) → 1 (el test del gate aislado; ver informe: sin él la
mutación sobrevivía por la capa redundante de la espera humana); validación
de goal de la misma task quitada → 1 integración + 1 contrato; nueva
execution key en la reconciliación → 3 integración + 1 recovery (SIGKILL);
creación directa de intentos fuera de ActionRuntime → 3 contrato; trigger de
trabajo de reconciliación quitado → 7; timer no cancelado ante input temprano → 1.

**Cambios en tests de fases previas (todos por extensión de contrato):**
listas de tipos de decisión (3 tests de contrato) y nombres del JSON Schema
(ahora con verificación explícita de campos confiables ausentes); base por tipo
de decisión en el test de campos confiables; lista de migraciones/tablas
(`migrations`, `migration-upgrade`, `migration-upgrade-c2`); rutas 404 de la API
(cancel y attention existen ahora); tabla de clases de falla (`waiting`,
`human_handoff` no son fallas); matriz del lifecycle (`requires_approval →
blocked`, takeover); lista de fuentes del compilador (`platform.interaction`);
allow-list de escritores de memoria (ingestión de input, con aserción de que
sólo escribe CONVERSATIONAL por el principal resuelto); allow-list de
dependencias (`@r4/scheduler`); el test C1 "READ forever" declara el uso de
tokens del modelo scriptado para aislar el techo de READs (el techo de tokens
tiene ahora su propio test de integración); el test D de cancelación con
llamada en vuelo espera ahora `blocked` + intención de cancelación (una task no
queda terminal con un efecto incierto). **Arnés:** `FakeModelProvider` acepta
scripts asíncronos (para probar la race de input durante la decisión) y el
worker de prueba acepta un reloj inyectado.

**Overhead del protocolo:** `r4.agent_decision.v3` = instrucciones 2 778
caracteres (824 de E) + JSON Schema 6 216 (≈4 140 de E), fijado por
`unit/agent-kernel/protocol-overhead`.

## 3.7 R4-F — Sales Reference Application

Pregunta: ¿puede R4 sostener una conversación comercial natural, mantener el
objetivo del cliente, consultar sistemas reales mediante capabilities,
construir progresivamente una solución y producir una cotización gobernada
sin codificar el flujo comercial como workflow? Diseño:
[arquitectura §15](../architecture/R4_ARCHITECTURE.md), ADR-023, ADR-024.
Baseline R4-E: `74ed8e7`. Todo el código de F vive fuera de Core
(`agents/sales`, `adapters/domains`, `adapters/models/openai-compatible`); la
migración `0006` es del pack (`agents/sales/migrations`, esquema `sales`).

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1 | Sales Agent fuera de Core | `agents/sales`; `contract/sales-boundaries` (Core no importa Sales ni adapters); `contract/core-purity` sin cambios |
| 2 | Input canónico en lenguaje natural | `SalesHarness.say` → `TemporalRuntime.submitInput`; todos los escenarios |
| 3 | Goal sobrevive multi-turno | S03, S09, CENTRAL (`goal_kept`, `current_goal_matches`, `root_goal_active`) |
| 4 | Ports Customer/Catalog/Shipping/Quote | `adapters/domains`; `unit/sales/domain-fixtures`; S01–S17 |
| 5 | Hechos de producto desde observations | capabilities de catálogo con `freshnessTtlMs`; S07 (`refreshed_after_expiry`, `quote_line_price`) |
| 6 | Estado Sales estructurado durable | `sales.workspaces` + `workspace_transitions`; `integration/sales-reference` |
| 7 | Selección no destructiva por accidente | `unit/sales/workspace-model`; S05 |
| 8 | Espera y reanudación | S09 (reinicio de worker), CENTRAL (`waited_and_resumed`, `prior_response_in_context`) |
| 9 | Pregunta incidental no destruye el goal | S03, CENTRAL |
| 10 | Corrección reemplaza la restricción | S04, CENTRAL (`fact_history`) |
| 11 | Quote por `propose_action` | `integration/sales-reference` (propuesta → decisión → comando → receipt) |
| 12 | Quote pasa por Policy | `SALES_ACTION_POLICY`; decisión persistida con regla `capabilities.quote.create.autonomy`; denegaciones sin evidencia / sin identidad |
| 13 | Éxito de quote exige receipt | `no_unbacked_quote_claim` en todos los escenarios; `invariants.test` (negativo) |
| 14 | Crash no duplica el efecto lógico | S13 + `integration/sales-reference` (worker muere tras emitir: 1 quote, 1 receipt vía `reconcile`, misma run) ; S17 y outcome desconocido vía scheduler |
| 15 | El agente continúa tras la observation del quote | S11 (turno 2 usa la validez del receipt) |
| 16 | Primer ModelProvider real fuera de Core | `adapters/models/openai-compatible`; ADR-024 |
| 17 | CI offline sin credenciales | `FakeModelProvider` + fixtures; `sales:live` sin credenciales ⇒ "not executed" |
| 18 | Harness live | `npm run sales:live` (artifacts en `artifacts/sales-live/`) |
| 19 | S01–S15 | `tests/sales/scenarios.test.ts` (S01–S17 + CENTRAL) |
| 20 | Sin workflow determinístico | `contract/sales-boundaries` (instrucciones y código sin etapas/intents/pasos) |
| 21 | Sin subagentes | `delegationPolicy: none`; un solo agente Sales |
| 22–23 | Tests A–E y F pasan | ver informe de cierre |
| 24 | build / lint / typecheck | ver informe de cierre |
| 25 | `git diff --check` | limpio |
| 26 | Documentación | arquitectura §15, ownership §1f, ADR-023/024, README |
| 27 | Nada de R4-G | invariantes mecánicas + reporte estructurado; sin scoring, rúbricas ni evaluación automática de lenguaje |

**Cambios en Core (genéricos, con test):** `CapabilityFailure` (el invoker
conserva `details` clasificados de un fallo READ) y `ModelProviderError` con
`timeout` / `invalid_provider_response`. Ver ADR-023.

**Cambios en tests de fases previas (inevitables):** `integration/agent-registry`
y `integration/api` esperaban que el repositorio registrara sólo
`platform-probe`; ahora `./agents` también contiene `sales@1` (5 expectativas, incl. `unit/agent-registry/loader`).
El test de handler-error del invoker verifica además `details: null`.

**Comando de escenarios:** `npm run test:sales` (incluido en `npm test`).

**R4-F BASELINE y congelamiento de esquema.** El commit que publica R4-F es el
**R4-F BASELINE**: `1927499c543aa5ae3c0db01d835cae9dff1c8f9d`. Desde ese commit las
migraciones **0001–0006 quedan congeladas**: todo cambio de esquema es una
migración nueva (0007+), nunca una edición. Lo impone
`tests/contract/frozen-migrations.test.ts` (checksums fijados con la
normalización del migrador), además del rechazo en runtime
(`migration_modified`) sobre bases que ya las aplicaron.

**Validación live pre-G (sin fase nueva).** Correcciones derivadas de las
primeras corridas reales de `sales:live` (DeepSeek `deepseek-flash`), cada
una con test offline: protocolo `r4.agent_decision.v4` (qué referencias son
citables; `riskClass`/`decision` visibles en cada capability — ADR-008);
`R4_MODEL_EXTRA_BODY` en el adapter (ADR-024); invariantes de hechos por
patrón de clave (`budget` vs `presupuesto_clp`) con equivalencia de monto;
el harness live ya no aborta cuando la task termina antes del último turno, y
registra la decisión rechazada (o sólo la forma de una salida no parseable,
nunca su texto), metadata por llamada, la clasificación de cada referencia
citada (`decisionTrace`) y la cadena propuesta → policy → command → receipt
(`governance`). **Decisión:** ADR-008 se mantiene (una decisión inválida
termina la run; sin reintentos, C1 intacto); la reparación queda diferida
hasta tener evidencia comparativa entre modelos. El gate se cerró con
`deepseek-flash`, thinking habilitado explícitamente
(`R4_MODEL_EXTRA_BODY`), `R4_MODEL_MAX_OUTPUT_TOKENS=8192`, protocolo v4.

## 3.8 R4-G — Quality & Learning (COMPLETADO)

Pregunta: ¿cómo sabemos sistemáticamente si un agente hizo un buen trabajo,
por qué falló y si una versión nueva realmente mejora? Diseño:
[arquitectura §16](../architecture/R4_ARCHITECTURE.md), ADR-025, ADR-026.
**R4-F LIVE-VALIDATED BASELINE:** `001b7a8181281f3ecd4000d3063d288308953fb5`.
Sin cambios en Core de ejecución y sin migración (0001–0006 congeladas).

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1–2 | EvaluationSubject; trayectoria canónica desde estado durable | `packages/evaluation/src/subject.ts`, `trajectory.ts`; `apps/evaluator/src/trajectory-reader.ts`; `integration/evaluation-trajectory`, `sales/evaluation-durable` |
| 3 | EvaluationRun versionado | `pipeline.ts` (`r4.evaluation_run.v1`, fingerprint de definición, reproducibilidad) |
| 4 | TaskOutcome separa technical/goal/business/quality (+ governance) | `outcome.ts`; `unit/evaluation/outcome-metrics-profile` |
| 5–6 | Findings con categoría/código/severidad/evidencia; taxonomía extensible | `finding.ts`, `taxonomy.ts`; extensión Sales |
| 7–9 | Evaluadores deterministas; frontera semántica; post-hoc y sólo lectura | `evaluators/*`, `semantic.ts`; `freezeSubject`; `contract/quality-boundaries` |
| 10 | Grounding: hecho / recomendación / afirmación / relación / entidad inexistente | `GroundingEvaluator` + `SalesClaimVerifier`; REG-0005, REG-0006 |
| 11 | Goal no depende de `manage_goal` | `GoalContinuityEvaluator`; REG-0010 |
| 12–13 | Métricas de eficiencia y composición de contexto | `EfficiencyEvaluator`, `ContextCompositionEvaluator` |
| 14–15 | RegressionCase; regresiones reales codificadas | REG-0001…REG-0012 + lock |
| 16–18 | Benchmark con repeticiones, resultados individuales, agregados | `benchmark.ts`; `unit/evaluation/benchmark-experiment` |
| 19–20 | Experiment baseline/candidate; sin score universal | `experiment.ts`; `experiment:sales` |
| 21 | Learning no modifica agentes | ADR-026; `contract/quality-boundaries` |
| 22 | Evaluadores Sales fuera del framework | `agents/sales/src/evaluations` (entrada propia) |
| 23 | CI offline sin credenciales | fixtures + juez scripted + `eval:sales` |
| 24 | Juez fallido ⇒ inconclusive | `unit/evaluation/semantic-and-pipeline` |
| 25 | Sin secretos ni razonamiento en artifacts | `assertArtifactSafe`; tests unit y contract |
| 26 | Metadata de versión/fingerprint | EvaluationRun.reproducibility; golden de fingerprint |
| 27 | Evaluación de referencia offline | `npm run eval:sales`, `benchmark:sales`, `experiment:sales` |
| 28–29 | Tests de arquitectura; mutation checks | `contract/quality-boundaries`; `npm run test:mutation:evaluation` (6/6) |
| 30–33 | A–F verdes; build/lint/typecheck; `git diff --check`; docs | ver informe de auditoría |
| 34 | Nada de R4-H | sin shadow, sin adapters reales, sin evaluación continua (R4-H: §3.9) |

**Cambios en tests de fases previas (justificados, ADR-025):** `temporal-boundaries` y
`governed-execution-boundaries` acotan su escaneo de "runtime" excluyendo
`packages/evaluation` y `apps/evaluator` (Quality inspecciona texto terminado y
usa un deadline de juez por diseño; `quality-boundaries` re-verifica ambas reglas
sobre el runtime); `sales-boundaries` excluye `src/evaluations` del runtime del
pack y permite `@r4/evaluation`/`@r4/evaluator` como dependencias del pack;
`dependency-boundaries` agrega las dos entradas del allow-list.

## 3.9 R4-H — Shadow / E2E (EN PROGRESO — pendiente de auditoría)

Pregunta: ¿qué ocurre cuando R4 ejecuta workloads completos, repetidos y
suficientemente realistas con el runtime verdadero, un modelo real y los
límites reales de integración, pero sin efectos de producción sobre clientes o
negocio? Diseño: [arquitectura §17](../architecture/R4_ARCHITECTURE.md),
ADR-027. **R4-G BASELINE SHA:** `4a54b2c8dbb95b6cec8631e88d60be483d3ed64d`.
Sin cambios en Core de ejecución y sin migración (0001–0006 congeladas; no
hay 0007). El PRD §40 describía H como "espejo del tráfico real"; no existe
fuente legal/operacional de conversaciones reales, así que H se ejecutó como
**curated shadow** (no replay de producción): el camino de replay existe y
está probado con datos sintéticos (`workloadFromReplay`).

| # | Criterio de salida | Evidencia |
|---|---|---|
| 1 | WorkloadCase versionado | `packages/shadow/src/workload.ts`; corpus + lock (`agents/sales/src/shadow/corpus*.ts`); `unit/shadow/workload-privacy-cost` |
| 2 | Modo shadow explícito | `R4_EXECUTION_MODE=shadow` / `--execution-mode shadow`; `unit/shadow/mode-and-bindings`; worker de proceso rechaza arrancar sin él (`recovery/shadow-process`) |
| 3 | Sin bindings de escritura de producción | `ShadowExecutionPolicy` + `assertShadowComposition` + `guardPort`; `contract/shadow-boundaries`; mutación 1 |
| 4 | Entrega real imposible | `ShadowOutboundSink` única implementación; `actualDelivery` literal `false`; factory rechaza `production-delivery`; mutación 2 |
| 5 | ShadowRun reproducible | `shadowRunSchema` (caso+fingerprint, perfil de modelo+fingerprint, bindings+fingerprint, política, config, SHA, dirty, agente, protocolo, evaluación) |
| 6 | Corpus realista | 28 casos (H01–H14 + H08A/B + H12B, S02/S03/S04/S11/CENTRAL, R01–R07): lenguaje coloquial, errores ortográficos, correcciones, preguntas laterales, restricciones tardías, cambios de preferencia, pausas largas |
| 7 | Ingress canónico | `TemporalRuntime.submitInput` (lo que llama `POST /v1/tasks/:id/inputs`); `shadow/shadow-suite` (turnos releídos del estado durable) |
| 8 | Runtime real E2E | API + worker + kernel + compilador + ActionRuntime/Policy + scheduler reales sobre PostgreSQL |
| 9 | Modelo real | `deepseek-flash`, thinking habilitado, 8192 max output, `json_object` (fingerprint `db310ddbc507…`) |
| 10 | Sales Agent sin reemplazo de workflow | mismas instrucciones, capabilities y política; `contract/shadow-boundaries` (runtime del pack sin "shadow") |
| 11–12 | Writes por D; Receipt/Observation | manifest une efecto ↔ comando ALLOW ↔ receipt por execution key; `shadow/shadow-suite` (ingress) |
| 13 | Wait/resume E2E | H05, H13, H14 (live y offline); `sales.waited_and_resumed` |
| 14 | Reinicio de proceso | `recovery/shadow-process` (worker SIGKILL + worker nuevo + scheduler de proceso); H05/H14 reemplazan el worker |
| 15 | Reconciliación | H09 (scheduler), H12B (cancel con efecto incierto) — offline y live |
| 16 | Aprobación / handoff | H10 (perfil `sales-shadow-approval`), H11 (takeover/release) |
| 17 | Conversación larga | H13 (12 turnos, corrección, pregunta lateral, un día de pausa) |
| 18 | Datos obsoletos | H06 (3 días, cambio de precio del owner), CENTRAL/H14 |
| 19 | Caída de dominio | H07 (Catalog down → up) |
| 20 | Falla de proveedor / protocolo | H08A (timeout inyectado), H08B (texto después del JSON inyectado) + fallas reales medidas |
| 21 | G evalúa toda trayectoria | `runBenchmark` sobre cada subject ejecutado; `evaluationRunId` en cada ShadowRun |
| 22–23 | Corridas individuales + agregados; métricas | `workload-results.jsonl`, `aggregates.json`, `report.md` |
| 24–26 | Manifest; productionEffects = 0; deliveries = 0 | todas las suites (offline y live) |
| 27–28 | Gap candidates; ningún gap arquitectónico corregido en silencio | `observeGapCandidates` + registro revisado (`agents/sales/src/shadow/gaps.ts`); GAP-H-001 sólo registrado |
| 29–30 | CI offline sin red; comando live explícito | proyecto `shadow` (scripted); `shadow:sales:live`/`:smoke` con opt-in; `contract/shadow-boundaries` |
| 31 | Sin secretos/razonamiento/PII en artifacts | gate de R4-G + gate de datos personales; outbound redactado y seudónimo |
| 32 | Mutaciones | `npm run test:mutation:shadow` (9/9) |
| 33 | Baseline live controlado | N=1 × 28 casos; N=3 × H01/H02/H03/H04/H05/H14; H10/H11 × 2 |
| 34–35 | Live-read sólo documentado; estado de integración honesto | ningún binding live-read (tabla en arquitectura §17.3) |
| 36 | Nada de R4-I | sin entrega, rollout, kill switch, SLO ni canal |
| 37–40 | Suites A–G, H; build/lint/typecheck; `git diff --check` | ver informe de auditoría |
| 41 | Documentación | arquitectura §17, ownership §1h, ADR-027, README |
| 42 | Sin commit | árbol de trabajo pendiente de auditoría |

**Corrección de bug probado de R4-G (política §76):** `SalesClaimVerifier`
leía la evidencia de `quote.create` desde el nivel superior del payload, pero
las observations de acción durables llevan el sobre del receipt
(`{receiptId, status, …, result}`); los fixtures de G escribían el resultado
sin sobre, por lo que sólo en trayectorias reales las cifras de una cotización
respaldada nunca se fundamentaban. Fix mínimo (desenvolver `result`),
`sales.grounding` v1 → v2 y test de regresión
(`unit/sales/evaluation/claims-envelope`). Detectado por el smoke live (H04).

**Bug del ejecutor H corregido durante la construcción:** un evento de proceso
anterior al primer input hacía correr al agente sobre una conversación vacía;
el ejecutor ya no mueve al worker antes del primer input.

**Cambios en tests de fases previas (extensión, no relajación):**
`dependency-boundaries` (allow-list `@r4/shadow`; excluido de "Core
independiente de Quality" porque compone sobre Quality; nueva regla "Core no
depende de Shadow"), `quality-boundaries` (`packages/shadow` fuera de "Core
execution"; `src/shadow` fuera del runtime del pack), `sales-boundaries`
(`src/shadow` fuera del runtime del pack; dependencias `@r4/scheduler`,
`@r4/shadow`). **Adapters:** los fixtures de dominio declaran
`bindingKind = 'fixture'` (aditivo). **Harness:** `SalesHarness` acepta
`ports` y `actionPolicy` (aditivo; default sin cambios).

**Candidatos para la revisión de gaps post-H** (gate humano, no fase): ver el
registro revisado y el informe de cierre. El único `architecture_gap_candidate`
es GAP-H-001 (una salida inválida del modelo termina la conversación entera).

## 3.10 Post-H Architecture Gap Review — GAP-H-001 (corrección, no fase)

El review posterior a R4-H confirmó GAP-H-001: una salida inválida del modelo
terminaba la task completa (11/44 ejecuciones live elegibles; 11/523 llamadas).
ADR-008 quedó intacto (salida inválida → step `invalid` → run `failed`); lo
incompleto era la consecuencia sobre la task. **Resolución implementada**
(ADR-028, [arquitectura §18](../architecture/R4_ARCHITECTURE.md)): para
`invalid_decision` y `model_failure` reintentable la task sigue `running` y
una run nueva (claim normal, ContextSnapshot nuevo) continúa el trabajo,
acotada por `maxRunFailureRecoveries` (default 1); al agotarse, o ante un
`model_failure` no reintentable, la task pasa a `blocked` con un handoff de
plataforma visible en `/v1/attention`. Sin migración (0001–0006 congeladas;
no hay 0007), protocolo v4 sin cambio, kernel / parser / gateway sin cambio.

| # | Criterio | Evidencia |
|---|---|---|
| 1–3 | ADR-008 intacto; step `invalid`; run `failed` | `integration/run-failure-recovery`; `integration/worker-kernel` |
| 4–7 | Task no terminal; run nueva; claim normal; snapshot nuevo (C2) | `integration/run-failure-recovery` (primer caso) |
| 8–10 | Finito; default 1; configurable | idem (agotamiento, `maxRunFailureRecoveries = 2`); `unit/task-runtime/run-failure-recovery` |
| 11–13 | Misma task; sin goal preciso; goals intactos | idem; shadow `run_failure_recovered` |
| 14–17 | Agotamiento / no reintentable ⇒ `blocked` + handoff de plataforma; recuperable por humanos | `integration/run-failure-recovery`; shadow H08C, H08D |
| 18–19 | Input entre runs aceptado e incluido en el contexto de recuperación | idem; shadow H08E |
| 20–21 | Ownership humano y reconciliación preceden | idem; shadow H08F, H08I |
| 22–26 | READ y writes previos preservados; un receipt; `executionKey` intacto; budget de writes no se reinicia | idem; shadow H08G, H08H |
| 27–28 | Decisión aceptada nunca reintentada; Quality nunca dispara recuperación | `integration/run-failure-recovery` |
| 29–31 | Crash durante la recuperación; fencing; doble worker ⇒ una run | `integration/run-failure-recovery`; `recovery/run-failure-recovery-crash` (SIGKILL real) |
| 32 | Quality mide la recuperación | `r4.execution_outcomes` v2 (`unit/task-runtime/run-failure-recovery`) |
| 33–36 | Sin texto inválido ni razonamiento persistido; sin migración; protocolo v4; kernel/gateway sin cambio | tests anteriores; `git diff` |
| 38 | Mutaciones | `npm run test:mutation:recovery` |

**Cambios en tests de fases previas (semántica nueva, no relajación):**
`integration/execution-leases`, `integration/worker-kernel`,
`integration/evaluation-trajectory` y `sales/live-diagnostics` afirmaban la task
`failed` tras `invalid_decision`/`model_failure`; ahora afirman la nueva
disposición. Dos casos de `integration/governed-execution` cuyo tema es D
(evidencia, campos confiables) configuran `maxRunFailureRecoveries: 0` para que
la task fallida no sea reclamada por el worker del caso siguiente (BD compartida
por archivo) y afirman `blocked`. Shadow: H08A/H08B v2 (lock) y casos nuevos
H08C–H08I; corpus v2; directivas de falla en cola (`pass`) y `process worker
stop|cycle|start` en el ejecutor.

## 3.11 R4-I — Governed Production (EN PROGRESO — pendiente de auditoría)

Checkpoint estable (no cierre de fase):

| Aspecto | Estado |
|---|---|
| Architecture | ACCEPTED |
| Offline implementation | PASS |
| Offline E2E | PASS |
| Mutations | PASS |
| Transcript / outbound deduplication correction audit | PASS (no migration) |
| Production WhatsApp cutover (R4 sole owner) | BLOCKED pre-cutover — [readiness](../architecture/R4-I_PRODUCTION_CUTOVER_READINESS.md) §5 |
| Production control (kill switch D-5 + release of `autonomy_disabled` holds D-6) | RESOLVED OFFLINE — `production:sales:control`, [readiness](../architecture/R4-I_PRODUCTION_CUTOVER_READINESS.md) §8 (B-3); not live-validated |
| Worker readiness (B-5) | RESOLVED OFFLINE — migration 0008 `worker_presence`, `/ready` (channel) vs `/ready/r4` (aggregate), [readiness](../architecture/R4-I_PRODUCTION_CUTOVER_READINESS.md) §9, [architecture](../architecture/R4_ARCHITECTURE.md) §19.6; not live-validated |
| Live harness evidence | PENDING |
| Final audit | PENDING |
| **R4-I overall** | **IN PROGRESS** |

**Gate de cierre revisado (decisión de proyecto, 2026-09-28):** R4-I cierra con
(1) el número productivo de WhatsApp bajo R4 como único dueño y único escritor
outbound (sin coexistencia con el CRM; n8n pertenece a otro entorno productivo y está fuera del alcance de R4-I — corrección 2026-09-28) y (2) evidencia live del harness
(inbound durable → Task → modelo real → OutboundMessage → aceptación de Meta →
callbacks → evaluación G; dedupe, respuesta obsoleta, `unknown`, kill switch).
La identidad del operador **no** bloquea I (plano CRM/operador; R4 conserva
`TrustedHumanContext`). Las capacidades comerciales (Customer, Catalog,
Shipping, Quote) **no** bloquean I: su ausencia es evidencia para R4-J. Esto
reemplaza la decisión D-1 (c) (número canary separado). Orden de fases sin
cambio: I → J (Sales Autonomy) → K → L.

Pregunta: ¿puede R4 operar contra usuarios e integraciones reales bajo una
frontera de producción explícita, reversible y auditable, sin perder
idempotencia, ownership humano, privacidad ni control de efectos? Diseño:
[arquitectura §19](../architecture/R4_ARCHITECTURE.md), ADR-029.
**R4 POST-H RECOVERY BASELINE:** `dd06a68ff078a18a81e3dd12f5fd0ca5ef177ec9`.
Prerrequisito cumplido: [auditoría del WhatsApp de CRM-Customer-360](../architecture/R4-I_CRM_WHATSAPP_AUDIT.md)
con decisiones humanas D-1 (número canary propio de R4 de punta a punta; el
número productivo sigue en el CRM; sin puente CRM→R4→CRM), D-2 (respuesta
manual del operador), D-3 (protección de respuesta obsoleta, causal) y D-4
(timeouts/5xx ⇒ `unknown`).

| # | Criterio de salida (§141) | Evidencia |
|---|---|---|
| 1–2 | Modo producción explícito, fail-closed; test/shadow/production distinguibles | `unit/live-ops/mode-profile-rollout`, `contract/live-ops-boundaries` |
| 3–6 | Ingress canónico con tráfico con forma de proveedor; firma; reintentos y duplicados concurrentes ⇒ un input | `unit/live-ops/whatsapp-adapter`, `integration/live-ops-hardening` |
| 7–9 | Binding de conversación; recuperación ADR-028 mantiene la task; humano persiste inbound y bloquea autonomía | `integration/live-ops-{reference,hardening}` |
| 10–19 | respond ≠ entrega; un OutboundMessage por `response_step_id`; callbacks monótonos; `unknown` nunca se reintenta a ciegas; ADR-028 deduplica sólo con texto igual, mismo Task y frontier inbound evaluado, conservando evidencia de aceptación incierta | `unit/live-ops/delivery`, `integration/live-ops-*`, `recovery/live-ops-process-crash` |
| 20–23 | Perfil versionado; writes por D; sin verdad comercial fixture; disponibilidad = bindings reales | `contract/live-ops-boundaries` |
| 24–27 | Kill switch (default seguro, no pierde inbound); rollout (default 0 %, estable) | `integration/live-ops-reference`, `unit/live-ops/*` |
| 28–29 | Operador (hilo, take over/release, respuesta manual, resolver/cancelar outbound, atención); correlación inbound → task → run → step → outbound → id del proveedor | `integration/live-ops-*` (API y HTTP) |
| 30–31 | Sin secretos persistidos; PII minimizada | `integration/live-ops-hardening` (volcado de todas las tablas) |
| 32 | CI sin red | fake provider local; `R4_PROD_ALLOW_NETWORK` + URL loopback |
| 33–34 | Crash/restart y carreras horizontales | `recovery/live-ops-process-crash` (SIGKILL), dos dispatchers, callbacks concurrentes |
| 35–39 | Artifacts reproducibles; E2E offline; ADR-028; kill switch; handoff + inbound | `production:sales:validate`, `integration/live-ops-reference` |
| 40 | Mutaciones | `npm run test:mutation:production` (21/21); `npm run test:mutation:production-control` (D-5/D-6) |
| B-3 | Administración productiva del kill switch y liberación explícita de retenciones `autonomy_disabled` (host, no operador) | `integration/production-control`, `recovery/production-control-process`, `unit/live-ops/administration` |
| 44–45 | Sin autonomía de R4-J; sin despliegue ni rollout real | perfil v1 conservador; autonomía nace deshabilitada |

**Cambios mínimos de Core (genéricos, justificados en ADR-029):**
`TaskRuntime.prepareCreate/createWithin` (refactor sin cambio de semántica),
`TemporalRuntime.createTaskWithInput` (task + primer input en una transacción:
cierra la carrera "worker reclama una conversación vacía"),
`TemporalRuntime.holdForHumansWithin` + `submitInput(hold)` (hold de
plataforma = handoff de E con razón), `TemporalRuntime.releasePlatformHold`
(su inversa para un llamador de plataforma de confianza — D-6: misma transición
que cancelar un handoff solicitado, sin estado ni ciclo de vida nuevos),
`WorkerAdmission` opcional, scope humano
`autonomy.control`, nombres de telemetría. Protocolo, kernel, parser y gateway
de modelo sin cambio.

**Cambios en tests de fases previas (extensión, no relajación):** listas de
migraciones y tablas (0007), allow-lists de dependencias (`@r4/live-ops`,
`@r4/channel-gateway`, `@r4-adapters/whatsapp-cloud`), timers de pacing
(gateway, dispatcher), el ancla de una mutación de ADR-028 (el cuerpo de
`submitInput` se movió a `#submitInputWithin`). El paquete se llama
`live-ops` porque el test de pureza de Core prohíbe nombres de paquete que
contengan términos de dominio (p. ej. "product" en "production").

**Pendiente externo (bloqueante antes de desplegar):** validación live del
canal (sin credenciales del número canary en este entorno) — ver §4.

## 4. Decisiones diferidas intencionalmente

| Tema | Por qué se difiere | Seam existente |
|---|---|---|
| Autenticación / identidad del llamador | No hay consumidor todavía; no inventar un modelo de identidad | `PrincipalResolver`; `requested_by_*`, `actor_*` |
| Endpoints turns, artifacts, resume explícito | "No inventar endpoints de features no implementadas" (cancel, inputs, attention, respuestas humanas y handoff: R4-E) | `TaskRuntime.transitionTask` (interno) |
| Llamadas LLM reales y routing de modelos | C1 prueba el harness, no calidad | `ModelProvider` SPI; `WorkerBindings.modelProvider` |
| Entry point de producción del worker (`main`) | No existe proveedor real ni capabilities de Core: un `main` sería un placeholder | `runWorkerProcess(loadWorkerConfig(env), bindings)` |
| HTTP `/health`, `/ready` del worker | Innecesario: desde R4-I la readiness del worker es presencia durable (`worker_presence`, 0008) observada en `/ready/r4` del gateway | `WorkerPresence` |
| Protocolo de acción híbrido (tool calls nativas) | Constitución §27.11 sigue abierta; C1 usa salida estructurada | `parseAgentDecision` |
| Decisión Delegate | R4-F+ (ProposeAction: R4-D; Wait, Consult, Handoff, manage_goal: R4-E) | `AgentDecision` (unión discriminada) |
| Reintentos de modelo y reparación de decisiones inválidas | Reparación / reintento dentro de la run: sigue diferido (ADR-008). **Recuperación a nivel de run: resuelta post-H por ADR-028** | `model_failure` / `invalid_decision` clasificados; `runFailureDisposition` |
| Presupuesto de costo / tokens como política | Ownership de pricing sin decidir; `maxTokens` sí se aplica si la task lo declara | `ExecutionPolicy`, `budgetSchema` |
| Deadline de task (`deadlineAt`) aplicado por el worker | No requerido por C1 | `maxRunDurationMs` |
| Prioridades / `LISTEN/NOTIFY` en el claim | Sin necesidad demostrada (ADR-006) | índice `agent_tasks_claimable_idx` |
| Retries de capabilities READ | Sin necesidad demostrada (los writes ya reintentan sólo por su estrategia declarada, R4-D) | `retryPolicy` en la definición; `attempts` en provenance |
| Outbox durable y catálogo público de eventos | Sin consumidor aún; evita infraestructura prematura | Eventos de telemetría con nombres estables |
| Artifact | Depende del modelo de tasks/ownership (Constitución §18) | — |
| Budgets de costo | Ownership de pricing/moneda sin decidir | `budgetSchema` extensible |
| Aviso antes de consult/handoff en el mismo turno (R4-J1E-R2.2) | `respond` es terminal para el turno (ADR-008); una solución es decisión de producto aparte, nunca un `respond` intermedio | `request_consultation` / `request_handoff`; ADR-031 "Diferido" |
| `respond` + `complete` en el mismo turno (R4-J1E-R2.2) | Hoy se completa en un turno sin respuesta o la task queda esperando input; sin `respond` intermedio | decisión `complete`; ADR-031 "Diferido" |
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
| (D) Cancelación cooperativa de un efecto en vuelo | Sin caso de uso; D marca la ejecución `needs_reconciliation` y rechaza la respuesta tardía | `signal` en `WriteHandlerContext`; `finishRunWithin` |
| (D) Verificación de identidad (`verified`) y tenancy | Sin servicio de identidad ni modelo de tenant; no inventarlos | `identityAssuranceOf`, `TrustedActionContext.actor` |
| (D) Deduplicación semántica entre propuestas distintas | Depende de la intención del dominio | propuestas y ejecuciones separadas por clave |
| (D) Política productiva (autonomía por agente, overrides reales) | Decisión de gobierno, no técnica | `ActionPolicyConfiguration`, `WorkerBindings.actionPolicy` |
| (D) Evaluación textual de afirmaciones del agente | R4-G; D garantiza la verdad estructural (ledger), no la redacción | observations + receipts |
| (D) Capabilities de escritura de dominio reales | Fuera de Core (ADR-005); D usa sólo el ledger de prueba | `registerWrite` |
| (E) Heartbeat del lease de reconciliación | `reconcile` es lectura idempotente por clave; un registro tardío es rechazado por la generación | lease del schedule |
| (E) IAM productivo de operadores | Sin servicio de identidad; no simularlo | `AppDependencies.humanContext` → `TrustedHumanContext` |
| (E) Operator UI / Operator Plane | Sin consumidor; la API expone los seams | `/v1/attention`, `/v1/tasks/:id/temporal` |
| (E) Adapters de canal (mensajería, voz) | Fuera de Core; el input es canónico y neutral | `POST /v1/tasks/:id/inputs` |
| (E) Política productiva de reconciliación y de follow-up | Decisión de gobierno; sin default en código | `R4_RECONCILIATION_*`; `WAIT_UNTIL` |
| (E) Jerarquía óptima de goals, planning automático, scoring | Sin evidencia; E sólo representa raíz/foco/padre | `manage_goal`, `goal_transitions` |
| (E) Memoria semántica de largo plazo; resumen de historia de interacción basado en modelo | Sin proveedor real ni evaluación | `platform.interaction` + compaction de C2 |
| (E) Delegación multi-agente; Quality Auditor | R4-F+ / R4-G | `AgentDecision`, evaluación |
| (E) Carga de la proyección de interacción acotada en la consulta (no sólo en el compilador) | Sin tasks largas reales todavía; C2 ya acota lo que ve el modelo | `interactionRecords` |
| (F) Adapters live de Customer / Catalog / Shipping / Quote | Ningún contrato público documentado en este repositorio; no se inventan endpoints | ports en `adapters/domains/*/port.ts` |
| (F) Entrega de `respond` por canal (WhatsApp, etc.) | Boundary posterior; `respond` es observable, no entregado | input canónico; `respond` en el step log |
| (F) Reintento de modelo / reparación de decisiones inválidas | Sigue diferido (C1): una decisión inválida de un modelo real termina la run; `sales:live` lo registra | `invalid_decision`, `model_failure` |
| (F) Actualización de cotizaciones emitidas | La semántica del owner en F es "cambio ⇒ quote nuevo" | `quote.create`; `selectionOrDeliveryChangedSince` en el workspace |
| (F) Tool calling nativo como transporte de decisiones | ADR-008 se mantiene durante F | `OpenAICompatibleModelProvider` no envía tools |
| (F) Presupuesto/optimización de contexto para Sales | Medir primero (ADR-015); el reporte ya da tokens por kind y fuente | `report.context`, `context_snapshot_items` |
| (F) Prompt de ventas óptimo, jerarquía óptima de goals, scoring de calidad, subagentes especialistas | Requieren evidencia de R4-G | escenarios + `sales:live` artifacts |
| (F) Identidad de cliente productiva | Sin servicio de identidad; binding provisional del ingress | `sales.conversations`, `customer.get_context` |
| (G) Tokens de razonamiento en `ModelUsage` | Tocaría C1/contratos; ningún proveedor los expone hoy por el adapter | `ModelCallRecord.reasoningTokens` (null = no expuesto) |
| (G) FailureCluster, KnowledgeCandidate, ImprovementProposal | Requieren volumen real; H sólo produce observaciones conservadoras + registro revisado | `findings.jsonl`, `aggregate.json`, `architecture-gap-candidates.jsonl` |
| (G) Quality Auditor como Agent Pack | Sin necesidad antes de evaluación continua | `SemanticJudge` + rúbricas versionadas |
| (G) Persistencia de evaluaciones en BD | Sin consumidor operacional (ADR-026) | artifacts con manifest |
| (G) Calculadora de costos | Precios no pertenecen a Core; se registran tokens y llamadas | métricas de eficiencia |
| (G) Benchmark live grande / comparación de proveedores | Costo; se preparó el seam y se limita N live ≤ 3 sin `--allow-large` | `benchmark:sales --source live` |
| (G) Reparación de prompt de Sales por findings | Prohibido en G: el evaluador debe ver los defectos actuales | RegressionCase → cambio externo → Experiment |
| (H) Retry/reparación de decisiones inválidas o "run fallida ≠ task fallida" | **Resuelto post-H (ADR-028, §3.10):** run fallida ≠ task fallida para `invalid_decision` y `model_failure` reintentable. Siguen diferidos: reparación dentro de la run, reintento por calidad, fallback de modelo | `runFailureDisposition`, `maxRunFailureRecoveries` |
| (post-H) Aplicar el principio de ADR-028 a `capability_failure` / caídas de dominio | Sin evidencia live para distinguir falla transitoria, rechazo de dominio, error de contrato y falla permanente | `runFailureDisposition` (`terminal` hoy) |
| (post-H → R4-I) `respond` entregado por canal y luego run fallida: la recuperación podría responder otra vez | **Resuelto en R4-I (ADR-029):** identidad por step; mismo reply causal sólo si coinciden Task, frontier inbound evaluado y texto; otro turno/Task/origen operator permitido | `outbound_messages.response_step_id` + `context_snapshot_items` + `task_inputs` |
| (H) Adapters live-read de Catalog/Customer/Shipping y sandbox de Quote | Sin contrato + endpoint + credencial configurados en R4 (GAP-H-007) | `live-read` en `ShadowExecutionPolicy` (opt-in + contrato) |
| (H) Replay de conversaciones reales | Sin fuente legal/operacional | `workloadFromReplay` + sanitización |
| (H) Tokens de razonamiento en métricas | `ModelUsage` no los expone (sin cambio de Core) | `ShadowModelCall.reasoningTokens` = null |
| (H) Experimento de prompt post-baseline | Decisión humana (§82); ningún candidato elegido en H | `experiment:sales` / Experiment de G |

### 4.1 Diferido desde R4-I (ADR-029)

| Tema | Por qué se difiere | Seam existente |
|---|---|---|
| (I → J) Ampliar la superficie autónoma: owners reales de Catalog/Customer/Shipping/Quote, menos aprobaciones, cohortes mayores por evidencia, optimización comercial, tuning del Sales | R4-J decide cuánto poder comercial otorgar | perfil de producción versionado, rollout, `SALES_PRODUCTION_ACTION_POLICY` |
| (I) Validación live del canal WhatsApp (número canary) | Sin credenciales/número canary configurados en este entorno — **bloqueante antes de desplegar** | `production:sales:smoke`, `production:sales:plan` |
| (I) Paridad de UI de operadores del CRM (hilo, controles, respuesta manual, estados) sobre las APIs de R4 | Bloqueante antes de migrar el número productivo (D-1) | `/v1/production/*`, `/v1/tasks/:id/thread` |
| (I) Plantillas fuera de la ventana de 24 h (respuesta manual y seguimiento) | Sólo texto dentro de la ventana en R4-I (D-2) | `OutboundChannelAdapter`, `window_closed` |
| (I) Indicador "escribiendo"/marcar leído; agrupación de fragmentos (turn settling) | UX, no correctitud; los fragmentos que llegan antes del claim ya entran al mismo snapshot | canal; claim ordinario |
| (I) Liberación masiva de tasks retenidas tras soltar el kill switch | Operación deliberada por task en R4-I; `autonomy on` nunca libera | `production:sales:control holds release --task` (sólo `autonomy_disabled`), `respondHuman(release|cancel)` |
| (I → plano CRM/operador) Handoffs pedidos por el agente (`request_handoff`) y demás retenciones sin superficie humana tras el cutover | La identidad del operador queda fuera de R4; la administración de host no los libera — evidencia R4-J visible | `TrustedHumanContext`, `/v1/production/*`, `/v1/attention` |
| (I) Clave de idempotencia del proveedor / exactly-once | Meta no documenta una; no se afirma | `idempotencyKey` en `OutboundSubmission` |
| (I) Reconciliación automática de `unknown` sin id del proveedor (p. ej. `biz_opaque_callback_data`) | No verificado en la documentación oficial; no se inventa | atención + resolución del operador |
| (I) Recuperabilidad genérica de `capability_failure` | Sin evidencia real nueva (sin owners reales en I) | `runFailureDisposition` |
| (I) Adjuntos multimodales | Sin seam multimodal; se clasifican `unsupported` y van a humano | `content.kind = unsupported` |

### 4.2 Diferido desde R4-J3 (re-delimitación del owner, 2026-10-14)

| Tema | Por qué se difiere | Seam / referencia |
|---|---|---|
| (J3 → R4 Media) Entrega del PDF oficial de la cotización al cliente (GAP-01; `J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA`) | J3 se re-delimitó a *Quote Integration & Autonomous Issuance*. La entrega requiere capabilities del harness para archivos salientes (ADR-038, `PROPOSED_DEFERRED`). **Requisito verificable antes de cualquier rollout comercial que prometa PDFs al cliente:** documento enviado una vez por cotización a la conversación autenticada que la pidió; SHA-256 = manifiesto del owner; destinatario = binding; sin filtración entre conversaciones; sin reenvío ante un resultado incierto; estado `delivered` del proveedor en el número real. Ningún perfil ni texto al cliente puede prometer el PDF antes de eso | Diseño en la rama `r4-j3f-document-delivery-design`; criterios AC-1…AC-13 del diseño J3F §12; GAP-01 |
| (J3 → R4 Media) Iniciativa **R4 Media & Communications — Governed Multimodal Capabilities**: audio entrante, transcripción, imágenes, comprensión multimodal, documentos entrantes, archivos salientes, transporte de medios por canal, autorización, idempotencia de comunicaciones, estados de entrega | Transversal. Fases independientes; entregar un PDF no exige completar el resto. Terminología: *capacidad de plataforma* o *capability del harness* (una skill agéntica las usa, no las implementa) | `content.kind = unsupported` (entrada); `OutboundChannelAdapter` (salida) |
