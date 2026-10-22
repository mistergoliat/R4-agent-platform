---
title: R4-J4-R5 — Registro de handoff de dependencias externas (CIA, Customer Profile, Operación)
status: handoff
mandate: R4-J4-R4-OWNER-ACCEPTANCE-AND-R5-PREPARATION-10
date: 2026-10-22
---

# R4-J4-R5: dependencias externas para el canary aislado de `sales-production@8`

Este registro **no implementa** nada fuera de R4: CIA y Customer Profile no se modificaron. Cada fila es un trabajo del owner correspondiente, con la condición que R4 necesita para declarar el canary listo para ejecutarse.

El canary consume los servicios de prueba con:
- `R4_CUSTOMER_MODE=synthetic`;
- credenciales `synthetic-`;
- hosts declarados en la allowlist cerrada `R4_CANARY_TEST_HOSTS` (https, nombres exactos).

Ver `R4_J4_R5_CANARY_TOOLING_REPORT.md`.

## CIA (`MS-pesaschile-customer-identity-authority`, `main` `7525395`)

| # | Pedido | Estado hoy (auditoría 2026-10-22) | Condición de aceptación para R4 |
|---|---|---|---|
| CIA-H1 | **Aceptación del runtime** (servicio, no solo contrato) en modo sintético | Solo está aceptado el contrato v1-d2, para interop sintética (`CIA_S4_RUNTIME_UNCHANGED`) | Registro de aceptación del owner de CIA para el runtime sintético |
| CIA-H2 | **Desplegabilidad sintética fuera de loopback**: configuración segura que acepte un host de prueba, la BD de prueba y el egress acotado | `validateConfig` e `isolation.ts` rechazan todo lo que no sea loopback | Una configuración de prueba versionada que no habilite datos reales: correo stub, emisor `.test`, claves sintéticas |
| CIA-H3 | **Artefacto reproducible** (imagen o paquete, con instrucciones) | No hay Dockerfile, CI/CD ni artefacto | El artefacto y su SHA, más una prueba de humo sintética |
| CIA-H4 | Endpoint https con nombre DNS exacto para la allowlist del canary | No existe | El nombre, el certificado y la confirmación de que el servicio es de prueba |
| CIA-H5 | Credenciales sintéticas separadas: agente `r4-sales` (`resolve` y `start`) y `channel-integration` (`confirm`) | Existen en la configuración sintética local | Entrega por un canal seguro a Operación; nunca en el repositorio |

Lo que **no** se pide para el canary (es de J7): KMS (DEP-6), correo transaccional real (DEP-5), adaptador PrestaShop real (DEP-2/3), DEP-10 y OD-CIA-2..5.

## Customer Profile (`MS-pesaschile-customer-profile`, `main` `bbd766e`)

| # | Pedido | Estado hoy | Condición de aceptación para R4 |
|---|---|---|---|
| CP-H1 | **G-16 y AP-01..08, AP-11**: pronunciamiento formal del owner | Pendientes | Registro firmado. Bloquea el cierre formal de J4-R1B, no la preparación |
| CP-H2 | **Entorno de prueba** con S5 desplegado (verificador de grants), separado de producción (producción está en `23a2ef3`, sin verificar hoy) | S5 no desplegado | Host de prueba https con nombre exacto, BD solo sintética y versión desplegada declarada |
| CP-H3 | **Grant verificado bajo `enforce`**: `CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE` activo en modo sintético, principal `r4-sales` registrado con el scope mínimo `customer.sales_context.read` | Por defecto `off`/`disabled`; principal no registrado en ningún entorno | Configuración del entorno de prueba más una prueba de humo: grant válido → 200; grant ajeno → 403 `grant_rejected` |
| CP-H4 | **X5–X7**: X5 (`enforce` con principal mínimo), X6 (correlation id, 503/504 tipados, rate limit) y X7 (contención de red de `:3010`) | X5 bloqueado, X6 no implementado, X7 pendiente | Evidencia de cada una en el entorno de prueba |
| CP-H5 | Datos sintéticos de facts coherentes con la CIA de prueba (`customerRef` del rango sintético) | El productor solo acepta `kind: synthetic` | Rango y fixtures acordados con la CIA |

Lo que **no** se pide para el canary (es de J7): L-1, lector PrestaShop real, contrato `approved`, gate de resiliencia con MariaDB real, AP-09/AP-10/D13/D14.

## Operación

| # | Pedido | Condición de aceptación |
|---|---|---|
| OP-H1 | **Autorización EC2** separada de producción para el canary J4 (mandato explícito) | Registro de autorización con host, alcance y duración |
| OP-H2 | **Inventario de procesos** del canary: exactamente un `sales:canary gateway`, un `sales:canary run` y la ingesta `send`; ningún gateway de plataforma contra la base del canary | Lista de procesos verificada antes de iniciar. El tooling además rechaza las réplicas detectables (`pg_stat_activity`) |
| OP-H3 | **Aislamiento**: base dedicada cuyo nombre contenga `canary`, sin ruta de red a la BD productiva ni al RDS de PrestaShop, egress limitado a los hosts de prueba listados | Evidencia de red y la allowlist aplicada |
| OP-H4 | **Secretos de prueba**: keyring sintético y credenciales sintéticas, solo en los procesos de rol gateway (`gateway`, `send`); el worker nunca los recibe | Variables por proceso documentadas. El worker las rechaza |
| OP-H5 | **Evidencia de 0 clientes reales** | Al cierre, `sales:canary purge --confirm <canaryId>` con `realCustomers` en cero y `rowsRemaining: 0`, archivada con su sha256 |

## Dependencias internas de R4 (no externas)

| # | Pedido | Estado |
|---|---|---|
| R4-1 | RR-1 R-4 (inmutabilidad de bindings) | PR #21, en revisión |
| R4-2 | Tooling del canary `@8` | PR de este frente, en revisión |
| R4-3 | Autorización del owner para **ejecutar** J4-R5 | Pendiente: la preparación no la autoriza |
