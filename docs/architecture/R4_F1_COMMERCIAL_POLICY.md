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

**Sin dependencias adicionales de Catalog:** no se requiere un archivo P-1 estático por SKU ni una clasificación de precio regular, promocional o desconocido (#54 y #57 dejan de bloquear F1).

## 2. Presentación al cliente

- Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible.
- Si el cliente pide despacho, se le explica que la cotización se emite sin despacho, o se deriva a una persona.
- Un rechazo nunca se reintenta con otra vigencia ni con otro principal.

## 3. Pendiente antes de la primera escritura real

- La autorización del owner de Quote para usar `r4-sales-retail-session` con tráfico real (Quote #33).
- La aprobación final del owner sobre el SHA exacto.
