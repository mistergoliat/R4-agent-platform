# ADR-019 — Recuperación de efectos externos

- **Estado:** Aceptado (R4-D)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §25.2–25.3; PRD §28, §40 (R4-D exit: kill/restart no duplica efectos ni corrompe la task); ADR-006, ADR-007, ADR-018

## Contexto

PostgreSQL no puede incluir una llamada de red en una transacción. Entre "el
dominio aplicó el efecto" y "R4 persistió el receipt" siempre hay una ventana
no atómica. La arquitectura debe manejarla explícitamente.

## Decisión

### Fronteras transaccionales (cada fila es UNA transacción fenced)

| Operación | Qué se escribe junto |
|---|---|
| `recordStep` (propose_action) | step `pending` + `ActionProposal` (evidencia verificada) + uso del modelo |
| `authorizeAction` ALLOW | `PolicyDecision` + comando (`executionKey`, `prepared`) |
| `authorizeAction` DENY | `PolicyDecision` + observation + step `observed` |
| `authorizeAction` REQUIRE_APPROVAL | `PolicyDecision` + observation + step `observed` + run `suspended` + task `requires_approval` + lease liberado |
| `rejectAction` | observation (`write_validation_failure`) + step `observed` |
| `advanceAction` | fila de intento (outcome null) + `prepared → executing` |
| **llamada externa** | **ninguna transacción** |
| `recordAttempt` definitivo | outcome del intento + receipt + estado resuelto + observation + step `observed` |
| `recordAttempt`/`advanceAction` incierto | outcome + `needs_reconciliation` + run `suspended` + task `blocked` + lease liberado |
| fin de run por cualquier vía (finish, abandono, cancelación, suspensión) | ejecuciones `executing` del run → `needs_reconciliation` (`finishRunWithin`) |

"Fenced" = bloqueo de la fila de la task y verificación de owner +
generación + lease vigente en el reloj de BD + task `running` (regla C1,
extraída a `lockOwnedExecution` y compartida).

### Ventanas de crash

| Muere… | Estado durable | Qué hace el siguiente dueño |
|---|---|---|
| A: tras la propuesta, antes de la política | step `pending` + propuesta | evalúa la política (sin llamar al modelo) |
| B: tras ALLOW, antes de intentar | comando `prepared` | ejecuta el mismo comando, misma clave |
| B′: tras la fila de intento, antes de la llamada | intento sin outcome | lo trata como desconocido: replay o reconcile según ADR-018 |
| C: tras el efecto, antes del receipt | intento sin outcome, efecto aplicado | misma clave → replay idempotente o reconciliación → **un** efecto, **un** receipt |
| D: tras receipt + observation | step `observed` | no re-ejecuta; la siguiente iteración compila un snapshot con la observation |

El kernel no llama al modelo mientras exista un step `pending` de acción
(`pendingAction` en `ExecutionState`; además `recordStep` y
`recordContextSnapshot` rechazan con `pending_step_exists`).

### Worker stale

Si A pierde el lease con una llamada en vuelo, no puede registrar outcome,
receipt, observation ni transición (fencing). B toma la task, ve el intento
de A sin outcome y repite con **la misma clave**; si el efecto de A ya
ocurrió, el dominio devuelve ese resultado (`replayed`). Cuando A vuelve, su
llamada llega con la misma clave (sin segundo efecto) y su escritura es
rechazada con `lease_lost`.

### Resultado incierto

Si el plan de intentos se agota sin resultado conocido: la ejecución queda
`needs_reconciliation`, **no** se crea observation ni receipt, el step queda
`pending`, el run termina `suspended` (`write_outcome_uncertain`, código
`write_outcome_uncertain` o `write_reconciliation_failure`) y la task pasa a
`blocked`. Ni el agente ni la task continúan como si hubiera fallado o
funcionado. Resolverlo (reconciliador, operador) queda para R4-E+.

## Consecuencias

- Verificado con SIGKILL real de proceso en la ventana C
  (`tests/recovery/governed-write-crash.test.ts`) y con inyección
  determinista en A, B, B′, C, D, worker stale, incertidumbre y cancelación
  (`tests/integration/governed-execution-recovery.test.ts`).
- Un error de plataforma no clasificado durante la acción termina el run como
  `internal_failure` (`action_execution_error`); la ejecución en vuelo queda
  `needs_reconciliation`, nunca "fallida".
