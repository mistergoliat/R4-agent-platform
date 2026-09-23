# ADR-011 — Modelo de autoridad, frescura y conflictos del contexto

- **Estado:** Aceptado (R4-C2)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §17; PRD §9 ("Domain structured state > Generated memory"); ADR-002

## Contexto

La regla central de C2: estado autoritativo ≠ observación ≠ conversación ≠
memoria derivada ≠ estado de trabajo del agente. Si esas clases colapsan en
"texto del contexto", un summary o una frase del usuario pueden convertirse
silenciosamente en verdad canónica.

## Decisión

### Autoridad explícita por ítem

| Autoridad | Significa | Tipos (`kind`) que pueden tenerla |
|---|---|---|
| `AUTHORITATIVE` | estado actual leído de su owner | agent_definition, task, execution_constraints, goal (del requester), capability, state |
| `OBSERVED` | evidencia de una capability o registrada por la plataforma | observation, episode |
| `CONVERSATIONAL` | algo dicho en una interacción | conversation_turn |
| `DERIVED` | summary / extracción / interpretación | derived_summary |
| `COGNITIVE` | estado de trabajo del agente | working_note, goal (formado por el agente) |

`AUTHORITIES_BY_KIND` lo impone el esquema (`ContextItem` y
`CompiledContext`): un `derived_summary` sólo puede ser `DERIVED`, un
`state` sólo `AUTHORITATIVE`, ningún tipo de memoria es `AUTHORITATIVE`.
No es un ranking: es semántica. En el código de runtime, sólo las fuentes de
plataforma (`sources/platform.ts`) producen ítems `AUTHORITATIVE` (test de
contrato); fuentes de dominio futuras lo harán desde el owner del estado.

### Frescura determinística (reloj inyectado, nunca el modelo)

`temporality`: `live` (registro del owner leído en esta compilación) o
`point_in_time` (verdadero/dicho/derivado a `observedAt`).

```text
validUntil conocido y now ≥ validUntil            → expired  (validUntil exclusivo)
live                                               → fresh
point_in_time, staleAfterMs[kind] y now ≥ obs+ms   → stale    (umbral inclusivo)
point_in_time con alguna cota                      → fresh
point_in_time sin cota                             → unknown  (p. ej. lo que alguien dijo)
```

### Verdad actual vs evidencia histórica

Un ítem `expired` nunca aparece como actual (el esquema prohíbe `expired`
fuera de `history`). Si es evidencia (`AUTHORITATIVE`/`OBSERVED`) y la
política lo permite (`expiredEvidence: include`), queda en `history` con
prioridad mínima — sirve para entender decisiones pasadas, no como estado.
Memoria, conversación y summaries expirados se excluyen (`expired`).

### Conflictos

Los ítems declaran `assertions` (`subject` estable + `value`) sólo para
detectar desacuerdos. Entre ítems incluidos, un subject con valores distintos
genera un `ContextConflict` con **todas** las posiciones. Nunca se fusiona,
nunca gana "lo último dicho", nunca un summary sobrescribe estado:
`authoritativeItemId` nombra la posición `AUTHORITATIVE` vigente si hay
exactamente un valor autoritativo; si no, `null` (sin resolver). Una
discrepancia conversacional puede justificar proponer una actualización al
owner (futuro, gobernado), no asumirla.

### Otras reglas de admisión

- Supersession sólo dentro de la misma fuente: un ítem derivado no puede
  retirar uno autoritativo apuntándolo.
- `SECRET` se excluye antes que nada (contenido nunca renderizado, persistido
  ni logueado); `SENSITIVE` entra etiquetado.
- Un ítem de otra task → `not_relevant_to_scope`.
- Mismo id con mismo contenido → `duplicate` (gana la primera fuente
  registrada); mismo id con distinto contenido → error de plataforma.

## Alternativas descartadas

- **Prioridad numérica:** "más alto gana" reintroduce la fusión silenciosa.
- **Resolver conflictos por recencia:** la frase más reciente no es verdad.
- **Frescura decidida por el modelo:** no determinística ni auditable.

## Consecuencias

- Detectar conflictos requiere que las fuentes declaren `assertions`; sin
  ellas, dos ítems contradictorios en texto libre no se detectan (límite
  aceptado: sin extracción por LLM en C2).

## Verificación

`tests/unit/context-compiler/contracts.test.ts`, `freshness.test.ts`,
`compiler.test.ts` (autoridad, conflictos, admisión), `long-context.test.ts`,
`tests/contract/context-boundaries.test.ts`.
