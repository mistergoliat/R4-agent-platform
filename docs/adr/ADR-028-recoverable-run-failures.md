# ADR-028 — Una run fallida recuperable no termina necesariamente el trabajo durable

- **Estado:** Propuesto (corrección post-H de GAP-H-001; pendiente de auditoría — no es una fase del roadmap)
- **Fecha:** 2026-09-24
- **Baseline R4-H:** `80a17332fe77eedb1ef63889c4f991f1ace0a980`
- **Autoridad superior:** Constitución §25; PRD §7, §27; ADR-006, 007, 008, 009, 012, 018, 021
- **Relacionado:** ADR-008 (se mantiene intacto), ADR-027 (evidencia), Architecture Gap Review post-H

## Contexto

C1 separó **task** (unidad durable de trabajo) de **run** (una ejecución
cognitiva acotada): *"A task may have many runs over its life (resume, retry,
wake-up)"* (`contracts/run.ts`). Pero la tabla de terminación de C1
(arquitectura §11.6) llevó toda run fallida a una task `failed`. Cuando la
task era un trabajo de una sola run, la diferencia no importaba. Desde R4-E una
task es una conversación de muchas runs (una por input, suspendidas en
`waiting`) y la tabla no se revisó.

ADR-008 decide, correctamente, que una salida inválida del modelo nunca es una
AgentDecision, se registra como step `invalid` y cierra la run — sin
reparación. Lo que ADR-008 no decide (y nadie decidió explícitamente) es qué
le pasa a la **task**.

## Evidencia de R4-H

Suites live `N1` (`shs_2026-09-24T16-16-27-545Z_3b21921c`) y `N3`
(`shs_2026-09-24T16-44-27-903Z_1a62d2f4`), `deepseek-flash`, protocolo v4:

- 11 fallos de protocolo no inyectados en 523 llamadas elegibles (2,1 %); con
  todas las suites live (smoke y H10/H11 incluidas), 11/589 (1,87 %).
- Cinco formas distintas: decisión + prosa (3), sólo prosa (2), dos decisiones
  (2), salida vacía por `finish_reason=length` (1), evidencia inexistente (3).
  0 fallos reales de transporte (timeout / 429 / 5xx).
- Cada fallo terminó su task: 11/44 ejecuciones elegibles (11/51 con todas).
  En 5 de ellas un input posterior del cliente fue rechazado; en las 11 el
  turno en curso quedó sin respuesta. Un operador tampoco podía tomar la task
  (`a terminal task cannot be taken over`).
- 3 de 11 fallaron en la primera llamada de su run; 8 después de READs
  observados en la misma run; 2 después de un write gobernado exitoso.

La pérdida crece con la longitud de la conversación con cualquier modelo:
1 − (1 − p)^k. Con p = 2,1 % y k ≈ 12 llamadas se predice ~22 % (observado
25 %). No es "DeepSeek comete errores": es una propiedad de la abstracción.

## Problema

R4 confundía **un intento cognitivo fallido** con **un trabajo durable
fallido**. De las cuatro flechas

```text
salida inválida → AgentDecision inválida → step invalid → run failed → task failed
```

las tres primeras son correctas (ADR-008). La última no lo es para fallos que
no establecen nada sobre el trabajo en sí.

## Decisión

**Regla:** una run fallida no termina el trabajo durable salvo que el fallo
mismo establezca que el trabajo es terminal.

**Alcance de esta primera implementación:** la regla se aplica sólo a
`invalid_decision` y a `model_failure` clasificado `retryable` por el gateway,
porque son las clases que la evidencia actual justifica. Todo lo demás queda
exactamente como en C1–H.

### Clasificación (`runFailureDisposition`, `@r4/contracts`)

| Terminación | Disposición | Qué hace la plataforma |
|---|---|---|
| `invalid_decision` (cualquier código) | `recoverable` | run `failed`; task sigue `running`; nueva run (acotada) |
| `model_failure`, `details.retryable === true` (timeout, 429, 5xx/transporte) | `recoverable` | igual |
| `model_failure` no reintentable (4xx, envelope, respuesta de proveedor inválida, sin clasificación) | `human` | run `failed`; task `blocked` + handoff de plataforma; sin run automática |
| `capability_failure`, `budget_exhausted`, `internal_failure`, `lease_lost` | `terminal` | sin cambio: task `failed` |
| completed, cancelled, suspensiones | — | no son fallos |

`retryable` es la clasificación del `ModelError` que el kernel ya registraba en
`termination.details` desde C1; cualquier valor distinto de `true` cuenta como
no reintentable (fail-closed hacia un humano, nunca hacia un reintento).

### Ciclo de vida

```text
invalid output ─► step invalid ─► run failed           (ADR-008, sin cambio)
                                     │ recoverable, dentro del presupuesto
                                     ▼
                        task sigue running, sin run activa, lease liberado
                                     │ claim normal (ADR-006)
                                     ▼
                        run n+1 ─► ContextSnapshot NUEVO (C2) ─► cognición
```

- **Dueño:** `ExecutionRuntime.finishExecution` (task-runtime), que ya era la
  autoridad sobre el ciclo de vida de la run y la transición de la task al
  terminarla. El kernel, el parser y el gateway no cambian: siguen reportando
  `invalid_decision` / `model_failure` exactamente como antes.
- **La recuperación es una run nueva, no un reintento de la llamada.** No hay
  reintento en el adapter, en el gateway ni en el kernel. La run nueva pasa por
  el claim ordinario, el Context Compiler y todas las reglas de C1–E.
- **Estado reutilizado:** "task `running` sin run activa" ya existía (lo
  produce un wake de E) y `claimNext` ya lo convertía en una run nueva. No hay
  estado de task, estado de run ni tabla nueva.

### Presupuesto de recuperación (`maxRunFailureRecoveries`)

- Configuración de operador (`R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`), default
  **1**, entero finito ≥ 0. Mismo patrón que `maxRunRecoveries` (C1).
- **Contador derivado de `agent_runs`**, nunca almacenado: la run que falla más
  las runs inmediatamente anteriores de la task que fallaron de forma
  recuperable y fueron `continued`. Cualquier otra run corta la secuencia.
- Con el default: la run 1 falla → una run de recuperación; si ésta también
  falla de forma recuperable → recuperación agotada.
- Cada run de recuperación usa los budgets normales de una run. Los budgets de
  alcance task **no** se reinician (`maxWriteActions` se deriva del ledger).
  No hay budget específico de reintentos. El costo queda acotado por
  (N + 1) × budget de una run y visible por run.

### ContextSnapshot nuevo

Cada run de recuperación compila su propio snapshot con C2 (los snapshots son
por `(run, iteración)`; una run nueva no puede reutilizar el de otra). Contiene
el estado durable vigente: historia de interacción, inputs llegados después
del fallo, observations y receipts (de alcance task), goals tal como están,
frescura y autoridad recalculadas. No se reintenta sobre un snapshot viejo, por
lo que la carrera "input nuevo durante la recuperación" no existe: el input se
acepta (la task no es terminal) y la siguiente compilación lo incluye.

**Sin pistas de reparación:** nada en el contexto dice que la salida anterior
fue inválida. Los steps `invalid` no se proyectan al modelo y el resumen del
handoff de plataforma tampoco (sólo se proyectan los handoffs `agent`).

### Fallback humano (R4-E, reutilizado)

Al agotarse la recuperación, o ante un `model_failure` no reintentable, la task
no pasa a `failed`: pasa a `blocked` con un `HumanRequest` de handoff
`requested`, `initiatedBy: 'platform'` y `reason`:

- `run_failure_recovery_exhausted` — agotó el presupuesto;
- `non_retryable_model_failure` — no se reintentó nada (no se etiqueta como
  agotamiento).

Es el mismo mecanismo que un handoff pedido por el agente (WAIT_FOR_HUMAN,
visible en `/v1/attention`). Un operador lo acepta y libera (la autonomía
vuelve: el siguiente claim es una run nueva), cancela la solicitud (igual) o
cancela la task. Mientras tanto los inputs del cliente se aceptan y quedan
durables. **Reinicio del contador:** una run marcada `exhausted` o
`handed_off` corta la secuencia; como después de ella sólo puede existir otra
run si un humano resolvió el handoff, "el humano liberó ⇒ el conteo vuelve a
empezar" se deriva de `agent_runs` sin comparar relojes. La historia no se
borra.

### Registro durable y observabilidad

- La disposición se estampa en la run fallida, en la misma transacción que la
  cierra: `termination.details.runFailureRecovery = { outcome: continued |
  exhausted | handed_off, consecutiveFailures, maxRunFailureRecoveries }`
  (metadata; sin texto del modelo).
- Telemetría: `task.run_failure.recoverable`, `.recovery_started`,
  `.recovered`, `.recovery_exhausted`, `.non_retryable`; el handoff reutiliza
  `handoff.requested` (evento temporal durable con `initiatedBy: platform`).
- Nunca se persiste el texto inválido ni razonamiento. Proveedor, modelo,
  `finishReason`, latencia y tokens siguen en `model.call.completed` del
  gateway (correlacionado por `runId`); la forma de una salida no parseable
  (`chars`, documentos JSON, texto extra) sigue en el recorder de shadow. Un
  step `model_failed` sigue registrando 0 tokens: el `ModelError` no trae usage
  y no se inventa.

### Task ≠ Goal

La recuperabilidad de una task es independiente de que exista un goal preciso
del cliente. La continuidad de orquestación durable no es continuidad semántica
de goals: la recuperación no crea, modifica, enfoca ni cierra goals; el
snapshot nuevo simplemente contiene los goals tal como están guardados. No se
rediseña la semántica de Goal.

## Invariantes

- ADR-008 intacto: una salida inválida nunca es una AgentDecision; no hay
  reparación, extracción del primer objeto ni tolerancia a prosa; step
  `invalid`; run `failed`.
- Una AgentDecision aceptada es final para su iteración; Quality nunca inicia
  recuperación ni cambia estados.
- Ninguna recuperación re-ejecuta una propuesta, regenera un `executionKey`,
  duplica un receipt ni evita la Policy: lo ya ocurrido es evidencia durable de
  la task y queda visible para la run nueva.
- Reconciliación antes que cognición: el claim sigue excluyendo tasks con
  `needs_reconciliation` o `action_retry` pendiente.
- Ownership humano gana: una task con handoff activo o solicitado, consulta o
  aprobación pendientes no es reclamable.
- Leases y fencing sin cambio: un crash durante una run de recuperación es un
  takeover de **la misma** run (C1), nunca una run nueva ni un fallo de run.
- Finito: a lo sumo `maxRunFailureRecoveries` runs automáticas por secuencia.
- Neutral respecto del proveedor: depende de `TerminationReason` y
  `ModelError.retryable`, no de `json_object`, modos de razonamiento ni vendor.
- Sin migración; protocolo `r4.agent_decision.v4` sin cambio.

## Consecuencias

- Las conversaciones sobreviven a fallos transitorios de cognición; el costo es
  latencia (≤ un intervalo de poll + una llamada) y tokens acotados.
- Modelos con más varianza de protocolo (p. ej. un 70B local) dejan de ser
  inviables por construcción; su tasa de fallo sigue medida, no oculta.
- Clientes de la API verán `running` durante una recuperación y `blocked` +
  request en attention al agotarse. `initiatedBy` admite `platform`: un cliente
  que validara el enum estrictamente debe aceptarlo.
- Tasks `failed` anteriores siguen `failed` (los estados terminales no tienen
  salida; no hay backfill).
- **R4-I (no resuelto aquí):** si un `respond` se entrega por un canal real y
  la run falla después, la run de recuperación podría responder otra vez. En H
  no ocurrió (ninguna run fallida tenía un `respond` previo) y en H/F los
  `respond` no se entregan. La frontera de entrega de R4-I debe definirlo.
- **Observación sin cambio:** `maxTokens` de la task se aplica por run (el
  consumo se deriva de los steps de la run). Ya era así para cada turno; la
  recuperación no lo empeora más allá del factor N + 1. No se rediseña aquí.

## Alternativas descartadas

- **Mantener C1–H:** pierde ~22–25 % de las conversaciones live y bloquea el
  rescate humano.
- **Reintento en el adapter:** el adapter no conoce la semántica de
  AgentDecision (ADR-004/024); los intentos serían invisibles para budgets y
  step log.
- **Reintento en el gateway:** no puede validar la semántica (3/11 fallos eran
  `unknown_evidence`, que exige hechos de la plataforma); intentos invisibles.
- **Reintento dentro del mismo step en el kernel:** viable y de menor latencia,
  pero cambia ADR-008 y el contrato del step, pone política de recuperación en
  el kernel y no corrige la flecha run → task. Posible optimización futura.
- **Estado durable de recuperación con reintento diferido (schedule nuevo):**
  requiere migración y no hay evidencia de fallos de transporte que necesiten
  backoff.
- **Sólo fallback humano:** derivaría a un operador ~22 % de las
  conversaciones por fallos transitorios; se usa sólo como segunda barrera.

## Extensión futura (no implementada)

El principio podría aplicarse a `capability_failure` (p. ej. un servicio de
dominio caído), pero R4-H no dio evidencia live suficiente para distinguir
fallo transitorio de dependencia, rechazo de dominio, error de contrato y
fallo permanente. Tampoco se implementa: reintento por calidad semántica,
reparación de prompts, fallback a otro modelo, consenso multi-modelo ni cambio
automático de proveedor.

## Verificación

`tests/unit/task-runtime/run-failure-recovery.test.ts` (clasificación,
contrato de handoff, configuración, métricas de G, directivas de shadow);
`tests/integration/run-failure-recovery.test.ts` (17 casos sobre PostgreSQL con
worker real); `tests/recovery/run-failure-recovery-crash.test.ts` (SIGKILL real
durante la run de recuperación); suite shadow (casos H08A–H08I);
`npm run test:mutation:recovery` (14 mutaciones).
