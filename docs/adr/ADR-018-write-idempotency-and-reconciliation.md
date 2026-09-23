# ADR-018 — Idempotencia y reconciliación de writes

- **Estado:** Aceptado (R4-D)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §25.2 (ningún LLM decide idempotencia); PRD §27 (retries ciegos prohibidos), §28; ADR-005, ADR-016

## Contexto

Un write puede fallar de forma ambigua (timeout, conexión cortada, proceso
muerto). Reintentarlo a ciegas puede duplicar el efecto; darlo por fallido
puede ocultar uno que ocurrió. La plataforma debe saber, por capability, qué
repetición es segura.

## Decisión

### Execution key de plataforma

Al crear el comando (misma transacción que el ALLOW) la plataforma genera
`executionKey = "r4x_" + executionId sin guiones` y lo persiste **antes** de
cualquier llamada externa. Toda llamada — ejecución, replay, reconciliación,
por cualquier worker, tras cualquier crash o takeover — usa esa clave. No
existe otro generador (test de contrato); el modelo no puede proponerla.

### Contrato de capability de escritura

```ts
registry.registerWrite({ definition, recovery: 'idempotent_replay' | 'reconcile_before_retry',
                         input, output, execute(input, ctx), reconcile?(ctx) })
ctx = { executionKey, execution: TrustedActionContext, attempt, signal }
execute  → applied{result, resourceRef?, externalOperationRef?, executedAt?, replayed?}
         | rejected{code} | failed{code} | unknown
reconcile→ lo anterior | not_applied
```

Ambas estrategias exigen que el dominio aplique **a lo sumo un efecto por
clave** (`idempotency: key_required`, validado por el esquema):

- `idempotent_replay`: ejecutar de nuevo con la misma clave devuelve el
  resultado original (reconcile opcional, último recurso).
- `reconcile_before_retry`: la repetición no devuelve necesariamente el
  resultado; hay que consultar por clave antes de volver a ejecutar
  (reconcile obligatorio).

Una capability de clase de escritura registrada con `register()` (sin
handlers de escritura) es visible pero **nunca** ejecutable: la política la
deniega (`unsafe_write_semantics`) y el executor no tiene cómo llamarla.

### Clasificación conservadora (ActionExecutor)

Sólo una respuesta explícita del dominio es un resultado conocido.
`rejected`/`failed` significan "sin efecto" por contrato. Timeout, excepción,
salida fuera de esquema, sobre fuera de contrato o `not_applied` desde una
ejecución ⇒ `unknown` — nunca éxito, nunca fallo.

### Quién decide el siguiente intento

`nextActionStep(comando, intentos)` (puro, en `task-runtime`), y sólo
`ActionRuntime.advanceAction` lo aplica: el llamador no elige el tipo de
intento. Con `maxAttempts` = `retryPolicy.maxAttempts` de la capability
(fijado en el comando al crearse):

| Último intento | idempotent_replay | reconcile_before_retry |
|---|---|---|
| ninguno | execute | execute |
| execute/replay sin respuesta o `unknown` | replay (misma clave) mientras queden; luego reconcile si existe; si no, incierto | reconcile mientras queden; si no, incierto |
| reconcile `not_applied` | replay mientras queden; si no, receipt `failed` (`write_not_applied`, definitivo) | ídem |
| reconcile `unknown`/sin respuesta | reconcile mientras queden; si no, incierto (`write_reconciliation_failure` si el reconciliador falló) | ídem |

Tipos de reintento distinguidos: **transport retry** (replay tras `unknown`
en el mismo proceso), **idempotent replay** (tras crash/takeover),
**reconciliation** (consulta por clave) y **business retry** (tras
`rejected`: nunca automático; requiere una propuesta nueva con clave nueva).

### Concurrencia optimista

R4 no inventa versiones. `expectedVersion` (o ETag/revision) es parte del
esquema de la capability; R4 lo valida y transporta en los argumentos del
comando; el dominio lo aplica. Un conflicto es `rejected` → receipt
`rejected` con el código del dominio → observation `action_rejected`. Nunca
se reintenta con otra versión.

## Consecuencias

- Duplicados evitados son medibles: intentos no iniciales cuyo dominio
  respondió `replayed: true`.
- Backoff en proceso = `initialBackoffMs` duplicado por intento (acotado);
  no es estado durable.
