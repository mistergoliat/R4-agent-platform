---
title: R4-J4-R6 F-1 — Corrección del origen de las salidas malformadas (un documento por turno)
status: for-independent-review
mandate: R4-J4-R6 Evidence Verification and Contract Acceptance (owner, 2026-10-27), Fase D
date: 2026-10-27
base: main e9a9bcb
---

# R4-J4-R6 F-1: corrección del origen de las salidas malformadas

```text
F1_REPRODUCED_LOCALLY                  (12,7 % global; 22,2 % en las familias difíciles)
F1_ORIGIN_CORRECTED_IN_ADAPTER         (render del adaptador OpenAI-compatible; parser, kernel y protocolo v5 sin cambios)
F1_REDUCED_NOT_ELIMINATED              (replay: 8/63 → 0/63 con la redacción final, árbol limpio cad30e3;
                                        A/B aleatorizado del revisor 8/42 → 0/42; turnos completos 1/54 malformada)
F1_CANARY_RERUN_PENDING                (requiere autorización separada del owner para el EC2)
J4_R6_BLOCKED                          (la decisión no cambia con este informe)
```

## 1. Qué se corrige y qué no

**Se corrige el origen.** El modelo (`deepseek-flash`, `thinking` activo, `json_object`, protocolo
`r4.agent_decision.v5`) incumple la regla de un documento por respuesta en los turnos que necesitan varias
lecturas. Responde con 2 o 3 documentos `read_capability` concatenados, o con un documento seguido de prosa.

**No se toca:**
- el parser estricto (ADR-008, sin reparación: nunca se acepta el primero de varios documentos);
- el kernel, ni `PROTOCOL_INSTRUCTIONS` ni `DECISION_PROTOCOL` (v5);
- ADR-028 (sin pistas de reparación en la recuperación);
- el proveedor y su perfil (sin failover; `thinking` sigue activo);
- el PR #27 (aviso determinístico). Ese aviso **no** cuenta como evidencia de confiabilidad: es la red de
  seguridad cuando la recuperación se agota, no la corrección del origen.

## 2. Reproducción

Herramienta: `scripts/experiments/j4r6-f1-structured-output/` (README). El canary J4-R5 se purgó, así que sus
contextos ya no existen. Se reconstruyeron contextos equivalentes, 21 en total:
- se usa el runtime real del canary `@7`/`@8` sobre una BD local desechable (nombre con `canary`);
- los owners son fixtures, y CIA y CP son stubs sintéticos (grant verificado, CP v1-rc2 `available`);
- las decisiones son guionadas;
- en cada turno REAL se guarda el `ModelRequest` exacto que arma el kernel.

Después, cada request guardado se envía N veces al modelo real a través del adaptador del build en curso. Se
registra solo la forma de la respuesta (`shapeOf`) y el veredicto del parser. No se guarda texto de respuesta.

**Ambos brazos usan los mismos requests guardados.** Solo cambia el build del adaptador que los renderiza.

| Familia (requests) | Qué invita el turno |
|---|---|
| `multi@7`, `multi@8` (3 + 3) | Invitado: varios productos y despacho; primera decisión |
| `multi-after-read@7`, `@8` (3 + 3) | Igual, con una lectura de catálogo ya observada |
| `linked@8` (3) | Cliente verificado: historial y stock actual; primera decisión |
| `linked-after-history@8` (3) | Igual, con el historial ya observado |
| `history@7` (3) | Historial pedido a `@7`, que no lo tiene |

### Línea base: `main` `e9a9bcb`, 63 llamadas (3 por request)

| Familia | Malformadas | Formas |
|---|---|---|
| `linked@8` | **3/9** | 2× `read+read`, 1× `read+read+prosa` |
| `linked-after-history@8` | **2/9** | `read+read`; `read+objeto sin type+prosa` |
| `multi@7` | **2/9** | `read+prosa`; `read+read+read+prosa` |
| `multi-after-read@8` | **1/9** | `read+read+prosa` |
| `multi@8`, `multi-after-read@7`, `history@7` | 0/9 cada una | — |
| **Total** | **8/63 (12,7 %)** | Todas con `read_capability`, igual que en el canary (`p0-replay-shapes.jsonl`: 11/25) |

En las cuatro familias difíciles: **8/36 (22,2 %)**. Todas las fallas son `finish_reason: stop`: no hay
truncamiento.

## 3. Corrección

`adapters/models/openai-compatible/src/render.ts`, en `renderMessages`:

1. El mensaje de sistema «Output:», que ya pedía «exactly one JSON document», ahora agrega `ONE_DOCUMENT_RULE`:
   - una respuesta lleva un documento, nunca dos o más;
   - si hacen falta varios datos o pasos, se devuelve solo el primero, y su resultado llega en el turno
     siguiente;
   - nada antes ni después del documento.
2. El mensaje de usuario con el contexto compilado termina con `ONE_DOCUMENT_REMINDER`, la misma regla en una
   línea, justo donde el modelo decide.

La regla **no nombra tipos de decisión** del protocolo R4: el adaptador sigue siendo neutral respecto del
agente (lo fija un test). Solo se aplica con contrato de salida `json`.

El `ContextSnapshot` registra el contexto compilado, no el prompt renderizado, así que los snapshots y las
huellas no cambian. El único llamador de `renderMessages` es el propio proveedor.

## 4. Verificación

### Candidato sobre los mismos requests (99 llamadas)

| Familia | Línea base | Candidato |
|---|---|---|
| `linked@8` | 3/9 | **0/18** |
| `linked-after-history@8` | 2/9 | **0/18** |
| `multi@7` | 2/9 | **0/18** |
| `multi-after-read@8` | 1/9 | **0/18** |
| Resto (`multi@8`, `multi-after-read@7`, `history@7`) | 0/27 | 0/27 |
| **Total** | **8/63 (12,7 %)** | **0/99 (0 %)** |

- **Total:** 8/63 frente a 0/99, Fisher exacto unilateral p = 3,9e-4; cota superior del 95 % (regla del tres)
  3,0 %. Las «familias difíciles» se eligieron **después** de ver la línea base y solo ellas recibieron
  repeticiones extra, así que su p = 8,6e-5 está inflado por selección y **no** se usa como evidencia (revisión
  F-2). Las evidencias válidas son el total y el A/B aleatorizado de §4.1.
- **Tipo de decisión:** en este replay solo se registra el tipo (no la capacidad ni los argumentos). La mezcla
  es estable entre brazos (≈ 87 % `read_capability`, ≈ 11 % `respond`, algún `propose_action`). La selección de
  capacidades y la progresión multi-producto se verificaron aparte (§4.1).
- **Tokens de salida:** media de 320 en la línea base y 231 en el candidato.
- **Fidelidad de la oferta J3E-C1:** familia `offer` de `j4r4-v8-compat` sobre el build candidato, 4 escenarios
  por perfil. Resultado: **8/8 `respond` byte-idénticos** a `presentation.offerMessage` (`@7` y `@8`).
- **Costo total del modelo:** 170 llamadas reales (162 de replay y 8 de oferta), **US$0,61**, dentro del tope
  de 400 llamadas y US$6.

**Procedencia (revisión F-4).** Las 99 llamadas del candidato se hicieron desde un árbol con cambios sin
commitear (`commit: e9a9bcb, dirty: true` en `calls-candidate.jsonl`). El A/B del revisor sobre el HEAD limpio
`22b39a6` las reproduce (§4.1), y la redacción final se midió desde el árbol limpio `cad30e3` (§4.2).

### 4.1 Revisión independiente (2026-10-27, APPROVE_WITH_CONDITIONS)

Un revisor independiente recomputó las cifras desde los logs crudos (coinciden) e hizo 138 llamadas reales
propias (≈ US$0,58):
- **A/B aleatorizado del mismo build** (21 requests × 2 × 2 brazos, orden aleatorio): línea base **8/42**
  malformadas frente a candidato **0/42** (Fisher unilateral p = 0,0027). Misma selección de capacidades en las
  mismas proporciones (`catalog.search` con las mismas consultas, `customer.get_context` en `linked@8`).
- **Turnos completos con el modelo real** (6 escenarios multi-producto, `@7` y `@8`, runtime real local): todos
  avanzan una lectura por llamada (cada producto, `shipping.quote`, actualización del workspace) y responden.
  **1/54 malformada** (prosa sin documento) en `multi1-7`, recuperada por ADR-028 con una run extra.
- **Presupuestos:** el peor caso usó 12 de 40 llamadas al modelo por run (`maxModelCalls` de v8), 9 lecturas
  de 40 y 127 s de 600 s. Las lecturas secuenciales no agregan llamadas respecto de una línea base válida: los
  documentos concatenados nunca se ejecutaban, solo se rechazaban.
- Sin failover; parser, kernel, protocolo v5 y autorización de acciones sin cambios.

### 4.2 Redacción final (revisión F-5)

La regla decía «its result arrives in the next turn **and you will be asked again**», lo que contradice el
protocolo v5 (`respond` termina el turno). Se quitó esa cláusula (`cad30e3`). Replay de los mismos 21 requests
× 3 desde el árbol limpio: **0/63 malformadas**, 0 rechazos semánticos. Mezcla de decisiones: 54
`read_capability`, 7 `respond`, 2 `propose_action`. En `history1-7` los tres brazos varían entre leer,
proponer y responder (línea base incluida): ruido de muestra, no un cambio de comportamiento.

**Auditoría (F-6):** el prompt renderizado no forma parte del `ContextSnapshot`, así que los snapshots no
muestran la regla. La regla vive en el código del adaptador, fijada por un test unitario.

### Límites de esta evidencia

- Son contextos sintéticos locales, equivalentes a los del canary pero no los mismos (aquellos se purgaron).
- El candidato **reduce, no elimina**, la tasa de malformadas: hubo 1/54 en turnos completos, y la cota
  superior del replay es del ~3–5 %. La recuperación de ADR-028 y el aviso del PR #27 siguen siendo necesarios como redes
  de seguridad.
- Falta la verificación integrada: **repetir el canary J4-R5** con esta corrección. Eso requiere desplegar en
  el EC2 aislado, con autorización separada del owner.

## 5. Pruebas

Ejecutadas sobre esta rama (PostgreSQL local; recuperación al final y sola):

| Suite | Resultado |
|---|---|
| `lint`, `typecheck` | ✓ |
| unit | 1520 passed, 4 skipped (incluye la prueba nueva) |
| contract | 450 passed |
| integration | 607 passed, 12 skipped |
| sales, shadow | 29, 5 |
| recovery | 18/18 |

- Prueba nueva en `tests/unit/sales/openai-compatible-provider.test.ts` («F-1: …»). Fija:
  - la regla en el mensaje «Output:»;
  - el recordatorio al final del contexto;
  - la neutralidad respecto del agente.
- No se cambió texto del kernel, así que las mutaciones del kernel no aplican.
