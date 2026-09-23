# ADR-022 — Scheduler, reconciliación y autoridad del tiempo (R4-E)

- **Estado:** Aceptado en el working tree de R4-E (pendiente de auditoría y commit)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución; PRD §15–17; ADR-003, 006, 007, 018, 019, 021

## Contexto

R4-E necesita tiempo durable (esperas hasta una fecha, expiración de
requests humanas, backoff de reintentos) y un camino para resolver
`needs_reconciliation`. La primera implementación del milestone tenía tres
problemas: el scheduler ejecutaba la reconciliación (y para eso necesitaba las
capabilities del worker), la reconciliación creaba intentos fuera de
`ActionRuntime`, y el trabajo se descubría escaneando todas las ejecuciones
inciertas en cada poll.

## Decisión

1. **Composition root separado.** `apps/scheduler` (`npm run start:scheduler`)
   comparte sólo PostgreSQL. Depende de `contracts`, `observability`,
   `persistence-postgres`, `task-runtime`, `pino` y `zod`; nunca de
   `model-gateway`, `capability-runtime`, `policy-engine`, `agent-kernel`,
   `context-compiler` ni `apps/worker` (allow-list verificada por test).
2. **El scheduler sólo posee el tiempo.** Reclama un schedule vencido (SKIP
   LOCKED, lease + generación) y lo dispara por el Temporal Runtime: un wake
   satisface su espera; una expiración expira su request; un `action_retry`
   libera la task; una reconciliación vencida queda `dispatched`. Nunca razona,
   nunca invoca un modelo ni una capability. Scheduler muerto tras el claim →
   el lease expira → otro reclama con generación mayor → el token viejo es
   rechazado → un wake efectivo.
3. **La reconciliación la ejecuta un worker, bajo `ActionRuntime`.** El worker
   (que tiene las capabilities) reclama trabajo `dispatched` con el lease del
   schedule, antes de reclamar cualquier task. `ActionRuntime` concede un
   intento `reconcile` del mismo comando (misma execution key, siguiente número
   de intento) y registra el resultado: conocido → receipt + observation →
   task runnable o estado terminal diferido; `not_applied` → receipt "no
   aplicado" (nunca re-ejecuta); desconocido → reprogramación por la política.
   Sin run ni cognición: también resuelve efectos de tasks que se están
   cancelando o que fallaron. Se descartó despertar la task para reconciliar
   dentro de una run (no sirve para tasks terminales y crearía runs vacías).
4. **El trabajo nace con la incertidumbre.** Un trigger sobre
   `action_executions` crea el schedule de reconciliación en la misma
   transacción que establece `needs_reconciliation`, cubriendo todos los
   caminos (intento desconocido, run terminada con llamada en vuelo, run
   abandonada, cancelación). Un constraint trigger diferido rechaza al commit
   una ejecución incierta sin trabajo. 0005 crea el trabajo de las incertidumbres
   preexistentes. No hay escaneo permanente.
5. **Política explícita, estampada durablemente.** `ReconciliationPolicy`
   (intentos, backoff inicial y máximo, deadline) es configuración del proceso
   scheduler sin default productivo; se estampa en el schedule (con su
   deadline) la primera vez que se reclama. Backoff y agotamiento se calculan
   de lo durable, no del worker. El backoff de reintentos de D (`action_retry`)
   sale de la semántica declarada del comando, sin tope fijo en código.
6. **Agotamiento con salida operativa.** Un trabajo `exhausted` deja el
   resultado desconocido (task bloqueada, visible en `/v1/attention`). Un
   operador con `reconciliation.manage` puede re-armarlo (presupuesto y
   deadline nuevos, idempotente). Nadie puede declarar éxito ni falla.
7. **Autoridad del tiempo.** `r4_now()` (0005) es el reloj temporal: due,
   leases de schedules, esperas, requests humanas, eventos y el ledger que
   escribe `ActionRuntime`. En producción es `clock_timestamp()`. Los leases de
   C1 no lo usan (siguen con `clock_timestamp()`). Steps, runs, snapshots (C1/C2)
   y la frescura del contexto siguen con el reloj inyectado del proceso. Dentro
   de una transacción de E todos los timestamps salen de una lectura. Una base
   de prueba desechable redefine `r4_now()` para avanzar el tiempo sin sleeps.

## Consecuencias

- Ningún timer en memoria afecta la corrección (test de contrato).
- `needs_reconciliation` sin trabajo es irrepresentable; la task no vuelve a
  razonar mientras un efecto es ambiguo.
- El lease de un worker reconciliando no tiene heartbeat: si `reconcile` dura
  más que el lease, otro worker puede repetir la consulta (lectura idempotente
  por clave) y el registro tardío del primero es rechazado por la generación.

## Diferido

Heartbeat del lease de reconciliación, prioridades/`LISTEN NOTIFY` en el
claim de schedules, política productiva de reconciliación y de follow-up,
dashboards.
