---
title: R4 F2 — Registro de decisión O-5: identidad del cliente y consentimiento de compra
status: APROBADO por el owner el 2026-11-18 (opción D). Pagos y rollout real siguen deshabilitados
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 85d9192 (carril WhatsApp `sales-production@22`)
related: R4_CHECKOUT_STATUS_2026-11.md (PR #86), R4_F2_WORK_ITEMS.md, R4_F2_O6_DELIVERY_CART_DECISION.md
---

# O-5 — Identidad y consentimiento para comprar

## 0. Decisión

**Aprobado por el owner, 2026-11-18.** Texto de la aprobación, tal como lo transmitió el mandato (en inglés):

> «Checkout issues the purchase-consent evidence from an explicit act that R4 records and transmits.»

Además: «Payments and the real rollout stay disabled.»

O-5 venía del plan del PR #64 (§8): «Emisor del consentimiento productivo (Checkout, CIA u otro); R4 sólo captura».
La decisión R4L-D3 (2026-11-10) ya había separado identidad y consentimiento: el comprador sale de la identidad y el
consentimiento prueba sólo la aceptación. Esta decisión cierra quién emite: **Checkout**, a partir del acto explícito
que **R4 registra y transmite**. R4 no firma ni emite consentimientos (R-3) y no se crea ninguna autoridad nueva.

Restricciones que siguen vigentes:

- R4 no es autoridad de identidad ni de consentimiento (ADR-039; R-3).
- «Mantener el consentimiento explícito para Checkout y cualquier operación financiera» (owner, 2026-11-10,
  [`R4_SALES_V19_INTENT_ACCEPTANCE.md`](R4_SALES_V19_INTENT_ACCEPTANCE.md) §1, punto 7). La aceptación en lenguaje
  natural rige sólo la emisión de cotizaciones; el acto de compra usa una gramática cerrada.
- Sin datos personales nuevos en R4.

## 1. Identidad: quién es el cliente y cómo se prueba

| Pieza | Regla | Fuente / estado |
|---|---|---|
| Comprador | `customerRef = prestashop_customer:<id_customer>` = `sub` del grant. Cuenta existente, registrada, activa, no invitada | CIA v1-d2; H3 §1 (candidato `39342b2`, sin publicar: F2-C01) |
| Vínculo canal → cuenta | La CIA vincula (`whatsapp`, cuenta de canal, `wa_id`) con la cuenta tras un OTP al correo de la cuenta y la revalida contra el proveedor de cuentas en cada `resolve` | CIA-S2/S3, sólo sintético; proveedor real inexistente (DEP-3, F2-E01) |
| Prueba para comprar | Grant CIA `cv=1`: `aud = quote-cart-preparer`, `azp = r4-sales`, `purposes = ["purchase"]` exactamente, TTL ≤ 300 s, `jti` | H3 §4.1. La CIA aún no tiene `purchase` ni audiencia por propósito (F2-C03) |
| Transporte | R4 pide el grant (handler determinista, contexto desde el binding de canal) y lo envía a Checkout en `x-customer-access-grant`; Checkout lo releva a Quote | H3 §6, §11; Checkout `/v1 1.0.4-proposed`. **Plumbing en R4 hecho** (F2-R03), sin proveedor del grant |
| Lo que R4 nunca hace | Decodificar el grant; mostrarlo, o mostrar `customerRef`, al modelo; persistirlo, registrarlo en logs, telemetría o recibos | H3 §11; prueba `checkout-http` (F2-R03) y tripwire `f2-purchase-boundaries` |

## 2. Emisor del consentimiento (decidido)

| Opción | Estado | Motivo |
|---|---|---|
| **D. R4 registra y transmite el acto; Checkout emite la evidencia de consentimiento** | **APROBADA** | Texto del owner (§0). Respeta R-3 y R4L-D3; sin pasos extra para el cliente; Checkout es la autoridad y el registro del consentimiento |
| A. Página de aceptación de Checkout | Rechazada | No elegida; más fricción e infraestructura web |
| B. La CIA emite | Rechazada | H3 §4.3: el grant no puede llevar cotización, importe ni sesión; mezclaría identidad y consentimiento |
| C. R4 firma | Rechazada | Viola R-3 y el mandato R4-L («No crear nuevas autoridades») |
| E. El pago es el consentimiento | Rechazada | La sesión y el carrito se crearían antes de la aceptación; contradice ADR-0002 §3 de Checkout y el punto 7 del owner |

Riesgo aceptado con la opción D: Checkout confía en la autenticación de servicio de R4 para el hecho del canal (un R4
comprometido podría fabricar un acto). Mitigaciones exigidas: el grant `purchase` sólo existe tras un OTP verificado;
un acto por mensaje del cliente (índice único en `0012`); un consentimiento por sesión; importe fijo de la cotización.

## 3. Evidencia auditable

| Qué | Dónde | Contenido | Retención | PII |
|---|---|---|---|---|
| Mensaje del cliente | Core de R4 (`task_inputs`, `memory_entries`) | El texto, como hoy | La del Core (DEP-10, FU-4) | Lo que el cliente escribió; ya existía |
| Acto de compra | R4, Sales `0012 sales.purchase_act_evidence` (**hecho**, detrás de un flag apagado) | `request_input_id` (único), `request_at`, SHA-256 del texto, versión de la gramática, cotización (id, versión, hora de emisión) | Append-only e inmutable, como la evidencia de aceptación `0009` | **Ninguna** |
| Evidencia de consentimiento | Checkout (`purchase_authorization` hoy; se extiende en F2-K04) | `subjectRef` (= `grant.sub`), cotización, versión, hash semántico, importe, identificador del acto, canal, `assurance`, `consentedAt` | Checkout + legal (FU-4) | Sólo la referencia del cliente |
| Grant | Nadie guarda el token | Checkout guarda `jti`, `sub`, `exp`; la CIA, `grant_issuance` | CIA y Checkout | Referencia del cliente |

## 4. Alcance del consentimiento

| Aspecto | Regla (vigente salvo que FU-2 la cambie) |
|---|---|
| Unidad | Un consentimiento por sesión de Checkout; un acto nuevo por cada enlace (R4 ya exige un pedido explícito posterior al último intento antes de pedir otro enlace) |
| Importe | Exactamente `totals.gross` de la cotización; Checkout lo copia de Quote |
| Vínculo | `quoteId`, `quoteVersion`, hash semántico, importe, `sub` del grant. Cualquier cambio exige una cotización nueva y un acto nuevo |
| Vencimiento | `min(vigencia de la cotización, emisión + 15 min)` |
| Revocación | Antes de iniciar el pago: un mensaje que niega o condiciona impide pedir otro enlace (ya ocurre); la cancelación de sesión en Checkout es FU-5 |
| Orden | El acto debe ocurrir después de un `resolve` `verified` con `purchase` en la misma conversación |

## 5. Registro determinista del acto en R4

Igual procedencia que la aceptación de cotizaciones de ADR-035 (registros de la plataforma que el modelo no puede
crear), con gramática cerrada `r4-sales-purchase-es-v1`.

| Regla | Implementación |
|---|---|
| Sólo entradas `contact` (ingreso de canal autenticado) | `agents/sales/src/capabilities/purchase-act.ts` |
| El **último** mensaje del cliente posterior a la emisión registrada se ajusta por completo a la gramática | ídem |
| Llegó antes del fin de la vigencia de la cotización; tiene `inputId` de la plataforma | ídem |
| Evidencia: ids, horas de la plataforma, SHA-256; nunca el texto, `customerRef` ni el grant | ídem; Sales `0012` |
| Un mensaje es el acto de un solo inicio de compra | `request_input_id` único; `checkout.start_purchase@1` rechaza `purchase_act_already_used` sin enviar nada |
| Se registra **sólo** con `purchaseActRecording === true` | `CheckoutCapabilityDeps.purchaseActRecording`; ningún perfil, composición ni app lo fija (tripwire) |

Pendiente: la **transmisión** del acto a Checkout (F2-R11) espera el formato que Checkout defina (FU-1, F2-K04). El
texto determinista de la oferta de compra generado desde Quote (F2-R10) depende de FU-6.

## 6. Seguimientos (antes «preguntas abiertas»)

| Id | Seguimiento | Dueño | ¿Bloquea? |
|---|---|---|---|
| FU-1 | Contrato de transmisión del acto a Checkout: forma de la evidencia (sin texto ni PII), autenticación del principal `r4-sales`, `assurance = service_attested`, respuesta con `consentId` | Owner Checkout + owner R4 | **Sí**: F2-K04 y F2-R11 |
| FU-2 | Confirmar un consentimiento por sesión con un acto por enlace (R4L-D2), o pedir uno por intento | Owner R4 + owner Checkout | Sí para F2-K04; no para F2-R02 (hecho) |
| FU-3 | Frescura de la prueba OTP para `purchase` (propuesta: misma conversación, ≤ 30 min; OQ-H3-3) | Owner CIA + owner comercial | Sí para F2-C03 en producción; no para el sandbox |
| FU-4 | Texto legal que acepta el cliente y retención del consentimiento y del mensaje (DEP-10, OQ-H3-4) | Owner comercial + legal | Sí para producción (G7); no para el sandbox |
| FU-5 | Cancelación de sesión en Checkout antes del pago (revocación) y su ruta en el puerto de R4 | Owner Checkout | Sí para producción; no para el sandbox |
| FU-6 | ¿Basta la gramática cerrada, o el primer E2E exige el texto determinista de compra (F2-R10)? | Owner R4 | Sí para F2-R09 (E2E sandbox) |

## 7. Qué cambia en cada servicio

| Servicio | Cambio | Item |
|---|---|---|
| CIA | Propósito `purchase`, audiencia por propósito, frescura, modo no sintético | F2-C01, C03, C04, C05 |
| Checkout | Comprador = `grant.sub`; verificador del grant; **emisión de la evidencia de consentimiento desde el acto transmitido por R4**; cancelación de sesión | F2-K03, K04 |
| Quote | Verificador del grant de producción (exactamente `["purchase"]`, `azp`, `jti`) | F2-Q02 |
| R4 | Acto determinista (hecho), persistencia detrás de flag (hecho), cabecera del grant (hecho, sin proveedor), transmisión del acto, `purchase` en el cliente CIA, texto determinista | F2-R01, R02, R03 (hechos); R11, R04, R10 |
