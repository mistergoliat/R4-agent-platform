# R4-J4-R1A-REVIEW-01 — Correcciones y consolidación

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Dictamen del owner | `ACCEPTED_WITH_REQUIRED_CHANGES` |
| Alcance | Corregir y consolidar J4-R1A, preparar ADR-039 para la aceptación interna y versionar los documentos J4 en su rama. Sin J4-R2 ni cambios ejecutables |
| Resultado | **`J4_R1A_REVIEW_CORRECTIONS_COMPLETE`** (§7) |

## 1. Documentos

| Documento | Cambio |
|---|---|
| [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) | Corregido |
| [Especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) | Corregida |
| [Requerimiento para Customer Service](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md) | Actualizado |
| [Requisitos para Customer Profile](R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md) | Actualizados |
| [Informe de diseño R1](R4-J4-R1_DESIGN_REPORT.md) | Matriz D1–D8, plan y estado actualizados |
| [Informe J4-R0](R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md) | **Sin cambios** (SHA-256 `46bfab8ef87f6e20aa702fec86959d82d17a7b4b4abd8a3d2dd6132e0e484d39`) |

La versión de los cinco documentos R1A anterior a esta revisión está preservada en el commit `b680b2c`.

## 2. Matriz de correcciones

| # | Corrección exigida | Qué se hizo | Dónde |
|---|---|---|---|
| A1 | D3 ACCEPTED: resolución perezosa desde `bindingByTask`, sin vinculación estática en la ingress | Marcada **ACCEPTED** y descrita como decisión | ADR-039 §3; especificación §3; informe de diseño §3 |
| A2 | D4: eliminar `displayName` de `get_context@2`; minimización estricta; qué emite CP frente a qué llega al modelo | Se eliminan `displayName` **y** `customerSince`. `get_context@2` solo da el estado de identidad, el indicador de historial y `validUntil`. Tabla de dos columnas (CP puede emitir / llega al modelo), lista de claves prohibidas y fallo cerrado `sensitive_field_present`. CP-04 pide quitar nombre y `displayName` de la ruta | ADR-039 §7; especificación §5, §6.1, §10; requisitos CP CP-04, CP-06 |
| A3 | D5: corregir la incompatibilidad entre `validUntil: null` y un timestamp obligatorio; verificar contra el runtime | El handler expone `validUntil = min(CP.validUntil ?? ∞, grant.expiresAt)`, siempre no nulo en `verified`. El extractor devuelve `null` en `unavailable`. Comportamiento F1–F8 verificado en código y con tests (§4). Se agregan tres condiciones | ADR-039 §6; especificación §6, §7; §4 de este informe |
| A4 | D7: distinguir revocación, reutilización y eliminación; J4-R5 solo con datos sintéticos | Tabla de los tres conceptos con el comportamiento real (reutilización dentro de la tarea con payload; sin eliminación). J4-R5 restringido a datos sintéticos; CS-12 y CP-20 piden entornos sintéticos | ADR-039 §8; informe de diseño §3, §5; requisitos CS CS-12; requisitos CP CP-20 |
| A5 | D2: mantener A como recomendación; modelo de amenazas (R4, token de servicio, grant); el hash del sujeto no es prueba independiente | Modelo de amenazas T1–T7 con residuos. Se aclara que el hash del sujeto deriva de lo que R4 afirma y CP no puede verificarlo. D2 sigue PROPOSED | Requisitos CP §3, §4; ADR-039 §5; requisitos CS CS-05, CS-08 |
| A6 | Contratos: `degraded`, cantidades y fechas desconocidas, orden de paginación, campos adicionales, datos sensibles, identificadores en la infraestructura HTTP | `degraded` en contexto da `unknown`; en historial, fallo `history_degraded`. `null` explícito, nunca 0. Orden total declarado con verificación `order_violation`. Campos desconocidos descartados. Claves sensibles hacen fallar cerrado. Identificadores solo en el cuerpo de `POST` de lectura, nunca en URLs | Especificación §5, §7, §8, §9, §10, §11; requisitos CP CP-04, CP-05, CP-11, CP-16 a CP-19; requisitos CS CS-01 |
| A7 | Documentar que la aceptación de CP-J4-CONTEXT es necesaria para congelar compras válidas, cancelaciones y devoluciones | Sección con el estado observado (CTX-02, -05, -06, -09, -12, -13) y lo que debe fijar la aceptación. El paso de la especificación a v1 y el cierre de J4-R1B lo exigen | Requisitos CP §6, §8; especificación §5, §12; ADR-039 (Consecuencias) |
| A8 | Rollback: separar el del canary `@8 → @7` del perfil productivo, que está en `@3` | El rollback del canary es el que se ensaya en J4-R6. Producción sigue en `sales-production@3` (`ef5a354`); un rollout de `@8` partiría de `@3` y es J7 | ADR-039 §10; informe de diseño §5 (J4-R6) |
| B | Git | §3 | — |

## 3. Evidencia de Git

| Paso | Resultado |
|---|---|
| Auditoría del diff de `99ea7ee` contra `main` (`b5fd288`) | 1 commit; 3 archivos, todos en `docs/` (`docs/acceptance/R4_J3_CLOSURE_RECORD.md` nuevo; `R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md` +4/−1; `docs/roadmap/R4_DELIVERY_ROADMAP.md` +15/−2). 0 archivos fuera de `docs/`. Exclusividad documental **confirmada** |
| Integración del cierre documental de J3 | `git merge --no-ff r4-j3-closure-record` en `main` → **`80f39fd`** (padres `b5fd288`, `99ea7ee`) |
| Publicación de `main` | `git push origin main`: `b5fd288..80f39fd`; `origin/main` = `80f39fd` |
| Rama J4 | `r4-j4-customer-integration` creada desde `80f39fd` y publicada con seguimiento a `origin` |
| Documentos preservados | **`b680b2c`**: el informe J4-R0 sin cambios y los cinco documentos R1A tal como se entregaron antes de la revisión |
| Correcciones | El commit que contiene este informe (siguiente a `b680b2c` en `r4-j4-customer-integration`) |
| No realizado | No se fusionó J4 en `main`. Sin cambios en producción ni en EC2. El worktree de Customer Profile no se tocó (sus cambios sin commit siguen siendo ajenos) |

Alcance de los commits J4 (`git diff --name-only 80f39fd..HEAD`): solo `docs/adr/ADR-039-…` y `docs/architecture/R4-J4-*`, `R4_J4_R0_*`. Sin cambios en `packages/`, `apps/`, `adapters/`, `agents/`, migraciones, perfiles ni `package*.json`.

## 4. D5: verificación contra el runtime

**Lectura de código:**
- `packages/capability-runtime/src/invoker.ts:84-133, 198-216`;
- `registry.ts:31-38`;
- `context-compiler/src/freshness.ts:17-28`;
- `compiler.ts:318-330`;
- `sources/platform.ts:263-297`;
- `task-runtime/src/execution-runtime.ts:412`;
- `persistence-postgres/src/observation-store.ts:27-28`;
- `apps/worker/src/config.ts:39,103`.

**Ejecución** (sin cambios de código):

```text
npx vitest run --project unit tests/unit/capability-runtime/owner-freshness.test.ts \
  tests/unit/context-compiler/compiler.test.ts tests/unit/worker/context-config.test.ts
Test Files 3 passed (3) · Tests 54 passed (54)
```

| # | Comportamiento verificado | Consecuencia para Customer |
|---|---|---|
| F1 | `runtimeValidUntil = observedAt + freshnessTtlMs`, con `observedAt` al terminar el handler | La vigencia corre desde la respuesta, no desde la petición |
| F2 | `validUntil = min(runtime, owner)`; el owner solo acorta | El grant y CP acortan; nunca extienden los 10 min |
| F3 | Un extractor que devuelve `null` hace regir el runtime; uno inválido hace fallar la invocación | Motivo de la corrección A3: `validUntil` siempre no nulo en `verified` |
| F4 | Fallos y rechazos con `validUntil: null` → `unknown`, siguen en el contexto | Solo contienen el error, sin datos de cliente |
| F5 | El mismo `invocationId` reutiliza la observación sin recalcular | La recuperación no extiende vigencias |
| F6 | Una invocación nueva crea una observación nueva; las anteriores no cambian | Cada lectura vuelve a resolver y autorizar |
| F7 | El contexto incluye todas las observaciones **de la tarea**, de cualquier run, con payload; nunca de otras tareas | Reutilización acotada a la conversación |
| F8 | Una observación vencida pasa a historia con payload (`include`, default) o sale del contexto (`exclude`); sigue persistida en ambos casos | La expiración no protege la privacidad: de ahí D4 estricta y D7 |

No verificado: el valor de `R4_CONTEXT_EXPIRED_EVIDENCE` en los despliegues de EC2 (no se accedió). Queda como condición de D5 antes de J4-R5.

## 5. Estado de D1–D8

La matriz completa está en el [informe de diseño](R4-J4-R1_DESIGN_REPORT.md) §3.

| ID | Antes de la revisión | Tras la revisión | Pendiente de |
|---|---|---|---|
| D1 | BLOCKED | **BLOCKED** | Auditoría y aceptación de Customer Service |
| D2 | PROPOSED | **PROPOSED** | Customer Profile y owner de identidad |
| D3 | PROPOSED | **ACCEPTED** | — |
| D4 | PROPOSED | **REQUIRES_CHANGE → corregida** | Confirmación del owner |
| D5 | PROPOSED | **ACCEPTED_WITH_CONDITIONS** | Condiciones de ADR-039 §6 |
| D6 | BLOCKED | **BLOCKED** | CONTEXT-02A y Catalog |
| D7 | PROPOSED | **PROPOSED_PRODUCTION_BLOCKER** | Política de retención (J7) |
| D8 | PROPOSED | **ACCEPTED** | — |

## 6. Dependencias externas abiertas

| # | Dependencia | Owner | Bloquea |
|---|---|---|---|
| X1 | **Auditoría del repositorio de Customer Service** (A1–A12) — **próxima prioridad** | Customer Service | D1 y toda la ruta crítica |
| X2 | Contrato de resolución verificada (CS-01 a CS-12), con identidades sintéticas | Customer Service (si se confirma) | J4-R3 |
| X3 | Corrección o declaración formal del nivel `verified` (vínculos automáticos, `is_verified`, números reciclados, revocación) | Autoridad de identidad | X2 |
| X4 | Aceptación de D2, formato del grant y custodia y rotación de claves | Customer Profile + autoridad de identidad | J4-R2, J4-R3 |
| X5 | Rutas R4 en CP (CP-03 a CP-06, CP-14 a CP-19) con JSON Schema, fixtures y SHA | Customer Profile | J4-R2 |
| X6 | Aceptación de CP-J4-CONTEXT (compras válidas, cancelaciones, devoluciones, unidades, fechas y zona) | Customer Profile | Especificación v1, J4-R1B |
| X7 | CONTEXT-02A revisado e integrado, y mapeo de producto de Catalog (D6) | Customer Profile + Catalog | J4-R4 (o diferir con `catalogKey: null`) |
| X8 | `enforce`, restricción de red, correlation id y rate limit en el despliegue de CP (CP-01, CP-09 a CP-12) | Customer Profile / operación | J4-R5 |
| X9 | Entorno de integración con datos sintéticos (CP-20, CS-12) | Customer Profile + Customer Service | J4-R5 |
| X10 | SECURITY-01 y RESILIENCE-01 de CP en su `main` (hoy solo en una rama local) | Customer Profile | Referencias verificables en J4-R1B |
| X11 | Política de retención y purga de observaciones (D7) | Plataforma R4 (J7) | Datos reales y producción |

## 7. Resultado

```text
RESULT=J4_R1A_REVIEW_CORRECTIONS_COMPLETE

PROJECT=R4_AGENT_PLATFORM
J3_TECHNICAL=CLOSED
J3_ADMIN=MERGED (80f39fd en main y origin/main)

J4_R0=READY_WITH_BLOCKERS
J4_R1A=DESIGN_ACCEPTED_CONDITIONALLY
ADR_039=ACCEPTED_WITH_REQUIRED_CHANGES (correcciones aplicadas; aceptación interna pendiente de confirmación del owner)

D1=BLOCKED
D2=PROPOSED
D3=ACCEPTED
D4=REQUIRES_CHANGE (corregida en esta revisión; pendiente de confirmación)
D5=ACCEPTED_WITH_CONDITIONS
D6=BLOCKED
D7=PROPOSED_PRODUCTION_BLOCKER
D8=ACCEPTED

J4_R1B=OPEN
J4_R2=NOT_AUTHORIZED
J4_R5_REAL_CUSTOMER_DATA=NOT_AUTHORIZED

CUSTOMER_IDENTITY_OWNER=UNCONFIRMED
CUSTOMER_AUTHORIZATION=NOT_IMPLEMENTED
PRODUCTION_PROFILE=sales-production@3
PRODUCTION_ROLLOUT=NOT_AUTHORIZED
```

Siguiente paso: obtener la auditoría del repositorio de Customer Service. No se inicia J4-R2 sin una autorización posterior.
