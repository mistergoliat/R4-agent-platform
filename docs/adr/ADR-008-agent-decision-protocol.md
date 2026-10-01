# ADR-008 — Protocolo AgentDecision (C1)

- **Estado:** Aceptado para R4-C1 (provisional respecto de Constitución §27.11)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §9, §25.1–§25.5, §25.13, §27.11; PRD §7; ADR-002, ADR-004

## Contexto

El kernel necesita un contrato único para lo que el modelo puede producir en
cada iteración. La salida del modelo no es confiable (P7.13: `invalid_model_json`
masivo; P7.12: efectos narrados no ejecutados). El PRD §7 enumera nueve
decisiones; C1 sólo implementa lectura y cierre.

## Decisión

### Contrato (`@r4/contracts`, `decision.ts`)

```ts
type AgentDecision =
  | { type: 'read_capability'; capabilityId: string; arguments: JsonObject }
  | { type: 'respond'; content: string }
  | { type: 'complete'; result: { summary: string; evidence: ObservationId[]; data?: JsonObject } };
```

- **read_capability** lleva sólo id y argumentos. Identidad, scopes,
  `invocationId`, versión y ejecución los resuelve la plataforma.
- **respond** es salida intermedia registrada en el run (step `recorded`); en C1
  no se entrega a ningún canal y **no termina** el run. *Enmendado por R4-J1E-R2.2
  (ver abajo): `respond` es terminal para el turno.*
- **complete** termina la task con un resultado estructurado. No puede fabricar
  efectos: el resultado se guarda como dato y nada más; `evidence` debe citar
  observations existentes de la task.
- Todos los objetos son **estrictos**: una clave desconocida invalida la
  decisión. Esto también impide almacenar razonamiento libre (sin
  chain-of-thought).

### Transporte

La decisión se pide como **salida estructurada JSON**
(`outputContract: { kind: 'json', name: 'agent_decision', schema }`, con el JSON
Schema derivado del contrato Zod). El parser acepta `structuredData` o `content`
que sea un documento JSON completo. Las tool calls nativas **no** son un
transporte aceptado en C1 (`invalid_structured_output`). Esto no cierra
Constitución §27.11: es la opción mínima para C1; un protocolo híbrido puede
añadirse detrás del mismo parser.

### Pipeline de validación

```text
ModelResult ── error del gateway ─────────────► model_failure  (clase model)
     │
     ▼ parse         → invalid_structured_output ┐
     ▼ tipo          → unknown_decision_type     │
     ▼ esquema       → invalid_decision_schema   ├► invalid_decision (clase protocol)
     ▼ semántica     → unknown_capability        │
                     → capability_not_permitted  │
                     → unknown_evidence          ┘
     ▼
AgentDecision válida
```

La semántica se valida contra **hechos de plataforma** del ExecutionContext: la
capability debe estar entre las concedidas por scope y ser `READ`; la evidencia
debe ser observations de la task. Los mensajes de error nunca repiten valores
producidos por el modelo.

### Qué termina el run y qué es evidencia

- Fallo de decisión (cualquier código de arriba) → termina: `invalid_decision`.
  La iteración se registra como step `invalid` **en la misma transacción** que
  el cierre. Sin reintentos de reparación en C1.
- Argumentos que no cumplen el esquema de la capability → **no** es fallo de
  decisión: el invoker (autoridad sobre esquemas) produce una Observation
  `rejected/invalid_arguments` que vuelve al modelo, que puede corregirse.
- Fallo del handler / timeout de capability → Observation `failed`, evidencia
  que vuelve al modelo. `capability_failure` queda para cuando la plataforma no
  puede producir evidencia de una invocación.

### r4.agent_decision.v4 (validación live de R4-F, antes de R4-G)

Las primeras corridas con un modelo real (DeepSeek, `sales:live`) terminaron
en `invalid_decision` por dos ambigüedades del texto, no del contrato:

- **`unknown_evidence`**: el modelo citó como `evidenceRefs` el id de registro
  del turno del cliente (`memory:<entryId>`) al registrar un hecho que el
  cliente declaró. El texto sólo mostraba el placeholder `<observationId>`.
  v4 añade una línea "References": sólo `content.observationId` de items
  observation es citable; turnos, memoria, goals, item ids y provenance no;
  lo que dijo el solicitante no necesita referencia (omitir `evidenceRefs`).
- **`capability_not_permitted`**: el modelo envió una escritura como
  `read_capability`. v4 nombra el campo `riskClass` en ambas líneas, y el
  item `capability` del Context Compiler declara, antes del `inputSchema`,
  `riskClass` y `decision` (`read_capability` | `propose_action`, derivado
  del riskClass).

**La validación no cambió**: referencias desconocidas siguen siendo
`unknown_evidence` (sin mapeo por similitud ni quitar prefijos) y una
escritura como READ sigue siendo `capability_not_permitted`. El esquema JSON
no cambió. Instrucciones: 2 778 → 3 214 caracteres
(`unit/agent-kernel/protocol-overhead`). Regresiones:
`unit/agent-kernel/decision-parser` (casos live),
`unit/context-compiler/capability-presentation`,
`sales/live-diagnostics` (replay del caso live por el harness).

## Alternativas descartadas

- **Function calling nativo como único transporte:** acopla el protocolo al
  formato de tools del proveedor (ADR-004) y no resuelve P7.12.
- **Aceptar JSON parcialmente válido** (descartar claves extra, defaults
  implícitos): viola "model output is untrusted".
- **Reintentar decisiones inválidas** automáticamente: política de reparación
  sin evidencia de necesidad; queda para C2+ con evaluación.
- **Implementar ya las nueve decisiones del PRD:** placeholders sin semántica.

## Consecuencias

- Un modelo que no respeta el esquema termina el run de inmediato; la tasa de
  `invalid_decision` es una métrica de calidad directa para R4-G.
- Añadir una decisión exige: tipo en el contrato, validación semántica,
  manejo en el kernel, ruta de persistencia y tests; nunca un bypass.

## Enmienda R4-J1E-R2.2 (2026-10-01) — `respond` es terminal para el turno

Un `respond` válido por protocolo se registra tal como el agente lo decidió (sin juez semántico
síncrono; ADR-031 superseded) y **cierra el turno**: el kernel registra un `WAIT_FOR_INPUT` de
`origin = 'platform'` (sin llamada al modelo y sin tokens; admitido por la migración 0010) por el
Temporal Runtime, que suspende la run y libera el lease. El próximo input despierta la task en una
run **nueva**. Para ese input no hay otra llamada al modelo, ni otro READ, ni un segundo `respond`:
`read → read → respond → fin` y `respond → fin`. El cierre es durable: si el worker cae entre el
`respond` y su wait, la run reanudada registra sólo el wait. Un input que la llamada que redactó la
respuesta no vio (`inputHorizonSnapshotId`) despierta la task de inmediato: nunca queda varado.

Consecuencias. Aplica a toda tarea (Core universal), y `KernelSession.executeTemporal` es obligatorio.
`complete` en la misma run después de un `respond` deja de existir: una tarea se completa con una
decisión `complete` en una run sin respuesta, o permanece abierta esperando input. La validez del
protocolo (schema estricto, `invalid_decision`, recuperación de ADR-028) no cambia.

**Diferido, sin implementar** (y sin volver a un `respond` intermedio): avisar/acusar recibo antes
de `request_consultation` o `request_handoff` en el mismo turno, y `respond` + `complete` en el mismo
turno. Ver ADR-031, "Diferido".

## Verificación

`tests/unit/contracts/decision-and-execution-contracts.test.ts`,
`tests/unit/agent-kernel/decision-parser.test.ts`,
`tests/unit/agent-kernel/protocol-overhead.test.ts`,
`tests/unit/context-compiler/capability-presentation.test.ts`,
`tests/unit/agent-kernel/kernel.test.ts` (mapeo de terminación),
`tests/unit/agent-kernel/turn-boundary.test.ts` y `tests/integration/pure-agent-execution.test.ts` (R4-J1E-R2.2),
`tests/integration/worker-kernel.test.ts` (todos los fallos contra PostgreSQL),
`tests/contract/execution-kernel-boundaries.test.ts`,
`tests/contract/provider-neutrality.test.ts`.
