---
title: R4-J7 — Paquete de trabajo Customer Profile con datos reales (backlog acotado)
status: backlog — NOT AUTHORIZED
mandate: R4-J4-R6 Final Acceptance and Customer Profile Contract Closure (owner, 2026-10-27), Fase E
date: 2026-10-27
---

# J7-CP: integración real de Customer Profile (backlog)

Paquete de trabajo **separado y acotado** que J7 hereda de J4. Registrarlo no lo autoriza: cada ítem requiere
mandato explícito. Producción y datos reales siguen prohibidos hasta entonces.

**Fuera de este paquete:** Customer Intelligence V2 (RFM, CLV, clustering, afinidad, dashboards, copilot),
Checkout (R4-L) y cualquier cambio de comportamiento comercial del modelo (J5/J6).

**Punto de partida:** CP `bbd766e` (productor `sales-context` solo sintético, v1-rc2 `candidate`), CIA `7525395`
(solo loopback y sintética), R4 `main` con `sales-production@8` fusionado y `R4_CUSTOMER_MODE=real` rechazado.
Detalle: [auditoría de CP](R4_J4_R6_CUSTOMER_PROFILE_STATE_AUDIT.md).

## Entrada al paquete (prerrequisitos)

| # | Prerrequisito | Owner |
|---|---|---|
| E-1 | J4 aceptado (`J4_RELEASE_CANDIDATE_ACCEPTED*`), incluido G-16 firmado | Owner R4 / CP |
| E-2 | Mandato J7 explícito que autorice datos reales para un alcance concreto | Owner |
| E-3 | Owner de datos nombrado para AP-03, AP-09 y la retención | Negocio |

## Ítems

| ID | Ítem | Entregable | Owner | Criterio de salida |
|---|---|---|---|---|
| J7-CP-01 | **Fuente factual de producción** | Implementación del puerto `SalesContextFactsSource` con `kind` real (hoy el tipo solo admite `synthetic`), en un slice CP autorizado | CP | Contrato v1-rc2 (o sucesor) byte-compatible; fixtures regenerados; test de contrato verde; ninguna PII fuera del contrato |
| J7-CP-02 | **Reutilización de readers PrestaShop** | Reader dedicado que reutiliza las consultas de `mysql-purchased-products-reader.ts` y `mysql-prestashop-customer-reader.ts`, entregando valores crudos (sin `coerceNonEmptyString`, sin conversión UTC; CTX-11b) y los flags `active`, `is_guest`, `deleted` + exclusión operacional | CP | Sin selección de PII (`firstname`, `lastname`, `email`); las rutas heredadas no cambian; test opt-in con MariaDB |
| J7-CP-03 | **Gate de resiliencia con MariaDB real** | `max_statement_time` ≤ presupuesto − margen o `KILL QUERY` al abortar; pool dedicado o `queueLimit` finito; prueba de saturación; p95 medido | CP | `RESILIENCE_REAL_PROVIDER_GATE=CLOSED` con evidencia; si el p95 sube el presupuesto, R4 ajusta su timeout (máx. 5 000 ms, AP-11) |
| J7-CP-04 | **Mapeo canónico de identidad** | CIA con proveedor de cuentas PrestaShop real (DEP-2/3), `providerScope` y multitienda decididos, versión de PrestaShop validada (1.7.8.3 vs 8.2.3) | CIA + negocio | `customerRef` estable y verificado contra la cuenta real; OD-CIA-2..5 cerradas |
| J7-CP-05 | **Grants de producción** | Emisor CIA productivo con claves en KMS (DEP-6), JWKS fijado en CP productivo, kids no sintéticos, correo real (DEP-5) | CIA + CP | CP verifica en `required` con claves reales; los fixtures sintéticos siguen rechazados en producción |
| J7-CP-06 | **Autorización por cliente** | `CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE=required` y `enforce` en producción; principal `r4-sales` con solo `customer.sales_context.read`; L-1 corregida (403 con motivo propio); riesgo residual de revocación aceptado o mitigado | CP + owner de datos | Grant ajeno → 403; grant vencido en composición → 403, no 500; ninguna lectura sin grant verificado |
| J7-CP-07 | **Políticas de calidad de datos históricos** | AP-03 (propósitos), AP-09 (eliminadas, guest, inactivas), AP-10 (precio cero, `lineKind`), D14 (zona horaria), D6 (`catalogKey`), D13/D-SPLIT | Owner de datos, Comercial, Catalog, CP | Cada política aprobada y reflejada en `policyVersion`; fixtures por caso |
| J7-CP-08 | **Contención de red y autenticación** | CP productivo fuera de `*:3010` (H-1/X7); X6 (correlation id extremo a extremo, 503/504 tipados, 429 por principal); migración del CRM-agent a `enforce`; AP-04-H con inventario previo | CP + Operación | Puerto no expuesto fuera del host/VPC; evidencia de red; consumidores heredados sin regresión |
| J7-CP-09 | **Contrato aprobado** | `contractStatus: approved` y `publishedApi` según el owner (PB-5) | CP + R4 | Pin de R4 actualizado al commit aprobado |
| J7-CP-10 | **Retención (D7 productivo) y RR-1 R-1..R-3, RS-01..04, BA-01..06, OA-10** | Decisiones del owner de R4 | R4 | Registradas antes del canary real |
| J7-CP-11 | **Canary con datos reales y rollback** | Allowlist de clientes reales consentidos, rollout 0 % + allowlist; rollback propio (producción parte de `@2`/`@3`, ver F-5 de J4-R5), purga de observaciones según D7 | R4 + Operación + owner de datos | Rollback ensayado; 0 lecturas fuera de la allowlist; evidencia de retención/purga |

## Orden sugerido

J7-CP-04/05 (identidad y grants) y J7-CP-07 (políticas) primero, porque condicionan el contrato; después
J7-CP-01/02/03 (fuente real); J7-CP-06/08 (autorización y red); J7-CP-09; J7-CP-10; y por último J7-CP-11.

```text
J7_CP_PRODUCTION_DATA_PACKAGE=REGISTERED_NOT_AUTHORIZED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
