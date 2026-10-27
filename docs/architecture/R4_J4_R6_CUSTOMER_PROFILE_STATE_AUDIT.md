---
title: R4-J4-R6 — Auditoría del estado real de Customer Profile en J4
status: audit
mandate: R4-J4-R6 Final Acceptance and Customer Profile Contract Closure (owner, 2026-10-27), Fase B
date: 2026-10-27
---

# R4-J4-R6: estado real de Customer Profile en J4

Auditoría de solo lectura de `mistergoliat/MS-pesaschile-customer-profile`. No se modificó CP, no se accedió
a EC2, RDS ni PrestaShop, y no se leyeron datos reales.

Etiquetas: **GIT** = verificado con `git fetch` + `git show`/`git grep` sobre `origin/main` el 2026-10-27 ·
**DOC** = afirmado en un documento de CP, sin verificación propia · **R4** = verificado en R4 `origin/main` `09d6579`.

## 0. Línea base

| Aspecto | Resultado |
|---|---|
| CP `origin/main` | **`bbd766e`** (= línea base reportada). `git log bbd766e..origin/main`: **0 commits** (GIT) |
| Ramas J4 sin fusionar | `docs/j4-d2-acceptance-s5-readiness` `9a1e27e` (1 commit documental, informe de readiness D2/S5). `docs/cp-j4-s5-d2-contract-alignment` y `feat/cp-j4-context-02c-synthetic`: ya contenidas en `main` (GIT) |
| CP productivo | `23a2ef3`, anterior a J4; escucha en `*:3010` (DOC: informe J4-R5 §2, F-5). No re-inspeccionado en este mandato |
| Pin de R4 | `adapters/domains/customer/http/contract-v1-rc2/SOURCE.json` → `ownerCommit` `bbd766e` (R4) |

## 1. Componentes S5 fusionados

Todos por PR #26 (merge commit `fff8ac7`) y el informe de merge por PR #27 (`bbd766e`) (GIT):

| Commit | Componente |
|---|---|
| `16c5ad3` | P0 de S5 |
| `8e89a6b` | S5.1 — contrato CIA `grant v1-d2` fijado (33 archivos con hash) |
| `13b4961` | S5.2 — verificador ES256 de grants CIA |
| `8fe5420` | S5.3 — configuración y guardas (`CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE` = `disabled` \| `required`; default **`disabled`**) |
| `957672b` | S5.4 — verificación del grant **antes** del productor; adopción de v1-rc2 en el runtime |
| `565461e` | S5.5 — interop sintética CIA ↔ CP |
| `410bfbd` | Revisión: opción de grant congelada; subclases del verificador rechazadas |
| `3b43664` | AUDIT-01: `kidObserved` / `kidAuthenticated` |
| `a137961` | Registro de la deuda **L-1** (sigue **abierta**) |

`required` exige `enforce` y la ruta habilitada (`src/config.ts:294-316`, GIT). **No desplegado**: producción no verifica grants.

## 2. `sales-context v1-rc2`

- `docs/contracts/customer-sales-context-v1-rc2/SOURCE.json`: `"contractStatus": "candidate"`, `"publishedApi": false` (GIT).
- Aceptado **solo como candidato** de la interfaz D2 (`CP-D2-ACC-02`, `docs/reviews/J4_D2_CP_ACCEPTANCE_RECORD.md`), que dice expresamente «esto **no** es `approved`».
- **Conclusión: sigue siendo un contrato candidato.** Ningún commit lo pasa a `approved`.

## 3. Fuentes de datos implementadas para `sales-context`

| Hecho | Evidencia (GIT) |
|---|---|
| El puerto admite un solo tipo de fuente: `SALES_CONTEXT_SOURCE_KINDS = ['synthetic']` | `src/domain/customer-sales-context/facts-source.ts` |
| La configuración solo acepta `CUSTOMER_PROFILE_SALES_CONTEXT_SOURCE=synthetic`; habilitar la ruta exige `enforce` | `src/config.ts:155-164`, `:277-292` |
| Implementación única: `synthetic-facts-source.ts` + `synthetic-dataset.ts` (dataset embebido) | `src/application/customer-sales-context/` |
| Fuente distinta (`prestashop`, `mariadb`, `rds`, `live`) → rechazo al construir o al arrancar; `mysql2` nunca se invoca | DOC: `CP_J4_CONTEXT_02C_PROVISIONAL_VALIDATION_REPORT.md` §7 |

**Conclusión: el productor nuevo de `POST /v1/capabilities/customer/sales-context` es exclusivamente sintético.**
No existe un reader real que implemente el puerto.

## 4. Endpoints heredados con datos reales ≠ endpoint gobernado de Sales

No deben confundirse:

| | Endpoint gobernado de Sales (J4) | Endpoints heredados de CP |
|---|---|---|
| Ruta | `POST /v1/capabilities/customer/sales-context` (único) | `GET /v1/customers/:customerId/{profile, purchased-products, purchase-behavior, commercial-summary, commercial-profile, orders/:reference/status, rfm, clv, cluster, affinity, intelligence}`, dashboards y copilot |
| Fuente | Sintética únicamente | PrestaShop (MariaDB/RDS) y snapshots analíticos **reales** |
| Autorización | Bearer + scope `customer.sales_context.read` + grant CIA por cliente (`required`) | Scopes de servicio; el `customerId` lo afirma el llamador (sin grant por cliente) |
| Contrato | v1-rc2 `candidate` | Sin contrato versionado de J4 |
| Uso por R4 | Sí (adaptador `adapters/domains/customer/http`) | **Nunca**. R4 no debe consumirlos |

Que CP productivo sirva datos reales por las rutas heredadas **no** significa que exista una fuente real para
`sales-context`.

## 5. Readers PrestaShop existentes reutilizables para la proyección factual real

El puerto pide `SalesContextAccountRecord` (flags de `ps_customer`) y `PurchasedVariantRecord` (agregado por
variante sobre órdenes válidas). Candidatos (GIT, `src/infrastructure/prestashop/`):

| Necesidad del puerto | Reader existente | Brecha conocida (DOC) |
|---|---|---|
| Existencia de la cuenta | `mysql-prestashop-customer-identity-repository.ts` | Solo `SELECT id_customer`; **no lee `is_guest`, `deleted` ni `active`** (F-05, `CP_CUSTOMER_INTELLIGENCE_DEEP_ARCHITECTURE_AUDIT.md`) |
| Flags de cuenta | `mysql-prestashop-customer-reader.ts` | Lee `active` (GIT, línea 28), **no** `is_guest` ni `deleted`; además selecciona PII (`firstname`, `lastname`, `email`) que el puerto no necesita. La exclusión de cuentas operacionales no existe como reader |
| Variantes compradas | `mysql-purchased-products-reader.ts` (`o.valid = 1`, agregado por `(product_id, product_attribute_id)`) | `coerceNonEmptyString` da 500 con nombre en blanco (CTX-11b); `parseRequiredUtcDateTime` convierte a UTC. **No reutilizable tal cual**: el reader real debe entregar valores crudos (02C §8) |
| Conteo de órdenes válidas | `mysql-customer-product-behavior-reader.ts`, `mysql-customer-orders-reader.ts` | Solo como referencia de consultas |
| Servicios administrativos (`seller-service`) | Ninguno | Política aprobada sin reader |
| Pool | `prestashop-pool.ts` | `queueLimit` 0 y sin acquire timeout; la ruta necesita pool dedicado o cola finita |

**Conclusión:** los readers existentes cubren las consultas base, pero ninguno se puede enchufar al puerto sin
un slice autorizado que corrija los mapeos (CTX-11b, UTC), añada los flags de cuenta y cierre el gate de
resiliencia con MariaDB real (`RESILIENCE_REAL_PROVIDER_GATE=OPEN`). Es trabajo de J7.

## 6. Decisiones AP: aceptación formal

| Fuente | Hecho |
|---|---|
| `CP_J4_R4_CONTRACT_ALIGNMENT.md` §9.1 (GIT) | AP-01 a AP-08 y AP-11: **PENDIENTE**. La atribución de `7b2e7f7` se retiró en `7373302`. «Para cerrar la aceptación: el owner de CP la registra él mismo en esta sección, con su identidad, la fecha y el estado por AP» |
| `CP_J4_F3_GATE_REGULARIZATION.md` §2 (GIT) | `G-16=PENDING`, `CP_OWNER_FORMAL_ACCEPTANCE=PENDING`, por **ausencia real** de aceptación |
| `J4_D2_CP_ACCEPTANCE_RECORD.md` (GIT) | Aceptadas (Felipe Porte, 2026-10-20) **solo** CP-D2-ACC-01/02/03, y declara que **no** regulariza G-16 ni AP-01..AP-11 |
| `CP_J4_S5_OWNER_MERGE_REPORT.md` §6 (GIT) | G-16 **PENDIENTE**; AP-01 a AP-11 y AP-04-H **PENDIENTES** |
| R4-J4-R1C §3 (R4) | R4 aceptó su posición en AP-01..AP-11 (lado consumidor), no la de CP |

**Conclusión: ninguna AP tiene aceptación formal del owner de CP.** Hay una excepción de desarrollo
(`CP_J4_02C_PROVISIONAL_IMPLEMENTATION_OVERRIDE`) que explícitamente no es aceptación.

## 7. G-16

**G-16 sigue abierto.** Criterio (R4-J4-R1C §6.2): «conformidad del owner de CP registrada para AP-01 a AP-08 y
AP-11 — documento de alineamiento de CP». No hay tal registro. La aceptación D2 sintética no lo resuelve (lo
dice ella misma). El registro preparado para cerrarlo está en
[`R4_J4_G16_CP_ACCEPTANCE_RECORD.md`](../acceptance/R4_J4_G16_CP_ACCEPTANCE_RECORD.md), sin firmar.

Hallazgo de gobierno asociado y **no regularizado**: el productor 02C se fusionó a `main` (`de6c04a`, PR #25 de CP,
2026-10-18) aunque el override excluía el merge y lo condicionaba a la aceptación formal.

## 8. Gates de seguridad y calidad de datos diferidos a J7

| Gate | Estado | Fuente |
|---|---|---|
| L-1: grant que vence durante la composición → hoy 500; debe ser 403 con motivo propio | Abierta (baja) | `CP_J4_S5_DEBT_L1_…` |
| `RESILIENCE_REAL_PROVIDER_GATE`: cancelación en servidor (`max_statement_time`), cola de pool finita, saturación con MariaDB real, p95 | Abierto | 02C §8 |
| Contención de red de `:3010` (H-1 / X7), `enforce` en producción y migración del CRM-agent | Solo documentado; producción en `*:3010` | SECURITY-01; J4-R5 F-5 |
| X6: correlation id extremo a extremo, 503/504 tipados, limitador por principal (429, PB-8) | No implementado | Handoff CP-H4 |
| `contractStatus: approved` (PB-5) | Pendiente | §2 |
| Owner de datos: legitimidad de los propósitos (AP-03, PB-11); cuentas eliminadas, guest e inactivas (AP-09, PB-3, PB-12) | Pendiente | Alineamiento §8.2, §9 |
| Comercial: precio cero y `lineKind` (AP-10); Catalog: D6 (`catalogKey: null`) | Pendiente | Alineamiento §9 |
| AP-04-H: `commercial-profile` fuera de `customer.facts.read` (con inventario previo) | Pendiente | Alineamiento DEC-04 |
| Riesgo residual de revocación (TTL sin introspección) para datos reales | No aceptado | D2 record §2 |
| Zona horaria (D14, `unverified`), D13/D-SPLIT | No bloquean | Alineamiento §8.3 |
| Emisor y claves CIA reales (KMS, DEP-6) | Ausente por diseño | Handoff |

## 9. Resultado

```text
CP_MAIN=bbd766e (sin cambios desde la línea base)
CP_S5=MERGED_SYNTHETIC_ONLY, NOT_DEPLOYED
CP_SALES_CONTEXT_V1_RC2=CANDIDATE
CP_SALES_CONTEXT_SOURCE=SYNTHETIC_ONLY
CP_REAL_READER_FOR_SALES_CONTEXT=ABSENT (reutilización parcial posible; J7)
AP_01_AP_08_AP_11_CP_OWNER_ACCEPTANCE=PENDING
G16=PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
