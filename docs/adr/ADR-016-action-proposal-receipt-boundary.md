# ADR-016 — Frontera ActionProposal / ActionReceipt

- **Estado:** Aceptado (R4-D)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §9, §25.2–25.5; PRD §6 (ActionProposal, ActionReceipt), §10, §12; ADR-002, ADR-008, ADR-009

## Contexto

Hasta C2 el modelo sólo podía leer, responder y completar. R4-D debe permitir
que un agente cambie el mundo sin que el modelo controle permisos, ejecución
ni verdad transaccional. El PRD §12 exige para todo write
`ActionProposal → Policy → Command → Execution → ActionReceipt`, y la
Constitución §25.5 prohíbe la falsa confirmación.

## Decisión

### `propose_action` es intención, nunca efecto

`AgentDecision` se extiende aditivamente (protocolo `r4.agent_decision.v2`):

```ts
{ type: 'propose_action', capabilityId: string, arguments: object, evidenceRefs?: uuid[] }
```

Objeto estricto: una decisión que trae `idempotencyKey`, `executionKey`,
`policyDecision`, `riskClass`, `permission`, `receipt`, `status`, `actor`,
`grantedScopes`, `identityAssurance` o cualquier otro campo es
`invalid_decision_schema` (nunca se descarta en silencio). El kernel valida
sólo estructura (capability concedida y no-READ; `evidenceRefs` ⊆
observations de la task); **si puede ejecutarse lo decide la Policy Engine**
(ADR-017).

### Registros, todos escritos sólo por la plataforma

| Registro | Qué es | Mutabilidad |
|---|---|---|
| `ActionProposal` | intención durable, con su step, **antes** de cualquier autorización o write (`proposalId` de plataforma, `evidenceRefs` verificadas, `contextSnapshotId`) | inmutable |
| `PolicyDecision` | resultado determinista, con `policy {id, version, hash, engineVersion}`, regla y razón | inmutable |
| `ActionCommand` (`action_executions`) | sólo datos confiables: argumentos validados, contexto confiable, `executionKey` de plataforma, semántica de recuperación | comando inmutable; `status` con máquina de estados |
| `ActionAttempt` | una llamada externa; fila escrita **antes** de la llamada | append-only; outcome una sola vez |
| `ActionReceipt` | evidencia del resultado **conocido** (`succeeded | rejected | failed`) | inmutable |
| Observation `source.kind = 'action'` | lo que el agente ve: validación, denegación, aprobación requerida o receipt | inmutable |

### Qué prueba qué

- Un receipt significa: *la plataforma tiene evidencia durable del resultado
  de esta acción en ese momento*. **No** es verdad de dominio actual: el
  owner del dominio sigue siéndolo; la observation del receipt tiene
  `validUntil = null` y nunca se vuelve "estado actual" (sección
  `observations`, autoridad `OBSERVED`, nunca `AUTHORITATIVE`).
- Ningún estado durable trata un write como exitoso sin receipt:
  - `action_executions.status ∈ {succeeded, rejected, failed}` sólo con el
    receipt coincidente (constraint trigger diferido);
  - una observation de acción `succeeded` exige `receipt_id` (CHECK en BD y
    refinamiento del contrato);
  - no existe código de observation para "resultado desconocido": un
    resultado desconocido no produce observation (ADR-019).
- El modelo nunca recibe "éxito" salvo por esa observation respaldada por
  receipt. **No hay detector textual** de afirmaciones: la garantía es
  estructural (ledger), no lingüística; la evaluación textual llega con R4-G.

### Observación → contexto

La observation se persiste en la misma transacción que el receipt y la
compleción del step (`pending → observed`). La siguiente iteración la lee de
PostgreSQL y el Context Compiler (C2, sin cambios de semántica) la incluye en
el siguiente ContextSnapshot; su contenido añade `action {proposalId,
receiptId}`. No hay canal lateral.

### Deduplicación

Se deduplica la **re-ejecución** de una misma propuesta/comando (misma
clave). Dos propuestas idénticas en iteraciones distintas son dos acciones:
R4-D no inventa deduplicación semántica (depende de la intención del dominio).

## Consecuencias

- `AGENT_DECISION_TYPES` ganó `propose_action`; tests de contrato que fijaban
  la lista C1 se actualizaron (cambio inevitable y autorizado).
- Las capabilities de escritura son visibles para el modelo **sólo** si la
  corrida puede escribir (`maxWriteActions > 0`); visible ≠ ejecutable.
- Delegate/Wait/Consult/Approval/Handoff siguen fuera (R4-E+).
