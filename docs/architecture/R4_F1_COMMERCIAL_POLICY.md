---
title: Política comercial F1 de cotizaciones autónomas por WhatsApp (F1-COMMERCIAL-POLICY-v1)
status: Definida por el owner (mandato «R4 — F1 simplified commercial canary», 2026-11-09). Las promociones quedan pendientes de autorización
date: 2026-11-09
---

# Política comercial F1 — `F1-COMMERCIAL-POLICY-v1`

**Roles:**

- **Catalog V2** es la autoridad de la información comercial: producto, variante, precio y stock.
- **Quote V2** es la autoridad de emisión.
- **R4** orquesta.

No hay motores de precio, catálogos, políticas de stock ni sistemas de elegibilidad paralelos. R4 aplica la política en `sales-production@17`, en `quote.preview` y otra vez en `quote.create`, y registra en cada rechazo la versión de la política.

## 1. Reglas del primer canary

| # | Regla | Control |
|---|---|---|
| 1 | El producto y la variante son exactos y se pueden vender (`itemKey` de Catalog V2) | Snapshot comercial (existente) |
| 2 | El precio vigente es el del owner para el tramo de cantidad | Snapshot (existente) |
| 3 | Hay stock confirmado para la cantidad pedida | Snapshot y `quote.preview` (existente) |
| 4 | La información está vigente y no degradada: tiene procedencia de Catalog, una validez acotada y no vencida, y el owner respondió | Snapshot (`catalog_evidence_stale`, existente). Para F1 se agregan `catalog_provenance_missing` y `catalog_evidence_unbounded`. Si Catalog no responde, nada se emite |
| 5 | La oferta confirmada es exactamente la renderizada, sin cambios, y cualquier cambio comercial entre la vista previa y la emisión la invalida | `quote.create@5` (existente: el `previewId` se recalcula al emitir) |
| 6 | Límites: ≤ 250.000 CLP, ≤ 3 líneas, ≤ 5 unidades por línea, ≤ 5 unidades en total, 1 cotización por conversación, 2 por hora | Existentes (`SALES_F1_CANARY_LIMITS`) |
| 7 | Cotizaciones **sin despacho** | `shipping_not_in_f1` |
| 8 | Vigencia de 60 minutos, fijada por Quote | Principal `r4-sales-retail-session` (`cl-retail-session-60m-v1`). Nunca el de 5 días |
| 9 | Sin carrito ni Checkout | El carrito está apagado en Quote; `@17` no tiene capacidades de Checkout |
| 10 | Una sola emisión en vuelo; idempotencia; kill switch | Existentes (#60) |

**Promociones:** solo se cotizarán después de que el owner comercial y el owner de Quote autoricen explícitamente honrar el monto emitido durante los 60 minutos. Hasta entonces, una línea con `pricing.promotion` de Catalog se rechaza (`price_promotional_excluded`). Ese es un campo del propio owner; no se usa ninguna clasificación heurística.

**Promociones con fin verificable (F1-COMMERCIAL-POLICY-v3).**

- **Decisión:** el owner comercial la tomó el 2026-11-13.
- **Activación:** solo con `R4_F1_PROMOTIONAL_QUOTES=enabled`, solo en `@19`, y solo después de que el owner de Quote la acepte (issue Quote #34). Por defecto queda apagada y rige el párrafo anterior.

Con la política v3 activa, una línea promocional se cotiza si `pricing.promotion.validUntil` (fecha de fin de PrestaShop, que entrega Catalog V2) es conocida y termina al menos **75 minutos** después del momento de decidir: 60 de vigencia de la cotización más 15 de margen.

- **Cuándo se verifica:**
  - en `quote.preview`;
  - en la decisión de `quote.create`;
  - **inmediatamente antes de cada envío a Quote del cuerpo autorizado**, también cuando el envío se reanuda después de un kill switch, de un owner no disponible o de un reinicio con su reconciliación. En ese momento se reconstruye la misma instantánea comercial con Catalog y Shipping, usando la misma regla de elegibilidad (sin otra fuente de precios ni otro motor). Debe quedar lista y con el **mismo `previewId`**: precio, variante, cantidad, stock, despacho y fin de la promoción iguales a lo aceptado, con 75 minutos desde ese instante.
- **Qué rechaza:**
  - en la vista previa o la decisión: fin desconocido o indefinido (`price_promotional_unbounded`) o fin dentro de los 75 minutos (`price_promotional_ending`);
  - en un envío reanudado que ya no cumple: `promotional_quote_no_longer_valid`, con el motivo. La orden queda cerrada, a Quote no se envía nada y no se crea otra cotización en su lugar.
- **Si Catalog no responde al revalidar:** el envío queda retenido en su misma clave, igual que con el kill switch.
- **Resultado desconocido de un envío:** se reconcilia por la clave idempotente antes de cualquier reenvío. Si Quote ya la había emitido, se asienta; nunca se reenvía.
- **Evidencia (sin datos del cliente):**
  - **con la decisión** (`quote_autonomous_decisions.quote_request.promotion`): por cada línea promocional, producto, variante, cantidad, precio unitario validado, fin de la promoción, referencia de precio y momento de la respuesta de Catalog, más el `previewId` y el momento de la validación. Catalog V2 no identifica las promociones, por eso `promotionRef` queda nulo;
  - **con cada intento de envío** (`quote_v2_sends.validation`, migración Sales `0011`, columna nueva que admite nulo): la validación usada, de la decisión o revalidada. Las cotizaciones regulares no cambian: no se revalidan y su fila no lleva validación;
  - la cotización y la clave idempotente se relacionan por la `execution_key` de esas filas.
- **Si un envío reanudado se rechaza:** la autorización sigue contando para el límite F1 de la conversación. Por eso se le indica al agente que explique que la cotización no se pudo emitir porque la oferta cambió y que ofrezca una persona, no que presente una oferta nueva.
- **Precondición de despliegue y de rollback.** El código anterior a esta corrección (main `97f6931` y anteriores) no revalida antes de enviar ni guarda evidencia de la promoción.
  - **Nunca** se debe activar `R4_F1_PROMOTIONAL_QUOTES` con ese código.
  - Antes de volver a ese código, verificar que no haya decisiones autorizadas sin aceptación de Quote cuyo `quote_request` incluya `promotion`. Si las hay, el rollback esperaría a que se asienten o se cancelen.
- **Lo que el agente ve antes de ofrecer:** cuando lee un producto con descuento, la misma regla le indica si puede emitir una cotización formal a ese precio. Así nunca ofrece como cotizable una promoción que la plataforma rechazará. Si no se puede, ofrece comprar al precio promocional en la tienda o derivar a una persona.
- **Lo que no cambia:** la revalidación de precio, variante, cantidad y stock; la oferta exacta aceptada; los límites F1; la idempotencia. Ninguna cotización reserva stock.

**Sin dependencias adicionales de Catalog:** no se requiere un archivo P-1 estático por SKU ni una clasificación de precio regular, promocional o desconocido (#54 y #57 dejan de bloquear F1).

## 2. Presentación al cliente

- Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible.
- (v1: `@17`, `@18`) Si el cliente pide despacho, se le explica que la cotización se emite sin despacho, o se deriva a una persona. En v2 (`@19`, §4) el despacho se cotiza.
- Un rechazo nunca se reintenta con otra vigencia ni con otro principal.

## 3. Pendiente antes de la primera escritura real

- La autorización del owner de Quote para usar `r4-sales-retail-session` con tráfico real (Quote #33).
- La aprobación final del owner sobre el SHA exacto.

## 4. F1-COMMERCIAL-POLICY-v2 (`sales-production@19`, decisión del owner del 2026-11-10)

> «los precios de shipping pc-carrier se alteran según el producto y la comuna, siempre son vigentes. El precio que arrojen es el que debemos respetar. Quitemos la política para 19»

| Cambio respecto de v1 | Control |
|---|---|
| Se elimina la regla 7: la cotización **puede llevar despacho** al precio que devuelve el owner de Shipping (pc-carrier) para los productos y la comuna, incluida la promoción Despacho Directo tal como venga | `F1-COMMERCIAL-POLICY-v2` (`shippingAllowed`) solo en `@19` |
| El precio de despacho se respeta tal cual, pero se vuelve a cotizar al emitir, como todo hecho del snapshot. Si la oferta cambió o ya no está, no se emite (`shipping_offer_changed`, `shipping_offer_unavailable`): el cliente vuelve a elegir entre las ofertas actuales (`select_shipping_offer`) y el agente presenta la oferta nueva | Snapshot (existente: oferta elegida por el cliente, mismo destino, monto exacto) |
| El retiro en tienda solo se ofrece si una oferta devuelta lo confirma | Definición v19 (regla de v17) |

Todo lo demás de v1 sigue igual: Catalog V2 como autoridad, la procedencia, la validez acotada, el precio, el stock, sin promociones de producto, los límites F1, la vigencia de 60 minutos, sin carrito ni Checkout. **`@17` y `@18` siguen en v1, sin despacho.**
