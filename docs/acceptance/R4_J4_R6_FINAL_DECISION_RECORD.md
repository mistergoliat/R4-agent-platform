---
title: R4-J4-R6 — Decisión final de J4
status: decision — J4_R6_BLOCKED
mandates: R4-J4-R6 Final Acceptance and Customer Profile Contract Closure (2026-10-27); R4-J4-R6 Evidence Verification and Contract Acceptance (2026-10-27)
date: 2026-10-27
base: R4 main e9a9bcb (PR #25 fusionado)
---

# R4-J4-R6: decisión final

```text
J4_R6_BLOCKED
```

Decisiones del owner aplicadas (2026-10-27):
- se mantiene `J4_R6_BLOCKED`;
- se autorizó la inspección de solo lectura del EC2 y el merge condicionado del PR #25;
- se ratificaron las posiciones de R4 sobre AP-01..AP-08 y AP-11, sin marcar la conformidad de CP;
- F-1 sigue **dentro** de la frontera de aceptación de J4-R6. El aviso determinista no prueba que la confiabilidad
  conversacional esté restablecida;
- no hay rollout productivo ni activación pública de WhatsApp.

Los nueve criterios originales (`R4_J4_CROSS_REPO_ROADMAP_REBASE_REPORT.md` §9) **no se modificaron**.

## 1. Lo hecho en este cierre

| Fase | Resultado | Registro |
|---|---|---|
| A — Evidencia en el EC2 | 23/23 hashes OK. Integración, OTP, dispatcher, rollback protegido, ausencia de huérfanas, purga (0 filas) y aislamiento de `@2`: **verificados**. Brechas desplegadas **confirmadas**: grant ajeno o provisional, 401/403 hacia R4 y quote `guest` con CP caído. Erratas EV-1..EV-3 | [Verificación](R4_J4_R5_EVIDENCE_VERIFICATION.md) |
| B — PR #25 | Preflight final: head `e6debe8`, base `09d6579`, diff sin cambios, GitGuardian en verde. Build, typecheck, lint, unit 1519 y contract 450 sobre ese head. Fusionado con `--match-head-commit`: **`main` `e9a9bcb`**. Archiva un canary con un fallo de confiabilidad conocido; **no** acepta J4 | PR #25 |
| C — G-16 | Posiciones de R4 ratificadas con sus condiciones. Solicitud de conformidad por ítem para CP §9.1 redactada; su commit en CP espera una identidad de autor autorizada. **G-16 PENDIENTE** | [Registro G-16](R4_J4_G16_CP_ACCEPTANCE_RECORD.md) |
| D — F-1 | Causa reproducida y corregida en el adaptador DeepSeek existente, sin tocar el parser, el kernel, el protocolo v5 ni el proveedor. Replay local de 21 peticiones: **8/63 → 0/99** malformadas (familias difíciles 8/36 → 0/72, p = 8,6e-5). Regresión completa en la rama. **Sin merge ni canary repetido** | PR #30; `R4_J4_R6_F1_STRUCTURED_OUTPUT_CORRECTION_REPORT.md` (en esa rama) |

## 2. Los nueve criterios

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | `@8`/v8 en `main`, capacidades exactas, mapa de versiones fijado | **MET** | PR #19 `3e04b4f`; `J4_R4_SYNTHETIC_ACCEPTED` |
| 2 | Huellas `@1`–`@7` y v3–v7 sin cambios | **MET** | Contract 450/450 sobre `e6debe8` y sobre la rama de PR #30 |
| 3 | Composición `@8` fail-closed, con mutaciones | **MET** | `profile-v8` 8/8, `canary-j4` 13/13 |
| 4 | Regresión completa en verde sobre el commit candidato | **PARTIAL** | Completa en la rama de PR #30 (unit 1520, contract 450, integration 607, sales 29, shadow 5, recovery 18/18). Falta repetirla sobre el commit que finalmente se acepte, tras los merges |
| 5 | Pareado `@7`/`@8` sin regresión; nunca repite secretos | **MET** | Comparación J4-R4; F-1 afectó a ambos perfiles; OTP en 0 columnas válidas (§3 de la verificación). La corrección F-1 mantiene la copia de la oferta J3E-C1 (8/8) |
| 6 | J4-R5 en verde con servicios desplegados, modo `synthetic` | **NOT MET** | F-1 corregido solo en local; el canary no se repitió. Sin evidencia desplegada de: grant ajeno o provisional → `unavailable`, 401/403 → `unauthorized`, CP caído → quote `guest` |
| 7 | Rollback `@8 → @7` protegido, sin huérfanas, `@7` intacto, dispatcher | **PARTIAL** | Rollback, huérfanas, `@7` y dispatcher: **verificados** en el EC2. Pendientes: «R5 PASS» y el hallazgo EV-2 (tasks `@8` que siguen en el worker `@7` con instrucciones v8) |
| 8 | G-16 y AP-01..08, AP-11 con pronunciamiento formal del owner de CP; D7 y `R4_CONTEXT_EXPIRED_EVIDENCE` decididos | **NOT MET** | D7 del canary y `exclude` decididos. Posiciones de R4 ratificadas. **Conformidad de CP pendiente** |
| 9 | Registro de aceptación firmado; gates heredados por J7 | **NOT MET** | Lista J7 lista ([J7-CP](../architecture/R4_J7_CUSTOMER_PROFILE_PRODUCTION_DATA_BACKLOG.md)); el registro no puede firmarse mientras 6–8 sigan abiertos |

## 3. Gates no cumplidos

| Gate | Criterio | Owner | Para cerrarlo |
|---|---|---|---|
| **BG-1** Conformidad de CP (G-16) | 8 | Owner de CP | Responder por ítem la solicitud de CP §9.1.1 (acepta, rechaza o devuelve con ajustes) y firmarla |
| **BG-2** F-1 en el entorno integrado | 6, 7 | Owner R4 | Revisión independiente y merge del PR #30. Después, autorización para repetir el canary J4-R5 en el EC2 y medir la tasa de salidas malformadas y de conversaciones sin respuesta. La recuperación exitosa de la task se mide aparte del aviso determinista (PR #27) |
| **BG-3** Evidencia desplegada faltante | 6 | Owner R4 / Operación | En la repetición: grant ajeno y provisional → `unavailable`; 401/403 → `unauthorized`; CP caído → quote `guest` emitida. Usar el escaneo OTP corregido para columnas `bytea` |
| **BG-4** Regresión sobre el candidato final | 4 | R4 | `npm test` + recovery (al final y solo) sobre el commit que se acepte |
| **BG-5** Registro firmado | 9 | Owner | Tras BG-1..BG-4 y BG-6 |
| **BG-6** Tasks `@8` tras el rollback (EV-2) | 7 | Owner R4 | Decidir y documentar el trato de las tasks `@8` abiertas al volver a `@7` (cerrar, traspasar o dejar fallar cerrado de forma explícita), y verificarlo en la repetición |

**Acción operativa pendiente (no bloquea):** detener y retirar el contenedor vacío `r4-j4-canary-postgres`
(`127.0.0.1:55435`, EV-1). No se hizo porque el acceso fue de solo lectura.

## 4. Gates de producción transferidos a J7

Sin cambios respecto del paquete [J7-CP](../architecture/R4_J7_CUSTOMER_PROFILE_PRODUCTION_DATA_BACKLOG.md):
- fuente factual real y reutilización de readers PrestaShop;
- identidad canónica, grants y claves productivas;
- autorización por cliente y L-1;
- políticas de calidad de datos (AP-03, AP-09, AP-10, D6, D14);
- contención de red de `:3010` y X6;
- contrato `approved`;
- D7 productivo y RR-1 R-1..R-3, RS-01..04, BA-01..06, OA-10;
- canary real con rollback propio desde `@2` (perfil productivo verificado hoy).

Fuera de J4 y de J7-CP: Customer Intelligence V2 y Checkout.

```text
J4_R6_BLOCKED
PRODUCTION_ROLLOUT=NOT_AUTHORIZED
WHATSAPP_PUBLIC_ACTIVATION=NOT_AUTHORIZED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
