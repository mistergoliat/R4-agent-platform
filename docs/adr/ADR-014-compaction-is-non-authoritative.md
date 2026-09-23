# ADR-014 — La compaction no es autoritativa

- **Estado:** Aceptado (R4-C2)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §17 ("la compaction puede ser una técnica de contexto, pero no una migración silenciosa de facts"); PRD §8, §9; ADR-011, ADR-013

## Contexto

Las conversaciones largas no caben en el presupuesto. Resumir es necesario,
pero un summary generado es la forma más fácil de convertir en "verdad" algo
que sólo fue dicho — o de borrar la evidencia original.

## Decisión

### Seam

```ts
interface ContextCompactor {
  id: string; version: string;
  compact(input: { items: ContextItem[] }): Promise<{ text: string; assertions: ContextAssertion[] }>;
}
```

C2 sólo trae `DeterministicCompactor` (extractivo, acotado, sin modelo: mismo
input → mismo output). Un compactor basado en modelo irá detrás del Model
Gateway en otra fase. Sin compactor configurado, la conversación que no cabe
se descarta de la más antigua a la más reciente (`budget`).

**Sólo bajo un presupuesto FIXED (ADR-015).** En UNBOUNDED (default) no hay
presión de presupuesto y por lo tanto no hay compaction, por grande que sea el
contexto: primero se observa cuánto contexto genera cada workload. Otras
políticas de activación (umbrales, costo) quedan para decisiones futuras
basadas en evaluación.

### Flujo

```text
conversación cruda (durable)
   → FIXED(N) y no cabe en el presupuesto restante (presión de presupuesto)
   → prefijo = todo salvo los últimos recentTurns, redondeado a bloques de chunkTurns
   → summary existente con la misma derivationKey  ó  compactor.compact(prefijo)
   → DERIVED_SUMMARY + cola cruda reciente (contigua, más nueva primero)
```

- **Siempre `DERIVED`** (el esquema no admite otra autoridad para
  `derived_summary`). Las `assertions` del compactor quedan como afirmaciones
  derivadas: si contradicen estado autoritativo, aparecen como conflicto y
  prevalece el autoritativo.
- **Procedencia completa:** `derivation{derivationKey, compactorId,
  compactorVersion, sourceItemIds, fromObservedAt, toObservedAt}`;
  `derivationKey = sha256(compactor + ids + contenido de las fuentes)`.
- **Las fuentes nunca se borran ni se alteran.** Los turnos compactados se
  omiten del contexto con motivo `compacted` (contados en `omissions`,
  enumerados por la derivación y registrados uno a uno en el snapshot con
  `representedBy` = summary). La contabilidad mide input/output de cada
  compaction (ADR-015).
- **Durable y reutilizable:** el summary nuevo se persiste como memoria
  `DERIVED_SUMMARY` en la transacción del snapshot que lo usa (idempotente por
  `(task, derivation_key)`); compilaciones siguientes lo reutilizan sin volver
  a compactar. El ítem que produce el summary fresco y el que produce el
  summary leído de memoria son idénticos (misma función), de modo que la
  recuperación reutiliza el snapshot (ADR-012).
- **Bloques:** el prefijo crece de a `chunkTurns`, así no se recompacta en cada
  turno nuevo. Un summary anterior totalmente cubierto por uno nuevo (o por
  turnos crudos incluidos) se excluye como `duplicate`.

## Alternativas descartadas

- **Reemplazar el historial por el summary:** destruye evidencia.
- **Migrar facts del summary a estado:** exactamente lo que prohíbe la Constitución.
- **Compactar en cada iteración:** costo y no determinismo con un compactor real.
- **Summaries incrementales (summary de summary):** diferido; C2 recompacta el
  prefijo completo desde las fuentes crudas.

## Consecuencias

- Con un compactor real no determinístico, la reutilización depende del
  summary persistido (se compacta una vez por rango).
- La calidad lingüística de los summaries no se evalúa en C2; sí su
  composición (autoridad, procedencia, presupuesto, cola reciente).

## Verificación

`tests/unit/context-compiler/compaction.test.ts`, `long-context.test.ts`,
`tests/integration/context-snapshots.test.ts` (compaction end-to-end con
PostgreSQL).
