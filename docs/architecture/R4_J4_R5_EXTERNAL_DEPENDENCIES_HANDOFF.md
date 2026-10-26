---
title: R4-J4-R5 — Registro de handoff de dependencias externas (CIA, Customer Profile, Operación)
status: handoff
mandate: R4-J4-R5-OWNER-REVIEW-AND-MERGE-11 (actualiza R4-J4-R4-OWNER-ACCEPTANCE-AND-R5-PREPARATION-10)
date: 2026-10-22
---

# R4-J4-R5: entregables externos pendientes para el canary aislado de `sales-production@8`

Este registro **no implementa** nada fuera de R4: CIA y Customer Profile no se modificaron desde este repositorio. Cada fila es un entregable del owner indicado, con la evidencia que R4 necesita para pedir la revisión del despliegue del canary.

El lado R4 está listo a nivel de código (`main` con PR #20, #21 y #22): RR-1 R-4 integrado, tooling del canary con singleton atómico, rollback y purga verificables. **No se desplegó nada; J4-R5 no se ejecutó.**

El canary consume los servicios de prueba con `R4_CUSTOMER_MODE=synthetic`, credenciales `synthetic-` y hosts declarados en la allowlist cerrada `R4_CANARY_TEST_HOSTS` (https, nombres DNS exactos, máximo 4, vacía por defecto). Ver `R4_J4_R5_CANARY_TOOLING_REPORT.md`.

## CIA — owner de `MS-pesaschile-customer-identity-authority` (`main` `7525395`)

| # | Entregable | Estado hoy | Evidencia que R4 necesita |
|---|---|---|---|
| CIA-H1 | **Runtime sintético aprobado** (el servicio, no solo el contrato v1-d2) | Solo el contrato está aceptado para interop sintética | Registro de aceptación del owner de CIA para el runtime en modo sintético |
| CIA-H2 | **Configuración segura de despliegue fuera de loopback** | `validateConfig` e `isolation.ts` rechazan todo lo que no sea loopback | Configuración de prueba versionada que acepte el host de prueba, la BD de prueba y el egress acotado, sin habilitar datos reales (correo stub, emisor `.test`, claves sintéticas) |
| CIA-H3 | **Artefacto reproducible** | No hay Dockerfile, CI/CD ni artefacto | Imagen o paquete con su SHA, instrucciones y prueba de humo sintética |
| CIA-H4 | **Host HTTPS de prueba exacto** | No existe | Nombre DNS exacto (para `R4_CANARY_TEST_HOSTS`), certificado válido y declaración de que es de prueba |
| CIA-H5 | **Propiedad operativa** | Sin asignar | Responsable nombrado del servicio de prueba (arranque, parada, incidentes, rotación de credenciales `r4-sales` y `channel-integration`) |

Fuera del alcance del canary (J7): KMS (DEP-6), correo real (DEP-5), adaptador PrestaShop real (DEP-2/3), DEP-10, OD-CIA-2..5.

## Customer Profile — owner de `MS-pesaschile-customer-profile` (`main` `bbd766e`)

| # | Entregable | Estado hoy | Evidencia que R4 necesita |
|---|---|---|---|
| CP-H1 | **S5 desplegado en modo de prueba aislado** | S5 no desplegado; producción en `23a2ef3`, separada | Host HTTPS de prueba con nombre exacto, BD solo sintética, versión desplegada declarada |
| CP-H2 | **Principal `r4-sales` registrado** con el scope mínimo `customer.sales_context.read` | No registrado en ningún entorno | Configuración del entorno de prueba |
| CP-H3 | **Grant sintético verificado en `enforce`** | Por defecto `off`/`disabled` | Prueba de humo: grant válido → 200; grant ajeno → 403 `grant_rejected` |
| CP-H4 | **X5–X7 completados**: X5 (`enforce` con principal mínimo), X6 (correlation id, 503/504 tipados, rate limit), X7 (contención de red de `:3010`) | X5 bloqueado, X6 no implementado, X7 pendiente | Evidencia de cada una en el entorno de prueba |
| CP-H5 | **G-16 / AP-01..08, AP-11** | Pendientes | Se siguen **por separado** como gates de aceptación formal (cierre de J4-R1B / J4-R6). No bloquean la revisión del despliegue del canary sintético |

Fuera del alcance del canary (J7): L-1, lector PrestaShop real, contrato `approved`, gate de resiliencia con MariaDB real, AP-09/AP-10/D13/D14.

## Operación — owner de la infraestructura R4

| # | Entregable | Evidencia que R4 necesita |
|---|---|---|
| OP-H1 | **Autorización EC2** separada de producción para el canary J4 | Mandato explícito con host, alcance y duración |
| OP-H2 | **Aislamiento de red** | Base dedicada cuyo nombre contenga `canary`; sin ruta a la BD productiva ni al RDS de PrestaShop; egress limitado a los hosts de prueba listados. Evidencia de red |
| OP-H3 | **Inventario de procesos** | Exactamente un `sales:canary gateway`, un `sales:canary run` y la ingesta `send`; ningún `apps/channel-gateway` contra la base del canary. El tooling garantiza el gateway único del canary (lock atómico); el inventario cubre lo que el tooling no ve (procesos de plataforma con otro `application_name`) |
| OP-H4 | **Secretos solo de prueba** | Keyring sintético y credenciales `synthetic-`, por proceso: el keyring y `confirm` solo en `gateway`/`send`; el worker los rechaza. Entrega por canal seguro, nunca en el repositorio |
| OP-H5 | **Runbook de despliegue y rollback** | Basado en `R4_J4_R5_CANARY_TOOLING_REPORT.md` §2: `init` (migra la base del canary, incluida `0011`), gateway, run, send; rollback `full → protect_only → (ventanas vencidas) → absent → @7`; cierre con `purge --confirm <canaryId>` archivando la evidencia (`rowsRemaining: 0`, `realCustomers` en cero, sha256). La migración Core `0011` se aplica solo con orden explícita (`db:migrate` o `init`), nunca por el merge |

## R4 (internas)

| # | Ítem | Estado |
|---|---|---|
| R4-1 | RR-1 R-4 (inmutabilidad de bindings, `0011`) | **Fusionado** (PR #21, `main` `b18113f`); no desplegado |
| R4-2 | Tooling del canary `@8` | **Fusionado** (PR #22, `main` `4c97ba0`); no ejecutado |
| R4-3 | Autorización del owner para **desplegar y ejecutar** J4-R5 | **Condicional** (2026-10-26): solo en un entorno sintético aislado, aprobado explícitamente y con todos los gates del preflight cumplidos. Estado: `R4_J4_R5_EXECUTION_PREFLIGHT_REPORT.md` |
