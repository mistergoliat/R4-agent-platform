# ADR-009 — Frontera del Agent Kernel

- **Estado:** Aceptado (R4-C1)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §9, §25.1, §25.9, §25.12; PRD §7, §8, §29; ADR-002, ADR-004

## Contexto

El kernel es donde el modelo "decide la siguiente acción". Si además posee
estado, persistencia o ejecución, se repite R3: autoridad y recuperación dentro
del loop cognitivo. Si decide la estrategia, se repite R1/R2.

## Decisión

### Paquete y dependencias

`packages/agent-kernel` depende sólo de `@r4/contracts`, `@r4/model-gateway`
(la interfaz `ModelGateway`, nunca un proveedor), `@r4/observability` y `zod`.
No puede importar PostgreSQL, `task-runtime`, `capability-runtime`,
`agent-registry`, Fastify ni apps (ESLint + allow-list + test de contrato).

### Port: `KernelSession`

Todo efecto durable del loop pasa por cuatro operaciones que la implementación
debe realizar como escrituras de dueño (fenced) o rechazar:

```text
load()          estado de ejecución reconstruido desde almacenamiento durable
recordStep()    iteración no terminal (READ → pending con invocationId; respond)
executeRead()   ejecuta un READ pendiente con su invocationId → Observation persistida
finish()        cierre estructurado (+ step final atómico)
```

La sesión señala interrupciones con `KernelInterrupt`
(`lease_lost | task_not_runnable | stopped | unavailable`): el kernel se detiene
sin escribir y el run queda reanudable. Cualquier otro error es un fallo de
plataforma → `internal_failure` (si un cierre es rechazado, se intenta registrar
`internal_failure`; si tampoco se puede, el run queda para recovery).

La implementación durable (`DurableKernelSession`, `apps/worker`) es pegamento:
las reglas viven en `ExecutionRuntime` (ownership, ciclo de vida del run),
`CapabilityInvoker` (scopes, READ-only, esquemas) y el kernel (decisiones,
budgets).

### Loop

```text
for (;;) {                                   // iterativo, nunca recursivo
  si abortado → interrupted
  state = session.load()                     // sin estado entre iteraciones
  si hay READ pendiente → executeRead(mismo invocationId); continue
  budget antes de llamar al modelo → budget_exhausted
  decision = gateway → parse/validate (ADR-008)
  si abortado mientras tanto → interrupted (no se registra)
  READ     → budget de READ → recordStep(pending) → executeRead → continue
  respond  → recordStep(recorded) → continue
  complete → finish(completed, step final)
}
```

### ExecutionContext (contexto mínimo C1)

Agent definition · task · goal actual · observations de la task · respuestas
del propio run · budget (límites + consumo) · capabilities concedidas por scope
(con su clase de riesgo; sólo las READ se ofrecen al modelo). Se reconstruye en
cada iteración desde estado durable (`buildExecutionState`, puro). **No** es el
Context Compiler: no hay transcript, memoria, retrieval ni compaction. Es el
input futuro del Context Compiler (R4-C2), que seleccionará de él.

### Budgets

`ExecutionPolicy` (configuración del worker: `maxIterations`, `maxModelCalls`,
`maxReadCapabilityCalls`, `maxRunDurationMs`, `modelCallTimeoutMs`) acotada por
el budget de la task (`maxModelCalls`, `maxCapabilityCalls`, `maxDurationMs`,
`maxTokens`). El kernel no contiene valores. El consumo se deriva del step log
durable, así que un crash no reinicia los límites; la duración cuenta desde
`run.startedAt`, incluyendo el tiempo huérfano.

### Qué decide cada parte

| El modelo decide | La plataforma decide |
|---|---|
| qué decisión sigue (leer, responder, completar) | si la decisión es válida (esquema, capability concedida y READ, evidencia real) |
| qué capability pedir y con qué argumentos | `invocationId`, identidad, scopes, validación de argumentos, ejecución, timeout |
| el contenido de `respond` y del resultado | si hay budget, cuándo termina el run y con qué razón |
| qué observations citar como evidencia | qué ocurrió (Observation), quién es dueño, estado de task/run |

## Alternativas descartadas

- **Kernel con acceso directo a stores:** acoplaría cognición y persistencia;
  impediría probar el kernel sin base de datos.
- **Kernel que mantiene el estado del loop en variables:** un crash perdería el
  progreso; el step log durable lo hace innecesario.
- **Framework de agentes (LangGraph, etc.):** prohibido como base (PRD §38).

## Consecuencias

- Un paso cuesta varias transacciones cortas (load, step, observation); se
  acepta por recuperabilidad. Optimizar sólo con evidencia.
- La llamada al modelo interrumpida por un crash se repite al reanudar (no tiene
  efectos); su uso de tokens no queda registrado.

## Verificación

`tests/unit/agent-kernel/*` (con una `KernelSession` en memoria),
`tests/contract/execution-kernel-boundaries.test.ts` (imports, superficie del
gateway, ausencia de SQL/transportes), `tests/contract/dependency-boundaries.test.ts`,
`tests/contract/core-purity.test.ts`, `tests/integration/worker-*.test.ts`.
