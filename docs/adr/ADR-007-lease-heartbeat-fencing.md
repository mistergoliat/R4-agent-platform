# ADR-007 — Leases, heartbeats y fencing

- **Estado:** Aceptado (R4-C1)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §25.2, §25.12; PRD §27, §28; ADR-003, ADR-006

## Contexto

Un worker puede morir, colgarse o perder la red. Otro debe poder continuar su
trabajo, y el primero —si vuelve— no puede seguir escribiendo como dueño. La
Constitución exige que ningún estado necesario para recuperar viva sólo en
memoria y que no haya efectos duplicados.

## Decisión

### Lease

Columnas en `agent_tasks` (migración `0002`): `lease_owner`,
`lease_generation`, `lease_acquired_at`, `lease_expires_at`,
`last_heartbeat_at`, con `CHECK` de consistencia.

- El lease vive **en la fila de la task**: su row lock es el único punto de
  serialización para claim, takeover y toda escritura de dueño.
- Un lease es **ownership, no lifecycle**: tomarlo o renovarlo no cambia
  `version`, `status`, `updated_at` ni estado de negocio.
- La expiración se evalúa **sólo con el reloj de PostgreSQL**
  (`clock_timestamp()`); el reloj de un worker nunca es autoritativo.

### Fencing

`lease_generation` es el fencing token: se incrementa en cada claim y nunca se
reinicia. Toda operación de dueño (`recordStep`, `recordObservation`,
`finishExecution` y también la lectura `loadExecution`) ocurre en una
transacción que primero hace
`SELECT … FOR UPDATE` de la task, lee `clock_timestamp()` **después** de obtener
el lock y exige `owner = token.owner ∧ generation = token.generation ∧
expires_at > now ∧ status = running`. Si no, `lease_lost` y nada se escribe.

- Un lease **expirado** ya no es válido aunque nadie lo haya tomado: su dueño no
  puede renovarlo ni escribir; debe reclamar de nuevo (nueva generación).
- El mismo worker que re-reclama queda fenced respecto de su token anterior:
  el fencing es por generación, no por identidad.
- Las observations de capabilities se escriben por la ruta fenced
  (`recordObservation`), en la misma transacción que las liga a su step: un
  worker stale puede haber ejecutado un READ (inocuo) pero no puede registrar
  evidencia.

### Heartbeat

El worker renueva el lease cada `heartbeatIntervalMs` con un único `UPDATE`
condicionado (owner, generation, no expirado, task `running`). Sólo demuestra
vida: no registra progreso ni toca estado de negocio. Regla de configuración:
`heartbeat × 2 ≤ leaseDuration` (se puede perder un heartbeat sin perder el
lease). Si una renovación es rechazada, el worker consulta `ownershipOf` y
aborta de inmediato la llamada en curso (`AbortSignal`): si la task dejó
`running` (p. ej. cancelada) con `task_not_runnable` y libera el lease; si no,
con `lease_lost` y emite `lease.lost` sin escribir nada más. Un error
transitorio de renovación no aborta: si el lease llega a expirar, el fencing
rechaza al worker.

### Run ante pérdida de dueño

- Crash/cuelgue: el run queda `running` (huérfano) hasta que el lease expira.
- Takeover (lease previo expirado): el nuevo dueño **reanuda el mismo run**
  (`run.resumed`, `worker.recovery`, `recoveries + 1`) desde su step log durable.
- Liberación ordenada (`worker.stop()`): el lease se libera sin terminar el run;
  el siguiente dueño lo reanuda al instante y no cuenta como recovery.
- Si un run supera `maxRunRecoveries` takeovers (poison task), el claim lo
  cierra como `abandoned` (`lease_lost`, `max_run_recoveries_exceeded`) y la
  task pasa a `failed`. Es el único camino a `abandoned` en C1: `lease_lost`
  nunca lo escribe el worker que perdió el lease (no puede escribir).
- Se crea un run nuevo sólo si la task está `pending` o `running` sin run activo.

## Alternativas descartadas

- **Reloj del worker** para expiración: la desviación de relojes podría
  extender o acortar leases.
- **Run nuevo por cada lease (epoch):** obligaría a sumar budgets entre runs
  para impedir que los crashes reinicien los límites, y separaría el step log
  de la ejecución que continúa. Reanudar el mismo run conserva budgets y
  duración (`maxRunDuration` cuenta desde `run.startedAt`).
- **Renovar leases expirados** si nadie los tomó: hace que la validez dependa
  de la ausencia de competidores; más difícil de razonar.
- **Tabla `task_leases` separada:** introduce un segundo punto de lock entre
  claim y escrituras de dueño.

## Consecuencias

- Latencia de recuperación tras un crash ≈ `leaseDuration`.
- Un READ puede ejecutarse dos veces si el dueño muere entre la decisión y la
  observation (no existía evidencia); ambas ejecuciones usan el mismo
  `invocationId` y sólo una observation puede persistir. Aceptable sólo porque
  C1 ejecuta exclusivamente READ; los writes (R4-D) requerirán idempotency keys
  y receipts.

## Verificación

`tests/unit/task-runtime/execution-lifecycle.test.ts` (estados del lease),
`tests/integration/execution-leases.test.ts` (renovación, expiración con reloj
real y forzada, takeover, stale worker rechazado en las 6 operaciones de dueño
sin cambiar estado durable, re-claim del mismo worker, release, abandono por
recoveries, cancelación), `tests/integration/worker-kernel.test.ts` (heartbeat
sano durante un READ de 4 s con lease de 1,5 s; pérdida detectada por
heartbeat aborta la llamada al modelo; cancelación detectada por heartbeat como
`task_not_runnable`), `tests/integration/worker-recovery.test.ts`
y `tests/recovery/worker-process-crash.test.ts` (SIGKILL real). Mutación
verificada: desactivar `assertLeaseHeld` hace fallar 5 tests.
