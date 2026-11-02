---
title: R4-J4-R7-1 — Runtime Contingency & Recovery — informe de implementación
status: R4_J4_R7_G1_READY_FOR_INDEPENDENT_REVIEW
mandate: «R4 — Implementation Mandate J4-R7-1: Runtime Contingency & Recovery» (owner, 2026-10-28; IMPLEMENTATION_AUTHORIZED_OFFLINE)
date: 2026-10-28
branch: feat/r4-j4-r7-1-runtime-contingency (local, sin push)
base: 0356388 (main d0bb7a7 + documentación R7 aprobada en G0)
---

# R4-J4-R7-1 — Informe de implementación

```text
R7_1A_RECOVERY              IMPLEMENTED  budget / capability / internal / lease_lost ⇒ handoff de plataforma; content_filter ⇒ contingencia
R7_1B_ADR041                INTEGRATED   PR #27 por cherry-pick (sin modificarlo); avisos generalizados a 7 razones; columna human_request_id
R7_1C_VALIDATIONS           IMPLEMENTED  expiry_in_past / unknown_evidence ⇒ step refused recuperable, mostrado al modelo
R7_1D_KC0                   IMPLEMENTED  escrituras ocultas con 0 restantes (kernel, no contractual)
R7_1E_KC2                   IMPLEMENTED  finishReason en termination.details de invalid_decision (kernel, no contractual)
R7_1F_OBSERVABILITY         IMPLEMENTED  attention().undeliveredOutbound (expired / window_closed); sin re-wake
PROTOCOL_V5 / KERNEL_PORT   UNCHANGED
NEW_PROCESSES / QUEUES      NONE
G1                          READY_FOR_INDEPENDENT_REVIEW
```

## 1. Rama y base

| Ítem | Valor |
|---|---|
| Worktree | `dev/r4-j4-r7-1` (aislado) |
| Rama | `feat/r4-j4-r7-1-runtime-contingency`, local, **sin push ni merge** |
| Base | `0356388` = `main` `d0bb7a7` + documentación R7 (`026867d`, `0356388`) |
| ADR-041 | `387b720` y `93fe35a` del PR #27 integrados por `cherry-pick -x` (commits `e25b6f8`, `1b2cefd`). El PR #27 **no se tocó** |
| Servicios | Sólo el PostgreSQL local de pruebas. Ninguna llamada a DeepSeek, WhatsApp, PrestaShop, CIA ni Customer Profile |
| Migraciones | Ninguna ejecutada fuera de las BD desechables de prueba. La `0012` (ADR-041) cambia de nombre de columna antes de aplicarse en cualquier entorno |

## 2. Cambios por componente

| Mandato | Archivo | Cambio |
|---|---|---|
| R7-1A | `packages/contracts/src/run.ts` | `runFailureDisposition`: `budget_exhausted`, `capability_failure`, `internal_failure`, `lease_lost` ⇒ `human`; `invalid_decision` con `finishReason = content_filter` ⇒ `human`. Razones `RUN_OUTPUT_FILTERED`, `RUN_BUDGET_EXHAUSTED`, `RUN_CAPABILITY_FAILURE`, `RUN_INTERNAL_FAILURE`, `RUN_ABANDONED`; `RUN_FAILURE_HANDOFF_REASONS`; `runFailureHandoffReason()` |
| R7-1A | `packages/task-runtime/src/execution-runtime.ts` | Razón del handoff por terminación; telemetría `task.run_failure.contingency`; abandono en `claimNext` ⇒ handoff en la misma tx; fallback sin runtime humano (`FORMERLY_TERMINAL`) para no entrar en bucle |
| R7-1A | `packages/task-runtime/src/temporal-runtime.ts` | Resumen del handoff para contingencias (texto de plataforma, sin salida del modelo) |
| R7-1B | `packages/persistence-postgres/migrations/0012_platform_fallback_outbound.sql`, `src/production-store.ts`, `packages/live-ops/src/{ports,delivery,context-source}.ts` | Columna `human_request_id` (D-8); materialización para todas las `RUN_FAILURE_HANDOFF_REASONS`; textos generalizados |
| R7-1C | `packages/task-runtime/src/temporal-runtime.ts` (`#humanRequestRejection`), `packages/context-compiler/src/sources/platform.ts` | `expiry_in_past` / `unknown_evidence` ⇒ step `refused` + evento `temporal.decision.rejected`; episodio `decision_rejection:` para el modelo |
| R7-1D | `packages/agent-kernel/src/context.ts` | KC-0: `visibleCapabilities` por escrituras **restantes** |
| R7-1E | `packages/agent-kernel/src/kernel.ts` | KC-2: `DecideOutcome.invalid.finishReason`; `termination.details = { finishReason }` |
| R7-1F | `packages/live-ops/src/ports.ts`, `persistence-postgres/src/production-store.ts` | `ProductionAttention.undeliveredOutbound` (agente o plataforma, `cancelled` por `expired`/`window_closed`) |
| — | `packages/observability/src/telemetry.ts` | Eventos `task.run_failure.contingency`, `temporal.decision.rejected` |
| — | `agents/sales/src/shadow/invariants.ts` | `shadow.non_retryable_handed_off` acotada a `model_failure` |
| Docs | `docs/adr/ADR-028` (enmienda), `ADR-041` (enmienda), **`ADR-042` (`R4-OWNER-COLLABORATION-01`, propuesto)**, **`ADR-043` (política: cotizaciones ordinarias sin aprobación humana)**, `docs/roadmap/R4_DELIVERY_ROADMAP.md` (J5-A, J5-B planificados) | — |

**No cambian:** el protocolo `r4.agent_decision.v5`, el puerto `KernelSession`, Quote, Checkout, perfiles, el pack Sales
(salvo la invariante shadow), los procesos y las colas. No se agregó supervisor ni segundo modelo.

## 3. Pruebas añadidas o actualizadas

**Nuevas**
- `tests/integration/runtime-contingency.test.ts`: 13 escenarios, S01, S03, S04, S08, S11, S12, S13, S14, S15, S16,
  S50, S53 y S57. Usa dos harnesses:
  - runtime directo con el Temporal Runtime (y sin él, para S15);
  - testbed de canal real: webhook, worker productivo Sales, entrega y WhatsApp falso.
- `tests/unit/task-runtime/run-failure-recovery.test.ts`: tabla de disposiciones de la enmienda; razones de handoff y
  su validez como razón de estado y de handoff.
- `tests/unit/agent-kernel/kernel.test.ts`: KC-2 (`length`, `content_filter`, `stop`); metadata sin texto del modelo.
- `tests/unit/agent-kernel/kernel-actions.test.ts`: KC-0.
- `tests/mutation/runtime-contingency-mutations.mjs` (`npm run test:mutation:runtime-contingency`): 11 mutaciones.

**Actualizadas** (cambio de comportamiento intencional; cada una lleva un comentario)

| Prueba | Antes | Ahora |
|---|---|---|
| `run-failure-recovery.test.ts` (escritura y luego presupuesto; "terminal failures stay terminal") | task `failed` | `blocked` `run_budget_exhausted`; `runFailureRecovery = handed_off` |
| `worker-kernel.test.ts` (READ infinito; techo de tokens) | task `failed` | `blocked` `run_budget_exhausted` |
| `reconciliation.test.ts` (abandono con efecto incierto) | intención terminal `failed` y luego `failed` tras reconciliar | handoff `run_abandoned`; la reconciliación establece el efecto (1 receipt, 1 escritura); el humano conserva la task |
| `sales-deterministic-offer-canary.test.ts` (`@7`, retenida más que el presupuesto) | `failed`, sin mensaje al cliente | `blocked` y **un** aviso fijo del pack entregado al cliente |

**Correspondencia con el plan de pruebas (§3.1, §3.4)**

| ID | Prueba |
|---|---|
| S01 | `runtime-contingency` (S01) + `run-failure-fallback.test.ts` (ADR-041) |
| S02 | `run-failure-recovery.test.ts` (existente) |
| S03 | `runtime-contingency` (S03) |
| S04 | `runtime-contingency` (S04) |
| S05 | `run-failure-recovery.test.ts`, `run-failure-fallback.test.ts` (timeout, existentes) |
| S06 | `worker-recovery.test.ts`, `execution-leases.test.ts` (existentes) |
| S07 | `tests/unit/model-gateway` (existentes) |
| S08 | `runtime-contingency` (S08 runtime y canal) |
| S09 | `worker-kernel.test.ts` (READ infinito, actualizado) |
| S10 | KC-0 unitario; `run-failure-recovery.test.ts` (escritura forzada ⇒ `blocked`) |
| S11 | `runtime-contingency` (S11) |
| S12 | `runtime-contingency` (S12) |
| S13 | `runtime-contingency` (S13) y `reconciliation.test.ts` |
| S14 | `runtime-contingency` (S14) |
| S15 | `runtime-contingency` (S15) y `execution-leases.test.ts` (abandono sin runtime humano ⇒ `failed`) |
| S16 | `runtime-contingency` (S16) |
| S50 | `runtime-contingency` (S50) |
| S51, S52 | `live-ops-hardening.test.ts`, `live-ops-reference.test.ts`, `tests/recovery/live-ops-process-crash.test.ts` (existentes) |
| S53 | `runtime-contingency` (S08, redeploy del gateway) |
| S54 | `run-failure-recovery.test.ts` ("a governed write before the invalid output": 1 propuesta, 1 ejecución, 1 receipt, misma clave; ahora `blocked`) |
| S57 | `runtime-contingency` (S57) |

**Desviación declarada:** S57 se implementó como **inyección de falla dentro de la transacción** (un handoff que
escribe todo y luego lanza), no con SIGKILL del proceso. Prueba lo mismo: todo o nada. La suite `recovery` existente
cubre los SIGKILL reales del camino de recuperación.

## 4. Resultados de regresión

Ejecución local del 2026-10-28 y 2026-10-29 sobre el árbol de esta rama (PostgreSQL de pruebas local; sin servicios
externos).

| Suite | Resultado |
|---|---|
| `typecheck` (`tsc --noEmit`) | OK |
| `lint` (repo completo, `--max-warnings=0`) | OK |
| `build` (`tsc -b tsconfig.build.json`, desde cero) | OK |
| unit | **1529 passed**, 4 skipped (85 archivos + 1 skipped) |
| contract | **452 / 452** |
| integration (`--no-file-parallelism`) | **642 passed**, 12 skipped, 0 failed (47 archivos + 1 skipped) |
| sales | **29 / 29** |
| shadow | **5 / 5** |
| recovery (sola, con el build de esta rama) | **18 / 18** (11 archivos) |
| mutaciones `runtime-contingency` (nueva) | **11 / 11** detectadas |
| mutaciones `run-failure-fallback` (ADR-041) | **6 / 6** |
| mutaciones `production` | **23 / 23** |
| mutaciones `production-control` | **13 / 13** |
| mutaciones `recovery` (ADR-028) | **14 / 14** (tras re-anclar 4 mutaciones; ver §4.1) |

Línea base `d0bb7a7` [D informe R6]: unit 1520, contract 452, integration 615, sales 29, shadow 5, recovery 18/18.
Los aumentos se explican así:
- unit +9: nuevas pruebas R7-1, incluidas las de ADR-041;
- integration +27: 14 de ADR-041 y 13 de R7-1.

### 4.1 Hallazgos de la ejecución

1. **Fallos intermitentes por carga con archivos en paralelo.**
   - En la primera corrida completa paralela falló 1 prueba: `sales-deterministic-offer-canary` > GAP-16, "the owner
     stays unavailable…".
   - En la segunda corrida paralela fallaron 2 distintas: `production-control` > "refuses outside a positively
     established…" (timeout de 30 s) y `worker-kernel` > heartbeat "keeps the lease alive…" (lease no renovado a
     tiempo, run `interrupted`).
   - Las tres pasan solas, y la corrida en serie da 0 fallos.
   - El camino de GAP-16 (`write_outcome_uncertain`) no es una terminación que R7-1 modifique.
   - Clasificación: **sensibilidad a tiempos del entorno local**, no regresión.
2. **Anclas del script de mutaciones de ADR-028** (`tests/mutation/run-failure-recovery-mutations.mjs`).
   - Tres mutaciones ("recover budget_exhausted", "recover capability_failure without evidence", "non-retryable model
     failure retried") anclaban en líneas que R7-1 reescribió en `runFailureDisposition`. Se re-anclaron con la misma
     intención.
   - La mutación "exhaustion without attention" tenía un **defecto previo**: su ancla calzaba primero en
     `holdForHumansWithin` (R4-I) y no en `handOffAfterRunFailureWithin`, así que mutaba la función equivocada.
   - Verificado sobre `d0bb7a7` en un worktree temporal: allí también **sobrevive** (17/17 pruebas pasan con la
     mutación). Se re-ancló a la función correcta.
3. **Montaje del worktree.** `recovery` y `build` resuelven `@r4/*` por `node_modules`; vitest lo hace por alias a los
   fuentes.
   - El `node_modules` compartido de otro worktree hacía que `recovery` ejecutara en parte código de `d0bb7a7`. Esa
     corrida se descartó.
   - Se armó un `node_modules` local: dependencias de terceros compartidas y paquetes de workspace apuntando a esta
     rama. Luego se recompiló desde cero.
   - Las suites basadas en vitest y las mutaciones no se vieron afectadas.

## 5. Comprobaciones pedidas por el mandato (§6)

| # | Comprobación | Resultado | Evidencia |
|---|---|---|---|
| 1 | No quedan tareas terminales silenciosas por agotamiento de presupuestos | **Sí**: todas las dimensiones ⇒ `blocked` + handoff + aviso | S08 (runtime y canal), S09, S10, `worker-kernel` |
| 2 | Handoffs durables y observables | **Sí**: `human_requests` + `WAIT_FOR_HUMAN` en la misma tx; listados en `attention()` | S08, S11–S13, S57 |
| 3 | Las contingencias no duplican mensajes | **Sí**: 1 aviso por solicitud (único `human_request_id`), aun tras redeploy y varias pasadas de entrega | S08/S53, S16, S01, S03, S04 |
| 4 | Las recuperaciones no repiten operaciones comerciales | **Sí**: ningún camino nuevo crea propuestas ni claves | S54, `reconciliation` (abandono con efecto: 1 escritura, 1 receipt) |
| 5 | Se conservan la idempotencia y sus mecanismos | **Sí**: `executionKey`, idempotencia del outbound y del inbound sin cambios | Suites `governed-execution*`, `live-ops-*`, `run-failure-fallback` |
| 6 | No cambian las garantías comerciales de J3 | **Sí**: suites J3/J3E en verde; sólo cambió lo que ve el cliente cuando una run se queda sin presupuesto (`@7`: un aviso en vez de silencio) | `sales-*`, `sales-deterministic-offer-canary` |

## 6. Riesgos y limitaciones

| Riesgo | Detalle | Mitigación |
|---|---|---|
| Más handoffs | Toda contingencia llega a un humano (antes eran fallos silenciosos) | Visibles en `attention()`; aviso al cliente; medir en canary |
| Aviso sin entrada pendiente | Hasta R7-2 no existe `UNANSWERED`: un presupuesto agotado en una run despertada por timer también avisa | Documentado en la enmienda de ADR-041; lo corrige R7-2 |
| Clientes de la API | Ven `blocked` donde antes veían `failed` | Enmienda de ADR-028; los códigos `run_*` explican la causa |
| `0012` renombrada | Una BD de canary que la hubiera aplicado con `handoff_request_id` queda `modified` | Recrear esa BD (nunca se aplicó en producción) |
| Fallback sin runtime humano | Sólo las cuatro clases antes terminales vuelven a `failed`; `content_filter` sin runtime humano lanza `run_failure_handoff_unavailable` (igual que `model_failure` no reintentable) | Los workers productivos siempre adjuntan el runtime temporal |
| BLK-AP1 | Sigue abierto (R7-3) | Dependencia operativa vigente: ningún perfil `REQUIRE_APPROVAL` con clientes reales |
| Producción | `@2` no cambia sin despliegue autorizado ni `db:migrate` | — |

## 7. Estado

`R4_J4_R7_G1_READY_FOR_INDEPENDENT_REVIEW`. No se inició R7-2.
