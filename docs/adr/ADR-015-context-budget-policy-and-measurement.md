# ADR-015 — Política de presupuesto de contexto y medición

- **Estado:** Aceptado (R4-C2, ajuste previo a la aceptación)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §17; PRD §8; ADR-010, ADR-012, ADR-014
- **Modifica:** ADR-010 (presupuesto), ADR-012 (equivalencia de snapshots, decisiones compactadas), ADR-014 (cuándo se compacta)

## Contexto

La primera versión de C2 hacía obligatorio un techo de tokens
(`maxEstimatedTokens`, default del worker 32.000) y lo trataba como la política
productiva. Ese número no tenía evidencia detrás. La prueba de estrés con
FIXED(6000) mostró además que un presupuesto artificial, combinado con el
orden de selección actual, deja fuera working y episodic memory. Eso demostró
que el mecanismo funciona; no demostró qué asignación produce mejores
resultados de task.

R4 todavía no sabe cuál es el contexto óptimo y no debe fingir saberlo.

## Decisión

**El presupuesto es un mecanismo; cuánto presupuestar es una decisión
empírica. La política temprana por defecto es UNBOUNDED.**

### Contrato

```ts
type ContextBudgetPolicy =
  | { mode: 'unbounded' }                               // default
  | { mode: 'fixed'; maxEstimatedTokens: number };
```

- Vive en `@r4/contracts` (`contextBudgetPolicySchema`) y forma parte de
  `ContextCompilationPolicy.budget` (default `{ mode: 'unbounded' }`).
- Techo opcional por request (el `contextPolicy.maxContextTokens` del agente)
  que sólo puede ajustar: `unbounded + N → fixed(N)`,
  `fixed(M) + N → fixed(min(M, N))` (`tightenContextBudget`).
- Worker: `R4_CONTEXT_BUDGET_MODE=unbounded|fixed` (default `unbounded`) y
  `R4_CONTEXT_MAX_TOKENS`, obligatorio exactamente cuando el modo es `fixed`.
  No existe ningún límite global hardcodeado.

### UNBOUNDED

**UNBOUNDED no significa contexto infinito.** Significa que R4 no impone
un límite artificial propio. El compilador sigue aplicando autoridad,
frescura, supersession, sensibilidad (exclusión de `SECRET`), duplicados,
validación de fuentes, representación de conflictos y orden determinístico.
Pero:

- ningún ítem se excluye por `budget`;
- no hay compaction (sin presión de presupuesto no hay nada que aliviar);
- `budget_exhausted` no puede ocurrir;
- los límites por tipo (`kindLimits`) siguen siendo posibles, pero son
  política de selección y excluyen con motivo `policy`, nunca `budget`.

### FIXED(N)

FIXED(N) es de primera clase y conserva todo el mecanismo:

- `ContextSizer`;
- selección acotada por prioridad;
- `kindLimits`;
- compaction por presión de presupuesto (ADR-014);
- `omissions`;
- terminación `budget_exhausted` / `max_context_tokens`.

Sirve para tests, benchmarks, experimentos, políticas futuras y protección
frente a ventanas de contexto reales.

### Límite físico del modelo (futuro)

```text
límite físico del modelo  ≠  política de presupuesto de R4
input efectivo permitido = min(límite físico del modelo, presupuesto opcional de R4)
```

C2 no modela límites por proveedor. Tampoco agrega nombre de proveedor o
modelo, tokenizer ni límites hardcodeados al compilador. El techo por request
es el punto de entrada para aplicar ese `min` más adelante sin tocar el
compilador.

### Medición: ContextComposition

Cada snapshot permite reconstruir cuánto consumió cada componente. La
composición **se deriva, no se persiste**: es una proyección determinística
(`contextComposition` / `snapshotComposition`) de:

- las decisiones por ítem (`context_snapshot_items`);
- `estimated_tokens`;
- el budget del snapshot.

**Cambio necesario:** las decisiones ahora incluyen **todos** los ítems
evaluados, también los compactados, que apuntan con `representedBy` al
summary que los representa. Los ítems `SECRET` se cuentan pero no se miden
(0 tokens): no se registra ni siquiera su longitud.

Métricas (unidades del sizer), con identidades exactas:

```text
rawEstimatedTokens      = included + excluded     (todo lo evaluado)
compiledEstimatedTokens = included + overhead     (overhead = cota del frame + conflictos)
```

- Desgloses: `byKind`, `byAuthority`, `bySource` (incluido/excluido: cantidad
  y tokens), `bySection` (incluye `history`) y `byExclusionReason`.
- Compaction:
  - `compactionInputEstimatedTokens`;
  - `compactionOutputEstimatedTokens`;
  - `ratio = output / input`;
  - `compactedItemCount`;
  - `summaryCount`.
- `compiledEstimatedTokens` es una cota superior conservadora del documento
  real. La diferencia queda explicada por:
  - el overhead;
  - menos de 2 tokens por ítem (redondeo de `ceil` y el separador).

  Lo verifican los tests; nada queda oculto.

Las consultas de percentiles (p50/p90/p95/p99 por agente, tipo de task,
kind, autoridad o fuente) salen de `GROUP BY` sobre `context_snapshot_items`
unido a `context_snapshots` y `agent_tasks`. No hay columnas desnormalizadas
ni dashboards en C2.

### Telemetría

`context.compile.completed` se emite una vez por snapshot usado, persistido o
reutilizado. Lleva:

- `snapshotId`, `taskId`, `runId`, `agentId`, `iteration`, `reused`;
- `budgetMode`, `maxEstimatedTokens`;
- `rawEstimatedTokens`, `compiledEstimatedTokens`, `includedEstimatedTokens`,
  `excludedEstimatedTokens`;
- `includedCount`, `excludedCount`, `compactedCount`;
- tokens de entrada y de salida de compaction;
- tokens incluidos por kind y por autoridad (enums cerrados: cardinalidad
  acotada).

El desglose por fuente y el detalle por ítem quedan en la persistencia. No
hay eventos por ítem ni contenido.

### Equivalencia de snapshots

`inputFingerprint` incluye ahora, además de los ítems evaluados y su frescura:

- el `policyVersion`;
- el **presupuesto efectivo**.

Pasar de UNBOUNDED a FIXED(6000), o cambiar N, u otra política efectiva,
nunca reutiliza un snapshot incompatible. Produce un attempt nuevo que
reemplaza al anterior, sin editarlo. La versión del compilador sigue sin
formar parte del fingerprint.

## Fundamento

- No hay evidencia para elegir un límite óptimo, y un límite arbitrario
  descarta información antes de saber si aporta valor.
- Primero se observa (cuánto contexto real genera cada workload y de qué está
  compuesto) y después se optimiza.

## Futuro: context engineering guiado por evaluación

Documentado como capacidad futura, **no implementado**:

- Experimentos posibles:
  - quitar episodic memory;
  - reducir el historial de conversación;
  - cambiar la prioridad de working memory;
  - distintos umbrales de compaction;
  - distintos presupuestos.
- Criterios de comparación:
  - éxito de la task;
  - continuidad del goal;
  - falso éxito;
  - preguntas repetidas;
  - selección de capabilities;
  - latencia, costo y tokens.

Los presupuestos productivos se definirán con esas evaluaciones y con el
consumo observado. Hoy el orden de selección y `kindLimits` no cambian.

## Consecuencias

- Con UNBOUNDED, el tamaño del contexto sólo lo acota el contenido durable.
  El límite físico del proveedor aún no se aplica (primer adapter real).
- El probe agent declara `maxContextTokens: 8000`, así que sus runs corren con
  FIXED(8000) efectivo. Es configuración explícita del agente, no un default
  de R4.
- Más filas por snapshot (los compactados ahora se registran), a cambio de
  una contabilidad completa y derivable.

## Verificación

- `tests/unit/context-compiler/budget-accounting.test.ts`: semántica
  UNBOUNDED, experimento FIXED(6000), conciliación exacta de la contabilidad,
  reproducibilidad, equivalencia por presupuesto y comparación.
- `tests/unit/worker/context-config.test.ts`.
- `tests/integration/context-snapshots.test.ts`: contabilidad derivada de
  filas, `GROUP BY` en SQL, telemetría, attempt nuevo por cambio de
  presupuesto.
