---
title: R4 F2 — Registro de decisión O-6: entrega y carrito (despacho en el carrito de Quote)
status: APROBADO por el owner el 2026-11-18 (opción C, módulo de PrestaShop). Pagos y rollout real siguen deshabilitados
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 85d9192 (carril WhatsApp `sales-production@22`); Quote `origin/main` a79d33f; Checkout `3d7b23d` (local)
related: R4_CHECKOUT_STATUS_2026-11.md (PR #86) §1 fila 8, R4_F2_WORK_ITEMS.md, R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md
---

# O-6 — Entrega y carrito

## 0. Decisión

**Aprobado por el owner, 2026-11-18.** Texto de la aprobación, tal como lo transmitió el mandato (en inglés):

> «Delivery is integrated through a PrestaShop module that preserves exactly the commercial conditions authorized by Quote.»

Además: «Payments and the real rollout stay disabled.»

Es la opción C (S2 de CART-00 §4.1): un módulo de PrestaShop (owner e-commerce) hace que el carrito preparado por Quote
cobre **exactamente** las condiciones comerciales de la cotización emitida, incluido el despacho y su precio (la
promoción Despacho Directo de $1 incluida). Nadie recalcula.

## 1. Hechos (verificados en código)

| # | Hecho | Fuente |
|---|---|---|
| H-1 | Quote rechaza hoy toda cotización con despacho: `SHIPPING_NOT_REPRESENTABLE` / `H1_BLOCKED_QUOTE_HAS_SHIPPING` | Quote `src/application/quote-v2/cart/line-representation.ts:74` |
| H-2 | El único modo representable hoy es retiro (`pickup-zero-v1`) con transportista designado (`QUOTE_CART_PICKUP_CARRIER_REFERENCE`, sin valor por defecto) | Quote `preparation-job.ts:348`; `cart-preparation-settings.ts:58-61` |
| H-3 | La cotización congela el despacho (transportista por nombre, servicio, comuna, importe y montos) dentro de su hash semántico | Quote `issued-snapshot.ts` |
| H-4 | R4 envía `carrier.name` y `serviceType.name`, nunca un código estable | R4 `commercial-snapshot.ts`; CART-00 M8 |
| H-5 | pc-carrier no publica id de oferta, código ni vigencia | R4 `adapters/domains/src/shipping/port.ts` |
| H-6 | El incentivo de Despacho Directo ($1) depende del total de la boleta | Fixtures de Shipping en R4; CART-00 §4.1 |
| H-7 | El total del carrito lo calcula PrestaShop vía `ps-cart-totals/v1`, que separa `products`, `discounts`, `shipping`, `total` y lista reglas con `freeShipping` (endpoint aún no construido: E-3) | Quote `cart-total-provider.ts` |
| H-8 | Checkout copia el importe del total emitido y verifica la paridad del carrito; nunca recalcula (C-2) | Checkout `checkoutService.ts` |

## 2. Principios (vinculantes)

1. **La cotización emitida es la verdad comercial.** Se cobra exactamente `totals.gross`. Nadie recalcula despacho,
   precio ni total al preparar el carrito o al cobrar.
2. **Sin recálculo silencioso.** Si el carrito no reproduce exactamente la cotización (despacho, total, destino), no
   llega a `READY`. El cliente recibe una **cotización nueva** que debe aceptar, y un acto de compra nuevo (O-5 §5).
   Nunca se ajusta el cobro.
3. El destino es parte de la cotización: otra comuna u otra modalidad es una cotización nueva.
4. Fallar cerrado: un motivo `NOT_READY` desconocido termina en derivación a una persona, nunca en un enlace.

## 3. Opciones

| Opción | Estado | Motivo |
|---|---|---|
| **C. Módulo de PrestaShop que aplica las condiciones congeladas por Quote (S2)** | **APROBADA** | Texto del owner (§0). Paridad exacta por construcción para cualquier precio de pc-carrier, incluida la promoción de $1; el despacho sigue siendo despacho (impuesto y logística) |
| A. Sólo retiro (S3) como camino de compra | Rechazada como camino de F2 | No preserva las cotizaciones con despacho de `@19+`. El código de retiro de Quote sigue existiendo; usarlo en un E2E requeriría una decisión aparte (FU-O6-3) |
| B. Transportista existente con cálculo propio de PrestaShop (S1) | Rechazada | No garantiza «exactly the commercial conditions authorized by Quote»: un desajuste de cálculo cambiaría lo que el cliente aceptó |
| D. Despacho como línea de producto | Rechazada | CART-00: rompe el tratamiento tributario del flete, la logística y la semántica de la orden |
| E. Checkout cobra el despacho fuera del carrito | Rechazada | El total de la orden no coincidiría con lo cobrado; Checkout no agrega cargos (C-2) |

## 4. Contrato del módulo (requisitos para e-commerce y Quote)

| # | Requisito |
|---|---|
| M-1 | El módulo aplica, para un carrito preparado por Quote, el transportista y el costo de despacho que Quote fijó desde la cotización emitida (importe con impuesto incluido igual al congelado). No consulta pc-carrier ni recalcula |
| M-2 | Sólo Quote puede fijar esas condiciones, con su llave dedicada (E-6), ligadas al `id_cart` que Quote creó; un carrito sin condiciones fijadas no usa el módulo |
| M-3 | Ninguna regla de la tienda (envío gratis por monto, reglas de carrito automáticas, manejo) altera el resultado: si lo haría, `ps-cart-totals/v1` lo muestra y la paridad falla |
| M-4 | El transportista se identifica por un código estable del mapa (transportista, servicio) → referencia de PrestaShop, versionado entre Shipping y e-commerce (F2-E06) |
| M-5 | `ps-cart-totals/v1` informa el despacho calculado por el camino de la orden; Quote exige `shipping.taxIncl` = despacho congelado y `total.taxIncl` = `totals.gross` |
| M-6 | La orden creada por Checkout conserva transportista y costo (la logística de la tienda opera sobre ella) |

## 5. La promoción de $1

El valor congelado ($1 en la banda que corresponda al emitir) es el que fija Quote y aplica el módulo; PrestaShop no
necesita conocer la promoción. Su vigencia queda acotada por la vigencia de la cotización y por la revalidación de la
instantánea comercial (precio, despacho, promoción) antes de cada envío a Quote (PR #79). Al pagar no se revalida: lo
aceptado es la cotización.

## 6. Cadena de paridad de importes

| Punto | Igualdad exigida | Quién la verifica | Si falla |
|---|---|---|---|
| Emisión | `lines + shipping` = `totals.gross` (A10) | Quote | No se emite |
| Carrito | `ps-cart-totals.total.taxIncl` = `totals.gross`; `shipping.taxIncl` = despacho congelado; transportista = el mapeado; dirección en la comuna cotizada | Quote | `NOT_READY` tipado (p. ej. `PARITY_FAILED`, `SHIPPING_CONDITIONS_NOT_APPLIED`, `DESTINATION_MISMATCH`) |
| Sesión | importe = total emitido; carrito `READY` del mismo hash | Checkout | Sin enlace |
| Enlace | importe de la preferencia = importe de la sesión | Checkout | Sin enlace |
| Conciliación | capturado = importe; `total_paid` de la orden = importe | Checkout | `ACTION_REQUIRED`, sin orden automática |

## 7. Cambio de destino o de costo entre la cotización y el pago

| Caso | Tratamiento |
|---|---|
| El cliente pide otra comuna o retiro | Cotización nueva (preview → aceptación → emisión) y acto de compra nuevo |
| La dirección elegida no está en la comuna cotizada | `DESTINATION_MISMATCH`: el agente pide confirmar la dirección o emite una cotización nueva |
| El costo de pc-carrier cambió después de emitir | Irrelevante: se cobra lo congelado mientras la cotización esté vigente |
| La cotización venció | Cotización nueva (ya hoy: `checkout_not_purchasable`) |

R4 traduce cada motivo `NOT_READY` a «hay una cotización nueva para aceptar» o a derivación; nunca a un enlace (F2-R07).

## 8. Qué cambia en cada servicio

| Servicio | Cambio | Item |
|---|---|---|
| e-commerce | Inventario B2 (transportistas, rangos, reglas de envío gratis); mapa de códigos con Shipping; **módulo** según §4 | F2-E06, E07 |
| Quote | Quitar el bloqueo H1 para el módulo: fijar transportista desde el código, escribir las condiciones congeladas para el `id_cart`, verificar la paridad del despacho; motivos `NOT_READY` tipados | F2-Q04 |
| Checkout | Dirección coherente con la comuna cotizada (H2); paridad de importe en sesión, enlace y conciliación; mapear los motivos nuevos | F2-K08 |
| R4 | Enviar `carrier.code` y `serviceType.code`; mapear los motivos nuevos a «cotización nueva»; no presentar una cotización con despacho como comprable hasta que el módulo esté habilitado | F2-R06, R07 |
| Shipping (pc-carrier) | Publicar códigos estables de transportista y servicio | F2-E06 |

## 9. Seguimientos (antes «preguntas abiertas»)

| Id | Seguimiento | Dueño | ¿Bloquea? |
|---|---|---|---|
| FU-O6-1 | Diseño del módulo según §4 (M-1..M-6), incluida su seguridad (quién escribe las condiciones) e interacción con el módulo de logística | Owner e-commerce + owner Quote | **Sí**: F2-E07, F2-Q04 |
| FU-O6-2 | Mapa versionado (transportista, servicio) → referencia de PrestaShop y códigos estables en pc-carrier | Owner e-commerce + owner Shipping | **Sí**: F2-E07, F2-R06 |
| FU-O6-3 | ¿Se usa retiro (`pickup-zero-v1`) en un E2E sandbox previo al módulo? No forma parte de la decisión aprobada | Owner comercial | No (opcional) |
| FU-O6-4 | Origen de la dirección de entrega mientras H2/G-ADDR no exista (OQ-H3-11) | Owner Checkout | Sí para F2-K08 |
| FU-O6-5 | Medición en la tienda aislada: cotizaciones reales del carril (sin cobrar) reproducidas por el módulo con paridad exacta | Owner e-commerce + owner Quote | Sí para el E2E con despacho (F2-R09) |
