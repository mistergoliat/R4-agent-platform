# ADR-013 — Clasificación y fronteras de la memoria

- **Estado:** Aceptado (R4-C2)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §17 (taxonomía de memoria); PRD §9; ADR-003, ADR-011

## Contexto

La Constitución separa la memoria por función y autoridad. Sin fronteras
explícitas, "memoria" termina como un bloque de texto que el modelo trata como
verdad, o como caché de proceso que no sobrevive un reinicio.

## Decisión

### Cuatro tipos, ninguno autoritativo

| Tipo | Contenido (estricto) | Kind en contexto | Autoridad |
|---|---|---|---|
| `WORKING` | `{category: hypothesis│note│open_question, text ≤ 2000}` | working_note (`live`) | COGNITIVE |
| `CONVERSATIONAL` | `{actor{role: requester│agent│participant│operator, ref}, text, interactionRef, assertions}` | conversation_turn | CONVERSATIONAL |
| `EPISODIC` | `{event (código), text, refs}` | episode | OBSERVED |
| `DERIVED_SUMMARY` | `{text, assertions, derivation{derivationKey, compactorId, compactorVersion, sourceItemIds, from/toObservedAt}}` | derived_summary | DERIVED |

La autoridad y el kind salen del tipo (`MEMORY_AUTHORITY`,
`MEMORY_ITEM_KIND`), nunca de la entrada: ninguna memoria puede entrar al
contexto como `AUTHORITATIVE`. No hay campo de razonamiento libre: las notas
de trabajo son texto corto, categorizado y auditable (no chain-of-thought).
No se modela memoria de largo plazo entre tasks, de organización ni
semántica/vectorial.

### Durabilidad y mutación

- Tabla `memory_entries`, task-scoped (FK a `agent_tasks`). La memoria
  necesaria para continuar vive sólo en PostgreSQL; no hay cachés de proceso.
- Append-only: un trigger rechaza `DELETE` y cualquier `UPDATE` salvo fijar
  `expired_at` una vez.
- Ciclo de vida sin destruir procedencia: **append**; **supersede** (entrada
  nueva con `supersedes_entry_id`, misma task y tipo, a lo sumo un sucesor);
  **expire** (`valid_until` al crear o `expired_at` después). El compilador
  excluye lo superseded/expirado con motivo.
- `SECRET` no es almacenable (sin infraestructura de cifrado en C2).
- `recordedBy` es un principal resuelto por la plataforma.

### Quién escribe

- `PostgresMemoryStore.append` (validación estricta en la frontera): para
  adapters/fixtures. No se expone `/v1/turns` ni endpoint de memoria en C2.
- `ExecutionRuntime.recordContextSnapshot`: sólo `DERIVED_SUMMARY`,
  `recordedBy = system:context-compiler`, en la transacción del snapshot.
- El modelo **no** tiene decisión de escritura de memoria ni de estado
  (`AgentDecision` sigue siendo `read_capability | respond | complete`).
  Convertir algo en verdad canónica exigirá una capability de dominio con su
  owner (R4-D+), nunca memoria.

## Alternativas descartadas

- **Memoria como una sola cadena/summary:** mezcla autoridades (Constitución §17).
- **Updates in-place:** destruyen procedencia.
- **Working memory en RAM del worker:** se pierde en un crash.
- **Decisión `remember` del modelo en C2:** ampliaría el protocolo C1
  congelado; se difiere.

## Consecuencias

- Sin escritor de working/episodic memory desde el loop en C2: el
  primitivo, su frontera y su durabilidad existen; los productores llegan con
  las fases que los necesiten.

## Verificación

`tests/unit/context-compiler/contracts.test.ts` (tipos, autoridad, SECRET),
`compiler.test.ts` (supersession, expiración),
`tests/integration/context-snapshots.test.ts` (append-only, expiración,
reinicio de worker), `tests/integration/restart-persistence.test.ts`,
`tests/recovery/database-restart.test.ts`,
`tests/contract/context-boundaries.test.ts` (escritores de memoria).
