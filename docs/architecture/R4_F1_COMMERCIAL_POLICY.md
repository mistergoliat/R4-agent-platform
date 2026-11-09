---
title: Política comercial F1 de cotizaciones autónomas por WhatsApp (F1-COMMERCIAL-POLICY-v1)
status: DRAFT — PENDIENTE DE APROBACIÓN (owner comercial, owner de Quote, owner de Catalog)
date: 2026-11-09
---

# Política comercial F1 — `F1-COMMERCIAL-POLICY-v1`

**Estado: borrador, no activa.** R4 la aplica en el perfil candidato `sales-production@17`, que está inactivo. Cada rechazo registra la versión de la política. No se activa sin la aprobación de los tres responsables (§3).

## 1. Reglas

Una cotización se emite automáticamente solo si cumple **todas** estas reglas:

| # | Regla | Quién lo prueba | Control en R4 |
|---|---|---|---|
| 1 | El producto y la variante están en el **conjunto autorizado por P-1**, con la evidencia vigente | Catalog (+ owner comercial) | Guard P-1 (existente) |
| 2 | **Precio regular confirmado.** Catalog declara el precio como `regular` y no hay un cambio programado antes de `issuedAt + 60 min + margen` | Catalog (#57) | Validación de elegibilidad: si no está probado, `price_class_unknown` |
| 3 | **Promociones excluidas** temporalmente | Catalog (`pricing.promotion`) | `price_promotional_excluded` |
| 4 | **Stock confirmado para la cantidad** | Catalog (contexto de ítem) | `quote.preview` y la revalidación al emitir (existentes) |
| 5 | **Sin despacho** mientras pc-carrier no entregue vigencia de tarifa | Shipping | `shipping_validity_unverified` |
| 6 | **Vigencia máxima de 60 minutos** | Quote (principal `r4-sales-retail-session`, `cl-retail-session-60m-v1`) | Configuración del principal; R4 no calcula vigencias |
| 7 | **Límites J3E/F1:** ≤ 250.000 CLP, 3 líneas, 5 unidades por línea y en total, 1 cotización por conversación, 2 por hora, ventana de confirmación de 900 s | R4 | Existentes |
| 8 | **Confirmación explícita de la oferta exacta**, idempotencia y una sola emisión en vuelo | R4 | Existentes (`quote.create@5`, #60) |

## 2. Presentación al cliente

- Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible (regla de modalidad de entrega de la definición v16).
- Un rechazo no ofrece ningún camino alternativo con otra vigencia: no se usa el principal de 5 días ni se reintenta. El cliente puede pedir una persona del equipo.

## 3. Aprobaciones

| Responsable | Qué aprueba | Estado |
|---|---|---|
| Owner comercial (e-commerce) | Política E3: un precio cotizado se honra durante 60 minutos. Además, las reglas 2, 3 y 5 | **Pendiente** |
| Owner de Quote | V6: usar `r4-sales-retail-session` con tráfico real F1, y esta política como evidencia E1–E3 | **Pendiente** (Quote #33) |
| Owner de Catalog | El contrato de clasificación de precio (#57) y P-1 (#54) | **Pendiente** |

Mientras falte el contrato de Catalog #57, R4 trata **todas** las líneas no promocionales como `unknown` y no emite ninguna cotización.
