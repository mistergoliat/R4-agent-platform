---
title: R4-J4-R5 — Preflight de ejecución del canary integrado sintético
status: blocked
mandate: R4-J4-R5 Resume Execution and Prepare Integrated Canary (owner, 2026-10-26, J4 P0)
date: 2026-10-26
base: main 4c97ba0
---

# R4-J4-R5: preflight de ejecución

```text
J4_R5_TOOLING_MERGED                       (PR #22, main 4c97ba0)
J4_R5_PREFLIGHT_EVALUATED                  (este informe)
J4_R5_INTEGRATED_CANARY_BLOCKED_WITH_EVIDENCE
J4_R6_ACCEPTANCE_PENDING
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_BOT_LAUNCH_P0
```

**Resultado.** El lado R4 está listo a nivel de código. El canary integrado **no se ejecutó**: faltan los servicios de prueba desplegados de CIA y Customer Profile, el entorno aislado de Operación y la aprobación explícita de ese entorno. La autorización de la fase C es condicional a que se cumplan todos los gates de este preflight; hoy no se cumplen.

**Regla de evidencia.** Las pruebas locales con stubs o con clones locales de CIA/CP (S7, interop 41/41) prueban el código de R4, **no** la interoperabilidad con servicios desplegados. En esta matriz no cuentan como evidencia de despliegue.

## 1. Qué se auditó

| Fuente | Estado observado (2026-10-26) |
|---|---|
| R4 `main` | `4c97ba0` (PR #22). Sin cambios posteriores |
| CIA `origin/main` | `7525395`, igual que en el handoff del 2026-10-22. Sin PR abiertos. Ramas remotas: solo S1–S4 y la revisión D2 |
| CP `origin/main` | `bbd766e`, igual que en el handoff. Sin PR abiertos. Último merge: PR #27 (informe de merge S5) |
| EC2 / entorno de prueba | **No inspeccionado.** El mandato no autoriza acceso al host; no hay entorno de prueba aprobado que auditar |

## 2. Matriz de readiness

Estados: **READY (código)** = implementado y probado en `main` sin servicios desplegados; **BLOCKED** = falta un entregable externo o una decisión; **NOT VERIFIED** = no se pudo observar en este mandato.

| # | Ítem | Owner | Estado | Evidencia | Bloqueante |
|---|---|---|---|---|---|
| 1 | CIA desplegada en prueba con configuración de runtime sintético aprobada | Owner de CIA | **BLOCKED** | CIA `7525395`: `src/config.ts:45-68` exige loopback para `databaseUrl`, `http.host` y `egressAllowHosts`; `src/isolation.ts` bloquea todo egress fuera de la lista. El repo solo tiene `docker-compose.yml` para la BD local: sin Dockerfile, CI ni artefacto. Aceptación solo del contrato v1-d2, no del runtime | CIA-H1 (aceptación del runtime), CIA-H2 (config fuera de loopback), CIA-H3 (artefacto), CIA-H4 (host HTTPS), CIA-H5 (owner operativo) |
| 2 | Customer Profile desplegado en prueba; grants; compatibilidad de contrato | Owner de CP | **BLOCKED** (despliegue y grants). Contrato: **compatible** | Contrato: R4 fija sales-context v1-rc2 en CP `bbd766e` y CP `main` sigue en `bbd766e`. Despliegue: S5 no desplegado. `src/app.ts:28` exige `CUSTOMER_PROFILE_API_AUTH_MODE=enforce` para la ruta sales-context; ningún entorno lo configura. El principal `r4-sales` con `customer.sales_context.read` no está registrado | CP-H1 (S5 en prueba), CP-H2 (principal), CP-H3 (grant en `enforce`), CP-H4 (X5–X7). CP-H5 (G-16/AP-*) no bloquea el canary |
| 3 | Base PostgreSQL dedicada e inventario de migraciones | Operación (base); R4 (inventario) | Inventario **READY (código)**. Base **BLOCKED** | `sales:canary init` exige una base vacía cuyo nombre contenga `canary` (`agents/sales/src/cli/canary/isolation.ts:60`) y migra los tres conjuntos (`runtime.ts:146`): Core `0001`–`0005`, `0007`–`0011` (incluye `0011_binding_identity_immutability`); Sales `0006`–`0009`; `identity_verification` `0011`–`0014`. Ninguna migración se aplica por el merge | OP-H2 (base dedicada sin ruta a producción ni al RDS de PrestaShop) |
| 4 | Credenciales sintéticas, separación de secretos, allowlist HTTPS | Operación (secretos); CIA/CP (hosts); R4 (guardas) | Guardas **READY (código)**. Secretos y hosts **BLOCKED** | Contrato `sales-canary-j4` 7/7: allowlist cerrada (DNS exacto, https, ≤4, vacía por defecto; solo el canary la lee); el worker rechaza keyring y `confirm`; `R4_CUSTOMER_MODE=real` y credenciales no `synthetic-` se rechazan. Mutaciones CJ4-M1..M3 | OP-H4 (keyring y credenciales sintéticas por proceso, por canal seguro); CIA-H4 y CP-H1 (nombres DNS exactos) |
| 5 | Gateway singleton y protección de ingress | R4 (código); Operación (inventario) | **READY (código)**. Inventario **BLOCKED** | Advisory lock de sesión `pg_try_advisory_lock(0x52345343, 8)`; integración «single canary gateway» 3/3; mutaciones canary-j4 13/13; S3 ingress 13/13. Residuo: un gateway de plataforma se detecta por `application_name`, que declara el cliente | OP-H3 (inventario de procesos: ningún `apps/channel-gateway` contra la base del canary) |
| 6 | Worker con perfil `sales-production@8` | R4 | **READY (código)** | `CANARY_PROFILES` incluye `@8` (`runtime.ts:52`); definición v8 fijada (`SALES_PRODUCTION_AGENT_VERSIONS`); J4-R4 aceptado en sintético; mutaciones profile-v8 8/8. **No** ejecutado contra servicios desplegados | Ítems 1, 2 y 9 |
| 7 | Inmutabilidad de bindings y protección del estado OTP | R4 | **READY (código)** | Migración Core `0011` (PR #21): binding_id y created_at inmutables, DELETE rechazado; mutaciones 12/12. Trigger `protection_cannot_shrink` (`identity_verification` `0011`); estado sellado (SEC-S2); integración «OTP flow»: el código no llega a ningún texto persistido. Nada aplicado en una base desplegada | Ítem 3 |
| 8 | Limpieza, rollback y retención de evidencia del canary | R4 (tooling); Operación (runbook, archivo) | Tooling **READY (código)**. Runbook y retención **BLOCKED** | `sales:canary rollback-status`, guarda `assertUninspectedCanaryAllowed`, `sales:canary purge --confirm <canaryId>` (TRUNCATE, compatible con `0011`); integración «rollback … purge» 1/1. Falta decidir dónde se archiva la evidencia JSON (sha256) y por cuánto tiempo | OP-H5 (runbook); decisión del owner sobre la ubicación y retención de la evidencia |
| 9 | Aislamiento operativo respecto de producción y de los gateways de plataforma | Operación | **BLOCKED / NOT VERIFIED** | Ningún entorno aprobado. Producción sigue en `sales-production@3` (no se inspeccionó el host). El precedente J3E (checkout aislado `~/r4-j3e-canary`) no es un entorno J4 aprobado | OP-H1 (autorización EC2 separada de producción, con host, alcance y duración), OP-H2 (red), OP-H3 (procesos) |
| — | Aprobación explícita del entorno para la ejecución | Owner | **PENDIENTE** | La autorización del 2026-10-26 es condicional («after all preflight gates are satisfied and the environment is explicitly approved») | Ítems 1–9 |

**Resumen.** Código R4 listo: ítems 5, 6 y 7. Código R4 listo con entorno pendiente: ítems 3, 4 y 8. Externos: ítems 1, 2 y 9. Ninguno está listo en un entorno: los nueve dependen de entregables de CIA, CP u Operación, o de la aprobación del entorno.

## 3. Fase C — ejecución del canary

**No ejecutada.** Motivo: ítems 1, 2, 3, 4, 8 y 9 en BLOCKED y sin aprobación del entorno. El mandato ordena detenerse ante cualquier fallo no resuelto de autorización o aislamiento del entorno.

No se hizo:
- ninguna conexión a EC2 ni a un host de prueba;
- ningún despliegue, migración ni arranque de componentes del canary;
- ningún uso de datos o credenciales reales.

La secuencia que se ejecutará cuando se cumplan los gates está en `R4_J4_R5_CANARY_TOOLING_REPORT.md` §2. La evidencia a registrar: interacciones con los endpoints desplegados, trazas, errores, escenarios pareados `@7`/`@8`, rollback a `@7` y la purga con `rowsRemaining: 0`.

## 4. Fase D — prueba de recuperación

`tests/recovery/production-bootstrap-process.test.ts` esperaba que el bootstrap registrara solo `sales@3`; registra `sales@3`–`sales@8` desde J2D/J4-R4. La corrección deriva la lista esperada del registro versionado `SALES_PRODUCTION_AGENT_VERSIONS` y conserva la aserción exacta. Va en un PR separado sin auto-merge; resultados en ese PR.

## 5. Fase E — J4-R6

**No preparada**: exige un canary integrado ejecutado. `J4_R6_ACCEPTANCE_PENDING`. J4 no se declara completo con pruebas locales sintéticas.

## 6. Acciones para desbloquear (por owner)

| Owner | Acción mínima para el canary |
|---|---|
| CIA | Mandato de CIA para un runtime de prueba: config fuera de loopback acotada (host, BD y egress de prueba; correo stub; emisor `.test`), artefacto con SHA, host HTTPS exacto y responsable operativo (CIA-H1..H5) |
| Customer Profile | Desplegar S5 en prueba aislada con `enforce`, principal `r4-sales` (`customer.sales_context.read`), humo de grant 200/403 y X5–X7 (CP-H1..H4) |
| Operación | Autorización EC2 separada de producción; base `*canary*` dedicada; red limitada a los hosts de prueba; secretos sintéticos por proceso; runbook (OP-H1..H5) |
| Owner R4 | Aprobar explícitamente el entorno resultante; decidir ubicación y retención de la evidencia del canary |

## 7. Límites respetados

- Harness sin cambios (`packages/*`, `apps/*`): este informe y la corrección de la fase D no los tocan.
- Sin arquitectura de extensiones, sin Checkout como prerrequisito, sin datos reales, sin capacidades productivas de Customer, sin despliegue ni mutación de producción, sin merge automático.
