# CS-R4-J4-IDENTITY-AUDIT-01 — Auditoría de autoridad de identidad

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Solicitante | R4 Agent Platform (J4, decisión D1) |
| Referencias | R4 `r4-j4-customer-integration` @ `2890a9c`: `docs/architecture/R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md` (A1–A12, CS-01 a CS-12) y `docs/adr/ADR-039-customer-identity-and-profile-consumption.md` |
| Modo | Solo auditoría. Sin cambios de código, contratos, migraciones ni datos; sin commits, push ni despliegues. R4, CRM y Customer Profile no se modificaron. No se hizo ninguna consulta sobre clientes ni vínculos |
| Ubicación de este informe | Se redactó en `C:\Users\dell\Pesaschile IA\dev\`, fuera de los repositorios. Por decisión del usuario se versiona en la rama J4 de R4 (ID-AUTHORITY-DECISION-01) |
| **Dictamen** | **`CS_IDENTITY_AUTHORITY_INCONCLUSIVE`** (§10) |
| Nota posterior (2026-10-15, no altera el dictamen) | El owner confirmó que el "Customer Service" de la documentación de CRM **es `pc-users`**, un microservicio interno documentado en `https://ms.pesaschile.cl/docs/?urls.primaryName=pc-users`, y que `client-multiplatform` sirve para unificar clientes en `master_customer`. También confirmó que no hay autoridad formal sobre `master_customer` ni sobre las identidades externas. La decisión resultante está en [`ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md`](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) |

## 0. Etiquetas de evidencia

| Etiqueta | Fuente |
|---|---|
| **CS-CODE** | Código fuente de Customer Service. **No disponible: no hay ninguna afirmación con esta etiqueta** |
| **SPEC** | Swagger publicado de `pc-users` (`GET https://ms.pesaschile.cl/api/pc-users/swagger/doc.json`, HTTP 200, 68 241 bytes, 2026-10-15T19:11Z, SHA-256 `ede84612…e8ed4f34`). Es lo que el servicio **declara**, no lo que hace |
| **CRM-CODE** | `CRM-Customer-360` @ `8298723` (rama `develop`, árbol limpio): código **consumidor** |
| **CRM-DOC** / **CP-DOC** / **R4-DOC** | Documentos de esos repositorios, sin verificación en código del productor |
| **PROPUESTA** | Diseño de este informe |

## 1. Estado Git y procedencia

| Verificación | Resultado |
|---|---|
| Repositorio de Customer Service en la estación | **No existe.** `dev/` contiene `CRM-Customer-360`, `MS-pesaschile-{catalog-service,customer-profile,quote-service}`, `R4-agent-platform` y los directorios `cat-discover-*`. `Pesaschile IA/EC2/` contiene solo un archivo de credencial (no se abrió) |
| Repositorio en GitHub (`mistergoliat`) | `git ls-remote` de `MS-pesaschile-customer-service`, `-customers-service`, `-customer`, `-client-multiplatform`, `-identity-service`, `client-multiplatform` y `customer-service`: **"Repository not found"** para todos. `gh` no está instalado. El repositorio puede existir con otro nombre o en otra organización |
| Productor local de `/v1/customers/resolve` | Búsqueda en todos los repositorios locales: **ningún productor**, solo el consumidor CRM y documentos |
| HEAD, rama y worktree de Customer Service | **No determinables** |

Fuentes externas usadas:

| Repositorio | Commit | Rama | Uso |
|---|---|---|---|
| CRM | `8298723` | `develop` | Consumidor y documentos |
| Customer Profile | `45b28a3` | `feat/cp-j4-security-01-resilience-01` | Solo documentos; worktree ajeno sin tocar |
| R4 | `2890a9c` | — | Requisitos |

**Consecuencia:** las Fases 1 a 3 no pueden responderse con evidencia del productor. Lo que sigue reconstruye la situación desde lo que el servicio publica (SPEC) y desde sus consumidores (CRM), marcando cada fuente.

## 2. Arquitectura real

### 2.1 "Customer Service" según CRM

| Hecho | Evidencia |
|---|---|
| CRM define el contrato **desde el consumidor**: `POST /v1/customers/resolve`, `POST /v1/customers`, `POST /v1/customers/{id}/external-identities`, con `x-api-key` | CRM-DOC `docs/integrations/customer-service-http-contract.md:21-134` (status `approved`); CRM-CODE `lib/integrations/customer-service/http-adapter.ts:219-231` |
| Lo que CS "debe ser responsable de": búsqueda entre fuentes, deduplicación, resolución, creación canónica, vinculación. Es un texto **normativo/aspiracional** | CRM-DOC `docs/data/customer-creation-linking-authority-contract.md` §2 |
| **No hay Customer Service desplegado, ni productivo ni sandbox.** `CUSTOMER_SERVICE_BASE_URL` y `CUSTOMER_SERVICE_API_KEY` están vacíos. Las capacidades son `operational: not_verified` y la release está `PAUSED_EXTERNAL` | CRM-DOC `docs/ACTIVE_RELEASE.md:52`; `docs/audits/SALES-AGENT-R1-current-commercial-capability-audit.md:209,437`; `docs/audits/r3-p7-6-runtime-config-parity-audit.md:92` |
| La integración se probó **contra un doble HTTP local** que implementa el contrato del consumidor, no contra un productor real | CRM-DOC `ACTIVE_RELEASE.md:52`; `docs/releases/SALES-AGENT-R2-ID-R2-A08.1-…:53` |
| La auditoría de integraciones de CRM: "No sibling microservice source repositories or deploy manifests … were available"; despliegue de CS "unavailable … UNVERIFIED" | CRM-DOC `docs/audits/CRM_WEBAPP_MICROSERVICE_INTEGRATION_AUDIT.md:19,47,123` |
| **Autoridad partida:** `POST /api/customers` de CRM inserta directamente en `master_customer`, sin pasar por CS | CRM-DOC (misma auditoría) `:22,334-338` |

### 2.2 `pc-users`, el "Customers service histórico" que sí está publicado

| Hecho | Evidencia |
|---|---|
| "PC Users API" v1.3.2, Swagger 2.0, `https://ms.pesaschile.cl/api/pc-users`. Se describe como "microservice for **user and POS data management**": usuarios, roles, permisos, clientes, direcciones, historial, más integraciones con PrestaShop y Mailling | SPEC `info` |
| **No declara** `/v1/customers/resolve`, `external-identities`, verificación, revocación, ni identidad de WhatsApp o canal | SPEC `paths` (52 operaciones) |
| `POST /client-multiplatform?platform_origin=…` "Inserts or synchronizes a client across multiple platforms". Admite `whatsapp`, `instagram`, `facebook`, `prestashop`, `pos`, `hub`, `import` y `master`. La respuesta trae `exists: boolean` por plataforma | SPEC `/client-multiplatform`; `handlers.PCMultiplatformClientInput/Output` |
| Ese mismo endpoint recibe `dni`, `email`, `first_name`, `last_name`, `phone_number`, **`password`**, y su esquema de **respuesta también declara `password`** | SPEC `handlers.pcMultiplatformCreateClient` |
| CP lo identifica como "Customers service histórico" y pide no presumir que verifique identidad ni que autorice historial | CP-DOC `CP-R1-T10B8A-…identity-contract-audit.md:148`; `CP_R4_J4_MINIMUM_READINESS_PRD.md:46` |
| El mismo host publica `pc-carrier` (owner de Shipping de R4): Internet pública, nginx, CORS `*` | R4-DOC `docs/architecture/R4-J2A_SHIPPING_OWNER_AUDIT.md:33` |

**No hay evidencia de que `pc-users` sea el "Customer Service" del contrato de CRM.** Sus rutas no coinciden con ese contrato. Lo más probable es que "Customer Service", tal como lo definió CRM, **no exista como servicio desplegado**. Esto es una inferencia: cerrarlo requiere al owner (§10).

## 3. Matriz A1–A12

| # | Pregunta | Respuesta | Evidencia | Estado |
|---|---|---|---|---|
| A1 | Capacidades de identidad y vinculación desplegadas | Contrato de CS: no desplegado. `pc-users` declara alta, sincronización, búsqueda y borrado de clientes, pero no vinculación de identidades | CRM-DOC §2.1; SPEC | **Sin evidencia de productor** |
| A2 | Modelo de verificación real | CS: desconocido. `pc-users`: ninguno declarado (solo validación de formato de RUT, `GET /dni-validation/{dni}`). CRM: `is_verified=1` para `prestashop` lo asigna CRM tras `completed`/`already_linked` de CS. La "verificación" previa es que el email y la referencia de pedido declarados coincidan | SPEC; CRM-CODE `customerIdentityCapabilities.ts:495-520`, `lib/domains/customer-identity/evidence.ts:49-53` | **No existe prueba de control** |
| A3 | ¿Resuelve sujeto de canal autenticado → cliente verificado sin teléfono ni email como prueba? | No hay evidencia. El contrato documentado de CS acepta `phoneNumber` y `email` como entrada de resolución y devuelve solo `customerMasterId` | CRM-DOC contrato `:62-83`; CRM-CODE `http-adapter.ts:221-226` | **No** (según el contrato del consumidor) |
| A4 | ¿Distingue coincidencia, declarado y verificado? | CS: desconocido. Contrato de CS: no (`resolved`/`no_match`/`conflict`). CRM internamente sí distingue niveles L0–L3, pero L2 no exige verificación | CRM-DOC contrato; CRM-CODE `evaluate.ts:45-70` | **No** en el contrato |
| A5 | Ambigüedad y conflictos | Contrato de CS: `conflict` + `conflictCode` (`multiple_candidates`). Semántica real del productor: desconocida | CRM-DOC contrato `:80` | Solo documentado |
| A6 | Números reciclados | No se encontró mecanismo en ninguna fuente. El vínculo de canal de CRM no tiene vigencia ni revalidación (`customer_external_identity` sin `verified_at` ni `expires_at`) | CRM-CODE `migrations/010_…sql:12-30` | **No existe** (en lo observable) |
| A7 | Revocación | CS: desconocida. `pc-users`: `DELETE /client/{id}` borra un cliente, no revoca un vínculo. CRM: `crm_customer_identity_evidence` tiene estados `REVOKED`/`STALE`, pero la tabla de vínculos no | SPEC; CRM-CODE `migrations/032_…:41-106` | **No existe** como revocación de vínculo |
| A8 | ¿API apta para R4? | **No.** El contrato de CS no tiene productor ni nivel de verificación. `pc-users` no tiene resolución | §2 | No |
| A9 | `masterCustomerId` ↔ `prestashop_customer` | En CRM, un `external_id` de PrestaShop pertenece a un solo maestro (`UNIQUE(provider, external_id)`), pero **un maestro puede tener varios PrestaShop** (no hay unicidad por `(customer_id, provider)`). La equivalencia entre `customerMasterId` de CS, `master_customer.id` de CRM y `pc-users.id` **no está demostrada** | CRM-CODE `migrations/010_…sql:24`; CP-DOC `CP-R1-T10B8A…:11,137,148` | **No demostrado** |
| A10 | Autenticación y autorización de consumidores | Contrato de CS: una `x-api-key`, sin scopes, canal ni propósito. `pc-users`: `BearerAuth` (apiKey en `Authorization`) en la mayoría de rutas; módulos de roles y permisos para **usuarios POS**. **Varias rutas de PrestaShop se declaran sin seguridad** (§5.3) | CRM-DOC contrato `:37`; SPEC `securityDefinitions` | **Insuficiente** |
| A11 | Disponibilidad, latencia, despliegue | CS: no desplegado (CRM-DOC). `pc-users`: público en `ms.pesaschile.cl`. Latencia y SLO desconocidos | §2 | Desconocido |
| A12 | Consentimientos | CRM: consentimiento por regex solo para crear o vincular; no hay consentimiento de acceso a datos. CS y `pc-users`: no se declara ninguno | CRM-CODE `consentEvidence.ts:17-45` | **No existe** consentimiento de acceso |

## 4. Modelo actual de identidad y verificación

Cadena reconstruida `WhatsApp → identidad externa → cliente maestro → cliente PrestaShop`. Todo es lado CRM, porque el lado CS no es auditable.

| Paso | Qué ocurre | ¿Hay prueba de titularidad? | Evidencia |
|---|---|---|---|
| 1. WhatsApp → `wa_id` | Webhook con firma HMAC de Meta | Sí, prueba que el mensaje vino de ese `wa_id` (control actual del canal) | CRM-CODE `middleware`/webhook; R4 equivalente |
| 2. `wa_id` → `customer_external_identity` | Una fila por `wa_id`. Si otra fila tiene el mismo teléfono normalizado, se **vincula automáticamente** al mismo maestro con `isVerified: false`. Si no, queda una fila no resuelta | **No** | CRM-CODE `native-whatsapp/service.ts:283-365`, en particular `:325-336` |
| 3. → maestro (L2) | Cualquier vínculo de canal, o evidencia de teléfono convergente, da L2. **No mira `is_verified`** | **No** | CRM-CODE `evaluate.ts:45-70` |
| 4. → PrestaShop (`READY_TO_LINK`) | El cliente **declara** un email y una referencia de pedido que apuntan al mismo `ps_customer`, más consentimiento detectado por regex | **No** prueba control del email ni de la cuenta: prueba conocimiento de dos datos | CRM-CODE `evidence.ts:49-53`; `consentEvidence.ts:17-45` |
| 5. → vínculo `prestashop` (L3) | Llamada a CS `link_prestashop_identity`. Si responde `completed`/`already_linked`, CRM escribe `is_verified=1`. **CS no está desplegado**, así que en este entorno el paso no tiene productor | — | CRM-CODE `customerIdentityCapabilities.ts:495-520`; CRM-DOC §2.1 |
| 6. Recheck de L3 | Comprueba `customer_id` y **no** `is_verified` | — | CRM-CODE `service.ts:80-95` |

**Respuestas a la Fase 2:**

1. **`is_verified`** es un valor asignado por una operación interna de CRM, después de una respuesta de un servicio no desplegado. La evidencia que lo respalda es conocimiento de datos (email más pedido), no control. **No es confiable** como prueba de titularidad.
2. **Control actual:** del canal, sí (firma de Meta). De la identidad comercial (cuenta o email de PrestaShop), **no** existe en ninguna fuente: no hay OTP, enlace mágico ni confirmación de email.
3. **Coincidencias que vinculan automáticamente:** sí. Por teléfono, en CRM (paso 2). `pc-users` responde `exists` al sincronizar clientes; su clave de coincidencia no está declarada.
4. **Números reciclados:** el vínculo no caduca ni se revalida. Un `wa_id` reasignado conserva el vínculo de su titular anterior.
5. **Revocación y expiración:** no existen para vínculos.
6. **Varios PrestaShop por maestro:** estructuralmente posible. Los conflictos se detectan en la política de CRM (`CONFLICTED`); en CS, desconocido.
7. **Sujetos arbitrarios:** con la clave única del contrato, un consumidor puede pedir `resolve` para cualquier `externalId`, teléfono o email.
8. **Restricciones por canal, cuenta, propósito o principal:** **no existen** en el contrato de CS. En `pc-users`, los roles y permisos corresponden a usuarios POS; no se declara un modelo de consumidores.

## 5. Confianza y acceso horizontal

### 5.1 Con el contrato de CS documentado por CRM

- El contrato no tiene niveles de verificación: `resolved` + `customerMasterId` no dice **cómo** se estableció la identidad.
- Admite teléfono y email como entrada: la "resolución" es una búsqueda.
- Usa una sola clave sin ámbito: cualquier poseedor puede resolver cualquier sujeto.
- **Conclusión:** no sirve como base para autorizar datos privados (incumple I2 e I3 de ADR-039).

### 5.2 Con `pc-users` (SPEC)

- Sin resolución de identidad.
- `client-multiplatform` sincroniza y responde `exists`: devuelve **si existe** un cliente para los datos dados, lo que permite enumeración si se expone a consumidores amplios.
- **Conclusión:** no ofrece las garantías.

### 5.3 Hallazgo de seguridad fuera del alcance de J4 — **requiere atención del owner de `pc-users`**

El Swagger publicado declara **sin esquema de seguridad** estas operaciones, en un host de Internet pública:

| Operación | Descripción declarada |
|---|---|
| `GET /customer-ps/{id_customer}` | "Retrieves a Prestashop customer by its identifier": ids enteros, enumerables |
| `GET /getCustomer?start_date=…` | "Retrieves Prestashop customer data filtered by start date…" |
| `POST /customer-ps` | "Creates a customer in Prestashop with the provided identity and access data" |
| `GET/POST /address-ps` | Direcciones de PrestaShop |

Además, el esquema de respuesta de `POST /client-multiplatform` declara un campo `password`.

**No se verificó** si esas rutas están realmente abiertas. Comprobarlo requeriría leer datos reales de clientes, lo que esta auditoría tiene prohibido. Un Swagger puede omitir seguridad aplicada por un gateway. Aun así, si la declaración es fiel, existe exposición de datos personales y creación no autenticada de clientes.

**Recomendación:** el owner de `pc-users` debe verificarlo con una prueba autorizada y, si se confirma, tratarlo como incidente. Esto es **independiente** de J4.

## 6. Contratos existentes frente a CS-01 a CS-12

| Req. | Contrato de CS (CRM-DOC) | `pc-users` (SPEC) | Reutilizable / cambia / falta |
|---|---|---|---|
| CS-01 Resolución de solo lectura por sujeto de canal, en el cuerpo, sin teléfono ni email | `POST /v1/customers/resolve` con `{channel, externalId, phoneNumber, email}` | — | **Cambia:** quitar teléfono y email; agregar `accountRef` y `purposes`. Sin productor |
| CS-02 `status` explícito con `verified`, `customerRef` PrestaShop, sin PII ni maestro | `resolved`/`no_match`/`conflict` + `customerMasterId` | — | **Falta:** niveles, referencia PrestaShop; quitar el maestro |
| CS-03 `verified` = vínculo verificado con método y momento, válido para el sujeto actual | No existe | No existe | **Falta** (requiere un método de verificación, §9) |
| CS-04 Dominio en 200; errores tipados | Sí (200 + `status`; 400/409/422/5xx) | Parcial (`entities.Response` genérico) | **Reutilizable** en el contrato de CS |
| CS-05 Grant (si D2 = A) | No | No | **Falta**; no se congela (D2) |
| CS-06 Mínimo privilegio por propósito | No | No | **Falta** |
| CS-07 Consumidor acotado a canal y cuenta; rate limit | Una `x-api-key` | Bearer; rate limit no declarado | **Falta** |
| CS-08 Auditoría y alertas | No documentado | No declarado | **Falta** |
| CS-09 Revocación | No | No (solo `DELETE /client`) | **Falta** |
| CS-10 Contrato publicado y versionado con fixtures | Documento del consumidor v2.0.0, sin productor | Swagger publicado v1.3.2 (patrón útil) | **Cambia:** debe publicarlo el productor |
| CS-11 SLO y caídas tipadas | No | No | **Falta** |
| CS-12 Identidades sintéticas | El doble HTTP de CRM (solo para pruebas) | No | **Falta** un entorno real de integración |

## 7. Dependencias reales

| Dependencia | Relación | Evidencia |
|---|---|---|
| CRM → CS | CRM es el único consumidor conocido del contrato de CS, que no está desplegado. CRM también escribe `master_customer` por su cuenta (autoridad partida) | §2.1 |
| CRM ↔ Customer Profile | CP lee `master_customer` de la MariaDB de CRM (`main_management`) | R4-DOC `R4_CRM_LEGACY_DEPENDENCY_DECOMMISSION_AUDIT.md:173` |
| CS ↔ Customer Profile | Ninguna implementada. CP no resuelve identidad y no referencia `pc-users` | CP-DOC `CP-R1-T10B8A…:127` |
| `pc-users` ↔ PrestaShop | Lee y crea clientes y direcciones PrestaShop | SPEC `/customer-ps`, `/address-ps` |
| CRM en retiro | Las tablas de identidad (`customer_external_identity`, `master_customer`) viven en la MariaDB de CRM, compartida con CP | R4-DOC decommission `:173,190` |
| R4 | No consume nada de esto. AGENTS.md le prohíbe leer tablas de CRM | ADR-039 |

## 8. Brechas priorizadas

| P | ID | Brecha | Efecto en D1 |
|---|---|---|---|
| **P0** | G1 | **No hay productor auditable de Customer Service**: sin repositorio, despliegue ni configuración. Solo existe el contrato escrito por su consumidor | Impide decidir D1 sobre CS |
| **P0** | G2 | **No existe un método que pruebe el control de la identidad comercial** (OTP, enlace mágico, confirmación de email). "Verificado" significa hoy "datos declarados coinciden" | Ningún servicio actual puede emitir `verified` en el sentido de CS-03 |
| **P0** | G3 | **Sin autorización por consumidor ni por propósito**: resolución de sujetos arbitrarios con una clave | Incumple CS-06 y CS-07 |
| **P0** | G4 | **Posible exposición en `pc-users`** (§5.3): sin verificar, fuera de J4 | Independiente de D1; urgente si se confirma |
| **P1** | G5 | Vinculación automática por teléfono y L2 sin `is_verified` (CRM) | Contamina cualquier migración del modelo CRM |
| **P1** | G6 | Sin revocación, expiración ni manejo de números reciclados | Incumple CS-03 y CS-09 |
| **P1** | G7 | Autoridad partida: CRM crea maestros directamente | Identidad canónica ambigua |
| **P1** | G8 | Equivalencia no demostrada entre `customerMasterId`, `master_customer.id`, `pc-users.id` y PrestaShop | Riesgo de vincular el cliente equivocado |
| **P2** | G9 | Sin contrato del productor (esquemas, versiones, fixtures) | Incumple CS-10 |
| **P2** | G10 | Sin correlation id, readiness ni SLO | Incumple CS-11 |
| **P2** | G11 | Sin consentimiento de acceso a datos | A considerar en D2 y D4 |

## 9. Propuesta de evolución mínima (PROPUESTA)

Aplica a **cualquier** servicio que asuma D1. Hoy no hay un CS auditable donde aplicarla. **No congela D2.**

### 9.1 Modelo de datos mínimo (vínculo de identidad)

| Campo | Propósito |
|---|---|
| `channel`, `account_ref`, `subject_ref` (único activo por sujeto) | Sujeto de canal |
| `prestashop_customer_id` | Destino del vínculo. Un sujeto activo apunta a un solo cliente |
| `state` ∈ `observed`, `declared`, `verified`, `revoked`, `expired` | Separa coincidencia, declaración y verificación |
| `method` (p. ej., `email_otp`, `account_login`, `operator`), `verified_at`, `evidence_ref` | Cómo y cuándo se verificó |
| `revalidate_after` | Mitigación de números reciclados |
| `revoked_at`, `revoked_by`, `revocation_reason` | Revocación auditable |
| Historial inmutable de transiciones | Auditoría |

**Sobre los modelos actuales:**
- `customer_external_identity` de CRM no tiene estado, método, vigencia ni revocación. Además vive en la base de un sistema en retiro.
- `crm_customer_identity_evidence` tiene estados más ricos, pero es de CRM y "never decides identity".
- `pc-users` no declara un concepto de vínculo.

**Conclusión: hacen falta cambios estructurales**, no solo ampliar un contrato.

### 9.2 Verificación (el núcleo de G2)

- Una prueba de **control** de la identidad comercial, ligada al sujeto de canal autenticado. Por ejemplo: un código o enlace de un solo uso enviado al **email registrado en la cuenta PrestaShop**, que el cliente confirma; el vínculo queda `verified` con `method = email_otp`.
- La coincidencia de teléfono o email, o los datos declarados, quedan como máximo `declared`.
- Revalidación periódica o ante señales de cambio de titular del número.

### 9.3 API para consumidores (CS-01 a CS-12)

1. `POST …/identity/resolve` (o equivalente): solo lectura, cuerpo `{schemaVersion, channel, accountRef, subjectRef, purposes[]}`, respuesta con `status` explícito y `prestashop_customer:<id>` solo si `verified`.
2. Registro de consumidores con credenciales separadas, allowlist de canal y cuenta, propósitos permitidos y límite de tasa.
3. Auditoría por resolución (hash del sujeto, consumidor, propósito, `status`, correlation id) y alertas de volumen.
4. Revocación administrable, con efecto en la siguiente resolución.
5. Contrato publicado por el **productor** (Swagger o JSON Schema versionado, fixtures, SHA), como ya hace `pc-users`.
6. Entorno de integración con identidades sintéticas.
7. Gancho para emitir grants **cuando** D2 se acuerde entre el owner de identidad y CP.
8. Separación estricta: el servicio de identidad no devuelve hechos comerciales (compras, montos); esos siguen en Customer Profile.

## 10. Recomendación sobre D1 y dictamen

```text
DICTAMEN=CS_IDENTITY_AUTHORITY_INCONCLUSIVE
D1=BLOCKED (no ACCEPTED)
```

**Por qué INCONCLUSIVE y no otro dictamen:**
- El objeto auditado, el **repositorio real de Customer Service**, no está disponible, y no se encontró ningún productor ni despliegue.
- No puede concluirse READY ni REQUIRES_CHANGES sin código.
- Tampoco NOT_SUITABLE: la evidencia negativa proviene de consumidores y de un servicio, `pc-users`, cuya identidad con "Customer Service" no está demostrada.

**Lo que sí está establecido**, y debe pesar en la decisión:

1. El contrato que R4 creía existente es **del consumidor** (CRM), sin productor desplegado conocido.
2. **Ninguna fuente observable** prueba el control de una identidad comercial (G2). Ninguna puede emitir hoy un `verified` aceptable para datos privados, sea cual sea el owner.
3. El único servicio relacionado y publicado (`pc-users`) gestiona usuarios y POS, y sincroniza clientes por coincidencia. En su forma declarada **no** satisface ninguna de las garantías CS-01 a CS-12.

**Para decidir D1 hacen falta, en este orden:**

| Paso | Responsable | Resultado esperado |
|---|---|---|
| 1 | Owner de negocio / arquitectura | Indicar **dónde está el código y el despliegue de "Customer Service"**, o declarar que no existe. Precisar si `pc-users` es ese servicio |
| 2a | Si existe | Repetir esta auditoría con su repositorio (Fases 1–3 con CS-CODE). Dictamen esperable: REQUIRES_CHANGES, como mínimo por G2, G3 y G6 |
| 2b | Si no existe (o es `pc-users`) | **Decisión de arquitectura:** qué servicio asume la autoridad de identidad verificada (ampliar `pc-users`, un servicio nuevo u otro) e implementar §9. Es la "carencia más profunda" en la gestión de identidades de PesasChile. R4 no la resuelve por su cuenta (ADR-039) |
| 3 | Owner de `pc-users` | Verificar G4 (§5.3), con independencia de J4 |

**Efecto en R4:**
- J4-R1B sigue abierto en la parte de identidad, y J4-R3 no puede empezar.
- Sales sigue operando con clientes `guest`.
- D2 se mantiene PROPOSED, a la espera de un owner de identidad con quien acordarla.
