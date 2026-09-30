# ADR-030 — Owner-bounded capability freshness

- **Estado:** Aceptado dentro de R4-J1C (el encargo §5 autoriza aprobarlo e implementarlo si no rompe C2/D; revertible sin migración)
- **Fecha:** 2026-09-29
- **Baseline:** `60651b8` (R4-J1B)
- **Autoridad superior:** Constitución (model output is untrusted; durable truth belongs to its owner); PRD §7; ADR-005, ADR-010, ADR-011, ADR-012
- **Cierra:** AG-J1B-01 (`docs/architecture/R4-J1B_CATALOG_CONSUMER_IMPLEMENTATION.md` §4)
- **Relacionado:** `docs/architecture/R4-J1C_CATALOG_CONTRACT_CONVERGENCE.md` §6

## Contexto

`CapabilityInvoker` estampa toda observación READ exitosa con
`validUntil = observedAt + definition.freshnessTtlMs`
(`packages/capability-runtime/src/invoker.ts`). El ContextCompiler clasifica
la frescura **sólo** con ese valor (`observationSource` →
`classifyFreshness`): `now ≥ validUntil` ⇒ `expired` (queda como evidencia
histórica), si no ⇒ `fresh`.

Un owner de dominio puede declarar su propia ventana. catalog-service v2
responde `freshness.validUntil = asOf + 15 s` (antes, si una promoción aplicada
termina antes). Sales declara `freshnessTtlMs = 5 min`. Resultado verificado en
J1C: durante ~4 min 45 s después de que el owner dejó de responder por su
respuesta, el contexto compilado la presenta como `fresh`. J1B lo mitigó sólo
en el pack (proyección del workspace y verificador de claims usan el mínimo);
el compilador — lo que el agente ve — no.

Subir o bajar el TTL no lo resuelve: un TTL mayor que la ventana del owner la
oculta; uno menor inventa una ventana que el owner no declaró, y las ventanas
del owner varían por respuesta (una promoción que termina en 3 s).

## Decisión

La vigencia registrada de una observación READ es el mínimo entre la cota del
runtime y la cota declarada por el owner **en esa respuesta**:

```
effectiveValidUntil = min(runtimeValidUntil, ownerValidUntil)   (sobre los no nulos)
runtimeValidUntil   = observedAt + freshnessTtlMs   | null si freshnessTtlMs = null
ownerValidUntil     = registration.ownerValidUntil(output) | null
```

1. **Mecanismo genérico.** `CapabilityRegistration` gana un campo opcional
   `ownerValidUntil(output) → timestamp | null`. Lo declara el pack/adapter
   que conoce el contrato del owner (Catalog: `freshness.validUntil`). El
   runtime no sabe nada de Catalog.
2. **Sólo puede acortar.** Nunca extiende la cota del runtime. `null` = el
   owner no declara ventana → rige la del runtime.
3. **Owner sin runtime.** Si `freshnessTtlMs = null` y el owner declara una
   ventana, rige la del owner (antes: sin cota).
4. **Payload vencido.** Si el owner ya la declaraba vencida al observarla
   (`ownerValidUntil ≤ observedAt`), la observación se registra con esa
   vigencia pasada: el compilador la clasifica `expired` desde el primer
   momento (histórica). No se falla ni se "repara".
5. **No confiable.** El valor pasa por `timestampSchema`; si el extractor
   lanza o devuelve algo que no es un instante, la invocación falla con
   `invalid_capability_output` (no se registra una vigencia inventada).
6. **Durable e idempotente.** La vigencia efectiva se calcula una vez y se
   persiste en la observación. Una re-invocación con el mismo `invocationId`
   devuelve la observación registrada (no se recalcula ni se extiende).
7. **Auditable.** Cuando la capability declara el extractor, `provenance`
   registra `freshness: { runtimeValidUntil, ownerValidUntil, bound }`
   (`bound ∈ {runtime, owner, none}`). Las demás observaciones no cambian.

## Qué no cambia (C2/D)

- `Observation`, `CapabilityDefinition` y su JSON Schema: sin campos nuevos
  (el extractor vive en la registración, no en la definición), por lo que las
  huellas de definiciones y del perfil productivo v1 no cambian.
- ContextCompiler, Kernel, Policy Engine, Scheduler, writes (R4-D): intactos.
  El compilador sigue leyendo `observation.validUntil`.
- Migraciones: ninguna (`validUntil` ya es nullable y persistido).
- Capabilities sin extractor: comportamiento idéntico al actual.

## Consecuencias

- Con catalog-service tal como está (15 s), la evidencia de catálogo pasa a
  histórica ~15 s después de leída: el agente debe volver a leer para afirmar
  precio o disponibilidad vigentes en un turno posterior. Es la semántica que
  el owner declara. Si el owner quiere otra ventana conversacional, es una
  decisión del owner (J1C OD-3), no un TTL de R4.
- La proyección del workspace y el verificador de claims de Sales mantienen su
  mínimo (defensa en profundidad y observaciones construidas por fixtures).

## Alternativas descartadas

- *TTL de Sales = 15 s*: fija una ventana que el owner puede cambiar y no ve
  promociones que terminan antes.
- *Campo `ownerValidUntil` en `Observation`*: cambio de contrato Core y
  migración para una información que `validUntil` + `provenance` ya expresan.
- *Que el handler devuelva `{ payload, validUntil }`*: cambia la firma de
  todos los handlers; el extractor declarativo es aditivo.
