---
title: R4 F2 — Registro de decisión O-6: entrega y carrito (despacho en el carrito de Quote)
status: PROPUESTA — pendiente de decisión del owner comercial (O-6) y del owner e-commerce. Nada se activa
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 704c15d (carril WhatsApp `sales-production@22`); Quote `origin/main` a79d33f; Checkout `3d7b23d` (local)
related: R4_CHECKOUT_STATUS_2026-11.md (PR #86) §1 fila 8, R4_F2_WORK_ITEMS.md, R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md
---

# O-6 — Entrega y carrito

## 0. Pregunta

Desde `@19` (política F1 v2, decisión del owner del 2026-11-10) las cotizaciones de WhatsApp **llevan despacho** al
precio del owner de Shipping (pc-carrier), incluida la promoción Despacho Directo de $1. El carrito de Quote sólo
representa **retiro a costo 0**. ¿Cómo entra al carrito una cotización con despacho, sin que nadie recalcule el precio
en silencio?

## 1. Hechos (verificados en código)

| # | Hecho | Fuente |
|---|---|---|
| H-1 | Quote rechaza toda cotización con despacho: `SHIPPING_NOT_REPRESENTABLE`, causa `H1_BLOCKED_QUOTE_HAS_SHIPPING` | Quote `src/application/quote-v2/cart/line-representation.ts:74` |
| H-2 | El único modo representable es retiro: `shippingMethod: "pickup-zero-v1"` con un transportista designado por el owner, sin valor por defecto (`QUOTE_CART_PICKUP_CARRIER_REFERENCE`, O-10) | Quote `preparation-job.ts:348`; `cart-preparation-settings.ts:58-61` |
| H-3 | La cotización congela el despacho: transportista (sólo nombre), servicio, destino (comuna), importe y sus montos; forma parte del hash semántico | Quote `issued-snapshot.ts` (`IssuedShipping`, `issuedSnapshotHash`) |
| H-4 | R4 envía `carrier.name` y `serviceType.name`, nunca un código estable | R4 `agents/sales/src/capabilities/commercial-snapshot.ts:332-336`; CART-00 M8 |
| H-5 | pc-carrier no publica id de oferta, código de transportista ni vigencia: «A quote is informational, never a checkout commitment» | R4 `adapters/domains/src/shipping/port.ts` (`ownerValidUntil: null`) |
| H-6 | El incentivo de Despacho Directo depende del total de la boleta (banda con $1); R4 cotiza con dimensiones nominales y `total_boleta` | Fixtures de Shipping en R4; CART-00 §4.1 |
| H-7 | El total del carrito lo calcula PrestaShop por un endpoint gobernado `ps-cart-totals/v1`, que ya separa `products`, `discounts`, **`shipping`**, `wrapping`, `fees` y `total`, y lista las reglas de carrito con `freeShipping` | Quote `cart-total-provider.ts` (endpoint aún no construido: E-3) |
| H-8 | Checkout copia el importe del total emitido de la cotización y verifica la paridad del carrito (`PREPARING → READY`); nunca recalcula (C-2) | Checkout `checkoutService.ts` (`quoteTotal(quote)`); E2E integrado §8 punto 4 |
| H-9 | CART-00 §4.1 ya evaluó S1 (transportista existente con cálculo igual), S2 (módulo que devuelve el costo congelado), S3 (sólo retiro) y rechazó «despacho como producto falso» | Quote `docs/cart/CART-00_ARCHITECTURE_REPORT.md` §4.1 |
| H-10 | No se conoce cómo el módulo de logística de la tienda calcula el costo en el carrito (inventario B2 pendiente del owner e-commerce) | CART-00 §4.1, B2 |

## 2. Principios (no negociables)

1. **La cotización emitida es la verdad comercial.** El importe que paga el cliente es exactamente `totals.gross` de
   la cotización. Ningún servicio recalcula el despacho, el precio ni el total al preparar el carrito o al cobrar.
2. **Sin recálculo silencioso.** Si el carrito no reproduce exactamente la cotización (importe de despacho, total,
   destino), el carrito **no** llega a `READY`. El cliente recibe una **cotización nueva** que debe aceptar, y luego un
   acto de compra nuevo (O-5 §5). Nunca se ajusta el cobro.
3. El destino es parte de la cotización. Cambiar de comuna o de modalidad es una cotización nueva.
4. Fallar cerrado: un motivo `NOT_READY` desconocido termina en derivación a una persona, nunca en un enlace.

## 3. Opciones

| Opción | Cómo funciona | A favor | En contra |
|---|---|---|---|
| **A. Sólo retiro (S3)** | Las compras sólo admiten cotizaciones sin despacho, emitidas como retiro con el transportista designado (O-10). Una cotización con despacho no es comprable: R4 deriva u ofrece una cotización de retiro | Ya implementado en Quote; sin dependencias de la tienda salvo O-10 | Contradice la experiencia de `@19+` (el cliente ya ve despacho); la política F1 v2 prohíbe presentar retiro salvo que una oferta lo confirme; deja fuera la promoción de $1 y a la mayoría de los clientes |
| **B. Transportista existente con paridad (S1)** | Quote fija el transportista de PrestaShop mapeado desde (transportista, servicio) de pc-carrier; PrestaShop calcula el despacho; el carrito es `READY` sólo si `totals.shipping.taxIncl` = despacho congelado y `totals.total.taxIncl` = `totals.gross` | Despacho real en la orden, logística nativa | Desajuste probable: R4 cotiza con dimensiones nominales y `total_boleta`, la tienda con peso y medidas reales; la promoción de $1 tendría que replicarse en PrestaShop; reglas de envío gratis de la tienda pueden interferir. Cada desajuste es una cotización nueva para el cliente |
| **C. Módulo de transportista con costo congelado (S2)** | Un módulo de PrestaShop (owner e-commerce) devuelve, para un carrito preparado por Quote, el costo de despacho que Quote escribió ligado a ese `id_cart` (sólo Quote puede escribirlo, por su llave dedicada). Quote fija el transportista mapeado y verifica la paridad completa | Paridad exacta por construcción, incluida la promoción de $1 y cualquier precio vigente de pc-carrier; el despacho sigue siendo despacho (impuesto y logística correctos); Checkout no cambia su regla de importe | Módulo nuevo en la tienda (diseño, seguridad del valor por carrito, interacción con el módulo de logística y con reglas de envío gratis); requiere el mapa estable de códigos (H-4) |
| D. Despacho como línea de producto | — | — | **Rechazada** en CART-00: rompe el tratamiento tributario del flete, la logística y la semántica de la orden |
| E. Checkout cobra el despacho fuera del carrito | — | — | **Rechazada**: el total de la orden de PrestaShop no coincidiría con lo cobrado; Checkout no recalcula ni agrega cargos (C-2) |

## 4. La promoción de $1 (Despacho Directo)

- Con **C**, el valor congelado ($1) es el que cobra el carrito: no hace falta que PrestaShop conozca la promoción.
- Con **B**, PrestaShop tendría que producir el mismo $1 para la misma banda de total; si no, la paridad falla y el
  cliente recibe una cotización nueva sin la promoción (contradicción comercial visible). Además, una regla de envío
  gratis de la tienda podría dejar el despacho en $0: también falla la paridad (diferencia hacia el cliente, pero
  igualmente no se cobra algo distinto de lo aceptado).
- En ambos casos: la vigencia de la promoción ya está acotada por la vigencia de la cotización y la revalidación antes
  de cada envío (política F1 v3, PR #79). La promoción no se revalida al pagar: lo aceptado es la cotización.

## 5. Cadena de paridad de importes

| Punto | Igualdad exigida | Quién la verifica | Si falla |
|---|---|---|---|
| Emisión | `lines + shipping` = `totals.gross` (aritmética A10) | Quote | No se emite |
| Carrito | `ps-cart-totals.total.taxIncl` = `totals.gross`; `shipping.taxIncl` = despacho congelado; transportista = el mapeado; dirección de entrega en la comuna de la cotización | Quote | `NOT_READY` con motivo tipado (`PARITY_FAILED`, `SHIPPING_PRICE_CHANGED`, `DESTINATION_MISMATCH`, nuevos) |
| Sesión | importe de la sesión = total emitido; carrito `READY` del mismo hash | Checkout | Sesión no `READY`, sin enlace |
| Enlace | importe de la preferencia = importe de la sesión | Checkout | Sin enlace |
| Conciliación | capturado = importe; orden `total_paid` = importe | Checkout | `ACTION_REQUIRED`, sin orden automática |

## 6. Cambio de destino o de costo entre la cotización y el pago

| Caso | Tratamiento |
|---|---|
| El cliente pide otra comuna o retiro | Cotización nueva (preview → aceptación → emisión) y acto de compra nuevo. La sesión anterior no se reutiliza |
| La dirección de PrestaShop elegida para la entrega no está en la comuna cotizada | `DESTINATION_MISMATCH` (Quote o Checkout, según H2): el agente pide confirmar la dirección o emite una cotización nueva |
| El costo de pc-carrier cambió después de emitir | Con C: irrelevante, se cobra lo congelado mientras la cotización esté vigente. Con B: la paridad falla → cotización nueva con el precio actual, que el cliente acepta o no |
| La cotización venció | Cotización nueva (ya hoy: `checkout_not_purchasable`) |

R4 traduce cada motivo `NOT_READY` a «hay una cotización nueva para aceptar» o a derivación. Nunca a un enlace.

## 7. Recomendación

1. **Destino: opción C (S2)**, porque es la única que cobra exactamente lo aceptado para todo precio de pc-carrier,
   incluida la promoción de $1, sin recálculo.
2. **Mientras C se construye**, el primer E2E sandbox puede usar **A (retiro)** sólo si el owner comercial autoriza
   ofrecer retiro en ese escenario (hoy la política F1 v2 sólo lo permite si una oferta lo confirma; la designación del
   transportista de retiro, O-10, sería esa confirmación).
3. **B sólo** si el inventario del owner e-commerce (B2) demuestra que la tienda calcula igual que pc-carrier, medido en
   la tienda aislada con las cotizaciones reales del carril (sin cobrar).

## 8. Qué cambia en cada servicio

| Servicio | Cambio | Item |
|---|---|---|
| e-commerce | Inventario B2 (transportistas, rangos, reglas de envío gratis); mapa estable (transportista, servicio) → referencia de PrestaShop, junto con Shipping; módulo S2; designación de retiro (O-10) | F2-E02, E06, E07 |
| Quote | Quitar el bloqueo H1 para el método elegido: fijar transportista desde el código, escribir el costo congelado (C) y verificar la paridad del despacho; motivos `NOT_READY` nuevos tipados | F2-Q04 |
| Checkout | Dirección de entrega coherente con la comuna cotizada (H2); verificación de importe en sesión, enlace y conciliación (ya parcial); mapear los motivos nuevos | F2-K08 |
| R4 | Enviar `carrier.code` y `serviceType.code` (M8); mapear los motivos nuevos a «cotización nueva para aceptar»; no presentar una cotización con despacho como comprable hasta que el método esté habilitado | F2-R06, R07 |
| Shipping (pc-carrier) | Publicar códigos estables de transportista y servicio | F2-E06 |

## 9. Preguntas para el owner

| # | Pregunta | Quién decide |
|---|---|---|
| Q1 | ¿Se adopta C como destino, con A como paso intermedio? | Owner comercial + owner e-commerce |
| Q2 | ¿Se autoriza ofrecer retiro en el primer E2E sandbox (A), y con qué transportista (O-10)? | Owner comercial + e-commerce |
| Q3 | Si el costo real de la tienda difiere (B), ¿se acepta mostrar al cliente una cotización nueva, o se prefiere esperar C? | Owner comercial |
| Q4 | ¿La promoción de $1 debe poder comprarse en el primer incremento, o queda para C? | Owner comercial |
| Q5 | Origen de la dirección de entrega mientras H2/G-ADDR no exista (OQ-H3-11) | Owner Checkout |
