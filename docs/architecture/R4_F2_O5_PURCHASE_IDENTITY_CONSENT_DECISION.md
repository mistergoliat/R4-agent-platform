---
title: R4 F2 — Registro de decisión O-5: identidad del cliente y consentimiento de compra
status: PROPUESTA — pendiente de decisión del owner (O-5 y R4L-D2). Nada se activa
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 704c15d (carril WhatsApp `sales-production@22`)
related: R4_CHECKOUT_STATUS_2026-11.md (PR #86), R4_F2_WORK_ITEMS.md, R4_F2_O6_DELIVERY_CART_DECISION.md
---

# O-5 — Identidad y consentimiento para comprar

## 0. Pregunta y alcance

O-5 (plan del PR #64 §8): «Emisor del consentimiento productivo (Checkout, CIA u otro); R4 sólo captura». La decisión
del owner R4L-D3 ya fijó la dirección: **identidad y consentimiento separados**, el comprador sale de la identidad y el
consentimiento prueba sólo la aceptación. Este registro propone el resto: quién emite, qué evidencia queda, el alcance
del consentimiento (R4L-D2) y cómo R4 registra el acto de compra.

Restricciones vigentes que esta propuesta respeta:

- R4 no es autoridad de identidad ni de consentimiento (ADR-039; R-3: «R4 no firmará consentimientos»).
- No crear autoridades nuevas (mandato R4-L del 2026-11-10).
- Decisión del owner del 2026-11-10 (aceptación de cotizaciones, [`R4_SALES_V19_INTENT_ACCEPTANCE.md`](R4_SALES_V19_INTENT_ACCEPTANCE.md) §1, punto 7):
  «Mantener el consentimiento explícito para Checkout y cualquier operación financiera.» La aceptación en lenguaje
  natural rige la **emisión** de una cotización, no el pago.
- Sin datos personales en R4 más allá de lo que ya guarda el Core (el mensaje del canal).

## 1. Quién es el cliente y cómo se prueba

| Pieza | Regla propuesta | Fuente / estado |
|---|---|---|
| Identidad del comprador | `customerRef = prestashop_customer:<id_customer>`, igual al `sub` del grant. Una cuenta **existente, registrada, activa, no invitada**; la CIA no crea cuentas | CIA contrato v1-d2; H3 §1 (candidato `39342b2`, sin publicar) |
| Vínculo canal → cuenta | La CIA vincula (`whatsapp`, cuenta de canal, `wa_id`) con la cuenta tras un OTP al correo de la cuenta, y la revalida contra el proveedor de cuentas de la tienda en cada `resolve` | CIA-S2/S3 (sintético); proveedor real inexistente (DEP-3) |
| Prueba para comprar | Grant CIA `cv=1`: `aud = quote-cart-preparer`, `azp = r4-sales`, `purposes = ["purchase"]` **exactamente**, TTL ≤ 300 s, `jti` | H3 §4.1 (H3-D1..D6). Hoy la CIA tiene **una** audiencia por instancia y no conoce `purchase` (C-CIA-1/-3) |
| Frescura | La prueba OTP que respalda `purchase` debe ser reciente. Propuesta: la misma conversación y como máximo 30 min antes del `resolve` | OQ-H3-3 (hoy 24 h para todo propósito). **Pregunta al owner Q3** |
| Transporte | R4 pide el grant (handler determinista, contexto desde el binding de canal, nunca argumentos del modelo) y lo envía a Checkout en `x-customer-access-grant`; Checkout lo releva a Quote | H3 §6, §11; Checkout `/v1 1.0.4-proposed` (sin aprobar) |
| Lo que R4 nunca hace | Decodificar el grant; mostrarlo, o mostrar `customerRef`, al modelo; persistirlo en `memory_entries`, `task_inputs`, telemetría, recibos o logs (un recibo puede llevar el `jti` o un hash) | H3 §11; prueba de frontera F2-R03 |

## 2. Quién puede emitir el consentimiento

El consentimiento prueba que **esa** persona acepta **esta** compra (cotización, versión, importe). El único actor que
ve el canal de WhatsApp es R4: el webhook del proveedor está firmado con un secreto de la app que sólo tiene el gateway
de R4. Ningún otro servicio puede verificar el mensaje por sí mismo sin recibir ese secreto.

| Opción | Cómo funciona | A favor | En contra |
|---|---|---|---|
| **A. Checkout emite, con una página propia** | Checkout muestra el resumen (cotización, total, entrega, vigencia) en una página suya; el cliente pulsa «Acepto» y Checkout firma el consentimiento | Checkout no depende de R4 para la prueba; texto bajo control de Checkout y legal | Un paso web más antes del pago en una conversación de WhatsApp; la identidad de quien pulsa también requiere probarse (enlace de un solo uso ligado al grant); infraestructura web nueva |
| **B. La CIA emite** | La CIA firma la aceptación junto con el grant `purchase` | Una sola firma | H3 §4.3 lo prohíbe: «La CIA NO DEBE incluir en el grant cotización, sesión, tienda, importe ni direcciones». La CIA no ve el canal ni la cotización; mezclaría identidad y consentimiento, que R4L-D3 separa. **Descartada** |
| **C. R4 firma** | R4 firma un artefacto de consentimiento con su clave | Simple | Viola R-3 («sería convertirse en autoridad de consentimiento») y el mandato R4-L («No crear nuevas autoridades»). **Descartada** |
| **D. R4 captura, Checkout emite** (recomendada) | R4 registra el acto de forma determinista (§5) y lo presenta a Checkout como **evidencia atestiguada por servicio** (identificadores, horas, hash; nunca un artefacto firmado por R4). Checkout verifica el grant, liga la evidencia a la cotización (id, versión, hash semántico, importe) y **emite y guarda** el consentimiento con su `consentId` | Respeta R-3 y R4L-D3; sin pasos extra para el cliente; Checkout es la autoridad del consentimiento y su registro; coincide con H3 §10 («registrado por Checkout con un `consentId`») | Checkout confía en la autenticación de servicio de R4 para el hecho del canal (`assurance = service_attested`): un R4 comprometido podría fabricar un acto. Mitigación: el grant `purchase` sólo existe si el cliente verificó por OTP; límites de importe; un acto por sesión. **Requiere que el owner acepte esta lectura de R-3 (Q1)** |
| **E. El pago es el consentimiento** | No hay artefacto previo; la aceptación es pagar en Mercado Pago el importe exacto | Ningún artefacto nuevo | La sesión, el carrito en la cuenta del cliente y el enlace se crean antes de cualquier aceptación; contradice ADR-0002 §3 de Checkout y el punto 7 del owner. **No recomendada** como único mecanismo |

## 3. Evidencia auditable

| Qué | Dónde | Contenido | Retención (propuesta) | PII |
|---|---|---|---|---|
| Mensaje del cliente | Core de R4 (`task_inputs`, `memory_entries`) | El texto, como hoy | La del Core (DEP-10 abierta) | Lo que el cliente escribió; ya existe hoy |
| Acto de compra | R4, Sales (tabla nueva, F2-R02) | `requestInputId`, `requestAt`, SHA-256 del texto, versión de la gramática, cotización (id, versión, hora de emisión), luego `sessionId` y `consentId` | Igual que la evidencia de aceptación `0009` (append-only, inmutable) | **Ninguna**: sin texto, sin `customerRef`, sin grant |
| Consentimiento | Checkout (`purchase_authorization`, hoy existente) | `subjectRef` (= `grant.sub`), cotización, versión, hash semántico, importe, `actId`, canal, `assurance`, `consentedAt`, emisor | Política de Checkout + legal (OQ-H3-4, DEP-10). Propuesta: la de los registros de venta | Sólo la referencia del cliente |
| Grant | Ninguno guarda el token | Checkout guarda `jti`, `sub`, `exp`; la CIA guarda `grant_issuance` | CIA y Checkout | Referencia del cliente |
| Texto aceptado | Generado por R4 desde datos de Quote (§5) | Plantilla versionada + valores | Su hash queda en el acto | Ninguna |

## 4. Alcance del consentimiento (R4L-D2)

| Aspecto | Propuesta | Por qué |
|---|---|---|
| Unidad | **Un consentimiento por sesión de Checkout**, y **un acto de compra nuevo por cada enlace** (R4 ya exige un pedido explícito después del último intento antes de pedir otro enlace, `checkout.request_payment_link@1`) | No amplía el contrato de Checkout (el sandbox E2E §4.1 advierte que «exigir un consentimiento por intento sería ampliar el contrato»); el acto por enlace queda en R4 |
| Importe | Exactamente el total emitido de la cotización (`totals.gross`); Checkout lo copia de Quote, nunca del cuerpo | Sin recálculo (C-2) |
| Vínculo | `quoteId`, `quoteVersion`, hash semántico (`jcs-sha256-v2`), importe, `sub` del grant | Cualquier cambio exige una cotización nueva y un acto nuevo |
| Vencimiento | `min(vigencia de la cotización, emisión + 15 min)`; el enlace hereda ese tope | Igual que el límite de Checkout (`expiresAt = min(creación + 900 s, vigencia)`) |
| Revocación | Hasta que el pago inicia: un mensaje del cliente que niega o cambia la compra impide pedir otro enlace (ya ocurre: la gramática rechaza negaciones y condiciones). Checkout necesita una ruta de cancelación de sesión para que R4 la invoque; hoy el puerto de R4 no tiene `cancel` | Pendiente en Checkout (F2-K04) |
| Identidad previa | El acto debe ocurrir **después** de un `resolve` `verified` con `purchase` en la misma conversación | H3 §10 |

## 5. Registro determinista del acto en R4

El acto se reconoce igual que la aceptación de cotizaciones de ADR-035 (registros de la plataforma que el modelo no
puede crear), pero con **gramática cerrada**, porque el owner mantuvo el consentimiento explícito para pagos.

Reglas (implementadas en este PR, sin conectar: `agents/sales/src/capabilities/purchase-act.ts`, F2-R01):

1. Sólo cuentan entradas `contact` (ingreso de canal autenticado); el agente y los operadores nunca producen un acto.
2. El **último** mensaje del cliente posterior a la emisión registrada de la cotización debe ajustarse por completo a
   `r4-sales-purchase-es-v1` (la regla que ya aplica `checkout.start_purchase@1`). Una pregunta, negación o condición
   posterior anula un pedido anterior.
3. El mensaje llegó antes del fin de la vigencia de la cotización.
4. Tiene `inputId` de la plataforma.
5. La evidencia guarda identificadores, horas de la plataforma y el SHA-256 del texto. Nunca el texto, el
   `customerRef` ni el grant.

Pasos siguientes (no implementados, requieren autorización):

- **Texto determinista de la oferta de compra** (F2-R10): un aviso de plataforma generado desde Quote (número,
  total, entrega, vigencia), como H3 §10 pide, en vez de una frase del modelo. Entonces el acto exige además que el
  aviso inmediatamente anterior sea ese texto, como `quote.create@4` exige la oferta con su referencia.
- **Persistencia** (F2-R02): tabla Sales append-only con `request_input_id` único, escrita en la misma transacción que
  `recordCheckoutPurchaseRequest`. Una migración Sales cambia el despliegue; necesita su propia autorización.

## 6. Recomendación

1. **Identidad:** grant CIA `purchase` según H3 (relevo R4 → Checkout → Quote, `azp = r4-sales`), con prueba OTP
   reciente de la misma conversación.
2. **Emisor del consentimiento: opción D.** Checkout emite y guarda el consentimiento; R4 sólo captura el acto de
   forma determinista y lo presenta como evidencia atestiguada por su principal de servicio, sin firmar nada.
3. **Alcance:** un consentimiento por sesión, un acto por enlace, importe = total emitido, vencimiento ≤ 15 min y ≤
   vigencia.
4. **Evidencia:** sin PII en las tablas de R4 (sólo hashes e identificadores), consentimiento en Checkout, grant sin
   persistir.
5. Si el owner no acepta que Checkout confíe en la atestiguación de servicio de R4, la alternativa es la opción A
   (página de aceptación de Checkout), con más fricción y más infraestructura.

## 7. Preguntas para el owner

| # | Pregunta | Quién decide |
|---|---|---|
| Q1 | ¿Se acepta que la evidencia del acto la atestigüe R4 como principal de servicio (opción D), sin que R4 firme un consentimiento? ¿Es compatible con R-3? | Owner, con el owner de Checkout |
| Q2 | ¿Un consentimiento por sesión con un acto por enlace (R4L-D2), o un consentimiento por intento? | Owner R4 + owner Checkout |
| Q3 | Frescura de la prueba OTP para `purchase` (propuesta: misma conversación, ≤ 30 min) | Owner CIA + owner comercial |
| Q4 | Texto legal que acepta el cliente y retención del consentimiento | Owner comercial + legal (DEP-10, OQ-H3-4) |
| Q5 | ¿Se agrega a Checkout una cancelación de sesión antes del pago (revocación)? | Owner Checkout |
| Q6 | ¿La gramática cerrada `r4-sales-purchase-es-v1` basta, o se exige el texto determinista de F2-R10 antes del primer E2E? | Owner R4 |

## 8. Qué cambia en cada servicio

| Servicio | Cambio | Item |
|---|---|---|
| CIA | Propósito `purchase`, audiencia por propósito, frescura, modo no sintético | F2-C01, C03, C04, C05 |
| Checkout | Comprador = `grant.sub`; verificador del grant; consentimiento emitido y guardado por Checkout desde la evidencia del acto; cancelación de sesión | F2-K03, K04 |
| Quote | Verificador del grant de producción (exactamente `["purchase"]`, `azp`, `jti`) | F2-Q02 |
| R4 | Acto determinista (hecho, sin conectar), persistencia, transporte del grant, `purchase` en el cliente CIA, texto determinista de compra | F2-R01, R02, R03, R04, R10 |
