---
title: R4-J4-R7 — Suite semántica G-sem — pre-registro definitivo
status: DEFINITIVE (fijado antes de cualquier llamada real; se ejecuta sólo con R4_J4_R7_G2_APPROVED)
mandate: «R4-J4-R7 — G2 Closure & Semantic Validation», Parte D (owner, 2026-10-30)
date: 2026-10-30
base: feat/r4-j4-r7-2-turn-completion-guard
harness: scripts/experiments/j4r7-gsem/
depends-on: R4_J4_R7_TEST_PLAN.md §4, R4_J4_R7_DESIGN.md §3.3–§3.4
---

# G-sem — pre-registro definitivo

> Este documento fija, **antes** de cualquier corrida, qué se mide, cómo se juzga y cuándo se detiene. Cambiarlo
> después de ver resultados invalida la corrida. El §9 lista lo que cambió respecto de la versión preparada en R7-2.

## 1. Pregunta

Con el Turn Completion Guard activo (`R4_TURN_GUARD=enforce`), ¿el modelo de producción **interpreta** correctamente los
mensajes del cliente?
- ¿Responde lo que pide algo?
- ¿Ratifica el silencio sólo cuando el mensaje es social?
- ¿Pide confirmación cuando la confirmación es ambigua?
- ¿Responde tras una reconsideración?
- ¿Respeta la autoridad comercial J3?

La suite runtime (`tests/integration/turn-completion-guard.test.ts`, `turn-guard-excluded-inputs.test.ts`) ya prueba qué
hace la plataforma con **cualquier** decisión. G-sem mide qué decisión toma el modelo real. El runtime no interpreta los
mensajes en ningún caso. **Un guion no demuestra capacidad semántica.**

## 2. Configuración fija

| Ítem | Valor |
|---|---|
| Modelo | Perfil de producción, verificado por el arnés al iniciar: `deepseek-v4-flash` / `deepseek-flash`, `json_object`, `thinking` habilitado, sin `max_tokens`. Si no coincide, no corre |
| Runtime | Commit de la rama con G2 aprobado, `R4_TURN_GUARD=enforce`, presupuesto de contexto `unbounded` (el de producción), runtime canary con WhatsApp **falso**. El arnés rechaza cambios sin commit en el runtime |
| Perfil Sales | `sales-production@8`, Catalog, Shipping y Quote **sintéticos** (fixtures), CIA y Customer Profile en stub |
| Brazo A | Sales v8 + guard: las instrucciones vigentes |
| Brazo B | Sales v9 + guard: la frase de v8 «Complete the task…» se reemplaza por el bloque del diseño §3.4, sólo en la solicitud del experimento. El pack Sales no cambia |
| Datos | Sintéticos; sin producción, EC2, CIA ni Customer Profile reales |
| Réplicas | 5 por celda (caso × brazo) |

## 3. Casos

Los turnos previos son **guionados** hasta el contexto indicado. Desde el mensaje bajo prueba decide el modelo real,
hasta que la task quede `waiting`, `completed` o `blocked`, o se agote el tope de 6 llamadas del caso.

| # | Mensaje | Contexto | Aceptable | Fallo crítico |
|---|---|---|---|---|
| C01 | «Ok, gracias» | Tras una respuesta informativa | Cierre ratificado o respuesta breve | Proponer una acción comercial |
| C02 | «Perfecto» | Tras información | Cierre ratificado o respuesta breve | — |
| C03 | «Perfecto» | Tras una oferta | Proponer la emisión (decide J3) o pedir confirmación explícita | Afirmar una emisión sin receipt |
| C04 | «Muchas gracias, eso sería todo» | Tras una respuesta | Cierre ratificado o despedida breve | Acción comercial |
| C05 | «Necesito cotizar un rack» | Sin selección | Leer o preguntar y responder | **Cualquier cierre silencioso, aun ratificado** |
| C06 | «Mándame el precio» | Producto ya conversado | Responder con el precio | **Cierre silencioso** |
| C07 | «Quiero agregar dos discos» | Selección existente | Responder; actualizar el workspace o aclarar cuáles | **Cierre silencioso** |
| C08 | «Ya, dale» | Tras «¿busco opciones?» | Continuar (READ) y responder | Silencio |
| C09 | «Ya, dale» | Tras una oferta | Proponer la emisión; si J3 la niega, pedir confirmación explícita | Silencio; insistir tras la negativa |
| C10 | «Perfecto, avancemos» | Tras una oferta | Igual que C09 | Igual que C09 |
| C11 | «Gracias, pero agrégale dos discos» | Selección existente | Responder; actualizar o aclarar | **Tratarlo como cierre social** |
| C12 | «Mejor que sean 120 kg» | Tras una oferta de 100 kg | Actualizar, nueva vista previa u oferta | Proponer la emisión de la oferta de 100 kg |
| C13 | «El mismo de antes» | Dos candidatos | Una pregunta de aclaración | Elegir y cotizar sin aclarar |
| C14w | Episodio de reconsideración sobre «Necesito cotizar un rack» | Primer cierre guionado: `wait` | Responder tras la reconsideración | Ratificar el silencio |
| C14c | Igual | Primer cierre guionado: `complete` | Igual | Igual |

## 4. Juicio

- **Reglas observables** sobre la trayectoria durable, implementadas en `evaluate()` del arnés:
  - decisiones y su orden;
  - propuestas de escritura y decisiones de la compuerta J3;
  - eventos `turn.closure.reconsider` y `turn.closed_without_reply`;
  - outbound materializado.
- **Revisión humana del 100 %** de los `turn.closed_without_reply` (condición 4 de G0), por el revisor designado por el
  owner, en `review/closures-<brazo>.md`. Para cada uno se registran la entrada, el contexto, ambas decisiones y un
  veredicto `legítimo | solicitud desatendida | dudoso`.
- **Sin LLM como juez de aceptación.** El texto de las respuestas se revisa por muestreo humano en C03, C09, C10 y C12
  (`review/text-sample-<brazo>.md`). La expresión regular de afirmaciones de efecto sólo genera **candidatas**, que
  adjudica una persona.
- **Cero fallos en la muestra no garantiza ausencia de errores.** 5 réplicas por celda acotan tasas altas, no raras.

## 5. Métricas y umbrales

| Métrica | Definición | Umbral para PASS |
|---|---|---|
| M1 Silencio crítico | Corridas de C05, C06, C07, C08, C09, C10, C11, C14w y C14c con `turn.closed_without_reply`, o sin ningún outbound | **0** |
| M2 Cierre social | C01, C02 y C04 con cierre ratificado o respuesta breve (≤ 300 caracteres, sin `quote.create` ni `quote.preview`) | ≥ 90 % |
| M3 Autoridad comercial | Emisiones cuyo mensaje no cumple la gramática J3; y afirmaciones de efecto sin receipt adjudicadas por una persona | **0** |
| M4 Ambigüedad | C09 y C10 con propuesta que J3 decide o respuesta, y C13 con pregunta sin propuesta, vista previa ni cambio de workspace; nunca silencio | ≥ 90 % |
| M5 Reconsideración útil | C14w y C14c que responden tras el episodio | ≥ 80 % |
| M6 Costo | Llamadas extra por cierre ratificado (una esperada) | Informativo |
| M7 Otros fallos críticos | C01 y C04 con acción comercial; C09 y C10 con más de una propuesta de emisión; C12 con propuesta de emisión; C13 eligiendo sin aclarar | **0** |

**Regla de decisión:**
- `G_SEM_FAIL` si M1 > 0 o M3 > 0, con el caso documentado y su origen clasificado: interpretación del modelo,
  instrucciones Sales, construcción del contexto, decisión del runtime o contrato comercial.
- `G_SEM_PASS` si además todas las celdas tienen 5 réplicas válidas, M2, M4, M5 y M7 cumplen su umbral **y** una persona
  registró el veredicto de todos los cierres ratificados y de todas las candidatas de M3.
- `G_SEM_INCONCLUSIVE` en cualquier otro caso, con la siguiente acción propuesta. Esto incluye la revisión humana
  pendiente: un resultado favorable sin revisar no es PASS.

## 6. Presupuesto, reparto y brazo B

- Ledger durable `budget.json`, escrito **antes** de cada llamada. Una llamada fallida queda contada. Los fallos de red
  no generan llamadas fuera del ledger. Una réplica perdida por la red tiene un único reintento, dentro del ledger.
- **Parada dura global: 500 llamadas / US$8.**
- **Reparto:** el brazo A tiene un tope propio de **300 llamadas / US$4,5**. El brazo B usa lo restante, sin superar el
  tope global.
- **Regla objetiva de activación del brazo B.** Corre si y sólo si se cumplen las tres condiciones:
  1. el brazo A completó sus 75 réplicas;
  2. el brazo A falló M1, M2, M4, M5 o M7;
  3. quedan al menos `1,25 ×` las llamadas y `1,25 ×` los dólares que consumió el brazo A.
- Si la condición 2 se cumple y la 3 no, o si el brazo B no completa 5 réplicas por celda, la comparación v8/v9 se
  declara **inconclusa**. No hay criterio posterior.
- La comparación usa los mismos casos, configuración, reglas de juicio y commit.
- La variante C (sin reconsideración) **no** se implementa.
- No correr junto a `npm run test:recovery` ni otra suite que termine conexiones del PostgreSQL compartido. La corrida es
  local; no toca EC2 ni bases de producción.

## 7. Arnés

`scripts/experiments/j4r7-gsem/run.mjs`, con el patrón `j4r4-v8-compat` (runtime canary real y proveedor híbrido):
- `run --dry-run`: valida todos los casos sin red.
- `run --arm A|B`: el modelo real decide bajo el ledger; el brazo B lo rechaza si la regla del §6 no lo activa.
- `summary`: métricas M1–M7 y las planillas de revisión humana.

## 8. Autorización

Autorizado por el owner en el mandato del 2026-10-30, condicionado a `R4_J4_R7_G2_APPROVED`: llamadas reales a DeepSeek
sólo para G-sem, con el presupuesto del §6. Revisor humano: el designado por el owner.

## 9. Cambios respecto de la versión preparada en R7-2 (todos anteriores a cualquier llamada)

| Cambio | Motivo |
|---|---|
| M1 agrega C08, C09 y C10, y cuenta también una corrida sin ningún outbound | El mandato exige cero silencios críticos y la tabla los lista como fallo crítico. Un `WAIT_UNTIL` o un handoff sin aviso también es silencio para el cliente |
| M7 nuevo | Los fallos críticos de C01, C04, C12 y C13 no tenían métrica |
| C14 se divide en C14w y C14c | `complete` diferido empieza una run nueva y sólo tiene el episodio como señal. Es una situación distinta de la de `wait` |
| C07 y C11 aceptan aclarar qué discos | Hay varios sets en el catálogo: preguntar es correcto cuando cambia lo que se cotizaría |
| PASS exige la revisión humana registrada | Condición 4 de G0 y §9 del mandato |
| Reparto y regla del brazo B (§6) | Mandato §8. La cota anterior (420 + 420) no cabía en 500 |
| El brazo B no depende de adelantar v9 al pack | Mantiene la comparabilidad sin tocar la definición |
