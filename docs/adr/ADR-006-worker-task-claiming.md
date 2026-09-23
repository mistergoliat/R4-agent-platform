# ADR-006 — Reclamación de tasks por workers

- **Estado:** Aceptado (R4-C1)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §25.12, §25.14; PRD §14, §27, §28; ADR-003

## Contexto

R4-C1 introduce un proceso worker, separado de la API, que ejecuta tasks
durables. Varios workers pueden correr a la vez (el MVP corre uno). Dos workers
no pueden ejecutar la misma task, y la reclamación no puede depender de un
`SELECT` seguido de un `UPDATE` en otra transacción, ni de locks de proceso.

## Decisión

1. **Una sentencia, un row lock.** `claimRunnableTask` es un único `UPDATE`:

   ```sql
   with clock as (select clock_timestamp() as now),
   candidate as (
     select task_id, lease_owner as previous_owner from agent_tasks
      where status in ('pending','running')
        and (lease_expires_at is null or lease_expires_at <= (select now from clock))
      order by created_at, task_id limit 1
      for update skip locked)
   update agent_tasks t set lease_owner = $1, lease_generation = t.lease_generation + 1, ...
     from candidate c where t.task_id = c.task_id returning t.*, c.previous_owner
   ```

   - `SKIP LOCKED`: los claimers concurrentes no se bloquean entre sí; pasan a
     la siguiente candidata.
   - En READ COMMITTED, si otra transacción cambió la fila tras nuestro
     snapshot, PostgreSQL re-evalúa el `WHERE` sobre la fila bloqueada: un lease
     recién tomado por otro nunca se sobrescribe.
   - Puede devolver 0 filas aunque existan otras candidatas (carrera perdida);
     el worker reintenta en el siguiente poll. Se prefiere esta pérdida benigna
     a esperar locks.
2. **Claim + run en la misma transacción.** `ExecutionRuntime.claimNext` toma el
   lease y, atómicamente, crea o reanuda el run (ADR-007 §Run). Nunca existe una
   task arrendada sin run, ni un run nuevo sin dueño.
3. **Qué es reclamable:** `pending` y `running` sin lease vivo. `waiting`,
   `blocked` y `requires_approval` no (los despertará el scheduler, R4-E). Una
   task cancelada nunca se reclama aunque conserve columnas de lease.
4. **Orden:** la más antigua primero (`created_at, task_id`), índice parcial
   `agent_tasks_claimable_idx`. Sin prioridades (no hay necesidad demostrada).
5. **Worker = ejecutor, no autoridad.** Una task a la vez por worker; el
   paralelismo se obtiene con más workers. La autoridad sobre quién ejecuta qué
   es el lease en PostgreSQL; el worker sólo retiene su token (task, owner,
   generation) mientras ejecuta, y perderlo de memoria no pierde nada: el lease
   expira y otro worker reanuda.

## Alternativas descartadas

- **`SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE` separados en la misma
  transacción:** equivalente en garantías, dos round-trips; la sentencia única
  es más simple de auditar.
- **Advisory locks** como autoridad: no sobreviven como estado consultable, no
  llevan owner ni expiración visibles y se liberan con la conexión (no con la
  vida del worker).
- **Cola externa (Redis/Kafka/pg-boss):** infraestructura sin necesidad
  demostrada (ADR-003).
- **`LISTEN/NOTIFY`** para despertar workers: optimización de latencia
  prematura; el polling (`R4_WORKER_POLL_MS`) basta para el MVP.

## Consecuencias

- Polling con intervalo configurable; latencia de inicio ≤ un intervalo.
- La reclamación es justa sólo en sentido FIFO aproximado.
- Un task con lease vivo es invisible para los demás workers hasta que expira o
  se libera (ADR-007).

## Verificación

`tests/integration/execution-leases.test.ts` (claim atómico, 10 claimers sobre
una task → 1 ganador, 8 claimers sobre 20 tasks → cada task exactamente una vez,
takeover concurrente → un run activo), `tests/integration/worker-recovery.test.ts`
(4 workers × 12 tasks: un claim por task, un run, una observation por
invocation). Mutación verificada: quitar la condición de lease del claim hace
fallar 5 tests.
