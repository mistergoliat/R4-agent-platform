---
title: R4 — Aceptación interpretada en lenguaje natural (sales-production@19) y propuestas en borrador de Quote V2
status: R4_SALES_V19_INTENT_ACCEPTANCE_READY_FOR_REVIEW — implementado en @19 (no desplegado ni activado); borradores bloqueados por permisos del principal
date: 2026-11-10
mandate: «R4 — ACTIVACIÓN @18, CIERRE @19 Y DECISIONES R4-L», decisión del owner sobre la confirmación de cotizaciones
---

# Aceptación en lenguaje natural (`@19`)

## 1. Decisión del owner (2026-11-10, resumen fiel)

La creación de una cotización **no** es una compra, un pago ni una reserva de inventario. Lo que decidió el owner:

1. No exigir frases literales («Sí, emítela»).
2. El modelo interpreta las expresiones naturales y el contexto completo.
3. Crear una **propuesta** cuando la intención comercial sea clara y estén definidos productos, variantes y cantidades, aunque no se pida emitir.
4. No generar cotizaciones por búsquedas exploratorias.
5. Mantener los controles deterministas: precio, stock, límites F1, idempotencia y concurrencia.
6. No tomar preguntas, rechazos ni pedidos de cambio como aceptación.
7. Mantener el consentimiento explícito para Checkout y cualquier operación financiera.

Antes de implementar el punto 3, había que verificar si Quote V2 permite guardar un **borrador** sin emitir el PDF.

**Contexto.** En el primer canary de `@18`, el cliente respondió «si emitela pls», «si» y «sí, emítelas». La gramática cerrada (`r4-sales-confirmation-es-v1`) rechazó las tres, y el agente repitió la oferta sin explicar por qué.

## 2. Borradores en Quote V2 (verificado en `a79d33f`, solo lectura)

| Ruta (contrato actual) | Scope | Estado |
|---|---|---|
| `POST /v2/quotes/drafts` | `quotes:draft:write` | Existe: crea un borrador (`status = draft`), sin número ni PDF |
| `PATCH /v2/quotes/:id/draft` | `quotes:draft:write` | Existe |
| `POST /v2/quotes/:id/issue` | `quotes:issue` | Existe: emite el borrador |
| `POST /v2/quotes` (el que usa R4) | `quotes:create` | Crear y emitir en un paso |

**Limitación.** El principal de R4 en producción (`r4-sales-retail-session`) solo tiene `quotes:create`, `quotes:read` y `quotes:document:read`. **No tiene `quotes:draft:write` ni `quotes:issue`.** El contrato ya contempla los borradores; lo que falta es el permiso.

**Adaptación mínima propuesta.** No cambia el contrato de Quote ni crea endpoints.

1. **Owner de Quote:**
   - agregar `quotes:draft:write` y `quotes:issue` al principal `r4-sales-retail-session` en su registro;
   - confirmar la semántica que R4 necesita: que el borrador no tenga número ni vigencia hasta emitirse, que la política de 60 minutos se aplique al emitir, y cuánto se retiene un borrador.
2. **R4, en un PR propio y solo después de ese permiso:**
   - métodos `createDraft`, `updateDraft` e `issueDraft` en el puerto de Quote;
   - una capacidad `quote.save_proposal` para el punto 3, que guarde la propuesta en borrador cuando haya intención clara y selección completa;
   - emisión del borrador ante la aceptación.

   Así, «propuesta guardada» y «cotización emitida» quedan separadas. R4 **no** pide ese permiso por su cuenta.

## 3. Lo implementado ahora en `@19` (con el contrato y los permisos actuales)

| Pieza | `@17` y `@18` (sin cambios) | `@19` |
|---|---|---|
| Cierre de la oferta | `r4-sales-offer-es-v1`: «¿Emito esta cotización? Puedes responder: Sí, emítela.» | `r4-sales-offer-es-v2`: «¿Te emito esta cotización? Si quieres cambiar algo, dímelo.» |
| Vista previa | `quote.preview@3` | `quote.preview@4` (plantilla v2) |
| Emisión | `quote.create@5`: la respuesta debe calzar con la gramática cerrada | `quote.create@6`: el **agente interpreta** la aceptación con cualquier redacción natural |
| Guardia de la plataforma sobre la respuesta | Gramática cerrada | `r4-sales-intent-guard-es-v1`: rechaza preguntas, negativas, dudas y pedidos de cambio (punto 6) |
| Definición | v16 / v17 | v18: la aceptación natural; ante un rechazo, el agente responde lo que dijo el cliente en vez de repetir la oferta |

**Se mantienen**, iguales en `@19` (punto 5):

- la oferta exacta presentada y entregada;
- la respuesta inmediata y la ventana de 15 minutos;
- el snapshot recalculado al emitir (precio, stock, política F1, sin promociones ni despacho);
- los límites F1;
- la clave de idempotencia;
- una emisión a la vez (lock consultivo);
- el kill switch;
- el presupuesto de escrituras;
- el registro de la evidencia (`sales.quote_intent_evidence`, con `grammar_version = r4-sales-intent-guard-es-v1`).

**Fuera de este cambio:**

- **Punto 3 (propuestas proactivas sin pedido de emisión):** depende de los borradores (§2). Hasta entonces, la emisión ocurre solo después de presentar la oferta y de una respuesta que el agente interpreta como aceptación.
- **Punto 7:** Checkout no cambia.
- **Notas de voz:** R4 hoy no transcribe audio. Si se agrega, la transcripción pasaría por el mismo guardia.

**Riesgo aceptado por el owner.** El agente decide la aceptación; la plataforma solo descarta lo que con seguridad no lo es. Un «sí» ambiguo puede emitir una cotización.

- **Lo que acota el impacto:** es una propuesta sin efecto financiero, válida 60 minutos, y nunca se duplica.
- **Su costo real:**
  - un falso «sí» gasta la **única** cotización de la conversación (límite 1), así que la cotización correcta queda bloqueada y necesita a una persona;
  - también gasta uno de los **2 por hora de todo el despliegue** (no por conversación).
- **El guardia** (revisado tras la revisión independiente) rechaza:
  - negativas y rechazos chilenos;
  - dudas y postergaciones («te confirmo», «a ver», «más rato»);
  - preguntas sin signo;
  - conversación de precio;
  - condiciones («si incluye…»);
  - cambios: otro producto, variante o color, cualquier número, «sin…» salvo «sin despacho», «con despacho»;
  - el `？` de ancho completo y los emojis negativos.

  Acepta 👍, ✅ y 👌.
- **Gate `ux-l3`:** exige medir con el modelo real los falsos sí y falsos no antes de activar.

## 4. Evaluación

| Prueba | Qué cubre |
|---|---|
| `tests/unit/sales/intent-guard.test.ts` | Acepta 24 respuestas naturales (incluidos 👍, ✅ y 👌) y rechaza 120 que no son aceptación: preguntas con o sin signo, rechazos chilenos, dudas y postergaciones, conversación de precio, condiciones, cambios, emojis negativos. La gramática cerrada no cambia |
| `tests/integration/sales-intent-acceptance.test.ts` (canary aislado) | `@19` emite exactamente 1 vez con «si dale», «oka, me parece», «sí, emítelas» o «👍», con la plantilla v2. `@19` **no** emite ante «¿incluye despacho?» ni ante «sí, la de 16 kg», aunque el agente lo proponga. `@18` sigue rechazando «si» |
| `tests/contract/sales-profile-v19.test.ts` | Capacidades (`quote.preview@4`, `quote.create@6`), regla de aceptación natural en v18 (incluida «nunca pedir una frase específica»), v16 y v17 intactas |
| Mutación `npm run test:mutation:intent-acceptance` | **5/5**, incluido el desfase entre la plantilla de la vista previa y la de la emisión |

### 4.1 Juicio de aceptación con el modelo real (gate `ux-l3`, 2026-11-10)

**Montaje:** canary aislado con `@19`, DeepSeek real, Catalog V2 real y Quote apuntado a un puerto cerrado, así que no hubo cotizaciones reales. En cada caso, una conversación nueva pide 1 kettlebell sin despacho, recibe la oferta y responde.

| Respuestas | El agente propuso emitir | Lo frenó el guardia | Emisiones posibles |
|---|---|---|---|
| 10 aceptaciones naturales: «si», «dale», «sí, emítela», «oka, me parece», «perfecto», «si porfa», «sí, emítelas», «mándamela», «👍», «ya po, dale» | **10/10** | 0 | 10, es decir 0 falsos no |
| 12 casos engañosos: «te confirmo», «ok gracias», «sí, 3», «sí, la de 16 kg», «sí, en negro», «si incluye despacho», «si me haces descuento dale», «está bien así», «a ver», «mmm», «👎», «sí, pero con despacho a Ñuñoa» | **4/12** («te confirmo», «ok gracias», «sí, en negro», «está bien así») | **4/4** | **0**, es decir 0 falsos sí |

**Lectura:**

- El modelo solo, sin guardia, habría emitido en 4 de 12 casos engañosos. **El guardia determinista es necesario**, no decorativo.
- **Tras el rechazo, el agente respondió bien:**
  - preguntó en corto si emitir;
  - con «sí, 3» armó una oferta nueva por 3 unidades;
  - con «sí, la de 16 kg» informó que no hay stock y ofreció alternativas;
  - con 👎 preguntó qué ajustar.

  En una ocasión sugirió la frase «sí, emítela». Por eso v18 ahora dice que nunca pida una frase específica.
- **Efecto del límite por hora:** se ve en la propia evaluación. Después de 2 emisiones autorizadas, las siguientes se rechazaron con `autonomy_limit_rate`, porque el límite es del despliegue y no de la conversación.

**Pendiente:** el L3 integral de `@19` por WhatsApp, con Catalog V2 y Quote V2 reales.

## 5. Despacho al precio del owner (F1-COMMERCIAL-POLICY-v2, decisión del owner del 2026-11-10)

En `@19` las cotizaciones pueden llevar despacho al precio que devuelve pc-carrier, que el owner declaró siempre vigente; ver `R4_F1_COMMERCIAL_POLICY.md` §4.

**Cambios en el perfil:**

- `@19` vuelve a exponer `shipping.quote` y la elección de oferta, y sus capacidades son las de `@18`.
- Corre la definición **v19**: la v17, con todas sus reglas de despacho, más la oferta en el mismo turno, la aceptación en lenguaje natural sin pedir frases, y la vigencia de 60 minutos sin que el agente calcule la hora.
- La definición v18, sin despacho, quedó registrada en producción cuando `@19` estuvo unos minutos en el carril. No se modifica y ningún perfil la usa.

**El guardia lee las palabras de despacho según la oferta que el cliente responde:**

- **Oferta sin despacho:** «sin despacho» coincide con la oferta y «con despacho» pide un cambio.
- **Oferta con despacho:** es al revés.
- **En ambos casos** se rechazan el retiro y los nombres de transportistas.

La definición v19 nombra también despacho, destino y transportista entre los cambios.

**Pruebas:**

- `@19` emite una cotización con la oferta de despacho elegida, al precio del owner, con su PDF (canary aislado).
- No emite ante «sí, sin despacho» si la oferta incluye despacho.
- Con la política v2 un destino no se bloquea; con v1 sí.
- Mutaciones IA-M6 e IA-M7 (7/7).
