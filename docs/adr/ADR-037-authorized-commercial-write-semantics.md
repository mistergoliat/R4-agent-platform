# ADR-037 — Semántica de una escritura comercial autorizada que no puede ejecutarse o cuyo resultado es incierto

- **Estado:** **Propuesto** (propuesta del owner, 2026-10-14; redactado en la corrección de GAP-16). No modifica `packages/`, `apps/` ni `adapters/`. Documenta la semántica vigente de `quote.create@5` y las brechas conocidas.
- **Fecha:** 2026-10-14
- **Alcance:** cualquier escritura comercial **autorizada** de forma autónoma. Hoy la única es `quote.create@5` (`sales-production@7`). Las capacidades históricas `quote.create@2–@4` conservan su semántica (§Compatibilidad).
- **No bloquea** el canary EC2 de `@7`. **Debe quedar aceptado antes de la aceptación operacional J7.**
- **Independiente de ADR-036**, que trata la autenticidad y la procedencia de los mensajes del cliente. Este ADR trata qué pasa con una escritura **después** de autorizada.
- **Autoridad superior:** Constitución ("writes require governed execution", "durable state must survive process restart"); ADR-016, ADR-018, ADR-019, ADR-020, ADR-021, ADR-028, ADR-034, ADR-035.
- **Evidencia:**
  - `docs/architecture/R4-J3E_C1_IMPLEMENTATION_REPORT.md` §6.2–6.4 (kill switch);
  - `docs/acceptance/R4_J3_FINAL_ACCEPTANCE.md` §5.4 y GAP-16 (owner no disponible);
  - `tests/integration/sales-deterministic-offer-canary.test.ts` (ciclo de vida real).

## Contexto

Una escritura queda **autorizada** cuando, en una sola transacción, Sales registra:
- la decisión `authorized:eligible` (`sales.quote_autonomous_decisions`, `0008`);
- el cuerpo congelado (`sales.quote_v2_requests`, `0007`);
- la evidencia de intención (`sales.quote_intent_evidence`, `0009`), que consume la confirmación del cliente.

Desde ese momento el único efecto legítimo es **enviar exactamente ese cuerpo con esa clave** (`Idempotency-Key` = clave de ejecución). Un índice único impide una segunda autorización del mismo snapshot en la conversación, y la confirmación no puede reutilizarse.

Reglas de la plataforma que este ADR no cambia (SOURCE):

| Regla | Ubicación |
|---|---|
| Un intento que no llegó al dominio es `unknown`; solo una búsqueda establece "no aplicado"; `execute` no puede devolver `not_applied` | `action-executor.ts:144-145`, `:245-246` |
| `applied`, `rejected` y `failed` son definitivos: recibo en la misma transacción, sin reintento | `packages/task-runtime/src/action-lifecycle.ts:67` |
| Con `reconcile_before_retry`, tras un `unknown` se reconcilia; `not_applied` con intentos disponibles → replay de la misma clave | `action-lifecycle.ts:56-87` |
| Backoff durable entre intentos: `initialBackoffMs × 2^(intentos−1)`, sin worker esperando | `packages/task-runtime/src/action-runtime.ts:186-199` |
| Reconciliaciones agotadas → `needs_reconciliation`; la reconciliación del scheduler que obtiene `not_applied` liquida `failed/write_not_applied` **sin replay** | `action-lifecycle.ts:76-79`; `action-runtime.ts:669` |

**Problema que motivó el ADR.** Dos situaciones terminaban en `failed` definitivo **después** de autorizar:
- un kill switch activado entre la autorización y el envío (corregido en C1 §6.2);
- un owner temporalmente no disponible (GAP-16, corregido en `quote.create@5`).

En ambas, la autorización y la confirmación quedaban consumidas sin cotización y sin forma autónoma de completarla.

## Decisión propuesta

### Tabla de situaciones

| # | Situación | Tratamiento | Resultado del handler | Qué hace la plataforma | Implementación |
|---|---|---|---|---|---|
| 1 | **Bloqueada antes de enviarse** (kill switch después de autorizar) | Retención conocida | `unknown`, **sin** fila de envío | Reconciliación por clave: sin envío, `not_applied` inmediato → replay de la misma clave al liberar | `sendHeld` (`quote-v5.ts`); C1 E2E 2 |
| 2 | **Enviada sin resultado confirmado**: timeout, conexión perdida, `contract_violation`, `not_found`, **owner no disponible** | Resultado incierto | `unknown`, **con** fila de envío | Reconciliación por clave; `not_found` es final solo cuando pasó la ventana del owner (90 + 30 s desde el último envío, reloj de la base) | `classifySend` (incierto); `ownerUnavailableHeld` (GAP-16); `reconcileQuoteV2Command` |
| 3 | **Confirmada como aplicada** | Reconciliación sin nuevo envío | Reconciliación: `applied`, liquidación estricta | Recibo `succeeded`, `replayed: true` | Test "lost answer" (GAP-16) |
| 4 | **Confirmada como no aplicada** | Reintento con la misma clave, sujeto a política | Reconciliación: `not_applied` | Replay de la misma clave y cuerpo si quedan intentos (`maxAttempts = 3`; backoff 20/40/80 s) | Tests C1 E2E 2 y "owner unavailable" (GAP-16) |
| 5 | **Reintentos agotados** | Reconciliación o intervención operacional | — | `needs_reconciliation`; el run termina `write_outcome_uncertain`, la tarea queda `blocked`; el scheduler reconcilia según su política: `applied` → `succeeded`; `not_applied` → `failed/write_not_applied`, **sin replay** | Test "stays unavailable" (GAP-16); runbook pendiente |
| 6 | **Rechazo definitivo del owner después de autorizar** (422, 409, 401/403) | Definitivo, operacional | `rejected` / `failed` | Recibo definitivo; la autorización queda y bloquea una reemisión (`duplicate_quote`) | `classifySend`; sin cambio |

### Reglas

- **R1. Antes de autorizar**, todo rechazo es `failed` o `rejected` y no deja nada autorizado; la confirmación no se consume. Ejemplos: kill switch antes de decidir, Catalog o Shipping caídos (`quote_evidence_unavailable`).
- **R2. Después de autorizar**, una condición **transitoria** nunca liquida el comando: devuelve `unknown` (situaciones 1 y 2). Solo un resultado del owner que pruebe aplicación o rechazo definitivo lo liquida.
- **R3. Nunca una clave nueva** para un cuerpo autorizado. Todo replay envía el mismo cuerpo congelado con la misma clave; el owner garantiza una sola cotización por clave.
- **R4. Retención conocida e incierto se distinguen por la fila de envío.** Sin envío registrado, `not_found` es final de inmediato (situación 1). Con envío, solo tras la ventana del owner (situación 2).
- **R5. Al reanudar no se re-verifican precios, stock ni despacho**: se envía lo que el cliente confirmó. Si una retención se debió a un problema comercial, el operador cancela o toma la tarea **antes** de liberar (C1 §13.3).
- **R6. Situaciones 5 y 6 requieren un operador**, con alerta y runbook (J7): listar ejecuciones `needs_reconciliation` y `executing` con `action_retry` pendiente; decidir por cada una; informar al cliente.

## Límites conocidos (candidatos a decisión; ninguno se implementa con este ADR)

| # | Límite | Efecto observado | Opciones |
|---|---|---|---|
| L1 | Solo se registra el **inicio** de cada envío | Ante un 503 inmediato, R4 espera la ventana completa (120 s) antes de dar `not_found` por final: el replay llega ≈ 300 s después del fallo (reconciliaciones a 20, 60 y 140 s; replay 160 s después) | Registrar el fin del intento (migración Sales nueva) y aplicar la regla del owner "final 30 s después del fin" |
| L2 | La reconciliación del scheduler **no reproduce** tras `not_applied` | Un corte más largo que las reconciliaciones del run (≈ 140 s) termina en `failed/write_not_applied` con la autorización varada | (a) Harness: permitir replay desde la reconciliación programada si quedan intentos y la tarea no es de humanos. (b) Sales: acción de operador que libere la autorización con registro. (c) Emisión fuera de R4 |
| L3 | **Silencio** con el cliente mientras está retenida o incierta | El run está suspendido; no hay mensaje "pendiente". Con la tarea `blocked`, nadie responde hasta que se resuelve | Alerta al operador (J7); o un aviso de plataforma durante la retención (harness) |
| L4 | **Presupuesto del run** | El camino de retención toma ≈ 300 s de tiempo de plataforma. Si el presupuesto del run (por defecto 15 min) es menor, la cotización se emite sin respuesta al cliente (C1 caso 4) | Fijar `R4_EXEC_MAX_RUN_DURATION_MS` ≥ 10 min en producción y verificarlo en el despliegue |
| L5 | **Kill switch por canal** | No detiene escrituras de `@7` | ADR propio o corrección de harness (GAP-07) |
| L6 | **Rechazo definitivo tras autorizar** (situación 6) | La autorización bloquea la reemisión del mismo snapshot | Igual que L2 (b) |

## Compatibilidad

- `quote.create@2–@4` y `classifySend` **no cambian**: un owner no disponible sigue siendo `failed quote_service_unavailable` (`retryable: true`) en esas versiones. Sus tests lo fijan:
  - `tests/integration/sales-autonomous-quote.test.ts:380` (C8, nivel handler);
  - `tests/integration/sales-quote-v2.test.ts:366` (S21, `quote.create@2`).
- `@5` no se publicó ni desplegó antes de esta corrección. El owner autorizó corregirlo en el lugar, con commit propio, sin crear `@6`.
- Sin migraciones y sin cambios de harness.

## Tests que fijan la semántica

| Situación | Test (ciclo de vida real: ingress, worker, kernel, ActionRuntime, ActionExecutor, scheduler) |
|---|---|
| 1 | "held on its key while engaged … replays the SAME key once"; "held, and the customer writes while engaged"; "held longer than the run budget" |
| 2–3 | "the owner commits but its answer is lost: … settled as the quote it already issued — one POST, one quote" |
| 2–4 | "the owner is unavailable at the send: held on its key (not failed); after the owner not-found window … the SAME key replays once" (espera 121 s reales: la ventana usa el reloj de la base) |
| 5 | "the owner stays unavailable through every in-run reconciliation: never failed, never a new key" |
| R1 | "engaged mid-run before the issuance decides: refused before any decision" |

Mutación verificada: si se quita la rama de GAP-16, fallan los tests de las situaciones 2–4 y 5 (`1:execute:failed:quote_service_unavailable`).

## Pendiente de decisión del owner

1. Aceptar las reglas R1–R6 como semántica de toda escritura comercial autorizada.
2. Elegir la opción para L2 y L6 (liberación o replay tras agotar reintentos).
3. Decidir si L1 justifica una migración para registrar el fin de cada intento.
4. Fijar el presupuesto de run de producción (L4) y el runbook de las situaciones 5 y 6 (J7).
