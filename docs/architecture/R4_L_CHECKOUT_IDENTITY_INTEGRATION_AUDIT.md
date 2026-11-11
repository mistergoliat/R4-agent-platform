---
title: R4-L — Auditoría de integración de identidad, consentimiento, carrito y Checkout (carril WhatsApp)
status: R4_CHECKOUT_IDENTITY_INTEGRATION_READY_FOR_REVIEW — auditoría documental; nada activado (sin Checkout productivo, perfiles, despliegues, compras ni pagos)
mandate: «R4 — PDF DELIVERY, UX AND CHECKOUT NEXT INCREMENT», sección D (owner, 2026-11-10)
date: 2026-11-10
base: main a704319
plan: R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md
---

# R4-L — Auditoría de integración Checkout e identidad

## 0. Mandato y método

Texto del mandato: «Se autoriza comenzar R4-L como trabajo de integración. Auditar: Identidad CIA. Referencia del
comprador PrestaShop. Consentimiento `purchase`. Preparación del carrito por Quote. Contrato Checkout. Modalidad
autorizada de entrega. Riesgo C1 de AD-5. No crear nuevas autoridades de identidad ni consentimiento. No activar
Checkout productivo.»

**Método.** Lectura del código y de los documentos de este repositorio en `main` `a704319`. Los servicios hermanos
(CIA, Quote V2, Checkout, PrestaShop) se describen **sólo** como los describen los documentos de R4; sus repositorios
no se leyeron. Las citas son textuales. Lo que este repositorio no define se marca «not defined in this repository»
(detalle en el [plan](R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md) §8–§10). No se cambió código, no hubo llamadas a
servicios ni a modelos y no se corrieron suites.

| # | Ítem | Autoridad (fuente) | Estado en R4 | Bloqueo principal |
|---|---|---|---|---|
| 1 | Identidad CIA | CIA (§1) | Sólo sintético, sólo en `@8` | Sin modo productivo ni propósito `purchase` |
| 2 | Referencia del comprador | CIA certifica; Quote toma el `id_customer` del grant | R4 nunca maneja ids | Checkout toma el comprador del consentimiento, no del grant |
| 3 | Consentimiento `purchase` | No es R4; emisor productivo sin decidir (O-5) | Fuente sólo sandbox | Fuentes en desacuerdo; sin emisor productivo |
| 4 | Carrito por Quote | Quote V2 (C-2) | R4 sin código de carrito | A7/H3 no aceptados; totales LIVE; transportista |
| 5 | Contrato Checkout | Checkout | Cliente sandbox (`@15`) | Sin modo productivo; `/v1` propuesto; sin remoto |
| 6 | Modalidad de entrega | Sin decidir (O-6) | F1: sin despacho | Retiro (readiness) frente a política F1 |
| 7 | Riesgo C1 de AD-5 | Owner + owner Checkout | Mitigación de 60 s | Abierto; «Sí debe resolverse antes de producción» |

## 1. Regla de autoridad

R4 no es autoridad de identidad ni de consentimiento. Fuentes:

| Fuente | Texto original |
|---|---|
| [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) | «R4 **no** es autoridad de identidad de cliente, no lee tablas de CRM y no usa los niveles L2/L3 de CRM mientras sus comprobaciones sean insuficientes.» |
| [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) §2.1 | Alternativa «D. R4»: «Una plataforma de agentes no es autoridad de clientes (ADR-039; AGENTS.md "Customer fuera de Core")», veredicto «**Descartada**» |
| Ídem §3 | «**Vínculos canal → cuenta PrestaShop, verificación, revocación, resolución, grants (D2)**»: «**CIA** (owner por designar)»; no hace: «Crear, modificar o fusionar clientes; leer hechos comerciales» |
| [Registro compartido](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §9 | D1: «**Designado.** La CIA es un servicio independiente (`MS-pesaschile-customer-identity-authority`)» (CIA-D1-01) |
| [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §3.4 | «La CIA es la autoridad de identidad designada (ID-AUTHORITY-DECISION-01 §2.2; owner designado en CIA-D1-01). **No se debe crear otra.**» |
| [Integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §7.2 | «R4 no lo firma: sería convertirse en autoridad de consentimiento.» |
| [Registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §1, C-2 | «**Quote V2 crea idempotentemente el carrito técnico PrestaShop.** Checkout no crea carritos ni recalcula cotizaciones» |
| [Diseño R7](R4_J4_R7_DESIGN.md) §3.1 | «Precios, productos, servicios, despacho, vigencia»: «**Quote**»; «Responsabilidades de Checkout»: «**Checkout** (ADR-0002 del servicio)» |

Estado de ID-AUTHORITY-DECISION-01: «**PROPUESTA.**» (su tabla inicial). El registro compartido §9 dice que, donde
ese documento difiere, «prevalecen estos registros».

## 2. Identidad CIA

**(a) Qué existe.**

| Pieza | Ruta | Estado |
|---|---|---|
| Puerto neutral de resolución | `adapters/domains/src/customer/profile-port.ts:61` (`CustomerIdentityResolver`) | Propósitos cerrados: `CUSTOMER_PURPOSES = ['sales_context', 'purchase_history']` (`:27`). No existe `purchase` |
| Cliente HTTP CIA | `adapters/domains/identity/http/src/{client,start,confirm,config}.ts` | `start` pide «`purposes: ['sales_context', 'purchase_history']`» (`start.ts:77`); `client.ts` exige que el grant cubra exactamente los propósitos pedidos |
| Protección OTP en el ingreso | `adapters/domains/identity/verification/src/*` (clasificador, inspector, almacén sellado, despachador) | ADR-040 |
| Capacidades | `agents/sales/src/capabilities/identity-verification.ts` (`identity.start_verification@1`, `identity.verification_status@1`) | Sintético |
| Composición | `agents/sales/src/capabilities/customer-synthetic.ts` | Rechaza el modo real: «`R4_CUSTOMER_MODE=real` refused» |
| Perfiles | Sólo `agents/sales/src/production/profile-v8.ts` compone la verificación | `@15` y `@17` no componen identidad |
| Migraciones Core | `0011_binding_identity_immutability.sql`, `0013_conversation_binding_history.sql` | Aplicadas en la cadena de migraciones |
| Pruebas | Contract `identity-http-contract`, `identity-verification-boundaries`; unit `tests/unit/customer-identity`, `tests/unit/identity-verification`; integration `identity-verification-{commercial,dispatch,ingress,state}`, `binding-identity-immutability`, `customer-rr1-revalidation` | — |
| Mutaciones | `test:mutation:identity-verification`, `-state`, `-ingress`, `-dispatch`, `-commercial`, `rr1`, `binding-immutability` | — |

CIA según [readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §3.4: «`config.ts` rechaza cualquier modo que no sea
sintético.»; «**El grant de compra no existe:** el carrito exige propósito `purchase` y audiencia
`quote-cart-preparer` (H3). Soportar una segunda audiencia requiere un cambio de código en la CIA.»

**(b) Autoridad.** CIA (§1). R4 transporta el grant sin decodificarlo: «Opaque per-customer authorization issued by the
identity authority. R4 never decodes it.» (`profile-port.ts`, `CustomerAccessGrant`).

**(c) Brechas para una compra sandbox desde WhatsApp.**

1. La CIA sólo opera en modo sintético; DEP-2, DEP-3, DEP-5, DEP-6 y DEP-10 abiertos (readiness §3.4).
2. Propósito `purchase` y audiencia `quote-cart-preparer` inexistentes (H3 candidato; C-CIA-1..8 «listados y no
   implementados», plan F0 §2).
3. R4 no resuelve identidad dentro de `checkout.start_purchase` y su cliente Checkout no envía grant (no hay cabecera de
   grant en `adapters/domains/checkout/http/src/client.ts`).
4. Ningún perfil de carril compone identidad y Checkout a la vez (`@8` sólo identidad; `@15` sólo Checkout).
5. `checkout.start_purchase@1` declara `identityRequirement: 'provisional'` (`agents/sales/src/capabilities/checkout.ts:169`),
   permitido sólo por la política sandbox D7-6. La plataforma exige otra cosa por defecto: «FINANCIAL exige aprobación y
   identidad `verified` (ADR-017; `policy-engine/src/configuration.ts:61-71`)» ([decisión D-7](R4_J5_D7_COMMERCIAL_AUTONOMY_DECISION.md) §5).
6. Correos OTP reales: OA-04 «E1 permitido **solo sintético**. Los correos reales requieren la decisión D7».

**(d) Riesgos.** ADR-039: «**R4 comprometido** (worker o host con sus credenciales)»: «Puede pedir resoluciones para
`wa_id` arbitrarios y leer cualquier cliente verificado cuyo número conozca.» RR-1 (cierre concurrente del binding),
BA-01..06 y OA-10 siguen abiertos ([plan](R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md) §9).

**(e) Evaluación.** Gate G3 (readiness §7): «el comprador interno vincula su `wa_id` con su cuenta PrestaShop por OTP
real.» L1 `identity-http-contract` contra el contrato `purchase` cuando la CIA lo publique; L2 de las suites y
mutaciones listadas; interop R4→CIA; prueba de que el `customerRef` y el grant no llegan al modelo.

## 3. Referencia del comprador PrestaShop

**(a) Cómo fluye hoy, por pieza.**

| Pieza | Fuente | Texto original |
|---|---|---|
| CIA | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §3.4 | «Tras un OTP por correo produce `customerRef = prestashop_customer:<id_customer>`, el mismo valor que el `sub` del grant. El vínculo es por (`whatsapp`, `channelAccountRef`, `wa_id`).» |
| CIA | [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) §4.4 | «`prestashop_customer:<id>` solo si `verified`.» |
| R4, formato | `adapters/domains/src/customer/profile-port.ts` | «`prestashop_customer:<id>`; any other namespace or a bare integer is foreign.» (`CUSTOMER_REF_PATTERN`) |
| R4, cotización | `agents/sales/src/capabilities/commercial-snapshot.ts:76` | «Customer identity is UNAVAILABLE in R4: an autonomous quote is a guest quote and carries no personal data.» |
| R4, cotización | Readiness §3.1 | «`quote.create` siempre envía un cliente `guest` (`commercial-snapshot.ts:218`). R4 nunca expone `customerRef` al modelo, y así debe seguir.» (la línea citada es de `52a58f4`; hoy el valor está en `:265` y `:280`) |
| R4 → Checkout | `adapters/domains/src/checkout/port.ts`, `CheckoutCreateSessionRequest` | Sólo `quoteId`, `quoteVersion` y `consent`: R4 no envía comprador |
| Checkout hoy | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §2 | «Comprador»: «El `sub` del consentimiento, nunca un campo del cuerpo (I-18)»; «R4 no envía identidad de comprador» |
| Checkout hoy | Ídem §4.1 | «`sub` debe estar en la lista configurada de compradores de prueba; el comprador de la sesión es el `sub`, nunca el cuerpo» |
| Checkout `/v1` | [Plan F0](R4_J5_F0_PLAN.md) §2 | «Encabezado opcional `x-customer-access-grant` (depende de H3).» |
| H3 | Ídem §2 | Binding de Checkout: «vincula cotización, versión, hash, tienda, sesión, consentimiento, comprador, direcciones y monto.» |
| Quote | Readiness §3.6 | «Un `POST carts` con el `id_customer` tomado del grant CIA (nunca del cuerpo, de R4 ni del modelo) y sus direcciones.» «Exige un cliente **registrado, activo, no invitado, con direcciones chilenas suyas**. Si no, responde `BUYER_NOT_ELIGIBLE`.» |
| Quote, A7 | Ídem §3.6 | «`POST /v2/quotes/{id}/cart-preparations` con `Idempotency-Key` y `X-Purchase-Authorization` (grant CIA + binding JWS de Checkout).» |
| Matriz | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §4 | «Carrito ligado a la identidad»: Quote «IMPL: cliente y direcciones salen de claims firmados»; Checkout «Firmante del binding sólo de prueba» |

**(b) Autoridad.** La CIA certifica el vínculo canal → `prestashop_customer:<id>`; los datos maestros del cliente no
son de la CIA (ID-AUTHORITY §3: «**`pc-users`, como único escritor**. **Requiere decisión formal** del owner (hoy no hay autoridad, F3)»).
Quote toma el `id_customer` del grant. R4 no es fuente del comprador.

**(c) Brechas.**

1. Checkout toma el comprador del **consentimiento**; Quote, del **grant**. E2E integrado §4: «**El contrato y el
   código actuales de Checkout los mezclan**».
2. `azp`: «H3 dice `r4-sales`; Quote y el emisor de prueba usan `checkout`.» (E2E integrado §4; X-1 en plan F0 §2.1).
3. Direcciones: «Direcciones FALTAN (H2); sólo el comprador de prueba configurado» (E2E integrado §4); E-7 sin respuesta.
4. Cambios de Quote para el grant productivo (E2E integrado §4): «`azp=r4-sales` (hoy el valor por defecto es
   `checkout`)», «exigir exactamente `["purchase"]` (hoy basta con contenerlo)», «claims `bv` y `amount`», «consumir el
   `jti` en la misma transacción y al final», «no exponer `details.code`».
5. El proveedor de cuentas de la tienda no existe («productor real FALTA (DEP-3)»).

**(d) Riesgos.** Un carrito o una sesión con un comprador distinto del verificado si el sujeto del consentimiento y el
`sub` del grant divergen; compradores invitados o nuevos (`BUYER_NOT_ELIGIBLE`; D-03 fuera del primer escenario);
fuga del `customerRef` al modelo.

**(e) Evaluación.** Prueba de frontera: R4 no envía comprador ni `customerRef` (contrato del puerto); prueba de que el
`customerRef` no aparece en la salida visible al modelo (readiness §9.4); en Quote, `BUYER_NOT_ELIGIBLE` para un
invitado (G4); prueba cruzada de que el comprador de la sesión, el `sub` del grant y el `id_customer` del carrito
coinciden (requiere R4L-D3, §9).

## 4. Consentimiento `purchase`

**(a) Qué existe.**

| Pieza | Ruta | Estado |
|---|---|---|
| Gramática cerrada del pedido de pago | `agents/sales/src/capabilities/checkout.ts:91-116` (`r4-sales-purchase-es-v1`, `isExplicitPurchaseRequest`) | «Whether one customer message is an explicit, unconditional request to pay» |
| Puerto | `adapters/domains/src/checkout/port.ts` (`CheckoutConsentSource`, `CheckoutConsentEvidence`) | «An opaque purchase-consent artifact issued by an approved consent authority (never built from a boolean).» |
| Fuente sandbox | `adapters/domains/checkout/http/src/sandbox-consent.ts` (`SandboxConsentDirectory`) | «R4 never signs, mints or changes consent» |
| Cuerpo congelado | `agents/sales/migrations/0010_sales_checkout_requests.sql` | El artefacto se congela con el cuerpo de `createSession` |
| Pruebas | `tests/unit/checkout/checkout-http.test.ts`; `tests/integration/sales-checkout.test.ts`; mutación CK-M14 en `test:mutation:checkout` | Sandbox E2E §4.3 |

Artefacto de prueba de Checkout ([sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §4.1): «Audiencia»: «**No hay
claim `aud`**»; «Revocación»: «**No existe**»; vínculo: «**No hay vínculo 1:1 consentimiento ↔ intento**».
El propósito CIA `purchase` no existe (§2).

**(b) Autoridad.** No es R4 (§1). El emisor productivo está **sin decidir** (O-5) y las fuentes no concuerdan: el
código de R4 y el sandbox E2E dicen que el artefacto productivo es el grant CIA `purchase`; H3 separa grant
(«*quién*») y consentimiento («*la aceptación*»); readiness F6 lo captura con la compuerta J3 de R4. Citas en el
[plan](R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md) §8.5.

**(c) Brechas.** Emisor y verificador reales («verificador de consentimiento real», E2E integrado §4); captura
determinista del acto «desde un evento firmado del canal» (ídem) en lugar de `SandboxConsentDirectory`; audiencia,
revocación y alcance por intento o por sesión (R4L-D2).

**(d) Riesgos.** Que R4 termine firmando o fabricando consentimiento (prohibido por el mandato y por R-3); que un
consentimiento sin audiencia se presente en otro servicio; que un consentimiento de sesión cubra intentos posteriores
no previstos.

**(e) Evaluación.** Negativos de G6 (readiness §7): «el modelo intenta escribir una URL, o inicia la compra sin
confirmación o sin identidad verificada, y la compra se rechaza»; suite `checkout` y CK-M14; unitarias de la
gramática y de la captura.

## 5. Preparación del carrito por Quote

**(a) Qué existe.** En R4 no hay código de carrito: «`checkout.start_purchase@1` llama a `prepare`; R4 nunca crea
carritos» ([integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §1). En Quote, según §5 del mismo informe:
«Implementado en Quote `main`, apagado: `QUOTE_CART_PREPARATION_ENABLED=false`, `QUOTE_CART_H3_MODE=closed`, y `verify`
rechazado en producción». A7: «CANDIDATO `a7-candidate-2.1/cart-02b-r1`» ([plan F0](R4_J5_F0_PLAN.md) §2). Migración
`000010`: los [gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) no concuerdan entre §1.1 y §2 (plan §2.3).

**(b) Autoridad.** Quote V2 (C-2, §1).

**(c) Brechas.** A7, H3 y `/v1` aceptados (G0); «`ps-cart-totals/v1` LIVE no existe» (integración Checkout §5);
E-5 (transportista de retiro, O-10), E-6 (llaves), E-7 (direcciones), E-9 (clon); X-1..X-7; topología: «Catalog V2
entrega como `productId` el `id_product` de la PrestaShop **productiva**» y la tienda aislada «tiene su propia
numeración» (E2E integrado §5).

**(d) Riesgos.** Carrito sobre otro producto en la tienda aislada (E2E integrado §5: «caería en otro producto, o en
ninguno»); carrito sin transportista; activar `QUOTE_CART_PREPARATION_ENABLED` en producción fuera de mandato.

**(e) Evaluación.** G4 (readiness §7); CART-02B con totales reales, «7 simulacros de resultado incierto», mutaciones
M1–M6 (definición: not defined in this repository); en R4, prueba de frontera de que no se crean carritos.

## 6. Contrato Checkout

**(a) Qué existe en R4.**

| Pieza | Ruta |
|---|---|
| Puerto (seis rutas, claves §5.1, mapeo §6, errores §7, control del enlace §8) | `adapters/domains/src/checkout/port.ts` |
| Cliente HTTP y configuración | `adapters/domains/checkout/http/src/{client,config}.ts`. `config.ts`: «There is no production mode»; acepta sólo `R4_CHECKOUT_MODE=sandbox` |
| Capacidades | `agents/sales/src/capabilities/checkout.ts`: `checkout.start_purchase@1` y `checkout.request_payment_link@1` (FINANCIAL), `checkout.purchase_status@1` (READ) |
| Perfil y definición | `agents/sales/src/production/profile-v15.ts`, `agents/sales/candidates/sales.v15.candidate.json`; política `sales-production-checkout-sandbox-policy` |
| Migraciones | Sales `0010_sales_checkout_requests.sql`; Core `0014_platform_notice_outbound.sql` |
| Pruebas | `tests/unit/checkout/{checkout-http,checkout-port}.test.ts`; `tests/integration/{sales-checkout,platform-notice}.test.ts`; `tests/contract/sales-profile-v15.test.ts` |
| Mutaciones | `test:mutation:checkout` (15/15 tras F-E3A-1, E2E integrado §8) |

Referencia del contrato en el código (`profile-v15.ts`): «checkout: docs/reviews/R4_CHECKOUT_INTEGRATION_CONTRACT.md
(owner commit d11e3c7, OpenAPI /v1 1.0.3-proposed, sandbox-purchase API listener only)». El plan F0 §2 registra una
revisión posterior: «`1.0.4-proposed`, `approved: false`». El texto del contrato no está en este repositorio.

**(b) Autoridad.** Checkout para sesión, enlace, conciliación y orden (§1). R4 sólo lee: «**`checkout.purchase_status@1`**
(READ). Es la única base para decir «pagado», y sólo con `paymentAccredited=true`.» (integración Checkout §9).

**(c) Brechas.** Sin modo productivo en R4 ni en Checkout («`live` prohibido en `sandbox-purchase`», integración
Checkout §6.1); repositorio de Checkout sin remoto (D-11); `/v1` sin aceptar; C-2 y C-3 del contrato Checkout
abiertos; `@15` desciende de `@14`, superado por `@16`/`@17` (D-10); D7-6 sólo sandbox.

**(d) Riesgos.** Pérdida del historial de Checkout (readiness §10: «La cadena `pay-*` (78 commits) existe sólo en una
copia local (D-11)»); reactivar defectos corregidos en `@16`/`@17` si se reutiliza `@15`; el modelo escribiendo URL o
montos (mitigado: «El modelo ve sólo `linkNotice`», integración Checkout §9).

**(e) Evaluación.** L2 completo por ser transversal; F-1..F-7 en L3 antes de producción ([estrategia 02](R4_TEST_STRATEGY_02.md)
§6.1); E2E «R4-CK-01..12» contra el runtime real (su enumeración: not defined in this repository).

## 7. Modalidad autorizada de entrega

**(a) Fuentes, textuales.**

| Fuente | Texto original |
|---|---|
| [Política F1](R4_F1_COMMERCIAL_POLICY.md) §1, regla 7 | «Cotizaciones **sin despacho**», control «`shipping_not_in_f1`» (código: `agents/sales/src/capabilities/commercial-snapshot.ts:226`) |
| Ídem, regla 9 | «Sin carrito ni Checkout» |
| Ídem §2 | «Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible.» |
| [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §9.1 | «Entrega»: «**Retiro en tienda**, costo 0 (`pickup-zero-v1`, S3). Sin despacho, sin promoción de $1 y sin mapa de transportistas» |
| Ídem §4, D-02 | «Alcance de entrega del primer escenario: retiro (S3) y designación del transportista de retiro (O-10)» |
| Ídem §3.3 | «Quote responde `NOT_READY SHIPPING_NOT_REPRESENTABLE` (H1) a toda cotización con despacho. Sólo existe el alcance S3: retiro con costo 0, `pickup-zero-v1`, con el transportista de retiro aún sin designar (O-10).» |
| Ídem §9.2, paso 5 | «Quote crea el carrito con el `id_customer` del grant, la dirección del cliente, el transportista de retiro y un `specific_price` por línea» |
| [Plan F0](R4_J5_F0_PLAN.md) §3, E-5 | «Transportista de retiro con costo 0 y su referencia (O-10)» |
| Cláusula DS-1 (candidatos v12, v14, v15, v16 en `agents/sales/candidates/`) | «Present store pickup as available only when an observation of a capability available to you confirms it for this customer» |
| O-10 | not defined in this repository (plan §8.6) |

**Conflicto, sin resolver.** La política F1 excluye despacho, carrito y Checkout, y prohíbe presentar una cotización
sin despacho como retiro disponible. El primer escenario de compra y el carrito de Quote prevén retiro en tienda con un
transportista que no está designado. Ningún documento de este repositorio dice qué modalidad rige el incremento de
compra. Decisión O-6.

**(b) Autoridad.** Despacho en la cotización: Quote (diseño R7 §3.1). Transportista: owner e-commerce (D-02, E-5).
Política F1: owner (frontmatter: «Definida por el owner»).

**(c) Brechas.** Decisión O-6; transportista designado; ninguna capacidad real confirma retiro (DS-1 §4: «Hoy ninguna
capacidad real confirma el retiro»).

**(d) Riesgos.** Prometer retiro sin evidencia (DS-1); un carrito sin transportista válido.

**(e) Evaluación.** Al decidir O-6: escenarios de presentación (C1–C6 del [informe DS-1](R4_J5_F1_DS1_PICKUP_CORRECTION_REPORT.md)
§3), evaluación de la definición con el modelo real y prueba del carrito con el transportista designado en el clon.

## 8. Riesgo C1 de AD-5

**Texto original** ([E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1, «Observaciones (deciden el
owner y el owner de Checkout)»):

> - **C1 (media).** La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo.
>   - Con `waiting_retry` (cobro fallido y reintento) o pagos offline (`waiting_payment`/`waiting_transfer`), la transacción acreditada puede iniciarse mucho después del vencimiento y aun así crear la orden. Sonda: en proceso en el minuto 10, capturado 3 días después → orden.
>   - Cumple la letra de AD-5 («iniciado antes»), pero el owner debe decidir si un reintento o un pago offline cuentan como «iniciado».
>   - Mitigación posible: ligar la evidencia al pago acreditado (`date_created` de `/v1/payments`, o id e intento), o poner un tope de demora.
>   - **No bloquea el E3-A** con tarjeta de prueba. **Sí debe resolverse antes de producción.**

| Aspecto | Fuente | Texto original |
|---|---|---|
| Estado de la revisión | E2E integrado §0 | «**`CHECKOUT_AD5_REVIEW_PASS`**, con tres observaciones para el owner (§1)» |
| Estado de C1 | E2E integrado §6 | «**AD-5:** decisión sobre C1 antes de producción, y merge en Checkout, que no tiene remoto.» |
| Opciones documentadas | E2E integrado §1 | «ligar la evidencia al pago acreditado (`date_created` de `/v1/payments`, o id e intento), o poner un tope de demora.» |
| Lado R4 | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §6 | «R4 no puede detectarlo; informa lo que Checkout informa.» |
| Mitigación R4 | [Integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §6.2 | «no ofrece un link a menos de 60 s de su `expiresAt`»; «`lateCapture` o una anomalía llevan a `HUMAN_INTERVENTION_REQUIRED`» |
| Relacionados | E2E integrado §1 y §6 | C2, C3 (plan §9) y «OD-06 (vencimiento del lado del proveedor)» |

**(b) Autoridad.** Decisión: owner y owner de Checkout. Código: Checkout.
**(c) Brechas.** Decisión O-7; implementación y revisión independiente en Checkout; merge con remoto (D-11).
**(d) Riesgo.** Una orden creada con un pago iniciado tras el vencimiento autorizado.
**(e) Evaluación.** En Checkout: regresión con la sonda de C1 y LATE-A/B/C; F-4, F-5 y F-7 del gate financiero.

## 9. Decisiones del owner pendientes

Definiciones completas en el [plan](R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md) §8 (O-1..O-8) y §9 (los demás).

| Id | Definición original (una línea) | Fuente |
|---|---|---|
| O-1 | «Nombre del incremento (evitar la colisión con F2 de J5)» | Plan `7b696f6` §8 |
| O-2 | «Autorizar R4-L (o la parte sandbox de Checkout) para este incremento». Respuesta del mandato: «Se autoriza comenzar R4-L como trabajo de integración.» | Ídem; mandato §D |
| O-3 | «Confirmar que «C1» es la observación C1 de AD-5 (§1)». El mandato nombra «Riesgo C1 de AD-5» | Ídem; mandato §D |
| O-4 | «Topología de E3-B: (a), (b) o (c)» | Ídem; opciones en E2E integrado §5 |
| O-5 | «Emisor del consentimiento productivo (Checkout, CIA u otro); R4 sólo captura» | Ídem |
| O-6 | «Entrega del primer escenario: retiro (contradice la política F1) u otra» | Ídem |
| O-7 | «C1: ¿un reintento o un pago offline cuentan como «iniciado»?» | Ídem |
| O-8 | «D-10 (número de perfil y definición) y D7-6/D-06 para uso no sandbox» | Ídem |
| R4L-D1 | Tope de operaciones financieras por task en sandbox. Fuente: «Si se quiere permitir un relink, el máximo debe ser 3. No se cambió sin decisión.» | Sandbox E2E §3 |
| R4L-D2 | Consentimiento por sesión o por intento. Fuente: «Exigir un consentimiento por intento sería ampliar el contrato: **no se hizo** (requiere revisión independiente).» | Sandbox E2E §4.1 |
| R4L-D3 | Fuente del comprador en Checkout para producción. Fuente: «Para producción hay que separarlos: comprador = `sub` del grant; el consentimiento prueba sólo el acto.» | E2E integrado §4 (owner Checkout + CIA) |
| R4L-D4 | Registrar en el roadmap el estado de R4-L. Fuente: fila «R4-L», «Extended Platform», «No iniciado», frente al mandato del 2026-11-10 | Roadmap §1 |

Siguen además abiertas, con su texto en el plan §9: aceptación de A7, H3 y `/v1` (G0); X-1..X-7; D-02, D-06, D-07,
D-08, D-09, D-10, D-11 y D-13; OA-04 y D7 (correos y datos reales); RR-1, BA-01..06 y OA-10.

## 10. Qué no se activa

Este documento no activa ni registra perfiles, no despliega, no cambia la EC2, Quote, Checkout, CIA, Catalog ni
PrestaShop, no habilita el carrito, no agrega un modo productivo a `R4_CHECKOUT_MODE`, no emite consentimientos, no crea
autoridades de identidad ni de consentimiento y no inicia compras ni pagos. `@17`, su allowlist y `@13` no cambian.
**Nada se activa.**

```text
R4_CHECKOUT_IDENTITY_INTEGRATION_READY_FOR_REVIEW
```
