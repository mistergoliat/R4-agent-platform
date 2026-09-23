# ADR-020 — Inmutabilidad de receipts y del ledger de acciones

- **Estado:** Aceptado (R4-D)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §25.5, §25.13; PRD §26; ADR-003, ADR-012, ADR-016

## Contexto

Un receipt es evidencia. Si pudiera editarse a otro resultado, dejaría de
probar nada. Lo mismo vale para la propuesta, la decisión de política y las
observations que el agente vio.

## Decisión

Inmutabilidad aplicada por PostgreSQL (migración `0004`), no sólo por código:

| Tabla | Regla |
|---|---|
| `action_proposals`, `policy_decisions`, `action_receipts` | sin UPDATE ni DELETE (trigger `action_ledger_immutable`) |
| `observations` | sin UPDATE ni DELETE (mismo trigger; antes era sólo convención) |
| `action_execution_attempts` | append-only; el outcome se registra una vez (`outcome is null` → valor) y nada más cambia |
| `action_executions` | columnas del comando inmutables; sólo `status/version/updated_at`, por transiciones válidas; sin DELETE |
| resuelto ⇒ receipt | `succeeded/rejected/failed` sólo con receipt del mismo estado (constraint trigger diferido) |
| comando ⇒ ALLOW | FK compuesta `(policy_decision_id, 'allow')` → `policy_decisions(decision_id, outcome)` |
| receipt ⇒ clave del comando | FK `(execution_id, execution_key)`; `unique(execution_id)`: un receipt por ejecución |
| éxito observado ⇒ receipt | CHECK: observation de acción `succeeded` exige `receipt_id` |

Correcciones = evidencia nueva (una nueva propuesta/ejecución, o en R4-E+ un
registro de reconciliación), nunca reescritura de la histórica. Cambiar la
política no toca decisiones pasadas: cada una conserva `policy_id`,
`policy_version`, `policy_hash` y `engine_version`.

Un receipt no se vuelve verdad de dominio indefinidamente: prueba qué ocurrió
en `executedAt`; su observation es `OBSERVED` con `validUntil = null` y nunca
entra en `authoritativeState`.

## Consecuencias

- Tests: `integration/governed-execution` (UPDATE/DELETE rechazados sobre
  cada tabla; comando inmutable; ejecución sin ALLOW y éxito sin receipt
  irrepresentables).
- El trigger de inmutabilidad de `observations` endurece C1 sin cambiar su
  comportamiento (ningún código ni test las modificaba).
