---
title: R4-J4 — Informe de convergencia (aceptación de J4-R4 y preparación de J4-R5)
status: for-owner-review
mandate: R4-J4-R4-OWNER-ACCEPTANCE-AND-R5-PREPARATION-10
date: 2026-10-22
---

# R4-J4: convergencia tras la aceptación de J4-R4 y la preparación de J4-R5

```text
J4_R4_PR19_MERGED                           (main 3e04b4fe50f8e9eeb250f6a8d69f67eb13e06b3b)
J4_R4_SYNTHETIC_ACCEPTED
RR1_R4_BINDING_IMMUTABILITY_READY_FOR_REVIEW (PR #21)
J4_R5_CANARY_TOOLING_READY_FOR_REVIEW        (PR de este frente)
J4_R5_EXTERNAL_DEPENDENCIES_PENDING
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

> **Nota posterior (2026-10-22, mandato R4-J4-R5-OWNER-REVIEW-AND-MERGE-11).** El owner aceptó el PR #19 y decidió:
> - PR #20 fusionado → `main` `485df2b`.
> - PR #21 con sus decisiones aplicadas: `binding_id` y `created_at` inmutables, ciclo de vida monótono y DELETE prohibido; mutaciones 12/12; numeración `0011` auditada y válida. Fusionado → `main` `b18113f`; no desplegado.
> - PR #22: el singleton del gateway pasa a un advisory lock de sesión atómico, retenido toda la vida del gateway; el gateway falla cerrado si pierde el lock.
>
> Las preguntas al owner de §3 quedan resueltas por esas decisiones. Los entregables externos exactos están en `R4_J4_R5_EXTERNAL_DEPENDENCIES_HANDOFF.md`.

## 1. Integración del PR #19 (fase A)

| Comprobación | Resultado |
|---|---|
| Baseline | `main` después del PR #18: `3b5c960` |
| HEAD del PR | `5263c7f817b16bc8a2859bac7c205f4b4efd2325`. Después del candidato validado `a066c1a` solo hay documentación y evidencia (`git diff a066c1a 5263c7f`: el informe y `evidence/j4-r4/*`) |
| Harness y contratos | Diff vacío en `packages/*`, `apps/{worker,api,scheduler}` y `adapters/*` (contratos CIA/CP intactos) |
| Huellas de `@1`–`@7` | Fijadas por pruebas de contrato y en verde en el candidato |
| Checks | GitGuardian `success`. `main` sin protección de rama (plan Free) |
| Secretos y activación | Ningún patrón de secreto en el diff. Ninguna configuración por defecto ni productiva selecciona `@8` |
| Merge | `--merge --match-head-commit 5263c7f…` → **`main` `3e04b4fe50f8e9eeb250f6a8d69f67eb13e06b3b`**; el tree es idéntico al de `5263c7f` |

## 2. Regularización documental (fase B): PR #20, sin merge

- **ADR-039 Cond. 3:** los facts de CP ya vencidos al recibirlos fallan cerrado (`freshness_expired`, sin observación). Una observación aceptada vigente que vence después se trata como historia o queda excluida según `R4_CONTEXT_EXPIRED_EVIDENCE`. La clasificación del error no cambia.
- **Adenda ADR-040:** **APPROVED**. Las réplicas mixtas siguen abiertas y bloquean los despliegues mixtos.
- **Roadmap J4-R4:** **DONE (sintético)**, desglosado por dimensión:
  - código integrado;
  - perfil componible solo en sintético (dominios `REAL` aprobados);
  - evaluación aceptada;
  - canary pendiente;
  - datos reales bloqueados.
- **Limitación conocida de `@7`** (`ACCEPTED_AS_KNOWN_LIMITATION`): v7 y sus huellas no se tocan. La prueba del rollback la cubre (§4).

## 3. Frente R4-A: RR-1 R-4, PR #21

- **Qué hace:** migración core `0011_binding_identity_immutability`, un trigger que inmoviliza `channel`, `conversation_key`, `account_ref` y `recipient_ref`, y deja asignar `task_id` una sola vez (ADR-038:312).
- **Pruebas:**
  - 11 pruebas de integración: cada columna; asignación única; cierre y ingesta intactos; concurrencia con `resolve` y con `confirm` (la misma clave de idempotencia y el mismo contexto); upgrade desde 0010 con bindings existentes.
  - Mutaciones 5/5; RR-1 5/5.
- **Despliegue:** cambia el head de compatibilidad core, así que la migración, el gateway y los workers se despliegan juntos. **No se desplegó.**
- **Implementación:** la hizo un agente delegado. Se revisó en esta sesión (alcance y trigger frente al contrato) y se re-verificó con 38/38 pruebas.
- **Preguntas al owner:**
  - `binding_id` y DELETE quedan fuera del contrato;
  - si deben congelarse otras columnas fijadas al abrir el binding;
  - la numeración 0011 frente a J3F.

## 4. Frente R4-B: tooling del canary, PR de este frente

Ver `R4_J4_R5_CANARY_TOOLING_REPORT.md`. Resumen:
- `@8` habilitado en el canary, solo con `exclude`, la misma política en los brazos pareados;
- allowlist cerrada de hosts de prueba (vacía por defecto);
- gateway único con rechazo de réplicas;
- ingesta inspeccionada;
- reinicio y recuperación del dispatcher probados (misma clave);
- rollback `@8 → @7` con `full → protect_only → absent` y `protect_until`;
- limitación de `@7` probada;
- purga verificable;
- rechazo de identidades reales y de rutas productivas;
- mutaciones 10/10.

**No se ejecutó J4-R5.**

## 5. Qué impide hoy ejecutar el canary

| # | Bloqueo | Owner | Detalle |
|---|---|---|---|
| 1 | Revisión y merge de PR #21 (RR-1 R-4) y del PR del tooling | Owner R4 | RR-1 R-4 es obligatorio antes de J4-R5 |
| 2 | **CIA desplegable en un entorno de prueba**: aceptación del runtime, configuración segura fuera de loopback, artefacto reproducible, host https con nombre exacto | CIA | Handoff CIA-H1..H5 |
| 3 | **Customer Profile en un entorno de prueba**: S5 desplegado, grant verificado bajo `enforce`, principal `r4-sales`, X5–X7 | CP | Handoff CP-H2..H5 |
| 4 | **Autorización EC2** separada de producción; inventario de procesos; aislamiento de red; secretos de prueba solo en los procesos con rol de gateway | Operación | Handoff OP-H1..H5 |
| 5 | **Autorización explícita para ejecutar J4-R5** | Owner | La preparación no la otorga |
| — | G-16 y AP-* | CP | Bloquean el cierre formal de J4-R1B, no la preparación. Antes de declarar `J4_RELEASE_CANDIDATE_ACCEPTED` |

Registro detallado: `R4_J4_R5_EXTERNAL_DEPENDENCIES_HANDOFF.md`.

## 6. Lo que sigue bloqueado para datos reales (J7)

- RR-1 R-1..R-3, RS-01..04, BA-01..06, OA-10, D7 productivo;
- CP L-1, lector PrestaShop real, contrato `approved`;
- CIA DEP-2/3/5/6/10, OD-CIA-2..5, KMS y correo real;
- versión de PrestaShop sin validar;
- residual R3-04 (réplicas mixtas en producción).

`R4_CUSTOMER_MODE=real` sigue rechazado por todos los loaders.
