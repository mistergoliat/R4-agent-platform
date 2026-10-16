# R4-J4-R1 — Informe de diseño: decisión de arquitectura y contratos entre servicios

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15. Revisado en R4-J4-R1A-REVIEW-01 (versión previa: commit `b680b2c`) |
| Autorización | R4-J4-R1 `APPROVED_WITH_RESTRICTIONS`; revisión del owner `ACCEPTED_WITH_REQUIRED_CHANGES` |
| Preflight | [R4-J4-R0](R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md): `READY_WITH_BLOCKERS`, conservado sin cambios |
| Revisión | [R4-J4-R1A-REVIEW-01](R4-J4-R1A_REVIEW_01_REPORT.md): correcciones, evidencia Git y dependencias abiertas |
| Corrección R1C | [Registro de decisiones compartidas R4 ↔ CP](R4-J4-R1C_SHARED_DECISION_REGISTER.md): posiciones de R4 AP-01 a AP-11 y D6, conformidades externas pendientes y gate F2 (2026-10-15) |
| Estado | **`J4_R1A=DESIGN_ACCEPTED_CONDITIONALLY`**; J4-R1B abierto (§6) |

Etiquetas: **R4** = verificado en este repositorio · **EXT-CP / EXT-CRM** = checkouts locales de solo lectura · **DOC** = documentado, sin verificar en código · **PROPUESTA** = diseño no aceptado.

## 1. Preparación (al iniciar J4-R1)

| Verificación | Resultado |
|---|---|
| Rama inicial | `r4-j3-closure-record` en `99ea7ee`, con `main` = `origin/main` = `b5fd288` |
| Cierre administrativo de J3 | En ese momento **no** estaba en `main`. Se integró después, con autorización, en `80f39fd` (informe de revisión §3) |
| Evidencia J4-R0 | Conservada sin cambios (SHA-256 `46bfab8e…`), versionada en `b680b2c` |
| Trabajo concurrente de CP | Sin commit (CONTEXT-02A y documentos CP-J4-CONTEXT). No se modificó ni se usó como base |
| ADR-039 | Número libre. ADR-038 solo existía entonces en la rama no fusionada `r4-j3f-document-delivery-design`. Se fusionó después en `bbb3974` (PR #9), solo como documento y en estado `PROPOSED_DEFERRED`; la reserva de `sales-production@8` y de la definición v8 para J4-R4 se mantiene ([reconciliación](R4_J3F_DOCUMENTARY_MERGE_RECONCILIATION.md) §3) |

## 2. Entregables

| # | Entregable | Documento |
|---|---|---|
| 1 | ADR-039 | [`docs/adr/ADR-039-customer-identity-and-profile-consumption.md`](../adr/ADR-039-customer-identity-and-profile-consumption.md) |
| 2 | Especificación del consumidor (DRAFT) | [`R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md`](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) |
| 3 | Requerimiento para Customer Service | [`R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md`](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md) |
| 4 | Requisitos para Customer Profile | [`R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md`](R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md) |
| 5 | Matriz D1–D8 | §3 |
| 6 | Plan J4-R1A / J4-R1B → J4-R6 | §5 |
| 7 | Invariantes y pruebas | ADR-039 (I1–I12); especificación §11 |

## 3. Matriz de decisiones D1–D8 (estado tras la revisión del owner)

| ID | Decisión | Owner responsable | Alternativas | Evidencia | Estado | Para cerrarla |
|---|---|---|---|---|---|---|
| **D1** Autoridad de identidad | **Customer Identity Authority** (servicio dedicado), con owner **por designar** ([ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md)). Alternativa condicionada: ampliar `pc-users` | Negocio (designación); owner de la CIA | CRM, CP, R4 y `pc-jwt-auth` como autoridad (descartados); `pc-users` (condicionado) | Auditoría CS: `INCONCLUSIVE`. OWNER: "Customer Service" = `pc-users`; el contrato de resolución y vinculación de CRM **no tiene productor**; sin autoridad formal sobre `master_customer` | **BLOCKED** | Owner designado con compromiso más contrato CS-01 a CS-12 aprobado y publicado por el productor |
| **D2** Autorización individual | **A:** grant firmado, corto, ligado a cliente, consumidor, audiencia y propósito; verificado por CP. `authorizationBasis` de CP es evidencia declarada, nunca suficiente; ninguna lectura real con `service_scope_only` (R1C, AP-05) | Customer Profile; autoridad de identidad | B (verificación en línea); solo token de servicio (descartado) | EXT-CP: sin control por cliente en `f631f32`. Modelo de amenazas T1–T7 (doc. CP §4) | **PROPOSED**. Verificación individual pendiente | Aceptación de CP y de la autoridad; formato del grant; claves; CP-03 implementado y verificado |
| **D3** Momento de resolución | Perezosa, en el handler, desde `bindingByTask`; sin vinculación estática en la ingress | R4 | Resolver en `afterOpen` | R4: `ports.ts:311`; `workspace/store.ts:140-147`; `ingress.ts:225` | **ACCEPTED** (owner, revisión) | — |
| **D4** Minimización (confirmada con la aceptación interna de ADR-039, CP-J4-F2) | Sin `displayName` ni datos personales. El modelo ve solo: estado de identidad, indicador de historial, `validUntil` e ítems de historial (nombre de producto, clave Catalog, día, cantidades). **R1C:** tres fronteras (dominio de CP, cable, modelo); en el cable, minimización por propósito, sin montos ni predictivos; validación estructurada y allowlist en lugar de prefijos (AP-03). Detalle en especificación §10 | R4 (modelo); CP + R4 (cable: CP-04 a CP-06) | Con `displayName` (rechazado por el owner); montos en el cable porque el modelo no los ve (rechazado en R1C) | Revisión del owner; auditoría cruzada §7 y §9.2 | **REQUIRES_CHANGE → corregida (R1A) → ampliada (R1C)**, pendiente de confirmación | Confirmación del owner (ADR-039 §7); conformidad de CP y del owner de datos (registro §2) |
| **D5** Vigencia | `verified`: `min(10 min, CP.validUntil, grant.expiresAt)`, con `validUntil` de salida siempre no nulo; `unavailable`: 10 min; fallos: sin vigencia | R4; autoridad (TTL del grant) | Caché por tarea; TTL de 60 min | R4: F1–F8 verificados en código y con 54/54 tests (ADR-039 §6) | **ACCEPTED_WITH_CONDITIONS** | Condiciones de ADR-039 §6: la privacidad no depende de la expiración; decidir `R4_CONTEXT_EXPIRED_EVIDENCE` del canary antes de J4-R5; tratamiento de grants vencidos |
| **D6** Identificador de producto | Catalog es la autoridad de las claves. CP hace el mapeo cuando exista un contrato verificado de Catalog; mientras tanto `catalogKey: null`. Ni SKU ni derivación desde ids de PrestaShop | Catalog; Customer Profile | SKU de CP; derivar `P{id}-V{attr}`; mapeo en R4 (descartado: llevaría ids al cable) | EXT-CP: ids numéricos; CONTEXT-02A en `91b6739`; CP ya tiene cliente HTTP de Catalog | **DEFERRED_WITH_NULL** (no aceptada; antes BLOCKED) | Pronunciamiento de Catalog sobre el mapeo y conformidad de CP |
| **D7** Retención y eliminación | Se distinguen revocación, reutilización y eliminación (ADR-039 §8). J4-R5 solo con datos sintéticos. Habilitación real o productiva bloqueada hasta una política aprobada | Plataforma R4 (J7) | Retención en el pack (sin mecanismo); bloquear J4-R2 a J4-R4 (innecesario) | R4: no hay retención ni purga; observaciones por tarea, con payload, visibles como historia (F7, F8) | **PROPOSED_PRODUCTION_BLOCKER** | Política aprobada de retención y purga; controles implementados |
| **D8** Datos declarados en J4 | No: J4 solo usa datos verificados; GAP-05 aparte | R4 / producto | Incluir `guest.displayName` declarado | Gap register GAP-05 | **ACCEPTED** (owner, revisión) | — |

Ninguna recomendación de esta matriz es una decisión de un owner externo.

## 4. Cambios de diseño

- **Respecto de J4-R0:** R0 se conserva intacto. Las precisiones de R1 que lo sustituyen están en la versión `b680b2c` de este informe, §4: fallo en vez de `owner_unavailable`, `not_authorized` frente a 401/403, `ambiguous` → `not_verified`, vigencia acotada, historial minimizado, configuración separada y mínimo privilegio por propósito.
- **Respecto de la versión `b680b2c`:** ver la matriz de correcciones del [informe de revisión](R4-J4-R1A_REVIEW_01_REPORT.md) §2.
- **Respecto de `1f67633` (R1C):** una ruta de CP con `purpose` frente a dos capacidades R4; fronteras dominio / cable / modelo; puerto sin `degraded` y con `withheld`; nombres nulos, cantidades 0 brutas y fechas de origen con zona sin validar (sin margen cuantitativo, CP-J4-F2); tamaños en bytes; errores planos de CP; scope único; D6 diferida con `catalogKey: null`. Ver el [registro](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §3 y §5.

## 5. Plan revisado

| Fase | Contenido | Depende de | Cierre verificable |
|---|---|---|---|
| **J4-R1A — Diseño del consumidor** | ADR-039, especificación, requerimientos, matriz, invariantes | — | **DESIGN_ACCEPTED_CONDITIONALLY** (owner). Las correcciones de la revisión están aplicadas; falta la confirmación del owner para la aceptación interna de ADR-039 |
| **J4-R1B — Contratos externos** | Auditoría y contrato de CS (D1); autorización y ruta de CP (D2, CP-01 a CP-24); CP-J4-CONTEXT aceptado; mapeo de producto (D6) | CIA (primero), CP, Catalog | Cada contrato con owner, versión, JSON Schema aprobado, fixtures y SHA. D1 y D2 cerradas; D6 cerrada o diferida explícitamente con `catalogKey: null` (diferida desde R1C). La especificación pasa a v1 |
| **J4-R2 — Adaptador CP** | `adapters/domains/customer/http` (CP), `CustomerProfilePort`, fixtures del owner | Contrato v1-rc de CP que supere el gate F2 (registro §6); **autorización posterior** (hoy `NOT_AUTHORIZED`) | Pruebas de la especificación §11 (I5, I6, I12, D4, contrato). Mutaciones. `core-purity` verde |
| **J4-R3 — Resolver de identidad** | Adaptador del resolver (CIA; contrato CS-01 a CS-12) y resolución perezosa | R1B-CIA | Pruebas de I1, I2, I10 e I11. Ninguna llamada externa desde la ingress |
| **J4-R4 — Capacidades y perfil** | `get_context@2`, `get_purchase_history@1`, definición v8, `sales-production@8` **no desplegado** | R2, R3; D6 cerrada o diferida | Pruebas de I3, I7 (local), I8, I9 y D5. Huellas `@1`–`@7` sin cambios |
| **J4-R5 — Integración y canary aislado** | E2E contra la integración de CS y CP; canary en EC2 sin canal real ni producción. **Solo identidades y datos sintéticos** (D7) | CP-01, CP-12, CP-20, CS-12; decisión sobre `R4_CONTEXT_EXPIRED_EVIDENCE`; plan de limpieza de la base del canary; **autorización EC2 explícita** | I4 e I7 con servicios reales. 0 clientes reales procesados (verificado). Evidencia etiquetada como sintética |
| **J4-R6 — Aceptación y rollback del canary** | Ensayo de rollback **del canary** `@8 → @7`; registro de aceptación | R5 PASS | Rollback sin ejecuciones Customer huérfanas; regresión completa. **Producción no se toca:** sigue en `sales-production@3` (`ef5a354`). Un rollout productivo de `@8` partiría de `@3`, con rollback propio, y pertenece a J7 (no autorizado) |

Ruta crítica: **designación del owner de la autoridad de identidad (D1) → contrato v1 → D2 → J4-R1B → J4-R3 → J4-R4**. La auditoría de Customer Service ya se hizo (`INCONCLUSIVE`). El owner confirmó que la autoridad no existe, lo que confirma la carencia de fondo en la gestión de identidades de PesasChile. La salida propuesta está en [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md).

## 6. Estado

```text
J4_R1A=DESIGN_ACCEPTED_CONDITIONALLY
ADR_039=ACCEPTED_INTERNAL_R4 (2026-10-15, CP-J4-F2, con precisiones RI-09; D1, D2, D6 y D7 sin cambio)
D1=BLOCKED  D2=PROPOSED  D3=ACCEPTED  D4=REQUIRES_CHANGE→CORREGIDA→AMPLIADA_R1C  D5=ACCEPTED_WITH_CONDITIONS
D6=DEFERRED_WITH_NULL  D7=PROPOSED_PRODUCTION_BLOCKER  D8=ACCEPTED
J4_R1C=R4_DECISIONS_RECORDED (AP-01..AP-11, D6; conformidades externas pendientes)
J4_R1B=OPEN
F2=EXECUTED_IN_CP (v1-rc1; ver registro R1C §6.3)  CP_CONTEXT_02C=NOT_STARTED
J4_R2=NOT_AUTHORIZED
J4_R5_REAL_CUSTOMER_DATA=NOT_AUTHORIZED
CUSTOMER_IDENTITY_OWNER=UNCONFIRMED
CUSTOMER_AUTHORIZATION=NOT_IMPLEMENTED
PRODUCTION_PROFILE=sales-production@3
PRODUCTION_ROLLOUT=NOT_AUTHORIZED
```
