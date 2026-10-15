# R4-J4-R1 — Informe de diseño: decisión de arquitectura y contratos entre servicios

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Autorización | R4-J4-R1 `APPROVED_WITH_RESTRICTIONS` (solo documentación y contratos propuestos) |
| Preflight | [R4-J4-R0](R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md): `READY_WITH_BLOCKERS` |
| Resultado | **`J4_R1A_DESIGN_READY_WITH_EXTERNAL_BLOCKERS`** (§6) |
| Cambios realizados | Solo cinco documentos nuevos (§2), sin commit. Sin código, harness, dependencias, migraciones, perfiles, EC2 ni despliegues. El worktree de CP no se tocó |

Etiquetas: **R4** = verificado en este repositorio · **EXT-CP / EXT-CRM** = verificado en checkouts locales de solo lectura (no necesariamente lo desplegado) · **DOC** = documentado, sin verificar en código · **PROPUESTA** = diseño no aceptado.

## 1. Preparación

| Verificación | Resultado |
|---|---|
| HEAD de R4 | `99ea7ee`, rama `r4-j3-closure-record`. Único cambio en el árbol: el informe J4-R0 sin seguimiento |
| `main` / `origin/main` | Ambos en `b5fd288`, tras `git fetch` sin novedades |
| ¿`99ea7ee` en `main`? | **No.** Tampoco está en `origin/main`, y la rama `r4-j3-closure-record` no existe en el remoto (`git ls-remote` vacío) |
| ¿Cierre administrativo de J3 integrado? | **No.** El registro `docs/acceptance/R4_J3_CLOSURE_RECORD.md` y las correcciones de estado del roadmap y del gap register existen solo en la rama local. El cierre técnico (`b5fd288`) sí está en `main` |
| Evidencia J4-R0 | Conservada sin cambios: `docs/architecture/R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md`, SHA-256 `46bfab8ef87f6e20aa702fec86959d82d17a7b4b4abd8a3d2dd6132e0e484d39`, sin seguimiento. Las diferencias de diseño respecto de R0 están en §4, no editadas en R0 |
| Trabajo concurrente de CP (EXT-CP) | `45b28a3` en `feat/cp-j4-security-01-resilience-01`. Hay 5 archivos modificados y 6 sin seguimiento, entre ellos `CP_J4_CONTEXT_02A_VALIDATION_REPORT.md` ("Pendiente de revisión", sin commit), que normaliza `product_reference` en blanco a `null`. SECURITY-01 y RESILIENCE-01 no están en `main` de CP ni en ninguna rama remota. **No se modificó** el worktree y **D6 no se congeló** contra esa versión |
| ADR-039 | Número libre. ADR-038 existe solo en la rama no fusionada `r4-j3f-document-delivery-design` |
| J1–J3 y perfiles históricos | Sin cambios (no se tocó código) |

Pasos de Git recomendados (**requieren autorización**, no ejecutados):
1. Integrar `99ea7ee` en `main` (merge o PR) y publicarlo.
2. Crear una rama J4 desde ese `main` y versionar en ella los documentos de R0 y R1.

## 2. Entregables

| # | Entregable | Documento |
|---|---|---|
| 1 | ADR-039 en estado propuesto | [`docs/adr/ADR-039-customer-identity-and-profile-consumption.md`](../adr/ADR-039-customer-identity-and-profile-consumption.md) |
| 2 | Especificación del consumidor Customer de R4 (DRAFT) | [`R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md`](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) |
| 3 | Requerimiento de identidad para Customer Service | [`R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md`](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md) |
| 4 | Requisitos de autorización y contratos para Customer Profile | [`R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md`](R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md) |
| 5 | Matriz D1–D8 | §3 de este informe |
| 6 | Plan J4-R1A / J4-R1B y dependencias de J4-R2 a J4-R6 | §5 de este informe |
| 7 | Invariantes de seguridad y pruebas de aceptación | ADR-039, "Invariantes" (I1–I12); especificación §11 (prueba por invariante) |

## 3. Matriz de decisiones D1–D8

Estados:
- **PROPOSED:** hay una recomendación y falta aceptación.
- **ACCEPTED:** aceptada por todos los owners responsables. Ninguna lo está todavía.
- **BLOCKED:** no se puede decidir hasta que exista un hecho externo.

Las decisiones de R4 (D3, D4 en su parte R4, D5, D8) pasan a ACCEPTED con la revisión de ADR-039 por el owner de R4. Esta auditoría no las da por aceptadas.

| ID | Decisión propuesta | Owner responsable | Alternativas | Evidencia disponible | Estado | Para cerrarla |
|---|---|---|---|---|---|---|
| **D1** Autoridad de identidad | Customer Service como autoridad de resolución verificada canal → cliente (**candidato**) | Customer Service; owner de R4 | CRM (descartado: L2 sin `is_verified`, vínculo automático por teléfono, AGENTS.md, retiro); CP como fachada (contradice su principio "nunca resuelve wa_id"); servicio propio de R4 (fuera de este hito) | DOC: CRM nombra a CS "única autoridad de creación y vinculación". EXT-CRM: su `/v1/customers/resolve` es una búsqueda por coincidencia que devuelve un maestro, sin nivel. CS **no auditado** | **BLOCKED** | Respuestas A1–A12 con evidencia del repositorio CS, aceptación de CS y contrato CS-01 a CS-11 (doc. CS §6) |
| **D2** Autorización individual | **A:** grant firmado, corto (≤ 10 min), ligado a cliente, sujeto, consumidor, audiencia y propósito; verificado por CP | Customer Profile; autoridad de identidad | B: verificación en línea de CP contra la autoridad; solo token de servicio (descartado, I4) | EXT-CP: sin control por cliente (informe SECURITY-01 :278). El PRD de CP exige un grant. La comparación A/B está en el doc. CP §3 | **PROPOSED** (su cierre depende de D1) | Aceptación de CP y de la autoridad, formato del grant, publicación y rotación de claves, CP-03 implementado |
| **D3** Momento de resolución | Perezosa, en el handler, en cada invocación, desde `bindingByTask` | R4 | Resolver en `afterOpen` y escribir `customer_ref` (propuesta CP §2) | R4: `ports.ts:311`; `bindConversation` insert-once (`workspace/store.ts:140-147`); `afterOpen` dentro de la ingress (`ingress.ts:225`) | **PROPOSED** (decisión R4) | Aceptación de ADR-039 |
| **D4** Minimización | El modelo ve `displayName` (≤ 80), `customerSince` (mes), indicador de historial y productos comprados (nombre, clave Catalog, día, cantidades). Nunca email, teléfono, RUT, dirección, montos, refs ni ids. `displayName` redactado ante jueces | R4 (qué ve el modelo); CP (qué devuelve, CP-06) | Sin `displayName`; incluir email para entregas (descartado: entrega diferida a R4 Media) | R4: `redactKeys` = email, phone, rut, address (`evaluations/definition.ts:54`); el test de privacidad permite el nombre (`privacy-regression.test.ts:33`) | **PROPOSED** | Decisión de privacidad del owner de R4; CP-06 |
| **D5** Frescura y revocación | TTL de runtime 10 min, acotado por `validUntil` = mín(frescura de CP, expiración del grant) vía ADR-030; nueva resolución en cada invocación; sin caché | R4; autoridad de identidad (TTL del grant) | Caché por tarea; TTL de 60 min (el actual de v1) | R4: ADR-030; `invoker.ts:98-100` | **PROPOSED** | ADR-039 aceptado; CS-05, CS-09 y CP-14 |
| **D6** Identificador de producto | `catalogKey` desde un mapeo publicado por Catalog, o `null`. R4 no deriva claves ni usa el SKU | Catalog; Customer Profile | CP devuelve un SKU (descartado: puede ser nulo y no es clave Catalog); R4 deriva `P{id}-V{attr}` (descartado: regla de negocio de Catalog) | EXT-CP: ids numéricos; CONTEXT-02A **sin commit** cambia el tratamiento de `product_reference` | **BLOCKED** | CONTEXT-02A revisado e integrado en CP; pronunciamiento de Catalog sobre el mapeo |
| **D7** Retención de observaciones con datos de cliente | En J4: la minimización como mitigación. La política de retención y purga se define en la plataforma (J7) antes de habilitar producción | Plataforma R4 | Retención específica en el pack (no hay mecanismo sin harness); bloquear J4-R2 a R4 (innecesario con minimización) | R4: no hay código de retención ni purga en `packages/`, `apps/` ni `agents/sales/src` | **PROPOSED** (la habilitación productiva queda bloqueada hasta J7) | Política aprobada de retención; plan de limpieza de la base de canary antes de J4-R5 |
| **D8** Datos declarados por el cliente en J4 | No: J4 solo usa datos verificados. GAP-05 sigue aparte | R4 / producto | Incluir `guest.displayName` declarado | R4: gap register GAP-05 | **PROPOSED** | Aceptación de ADR-039 |

Ninguna recomendación de esta matriz es una decisión aceptada por los owners externos.

## 4. Cambios de diseño respecto de J4-R0

R0 se conserva intacto. Estas precisiones lo **sustituyen** en el diseño vigente:

| R0 | R1 | Motivo |
|---|---|---|
| La caída del owner se responde como `identity: unavailable, reason: owner_unavailable` | La caída es una **observación fallida** (`temporarily_unavailable` o `timeout`) | Una respuesta exitosa quedaría vigente durante el TTL y ocultaría la caída. Además, es el patrón existente de `domainRead` |
| `not_authorized` como razón genérica | `not_authorized` solo cuando la autoridad **niega el grant** por política. 401/403 son fallos `unauthorized` | I5 |
| Estados `ambiguous` y `conflicted` sin destino definido | Llegan al modelo como `not_verified`; la telemetría conserva el detalle | El modelo no necesita, ni debe revelar, conflictos de identidad |
| TTL sugerido de 10 min | TTL de 10 min **acotado por `validUntil`** (frescura de CP y expiración del grant), vía ADR-030 | Revocación acotada sin mecanismo nuevo |
| Historial con `productRef` y sin semántica de fecha | `catalogKey` (D6) o `null`; fecha con precisión de día; sin `catalogStatus` ni montos | Minimización e I8: Catalog es la autoridad de la vigencia del producto |
| Una variable de configuración por servicio | Variables separadas para el resolver y para CP | Son owners distintos |
| Grant para ambos propósitos | Cada capacidad pide **solo su propósito** | Mínimo privilegio |

## 5. Plan revisado

| Fase | Contenido | Depende de | Cierre verificable |
|---|---|---|---|
| **J4-R1A — Diseño del consumidor** (esta entrega) | ADR-039 propuesto; especificación DRAFT; requerimientos para CS y CP; matriz D1–D8; invariantes y pruebas | — | Revisión del owner de R4 sobre ADR-039 y los documentos; aceptación de las decisiones de R4 (D3, D4-R4, D5, D8). `git diff` limitado a `docs/` |
| **J4-R1B — Contratos externos** | Auditoría y contrato de CS (D1); autorización y rutas de CP (D2, CP-01 a CP-15); mapeo de producto (D6) | Respuesta de CS, CP y Catalog | Cada contrato con owner, versión, JSON Schema aprobado, fixtures y SHA del repositorio. D1, D2 y D6 en ACCEPTED (o D6 diferida explícitamente con `catalogKey: null`). La especificación pasa de DRAFT a v1 |
| **J4-R2 — Adaptador CP** | `adapters/domains/customer/http` (parte CP), puerto `CustomerProfilePort`, fixtures del owner, sin binding productivo | R1B-CP (CP-03, CP-04, CP-05, CP-13 y el header del grant) | Pruebas de la especificación §11 para I5, I6, I12, topes y errores. Mutaciones. `core-purity` verde |
| **J4-R3 — Resolver de identidad** | Adaptador del resolver (parte CS) y resolución perezosa en el pack | R1B-CS (D1 aceptada, CS-01 a CS-05, CS-10) | Pruebas de I1, I2, I10 e I11. Ninguna llamada externa desde la ingress |
| **J4-R4 — Capacidades y perfil** | `customer.get_context@2`, `customer.get_purchase_history@1`, definición v8 (resuelve GAP-15), `sales-production@8` **no desplegado**, composición fail-closed | R2, R3; D4 aceptada; D6 cerrada o diferida | Pruebas de I3, I7 (local), I8 e I9. Topes de salida. Huellas `@1`–`@7` sin cambios |
| **J4-R5 — Integración y canary aislado** | E2E contra los despliegues de integración de CS y CP; canary en EC2 sin canal real ni producción | CP-01, CP-12 y CS desplegados en integración; plan de limpieza de datos del canary (D7); **autorización EC2 explícita** | I4 (lado CP) e I7 con servicios reales. Evidencia etiquetada; ningún fixture se presenta como evidencia productiva |
| **J4-R6 — Aceptación y rollback** | Ensayo `@8 → @7`; registro de aceptación; actualización del gap register | R5 PASS | Rollback sin ejecuciones Customer huérfanas; regresión completa con resultados reales. **Sin rollout productivo** (J7, D7) |

Ruta crítica: **D1 → D2 → J4-R1B → J4-R3 → J4-R4**. J4-R2 puede adelantarse en cuanto CP publique su contrato, incluido el formato del grant. Para eso basta con que D2 tenga la forma acordada; no exige que CS haya terminado su auditoría.

## 6. Resultado

```text
J4_R1A_STATUS=J4_R1A_DESIGN_READY_WITH_EXTERNAL_BLOCKERS
J4_R1A_PENDING=revisión del owner de R4 (ADR-039 y especificación)
J4_R1B_STATUS=OPEN (D1 BLOCKED, D2 PROPOSED, D6 BLOCKED)
ADR_039=PROPOSED
CONSUMER_SPEC=DRAFT
IDENTITY_OWNER=NOT_CONFIRMED (candidato: Customer Service, no auditado)
INDIVIDUAL_AUTHORIZATION=NOT_RESOLVED
CUSTOMER_INTEGRATION=NOT_ENABLED
J3_ADMIN_CLOSURE_IN_MAIN=NO (99ea7ee solo local)
CODE_HARNESS_MIGRATIONS_PROFILES_EC2=UNCHANGED
```

J4 no está completo. La integración no está habilitada y la autorización individual no está resuelta. El diseño del consumidor está listo para revisión. Todo lo que sigue depende de contratos que Customer Service, Customer Profile y Catalog aún no han publicado.
