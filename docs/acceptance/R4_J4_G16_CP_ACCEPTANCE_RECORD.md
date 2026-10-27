---
title: R4-J4 — Registro de aceptación de Customer Profile (G-16, AP-01..AP-08, AP-11)
status: prepared — NOT SIGNED
mandate: R4-J4-R6 Final Acceptance and Customer Profile Contract Closure (owner, 2026-10-27), Fase C
date: 2026-10-27
---

# Registro de aceptación de Customer Profile para G-16 (preparado, sin firmar)

> **Este documento no contiene ninguna aprobación.** Lo prepara Claude Code para que el owner de Customer
> Profile se pronuncie. Ninguna casilla está marcada y ninguna decisión se atribuye a nadie. El mandato R4-J4-R6
> pide preparar el registro; no lo firma.

**Criterio G-16** (R4-J4-R1C §6.2): «conformidad del owner de CP registrada para AP-01 a AP-08 y AP-11» en el
documento de alineamiento de CP. Por la regla de CP (`CP_J4_R4_CONTRACT_ALIGNMENT.md` §9.1), el owner la registra
**él mismo**, con identidad, fecha y estado por AP. Este registro es el borrador de ese pronunciamiento; una vez
firmado se transcribe a CP §9.1 en un commit documental de CP (mandato aparte; este mandato no modifica CP).

Estado de partida: [auditoría de CP](../architecture/R4_J4_R6_CUSTOMER_PROFILE_STATE_AUDIT.md) §6–§7.

## 1. Ya aceptado — solo interoperabilidad sintética (no es G-16)

Firmado por Felipe Porte el 2026-10-20 (`docs/reviews/J4_D2_CP_ACCEPTANCE_RECORD.md` en CP):

| ID | Objeto | Alcance |
|---|---|---|
| CP-D2-ACC-01 | Verificación D2 (DM-01..DM-12): ES256, 18 pasos, `azp`/`sub`/`purpose`, TTL ≤ 300 s, JWKS fijado, 403 `grant_rejected` | Interop sintética |
| CP-D2-ACC-02 | `sales-context` v1-rc2 como **candidato** | No es `approved` |
| CP-D2-ACC-03 | CP autoriza antes del productor (bearer → scope → petición → grant → productor), fail closed | Interop sintética |

Ese registro declara que **no** regulariza G-16 ni AP-01..AP-11. Tampoco cubren G-16: la excepción de
desarrollo de 02C, la posición de R4 en R4-J4-R1C ni la atribución retirada de `7b2e7f7`.

## 2. Requiere nueva decisión del owner de CP (G-16)

Texto de cada AP: `CP_J4_R4_CONTRACT_ALIGNMENT.md` §9 (CP `bbd766e`). La columna «Implementado» indica lo que
F2/02C/S5 ya aplicaron técnicamente; **no** es aceptación.

| AP | Decisión | Implementado en `bbd766e` | Decisión del owner de CP |
|---|---|---|---|
| AP-01 | Una ruta `POST /v1/capabilities/customer/sales-context`, `purpose` obligatorio (`sales_context` \| `purchase_history`), composición por propósito | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-02 | `POST` de solo lectura, identificadores en el cuerpo, `Cache-Control: no-store` | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-03 | Minimización: sin montos, componentes monetarios ni predictivos en J4; allowlist en R4 | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-04 | Scope `customer.sales_context.read` exclusivo para `r4-sales`; nunca `facts.read`, `pii.read`, `analytics.read`, `dashboard.read` | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-05 | Ciclo de vida (`schemaVersion`, `contractStatus`, `policyVersion`, `serviceBuildRef`); `authorizationBasis` como evidencia declarada, nunca suficiente; reserva `deleted_account` | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-06 | Error plano; R4 mapea por status y código; H-15 resuelto por contrato | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-07 | Tamaño en bytes UTF-8; R4 pide ≤ 10 ítems; máximo explícito del propósito J4 | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-08 | Puerto sin `degraded`; `withheld` con `reason`; 503/504 = fallo temporal; `not_found` ≠ 401/403 | Sí | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |
| AP-11 | Presupuesto de CP ≤ timeout de R4 − 500 ms; timeout R4 3 000–5 000 ms; no es SLO | Sí (presupuesto 2 500 ms) | ☐ Acepto ☐ Acepto con condición ☐ Rechazo |

**Alcance a declarar por el owner** (marcar uno):
- ☐ Conformidad para el **cierre sintético de J4** (contrato `candidate`; no habilita datos reales).
- ☐ Conformidad también como base del contrato `approved` (exige además los gates de §3).

**Efecto de un rechazo o condición incompatible:** la parte afectada de v1-rc2 vuelve a F0 (CP §9.1) y J4-R6
sigue bloqueado.

## 3. Fuera de G-16: bloqueos explícitos con su owner

No los resuelve la firma de §2. Ninguno bloquea el cierre sintético de J4 salvo que se indique; todos bloquean
datos reales (J7).

| # | Decisión | Owner | Estado |
|---|---|---|---|
| B-1 | AP-03: legitimidad de los propósitos `sales_context` y `purchase_history` (PB-11) | Owner de datos / negocio | Pendiente |
| B-2 | AP-09: cuentas eliminadas, guest e inactivas (PB-3, PB-12) | Owner de datos | Pendiente (regla provisional: no divulgar) |
| B-3 | AP-10: precio cero y clasificación `lineKind` | Comercial (+ CP) | Pendiente |
| B-4 | AP-04-H: sacar `commercial-profile` de `customer.facts.read`, con inventario previo | Owner de CP | Pendiente |
| B-5 | D6: `catalogKey` (hoy `null`) | Catalog | Diferida |
| B-6 | Riesgo residual de revocación por TTL para datos reales | Owner de datos | No aceptado |
| B-7 | Regularización del merge de 02C en `main` (`de6c04a`) | Owner de CP | Registrado, no regularizado |
| B-8 | `contractStatus: approved` (PB-5) | CP + R4 | Pendiente (J7) |

## 4. Firma

| Campo | Valor |
|---|---|
| Firmante (owner de Customer Profile) | _pendiente_ |
| Fecha | _pendiente_ |
| Evidencia de la decisión | _pendiente_ (declaración del owner en sesión o commit firmado) |
| Transcripción a CP §9.1 | _pendiente_ (commit documental de CP, mandato aparte) |

```text
G16=PENDING
AP_01_AP_08_AP_11_CP_OWNER_ACCEPTANCE=PENDING
CP_D2_ACCEPTED_FOR_SYNTHETIC_INTEROPERABILITY (2026-10-20; no resuelve G-16)
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
