# ADR-010 — Frontera del Context Compiler

- **Estado:** Aceptado (R4-C2)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §17; PRD §8, §9; ADR-002, ADR-004, ADR-009

## Contexto

En C1 el kernel renderizaba su `ExecutionContext` a un único string JSON
(mensaje `user`). Eso no distingue verdad, evidencia, conversación y memoria,
no tiene presupuesto, no es auditable ítem por ítem y ata la forma del contexto
al renderizado. C2 debe decidir **qué ve el agente, por qué, con qué autoridad
y cuánto**, sin que el kernel (que decide la siguiente acción) ni el modelo
controlen esa información.

## Decisión

### Paquete y dependencias

`packages/context-compiler` depende sólo de `@r4/contracts`,
`@r4/observability` y `zod`. No puede importar PostgreSQL, `task-runtime`,
`capability-runtime`, `agent-registry`, `agent-kernel`, `model-gateway`,
Fastify ni apps (ESLint + allow-list + test de contrato). Los contratos del
contexto (`ContextItem`, `CompiledContext`, `ContextSnapshot`, `MemoryEntry`)
viven en `@r4/contracts`, porque los consumen kernel, gateway, runtime y
persistencia.

### Flujo

```text
ExecutionRuntime.loadExecution (fenced)            ← estado durable de la iteración
      │
DurableKernelSession.prepareContext(context)       ← port KernelSession (ADR-009)
      │   ContextCompiler.compile(request)          ← sources → selección → CompiledContext
      │   ExecutionRuntime.recordContextSnapshot    ← fenced, ANTES del modelo (ADR-012)
      ▼
AgentKernel.decide(context, compiled)
      │   renderModelRequest → ModelRequest { messages: [protocolo], context: compiled }
      ▼
ModelGateway
```

- El **kernel** no conoce el compilador: recibe un `CompiledContext` por
  `KernelSession.prepareContext` y lo envía. Sigue validando decisiones contra
  sus propios hechos (`ExecutionContext`): lo visible no es lo ejecutable.
- El **compilador** no decide la siguiente acción, no escribe nada y no usa un
  modelo para decidir qué incluir. Devuelve los summaries que produjo para que
  la capa de ejecución los persista.

### ContextSource

```ts
interface ContextSource {
  id: string;                                   // namespaced: platform.memory, external.x
  load(request: ContextSourceRequest): Promise<ContextContributionInput[]>;
}
```

El compilador valida cada contribución con el esquema estricto y le **sella**
el `sourceId` (una fuente no puede hablar por otra). Fuentes iniciales:
`platform.agent`, `platform.task`, `platform.run` (restricciones de ejecución
y respuestas del propio run), `platform.goal`, `platform.capability`,
`platform.observation`, `platform.memory`. Fuentes de dominio futuras se
registran en el worker (`WorkerBindings.contextSources`) sin tocar el
compilador (test: `external.record_state`).

### Salida estructurada

`CompiledContext` es un objeto versionado (`schemaVersion`, `compilerVersion`,
`policyVersion`), validado por esquema y neutral de proveedor y dominio:
secciones de ítems (`agent`, `task`, `goals`, `capabilities`,
`authoritativeState`, `observations`, `conversation`, `workingMemory`,
`episodicMemory`, `derivedMemory`, `history`), `conflicts`, `omissions` y
`budget`. `ModelRequest.context` lo transporta intacto; `messages` sólo lleva
el protocolo de decisión del kernel. Renderizarlo para un proveedor concreto es
trabajo de su adapter.

### Selección y presupuesto

Determinística y gobernada por `ContextCompilationPolicy` (configuración del
worker, `R4_CONTEXT_*`). El presupuesto es un `ContextBudgetPolicy`
explícito (ADR-015): **UNBOUNDED por defecto** (R4 no impone límite propio;
nada se excluye ni se compacta por presupuesto) o **FIXED(N)** (mecanismo
completo de abajo). `contextPolicy.maxContextTokens` del agente sólo puede
ajustarlo (unbounded + N → fixed(N)).

1. admisión: `SECRET` → duplicados → scope de task → supersession (misma
   fuente) → frescura/expiración → política;
2. requeridos (por tipo en la política, o marcados por la fuente — p. ej. la
   última observation del run): nunca se descartan por presupuesto; si no
   caben en FIXED(N), `budget_exhausted` y el run termina sin llamar al modelo
   (`max_context_tokens`);
3. resto por `selectionOrder` (state → observation → conversation → working →
   episode → derived_summary), más recientes primero; los límites opcionales
   por tipo (`kindLimits`) son política de selección (motivo `policy`); la
   conversación mantiene una cola reciente contigua y, bajo FIXED con
   compactador, compacta el prefijo (ADR-014);
4. evidencia expirada al final, como `history`;
5. los conflictos forman parte del presupuesto: si no caben se descarta lo
   último seleccionado no requerido.

`ContextSizer` es un port (default: bytes UTF-8 del JSON / 4). La suma de
ítems sobreestima el documento completo, así que el presupuesto se cumple
también para el documento entero (verificado por test).

### Determinismo

Mismo estado durable + versión de compilador + política + presupuesto →
mismos ítems, mismo orden (cronológico por sección, luego id), mismo
`contentHash`. Sólo `asOf` (metadata temporal) queda fuera del hash.

## Alternativas descartadas

- **Kernel que arma su contexto:** mezcla "qué ve" con "qué hace" (ADR-009).
- **Prompt único como salida canónica:** pierde autoridad, frescura y
  procedencia por ítem; ata el significado al renderizado.
- **Selección por LLM / embeddings / RAG:** no reproducible, fuera de alcance
  (sin infraestructura sin necesidad demostrada).
- **Ranking numérico de prioridad:** la autoridad es semántica (ADR-011); el
  orden de selección es política explícita por tipo.

## Consecuencias

- Cada iteración compila sobre estado durable: costo O(ítems evaluados) por
  iteración (≈0.1–0.2 ms/ítem medido); en UNBOUNDED todo lo evaluado entra. Un
  test de estrés C1 de 400 iteraciones necesitó timeout explícito.
- Bajo FIXED, un contexto requerido que no cabe es un fallo de presupuesto
  explícito, no un truncamiento silencioso de lo requerido.
- La contabilidad del contexto (ADR-015) se deriva de las decisiones por ítem.

## Verificación

`tests/unit/context-compiler/*`, `tests/contract/context-boundaries.test.ts`,
`tests/contract/dependency-boundaries.test.ts`,
`tests/unit/agent-kernel/context-and-request.test.ts`,
`tests/integration/context-snapshots.test.ts`.
