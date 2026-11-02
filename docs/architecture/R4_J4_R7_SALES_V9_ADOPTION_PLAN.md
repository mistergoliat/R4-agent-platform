---
title: R4-J4-R7 — plan de adopción condicionada de Sales v9
status: CONDICIONAL. Nada implementado
mandate: «R4-J4-R7 — Owner Decision Record», D2
date: 2026-10-30
---

# Plan de adopción condicionada de Sales v9

## 1. Condición

Este plan **no se ejecuta** hasta que existan las dos cosas, en este orden (D2):

1. Adjudicación humana favorable registrada por el owner.
2. `G_SEM_PASS` emitido formalmente para el brazo B en `R4_J4_R7_GSEM_REPORT.md`.

Si la adjudicación es adversa, v9 no se adopta y este plan se revisa con el hallazgo a la vista.

**Qué no cambia:** kernel, protocolo v5, Quote, Policy Engine, política de acciones, capacidades, límites autónomos, gramática J3 y Turn Completion Guard.

## 2. Hallazgo: v9 no puede ser sólo una edición de texto

D2 limita la adopción a las instrucciones. Eso se cumple en el comportamiento, pero el repositorio exige más que editar un texto:

- Una versión registrada es inmutable: un cambio es un archivo nuevo (`agents/sales/src/definition.ts:10-12`; `packages/agent-registry/src/registry.ts:62-69`).
- Cada perfil de producción fija una sola versión (`salesProductionAgentVersion`, `agents/sales/src/production/profile-v8.ts:135`).
- Un worker sólo toma tasks de la versión que sirve; las demás esperan (EV-2, `agents/sales/src/production/composition.ts:215-217`).

Por tanto, **algún perfil tiene que servir v9.**

| Opción | Qué implica | Rollback | Evaluación |
|---|---|---|---|
| **A: `sales-production@9` (recomendada)** | Perfil nuevo con las mismas capacidades, que reutiliza `SALES_PRODUCTION_V8_ACTION_POLICY` y entra en los mismos conjuntos de `@8` | Seleccionar `@8` con `R4_PROD_POLICY_PROFILE` | Sigue la convención del repositorio y una etiqueta identifica exactamente qué corre. Agrega unas líneas de registro, sin ninguna regla nueva |
| B: `@8` pasa a servir v9 | Cambia sólo el mapeo | Exige redeploy | Diff mínimo, pero `@8` deja de significar lo que evaluaron J4-R4 y G-sem brazo A, y se pierde el rollback por configuración |

**Se recomienda A**, con una prueba que falle si `@9` difiere de `@8` en algo que no sea la versión de la definición. **El owner debe confirmar esta lectura de D2** antes de ejecutar.

## 3. Pasos

| # | Paso | Detalle | Verificación |
|---|---|---|---|
| 1 | Base | Rama desde R7-2. v9 no puede aterrizar sin el guard: sus reglas 3 y 10 describen la reconsideración | R7-2 presente en la rama |
| 2 | Definición | `agents/sales/sales.v9.agent.json`: copia de v8 con `version: 9` y la frase «Complete the task…» sustituida por el bloque §3.4 del diseño. Registro en `SALES_AGENT_DEFINITION_FILES`. `SALES_AGENT_LATEST_VERSION` no cambia | Prueba de identidad (paso 4) |
| 3 | Perfil | `SALES_PRODUCTION_PROFILE_V9`, `SALES_PRODUCTION_AGENT_VERSIONS`, `SALES_PRODUCTION_PROFILES`, y pertenencia a `SALES_AUTONOMOUS_QUOTE_PROFILES`, `SALES_CONFIRMED_INTENT_PROFILES`, `SALES_DETERMINISTIC_OFFER_PROFILES` y `SALES_CUSTOMER_IDENTITY_PROFILES`. `salesActionPolicyFor` devuelve la misma política de `@8`. Gate propio que hereda todo `SALES_PRODUCTION_PROFILE_V8_GATE` más `G_SEM_PASS` | `tests/contract/sales-profile-*` |
| 4 | Pruebas (se entregan con el cambio) | **Identidad con lo evaluado:** las instrucciones de v9 son exactamente las de v8 con la sustitución, usando el mismo `V9_BLOCK` del arnés, y el resto del JSON sólo difiere en `version`. **Paridad:** `@9` y `@8` tienen capacidades, política y límites iguales. **Sin aprobación:** `@9` no introduce `REQUIRE_APPROVAL` en cotizaciones ordinarias (ADR-043). Contratos que listan versiones actualizados | Nuevas |
| 5 | Regresión sin modelo real | `sales-autonomous-quote`, `sales-confirmed-intent-*`, `sales-deterministic-offer-*` sobre `@9`; `turn-completion-guard`; `unit`, `contract`, `integration`, `sales`, `shadow`, `recovery`; mutaciones | Sin llamadas a DeepSeek |
| 6 | Revisión | Revisión del diff con el owner. Sin push, merge ni despliegue hasta que él lo autorice | Decisión del owner |
| 7 | Activación | Fuera de este plan: requiere su propia autorización (§5) | — |

**Por qué basta sin una corrida nueva:** G-sem evaluó ese texto exacto, sustituido en la solicitud. La prueba de identidad garantiza que lo adoptado es lo evaluado, salvo el número de versión. Lo que no cubre está en §6.

## 4. Numeración

El plan del diseño (§13) reservaba «pack Sales v9 completo» para R7-4. Esta adopción usa el número 9 sólo para el bloque §3.4. Lo que R7-4 agregue será **v10**, y su evaluación será aparte.

## 5. Condiciones de activación y rollback

- **v9 sólo con `R4_TURN_GUARD=enforce`.** ADR-044 propone `observe` como primera compuerta del canary y como rollback, pero **v9 con `observe` no se evaluó y es peligroso**: la regla 3 pide esperar en silencio ante mensajes sociales, y en `observe` nada obliga a reconsiderar. Por tanto, el rollback del guard a `observe` debe incluir volver a `@8`. Con v8 se puede seguir usando `observe`.
- **Tasks fijadas a una versión.** Por EV-2, al volver a `@8` las tasks creadas con v9 quedan esperando sin responder, y al pasar a `@9` les ocurre lo mismo a las de v8. Como ambos perfiles son idénticos salvo el texto, se propone que los dos declaren `servedAgents` con las versiones 8 y 9, para que ninguna conversación quede detenida. **Debe ir en el primer despliegue de `@9`**, y la prueba de paridad es lo que lo justifica. Hoy no hay tasks afectadas: `@8` no está desplegado.
- **`@8` no está desplegado.** Sus gates siguen bloqueantes (`SALES_PRODUCTION_PROFILE_V8_GATE`) y `@9` los hereda. Adoptar v9 no adelanta J4-R5, datos reales ni despliegue.
- **Criterios para detener un canary con v9:** cualquier emisión sin confirmación explícita, cualquier afirmación de efecto sin receipt, cualquier cierre ratificado que omita una solicitud real.

## 6. Riesgos residuales

| Riesgo | Detalle | Tratamiento |
|---|---|---|
| Muestra pequeña | 5 réplicas por celda; una tasa real cercana al 6 % de silencios críticos pasaría inadvertida | Canary con revisión de `turn.closed_without_reply` |
| Más cierres silenciosos | v9 ratificó 3 de 15 mensajes sociales, frente a 1 de 15 con v8. Es lo que pide, y por eso aumenta la exposición si el modelo se equivoca | Revisión humana de cierres en canary |
| Búsqueda repetida (C12) | 2 de 5 réplicas de cada brazo llegaron al tope ante un producto inexistente; v9 no lo mejora. No se observó cómo termina con el presupuesto real | Vigilar en canary; no bloquea |
| Emisión legítima | G-sem no incluyó confirmaciones válidas | La cubren las suites del paso 5 |
| Costo | Igual en la muestra (174 frente a 177 llamadas), pero en sociales pasa a dos llamadas por mensaje | Medir en canary |
