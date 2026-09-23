# ADR-012 — Semántica de ContextSnapshot

- **Estado:** Aceptado (R4-C2)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §25 (recuperación, auditoría); PRD §8; ADR-003, ADR-007, ADR-009

## Contexto

Si el proceso muere durante una llamada al modelo, la recuperación debe saber
exactamente qué contexto se usó, y no debe producir en silencio un contexto
distinto para la misma iteración lógica. Toda llamada al modelo debe poder
reconstruirse después.

## Decisión

### Qué es

Un `ContextSnapshot` es el registro durable e inmutable del input de una
llamada al modelo:

```text
snapshotId · runId · taskId · iteration · attempt · agentId/agentVersion ·
compilerVersion · policyVersion · compiledContext (exacto) · contentHash ·
inputFingerprint · estimatedTokens · budget (presupuesto efectivo) ·
decisions[] (cada ítem evaluado: incluido/excluido + motivo, sin contenido) ·
supersedesSnapshotId · correlationId · createdAt
```

- `contentHash`: sha256 del `compiledContext` canónico sin `asOf`.
- `inputFingerprint`: sha256 de los ítems evaluados (contenido + frescura, sin
  `SECRET`) **más la política efectiva** (`policyVersion` y presupuesto
  efectivo, ADR-015); independiente de la versión del compilador.
- `decisions`: **todos** los ítems evaluados, compactados incluidos
  (`representedBy` = su summary). Fuente única de la contabilidad del
  contexto (ADR-015). *(Hasta el ajuste de ADR-015 se omitían los
  compactados.)*

### Cuándo se persiste

**Antes** de llamar al modelo, en una transacción fenced
(`ExecutionRuntime.recordContextSnapshot`) que además persiste los summaries
que produjo la compilación y apunta `run.contextSnapshotRef` al snapshot.
Cada `RunStep` registra `contextSnapshotId`; una FK compuesta
`(context_snapshot_id, run_id, iteration)` garantiza que el step usa un
snapshot de **su** run e iteración.

### Inmutabilidad

Triggers de PostgreSQL rechazan `UPDATE`/`DELETE` sobre `context_snapshots` y
`context_snapshot_items`. Información nueva ⇒ snapshot nuevo, nunca edición.

### Reutilizar vs compilar de nuevo

Al preparar la iteración N, la sesión compila y compara con el último snapshot
de `(run, N)`:

| Situación | Resultado |
|---|---|
| No existe snapshot para `(run, N)` | se persiste `attempt = 1` |
| Existe y `inputFingerprint` es igual (p. ej. el worker murió durante la llamada) | **se reutiliza tal cual**: mismo `snapshotId`, mismo `compiledContext` byte a byte; telemetría `context.snapshot.reused` |
| Existe y el fingerprint difiere | se persiste `attempt + 1` con `supersedesSnapshotId`; el anterior queda intacto |

El fingerprint cambia sólo si cambia lo que se evaluó: una transición durable
(memoria nueva, goal modificado, otra observation) **o** un cruce de frontera
de frescura (algo que era `fresh` ahora está `expired`: presentarlo como
actual violaría ADR-011) **o** un cambio en lo que la plataforma expone al
modelo (capabilities visibles, restricciones de ejecución de la
configuración del worker que reanuda) **o** un cambio material de la política
efectiva, incluido el presupuesto (UNBOUNDED → FIXED(6000), otro N, otro
techo del agente; ADR-015). No cambia con la versión del compilador: una
recuperación tras un deploy que no cambie la política reutiliza el snapshot.

Una iteración con READ pendiente no llama al modelo (C1): no genera snapshot.

### Reconstrucción

`step.contextSnapshotId → snapshot.compiledContext` es exactamente el
`ModelRequest.context` enviado (test de integración compara con lo que recibió
el proveedor). El resto del request es determinístico: protocolo del kernel
(`DECISION_PROTOCOL`, versionado), esquema de salida y requisitos del agente.

## Alternativas descartadas

- **Snapshot después de la llamada:** un crash durante la llamada perdería qué
  vio el modelo.
- **Recompilar siempre al recuperar:** la misma iteración lógica podría ver
  otro contexto sin rastro.
- **Reutilizar siempre:** presentaría como actual evidencia que ya expiró o
  ignoraría información nueva.
- **Comparar por `contentHash`:** un deploy con otra versión de compilador
  forzaría un attempt nuevo sin transición durable.

## Consecuencias

- Una escritura adicional por iteración (snapshot + filas de decisión), en la
  misma clase de transacción corta fenced que C1.
- El `timeoutMs` de la llamada no forma parte del snapshot (depende del tiempo
  restante); no altera el significado del contexto.

## Verificación

`tests/integration/context-snapshots.test.ts` (persistido antes de la llamada,
inmutabilidad, reuse, attempt nuevo, fencing),
`tests/recovery/worker-process-crash.test.ts` (SIGKILL durante la llamada →
el segundo worker reutiliza el snapshot),
`tests/integration/migration-upgrade-c2.test.ts`.
