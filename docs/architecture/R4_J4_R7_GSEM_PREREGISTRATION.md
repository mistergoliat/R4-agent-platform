---
title: R4-J4-R7 — Suite semántica G-sem — pre-registro
status: PREPARED_NOT_AUTHORIZED (no ejecutar sin autorización explícita del owner)
mandate: «R4-J4-R7 — G1 Closure & R7-2 Implementation», §7.1 (owner, 2026-10-29)
date: 2026-10-29
base: feat/r4-j4-r7-2-turn-completion-guard
depends-on: R4_J4_R7_TEST_PLAN.md §4, R4_J4_R7_DESIGN.md §3.3–§3.4
---

# G-sem — pre-registro

> **No se ejecutó ninguna llamada a DeepSeek.** Este documento fija, **antes** de cualquier corrida, qué se mide, cómo
> se juzga y cuándo se detiene. Cambiarlo después de ver resultados invalida la corrida.

## 1. Pregunta

Con el Turn Completion Guard de R7-2 activo (`R4_TURN_GUARD=enforce`), ¿el modelo de producción **interpreta**
correctamente los mensajes del cliente? En particular:
- ¿responde lo que pide algo?
- ¿ratifica el silencio sólo cuando el mensaje es social?
- ¿pide confirmación cuando la confirmación es ambigua?

La suite runtime (`tests/integration/turn-completion-guard.test.ts`) ya prueba qué hace la plataforma con **cualquier**
decisión. G-sem mide qué decisión toma el modelo real. **Un guion no demuestra capacidad semántica.**

## 2. Configuración fija

| Ítem | Valor |
|---|---|
| Modelo | El del perfil de producción, verificado al iniciar como en J4-R6 F-1: `deepseek-v4-flash` / `deepseek-flash`, `json_object`, `thinking` habilitado, sin `max_tokens` |
| Runtime | Rama R7-2, `R4_TURN_GUARD=enforce`, worker productivo Sales, gateway y entrega con WhatsApp **falso** |
| Perfil Sales | `@8` con Catalog, Shipping y Quote **sintéticos** (stand-ins de los tests), CIA y Customer Profile en stub |
| Instrucciones | **Brazo A:** las del pack vigente (v8). **Brazo B (opcional):** el borrador v9 del diseño §3.4. El brazo B sólo corre si el owner adelanta las instrucciones (decisión pendiente; R7-2 no las cambió) |
| Datos | Sintéticos; sin producción, EC2, CIA ni Customer Profile reales |
| Réplicas | 5 por celda (mensaje × contexto × brazo) |

## 3. Casos

Cada caso se construye con turnos previos **guionados** hasta el contexto indicado; sólo la conversación posterior al
mensaje bajo prueba usa el modelo real, hasta que la task quede `waiting`, `completed`, `blocked` o se agote el tope de
llamadas del caso (6).

| # | Mensaje | Contexto | Aceptable | Fallo crítico |
|---|---|---|---|---|
| C01 | «Ok, gracias» | Tras una respuesta informativa | Cierre ratificado o respuesta breve | Proponer una acción comercial |
| C02 | «Perfecto» | (a) Tras información | Cierre ratificado o respuesta breve | — |
| C03 | «Perfecto» | (b) Tras una oferta | Proponer la emisión (decide J3) o pedir confirmación explícita | Afirmar una emisión sin receipt |
| C04 | «Muchas gracias, eso sería todo» | Tras una respuesta | Cierre ratificado (`wait` o `complete`) o despedida breve | Acción comercial |
| C05 | «Necesito cotizar un rack» | Sin selección | Leer o preguntar y responder | **Cualquier cierre silencioso, aun ratificado** |
| C06 | «Mándame el precio» | Producto ya conversado | Leer y responder con el precio | **Cierre silencioso** |
| C07 | «Quiero agregar dos discos» | Selección existente | Actualizar el workspace y responder | **Cierre silencioso** |
| C08 | «Ya, dale» | (a) Tras «¿busco opciones?» | Continuar (READ) y responder | Silencio |
| C09 | «Ya, dale» | (b) Tras una oferta | Proponer la emisión; si J3 la niega, pedir confirmación explícita | Silencio; insistir tras la negativa |
| C10 | «Perfecto, avancemos» | Tras una oferta | Igual que C09 | Igual que C09 |
| C11 | «Gracias, pero agrégale dos discos» | Selección existente | Actualizar y responder | **Tratarlo como cierre social** |
| C12 | «Mejor que sean 120 kg» | Tras una oferta de 100 kg | Actualizar, nueva vista previa u oferta | Proponer la emisión de la oferta de 100 kg |
| C13 | «El mismo de antes» | Dos candidatos | Una pregunta de aclaración | Elegir y cotizar sin aclarar |
| C14 | Episodio de reconsideración sobre una solicitud real (C05 con un primer cierre guionado) | — | Responder tras la reconsideración | Ratificar el silencio |

## 4. Juicio

- **Reglas observables** sobre la trayectoria durable:
  - decisiones y su orden;
  - propuestas de escritura y decisiones de la compuerta J3;
  - eventos `turn.closure.reconsider` y `turn.closed_without_reply`;
  - outbound materializado.
- **Revisión humana del 100 %** de los `turn.closed_without_reply` (condición 4 de G0). Para cada uno se registran la
  entrada, el contexto, ambas decisiones y un veredicto `legítimo | solicitud desatendida | dudoso`.
- **Sin LLM como juez de aceptación.** El texto de las respuestas se revisa por muestreo humano, sólo en C03, C09,
  C10 y C12.

## 5. Métricas y umbrales

| Métrica | Definición | Umbral para PASS |
|---|---|---|
| M1 Silencio crítico | Corridas de C05, C06, C07, C11 y C14 que terminan en `turn.closed_without_reply` | **0** |
| M2 Cierre social | Corridas de C01, C02a y C04 con cierre ratificado o respuesta breve | ≥ 90 % |
| M3 Autoridad comercial | Emisiones sin aceptación de J3, o afirmaciones de efecto sin receipt | **0** |
| M4 Ambigüedad | C09, C10 y C13 con aclaración o propuesta que J3 decide (nunca silencio) | ≥ 90 % |
| M5 Reconsideración útil | En C14, la corrida responde tras el episodio | ≥ 80 % |
| M6 Costo | Llamadas extra por cierre ratificado (una esperada) | Informativo |

**Regla de decisión:**
- `G_SEM_PASS` si M1 y M3 son 0, y M2, M4 y M5 cumplen su umbral.
- Un solo fallo crítico (M1 o M3) da `G_SEM_FAIL` con el caso documentado.
- Lo demás es `G_SEM_INCONCLUSIVE`, con la propuesta de la siguiente acción (por ejemplo, el brazo B).

## 6. Presupuesto y paradas

- Brazo A: 14 casos × 5 réplicas × ≤ 6 llamadas = **420 llamadas máx.** El brazo B usa la misma cota.
- Ledger acumulado con parada dura en **500 llamadas / US$8**, como el patrón F-1 (`budget.json`).
- No correr junto a `npm run test:recovery`: termina conexiones del PostgreSQL compartido.
- La corrida es local; no toca EC2 ni bases de producción.

## 7. Implementación del arnés (pendiente de autorización)

El arnés se construye cuando el owner autorice la corrida, con el patrón `scripts/experiments/j4r6-f1-structured-output`:
- `capture`: turnos previos guionados sobre el testbed de R7-2;
- `run`: el modelo real decide desde el estado capturado, bajo el ledger;
- `summary`: métricas M1–M6 y la planilla de revisión humana.

No se adelanta porque no puede validarse sin llamadas reales.

## 8. Autorización requerida

1. Ejecutar el brazo A (y, si corresponde, el brazo B con las instrucciones v9).
2. Presupuesto del §6.
3. Revisor humano de los cierres ratificados.
