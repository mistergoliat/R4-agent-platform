# R4-J4-R3-CIA-DISCOVERY-01 — Auditoría de identidad y diseño de la Customer Identity Authority v1

| Campo | Valor |
|---|---|
| Fecha | 2026-10-19 |
| Mandato | R4-J4-R3-CIA-DISCOVERY-01: preparar la implementación de la CIA v1 para resolver D1 y D2 |
| Modo | Investigación, revisión de código y diseño contractual. **Sin implementación**: sin OTP, sin grants reales, sin consultas a clientes reales, sin cambios en CP, CRM, `pc-users` ni el harness de R4, sin despliegue ni merge |
| Documento hermano | [Propuesta de contrato CIA v1](R4_J4_R3_CIA_CONTRACT_PROPOSAL.md) (**PROPUESTA, no aprobada**) |
| Antecedentes | [CS-R4-J4-IDENTITY-AUDIT-01](CS_R4_J4_IDENTITY_AUTHORITY_AUDIT_REPORT.md) (`INCONCLUSIVE`), [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) (CIA recomendada, owner por designar), [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) §5 (D2, alternativa A recomendada), [requisitos CS-01 a CS-12](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md), [registro de decisiones](R4-J4-R1C_SHARED_DECISION_REGISTER.md) |
| Premisas del mandato | Autoridad inicial de cuentas comerciales: **PrestaShop 8.2.3** (`ps_customer`, por sus interfaces oficiales). Prueba de control: **OTP al email declarado**. J4 solo resuelve cuentas existentes: la creación de cuentas pertenece a Checkout (R4-L/J5.5) |
| **Dictamen** | `CIA_V1_DISCOVERY_COMPLETE` · `D1_DECISION_READY` · `D2_CONTRACT_PROPOSED` (§10). **Actualizado** por la revisión OMNICHANNEL-ALIGNMENT-01 (abajo) |

> **Revisión OMNICHANNEL-ALIGNMENT-01 (2026-10-19).**
> - La [revisión de diseño omnicanal](R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md) **prevalece** sobre este informe cuando difieren.
> - El owner de R4 aprobó el flujo funcional OTP-por-email y **seleccionó la dirección B**. La designación del owner productor de la CIA sigue pendiente.
> - Secciones afectadas:
>   - §4.1: el flujo es genérico por canal;
>   - §4.3: la vigencia se separa en cuatro planos (A–D);
>   - R-5: el código ya no pasa por el modelo;
>   - §9.4: decisiones actualizadas;
>   - §10: dictamen nuevo.
> - El resto del informe (inventario, PrestaShop, alternativas) sigue vigente como evidencia.

## 0. Etiquetas de evidencia

| Etiqueta | Fuente |
|---|---|
| **GIT** | Verificado con git en esta sesión, tras `git fetch --prune` |
| **R4-CODE** | `R4-agent-platform` @ `3e7b4ee` |
| **CP-CODE / CP-DOC** | `MS-pesaschile-customer-profile` @ `de6c04a` (`origin/main`; árbol del checkout idéntico) |
| **CRM-CODE / CRM-DOC** | `CRM-Customer-360` @ `8298723` (`develop` = `origin/develop`) |
| **SPEC** | Swagger público: `pc-users` v1.3.2 (SHA-256 `ede84612…e8ed4f34`) y `pc-jwt-auth` v1.2.0 (SHA-256 `21f0ee85…4c2ceeca`), descargados el 2026-10-19T17:54Z. Es lo que declaran los servicios, **no su código** |
| **PS-SOURCE** | Código oficial de PrestaShop, tag `8.2.3` (commit `8f7502c9`), comparado con `1.7.8.1`; `B/` = `https://github.com/PrestaShop/PrestaShop/blob/8.2.3/` |
| **OWNER** | Hechos confirmados por el owner y ya registrados en ID-AUTHORITY-DECISION-01 §1 |
| **INFERRED** | Deducción de este informe, sin verificación directa |

Ninguna afirmación se apoya en el código de `pc-users` ni de `pc-jwt-auth`: no está disponible (§1).

---

## 1. Preflight

| Repositorio | Referencia | Estado | Fuente |
|---|---|---|---|
| R4 | `origin/main` = `3e7b4eec` | Merge del PR #11 (adaptador Customer Profile R2, inactivo). Cierre documental de R2 en la rama `docs/r4-j4-r2-postmerge-closure` (`c7a8e3c`), sin fusionar | GIT |
| Customer Profile | `origin/main` = `de6c04a6` | Merge del PR #25 (productor sintético 02C, apagado por defecto). G-16 PENDING | GIT |
| CRM | `develop` = `origin/develop` = `82987232`; `origin/main` = `7ec04886` (ancestro antiguo) | **Sin cambios** en el código de identidad desde la auditoría del 2026-10-15 | GIT |
| `pc-users` | — | **Repositorio no disponible.** No está en la estación (búsqueda hasta 6 niveles bajo el perfil del usuario). `git ls-remote` de `mistergoliat/{pc-users, pc_users, MS-pesaschile-pc-users, MS-pesaschile-users}`: "Repository not found" (se suma a los siete nombres probados el 2026-10-15). Swagger publicado **idéntico byte a byte** al auditado el 2026-10-15 | GIT; SPEC |
| `pc-jwt-auth` | — | Repositorio no disponible. Swagger idéntico al auditado | SPEC |
| PrestaShop | Tag `8.2.3` (`8f7502c9`) | Versión objetivo. La versión instalada en la tienda **no se verificó** (no se contactó ningún host de PesasChile) | PS-SOURCE |

No se modificó ningún repositorio ajeno. En Customer Profile y CRM solo se ejecutó `git fetch`.

---

## 2. Inventario de identidad existente

### 2.1 ¿Quién crea y actualiza `master_customer`?

| Hallazgo | Evidencia | Fuente |
|---|---|---|
| Schema: `id` autoincremental, `firstname`, `lastname`, `email` NOT NULL, `platform_origin`. **UNIQUE solo sobre `email`.** Sin teléfono ni RUT | `migrations/006_master_customer_platform_origin.sql:4-12` | CRM-CODE |
| Único INSERT productivo de CRM: `createMasterCustomer` (email normalizado; un duplicado devuelve `customer_email_duplicate`), invocado por `POST /api/customers` con `requireOperator` | `lib/integrations/customer-master/customer-repository.ts:79-105`; `app/api/customers/route.ts:18-33` | CRM-CODE |
| CRM **no** tiene UPDATE, DELETE ni merge productivos de `master_customer`, y prohíbe por test escribirlo desde sesión, onboarding e identidad | `tests/commercial/customerMasterProjectionGate.test.ts:195-221` | CRM-CODE |
| `pc-users` escribe `master_customer` a través de `POST /client-multiplatform` ("Inserts or synchronizes a client across multiple platforms") | OWNER; SPEC `/client-multiplatform` | OWNER; SPEC |
| El código de CRM **no** llama a `pc-users` ni a `client-multiplatform` | `git grep` sin resultados | CRM-CODE |

**Conclusión:** hay al menos dos escritores (CRM y `pc-users`) y ninguna autoridad formal (ID-AUTHORITY-DECISION-01, F3). La CIA **no debe** escribir `master_customer` ni depender de él.

### 2.2 ¿Qué responsabilidad tiene `pc-users`?

| Hallazgo | Evidencia | Fuente |
|---|---|---|
| "Microservice for user and POS data management": usuarios, roles y permisos POS, clientes, direcciones, historial, integraciones con PrestaShop y Mailling | SPEC `info` | SPEC |
| Alta y sincronización de clientes (`/client-multiplatform` responde `exists` por plataforma), búsqueda de clientes (`GET /client`, `GET /all-clients`, filtros en el cuerpo de un GET), borrado (`DELETE /client/{id}`) | SPEC `paths` | SPEC |
| Lectura y alta de clientes PrestaShop: `GET /customer-ps/{id_customer}`, `POST /customer-ps`, `GET /getCustomer`, `GET/POST /address-ps`, **sin seguridad declarada** (G4 de la auditoría anterior, sigue sin verificar y sin cambios en el Swagger) | SPEC | SPEC |
| **No declara** resolución de identidad, vínculos de canal, verificación, OTP, revocación ni grants | SPEC: 0 coincidencias de `otp`, `magic`, `one-time`, `revok`, `jwks`, `kid` | SPEC |

`pc-users` es el **gestor de datos maestros de cliente y POS**, no una autoridad de identidad.

### 2.3 ¿Hay OTP o verificación de email reutilizables?

| Componente | OTP, magic link o verificación de email | Envío de email | Fuente |
|---|---|---|---|
| CRM | **No.** Sin dependencias de correo (`nodemailer`, SMTP, SES) | Solo cotizaciones, delegadas a Quote Service (`POST /v1/quotes/{id}/send-email`) | CRM-CODE `httpQuoteServiceAdapter.ts:595` |
| `pc-users` | **No declarado** | Integración con "Mailling", una plataforma de mailing (`POST /create-user`, `GET /md-customer`, `GET /mailling-login`), no correo transaccional | SPEC |
| `pc-jwt-auth` | **No.** `POST /pc-ps-customer-login` valida **email y contraseña** y devuelve un JWT. `POST /logout` "invalida" emitiendo un token vencido: **no hay revocación en el servidor** | — | SPEC |
| Customer Profile | No | No | CP-CODE (sin coincidencias en `src/`) |
| PrestaShop 8.2.3 | **No** hay verificación de email en el alta ni en el cambio de email. Sí hay restablecimiento de contraseña por enlace enviado al email (`Mail::Send`) | Correo propio de la tienda | PS-SOURCE `controllers/front/PasswordController.php:67-122`; `IdentityController.php:57-69` |
| R4 | No | No | R4-CODE |

**No existe un mecanismo de OTP reutilizable.** Hay que construirlo. El único canal de correo transaccional confiable para clientes es el de la tienda o un proveedor nuevo (dependencia abierta DEP-5, §9).

### 2.4 Relación entre `master_customer` y `ps_customer`

| Hallazgo | Evidencia | Fuente |
|---|---|---|
| No hay FK hacia PrestaShop. El vínculo vive en `customer_external_identity` (`provider='prestashop'`, `external_id=id_customer`), con `UNIQUE(provider, external_id)` y FK `customer_id` → `master_customer`. `customer_id` es NULLABLE desde la migración 024 | `migrations/010_…sql:12-30`; `migrations/024_…sql:19` | CRM-CODE |
| Un `id_customer` apunta a un solo maestro; **un maestro puede tener varias cuentas PrestaShop** | `migrations/010:23-25` | CRM-CODE |
| El vínculo lo escribe solo CRM, después de una respuesta `completed` o `already_linked` de un "Customer Service" que no está desplegado | `customerIdentityCapabilities.ts:495-520` | CRM-CODE |
| **Hallazgo nuevo:** el upsert usa `ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), is_verified = VALUES(is_verified)`, así que **reasigna en silencio** una cuenta PrestaShop a otro maestro | `lib/integrations/customer-external-identity/repository.ts:88-151` | CRM-CODE |
| Las lecturas de candidatos (`SELECT DISTINCT id_customer FROM ps_customer WHERE LOWER(email)=?`) **no filtran** `id_shop`, `is_guest`, `active` ni `deleted` | `lib/integrations/prestashop-mirror/repository.ts:60-101` | CRM-CODE |
| Customer Profile pasó de `masterCustomerId` a `ps_customer.id_customer` directo (T12A). `master_customer` solo se usa en el camino legacy de RFM | CP-DOC `CP-R1-T12A-direct-prestashop-customer-input.md:11-16`; CP-CODE `src/infrastructure/crm/mysql-master-customer-reader.ts:7-10` | CP |

La relación es **N:1** (varias cuentas PrestaShop por maestro), la escribe un sistema en retiro y con una reasignación silenciosa. **No es base para la CIA.** Confirma la regla de ID-AUTHORITY-DECISION-01 §3: la CIA vincula sujetos de canal con `prestashop_customer:<id>` y no usa `master_customer` (I11 de ADR-039).

### 2.5 ¿Quién tiene autoridad para vincular una cuenta externa con un maestro?

**Nadie, formalmente.**
- El contrato de CRM designa a "Customer Service" como autoridad única (`docs/data/customer-creation-linking-authority-contract.md:1-6`, `approved`).
- Sus capacidades están `operational: not_verified` (`docs/CAPABILITY_MATRIX.md:74-78`).
- El productor no existe: el contrato `/v1/customers/*` no lo implementa `pc-users` (OWNER, SPEC; ID-AUTHORITY-DECISION-01 F2).

Este informe **no** propone una autoridad sobre `master_customer`. Esa propiedad sigue pendiente del negocio (ID-AUTHORITY-DECISION-01 §6, paso 2).

### 2.6 ¿Existe un sistema de grants verificables y revocables?

| Componente | Estado | Fuente |
|---|---|---|
| CRM | No. Solo sesión de operador (cookie HMAC, 12 h) y bearer estáticos | CRM-CODE `lib/auth.ts:5-87` |
| `pc-jwt-auth` | JWT de sesión de cliente PrestaShop. Sin revocación en servidor, sin JWKS declarado, con credenciales como entrada | SPEC |
| Customer Profile | Bearer **opacos** por principal (hash SHA-256, comparación en tiempo constante, rotación de hasta 2 hashes), scopes por familia de rutas. **Sin bibliotecas JWT/JWS/JWKS.** `authorizationBasis` fijo en `service_scope_only` | CP-CODE `src/http/auth/principal-registry.ts:1-21,128-145`; `package.json:57-65`; `compose-sales-context.ts:140` |
| Customer Profile (diseño) | Grant **CAG** propuesto: JWS compacto (EdDSA o ES256), JWKS fijado en configuración, `aud=customer-profile`, `azp=<principal>`, `sub=prestashop_customer:<id>`, `exp ≤ 15 min`, `jti`. **Descarta la introspección por petición.** Header reservado: **`x-customer-access-grant`** | CP-DOC `docs/audits/CP_V2_ARCHITECTURE_AUDIT.md:752-768`; `docs/reviews/CP_J4_R4_CONTRACT_ALIGNMENT.md:333,445` |

**No existe un sistema de grants.** Lo que hay son dos diseños compatibles: ADR-039 §5 alternativa A y CAG de CP. La propuesta de contrato los unifica (§5 de este informe).

---

## 3. Resolver de clientes PrestaShop 8.2.3

### 3.1 Hechos del código oficial

| Tema | Hallazgo | Evidencia | Fuente |
|---|---|---|---|
| Búsqueda por email (API oficial) | Webservice `customers`: `filter[email]=[x]` se traduce a una igualdad SQL. Un `|` dentro del valor produce un OR y un `%` al inicio o al final produce un LIKE: **el email debe validarse y escaparse antes de consultar**. Comparación según la collation (normalmente `_ci`) | `classes/webservice/SQLUtils.php:45-80`; `WebserviceRequest.php:1143-1163` | PS-SOURCE; collation INFERRED |
| Permisos del webservice | Clave de 32 caracteres (usuario de Basic auth o `ws_key`). Permisos por recurso y método: una clave puede limitarse a GET/HEAD sobre `customers` y asociarse a tiendas. El webservice debe estar activado (`PS_WEBSERVICE`) | `webservice/dispatcher.php:43-60`; `WebserviceRequest.php:820-846,863-872,964-992`; `WebserviceKey.php:123-131` | PS-SOURCE |
| **Exposición de secretos** | `customers` **no tiene campos ocultos**: un GET devuelve `passwd` (hash bcrypt) y `secure_key` (llave del enlace de restablecimiento). `display=[…]` reduce la salida, pero **no** el privilegio de la clave | `classes/Customer.php:154-214`; `WebserviceOutputBuilder.php:556`; `PasswordController.php:99,131` | PS-SOURCE |
| Identificadores | `id_customer`: `int unsigned AUTO_INCREMENT`, clave primaria. Cada cuenta tiene `id_shop` e `id_shop_group` | `install-dev/data/db_structure.sql:606-647` | PS-SOURCE |
| Multitienda | `customer` no está entre las tablas asociadas a tienda: un listado del webservice trae clientes **de todas las tiendas** y hay que filtrar con `filter[id_shop]` | `classes/shop/Shop.php:162-201`; `ObjectModel.php:1511-1544` | PS-SOURCE (comportamiento en ejecución INFERRED) |
| **Email no único** | Solo `KEY customer_email (email)`, sin UNIQUE (igual en 1.7.8.1). La unicidad depende del flujo: el alta en el front bloquea si ya existe una cuenta registrada **en el ámbito de clientes compartidos**. Pueden coexistir varios invitados, un registrado con invitados, y registrados entre tiendas que no comparten clientes. El back office ignora cuentas borradas e invitados al validar | `CustomerPersister.php:207-222`; `Customer.php:579-593`; `Shop.php:1090-1108`; `AddCustomerHandler.php:86-104`; `EditCustomerHandler.php:206-223` | PS-SOURCE |
| Duplicados reales | CP documenta **385 emails duplicados** en `ps_customer`: 16 dentro de la misma tienda y 373 entre tiendas. La tienda tiene al menos las tiendas 1, 2 y 3. **No hay política multitienda para identidad** | CP-DOC `CP-R1-T02-…:40,76`; `CP-R1-T10A-3-multishop-decision.md:13-17` | CP-DOC (no re-verificado: requeriría leer datos reales) |
| Invitados | `is_guest=1`: no pueden iniciar sesión; se crean con contraseña aleatoria. `transformToCustomer` conserva el id y falla si ya hay un registrado con ese email | `CustomerLoginForm.php:77`; `CustomerPersister.php:119-149,195-204`; `Customer.php:1206-1250` | PS-SOURCE |
| Inactivas | `active=0`: login y restablecimiento rechazados | `CustomerLoginForm.php:75-78`; `PasswordController.php:85-86` | PS-SOURCE |
| Eliminadas | Dos modos. "Permitir registrarse de nuevo" hace **borrado físico** (el `id_customer` desaparece; los pedidos quedan huérfanos). "No permitir" hace borrado lógico `deleted=1`. psgdpr hace borrado físico | `DeleteCustomerHandler.php:50-59`; `Customer.php:328-335,385-417`; psgdpr `master` `CustomerService.php:137-243` | PS-SOURCE (psgdpr en `master`, no la versión instalada) |
| Cambio de email | Cambiar el email desde "identity" conserva el `id_customer`, pide la contraseña actual y **no verifica el nuevo email** | `IdentityController.php:57-69`; `CustomerPersister.php:62-95,151-155` | PS-SOURCE |
| Migración 1.7.8.1 → 8.2.3 | Los SQL de actualización solo tocan columnas menores de `ps_customer` (`ape`, `note`). Ids y emails se conservan. Contraseñas en bcrypt desde 1.7, con fallback md5 que se re-hashea al iniciar sesión | autoupgrade `upgrade/sql/8.0.0.sql:197-199`, `8.1.3.sql:5`, `8.1.7.sql:21`; `src/Core/Crypto/Hashing.php:111,129-135` | PS-SOURCE |
| Verificar contraseñas | **No hay endpoint oficial.** El webservice es CRUD; `Customer::checkPassword` solo compara contra la cookie de sesión | `Customer.php:829-837` | PS-SOURCE |
| Enumeración | El restablecimiento revela si un email existe (mensajes distintos para inactiva o recién solicitada). El registro revela "email already used". **No hay límite de intentos de login** en el núcleo | `PasswordController.php:67-122`; `CustomerForm.php:127-131`; `CustomerLoginForm.php:64-82` | PS-SOURCE |

### 3.2 Consecuencias para la CIA

1. **El email no es una clave.** Una búsqueda puede dar 0, 1 o N cuentas. La CIA nunca elige "la primera" (`getByEmail` y `customerExists` lo hacen: `Customer.php:449-522,579-593`). Con más de una cuenta elegible el resultado es `ambiguous`.
2. **`id_customer` es estable** frente a cambios de email y a la actualización, pero **puede desaparecer** con un borrado físico. Un vínculo apunta al id y se revalida contra la cuenta en cada resolución.
3. **El email es mutable y no verificado por PrestaShop.** Un vínculo establecido por control del email vale mientras el email actual de la cuenta siga siendo el verificado. Si cambia, el vínculo pasa a `stale`.
4. **Elegibilidad v1:** `is_guest=0`, `active=1`, `deleted=0` e `id_shop` dentro de las tiendas permitidas al consumidor. La política de tiendas es una decisión abierta (OD-CIA-2). Invitados e inactivas quedan fuera, en línea con AP-09 (fail-closed).
5. **La clave del webservice es una credencial de alto valor:** lee los hashes de contraseña y las llaves de restablecimiento de **todos** los clientes. Requiere clave dedicada solo GET sobre `customers`, custodia como secreto, salida de red solo desde la CIA, `display` siempre restringido y respuestas nunca registradas. Alternativa a evaluar con el owner de la tienda: una vista o un endpoint de solo lectura que exponga únicamente los campos de §3.2.4 (DEP-3).
6. **Equivalencia de pruebas.** En PrestaShop 8.2.3, quien controla el email de una cuenta registrada y activa puede restablecer su contraseña (`PasswordController.php:73-119`). Por lo tanto, para esas cuentas, **el control del email no es más débil que el login**. El OTP evita además que las credenciales pasen por un agente o por páginas de terceros (riesgo R10 de ID-AUTHORITY-DECISION-01). Esto justifica que el OTP sea el método principal, en lugar del `account_login` que proponía ID-AUTHORITY-DECISION-01 §4.3. **Es una enmienda que debe aceptar el owner** (OD-CIA-1).

---

## 4. OTP por correo: diseño del flujo

### 4.1 Flujo

> **Revisión OMNICHANNEL-ALIGNMENT-01:**
> - El flujo vale para cualquier canal autenticado. WhatsApp es solo el primer adaptador.
> - El sujeto viaja en un `context` genérico (revisión §5.1).
> - El paso "R4 → CIA: confirma" ya no lo hace una capacidad: lo hace un **desvío en la ingesta**, antes de persistir el mensaje y fuera del harness (revisión §4).
> - El diagrama siguiente se conserva como referencia del diseño original.

```text
WhatsApp autenticado (firma de Meta: control del canal, NO identidad comercial)
  → R4: binding de la tarea → sujeto {channel, accountRef, subjectRef}         (nunca del modelo)
  → CIA: inicia verificación {sujeto, email declarado, conversación, propósitos}
        → respuesta UNIFORME (no revela si hay cuenta) + OTP enviado AL EMAIL DECLARADO
  → el cliente escribe el código EN EL MISMO CHAT de WhatsApp
  → R4 → CIA: confirma {sujeto, verificationId, código}
        → email verificado (control del buzón)
        → resolución PrestaShop por email verificado y tiendas permitidas      (después de la prueba)
        → exactamente 1 cuenta elegible → vínculo `verified` (method=email_otp)
  → R4 → CIA: resolve(sujeto, propósito) → verified + customerRef + grant      (ADR-039 §3, lazy)
  → R4 → CP: lectura con el grant (x-customer-access-grant) → CP verifica antes de responder
```

**Orden deliberado:** la búsqueda de cuentas ocurre **después** de probar el control del email. Así el resultado (ninguna cuenta, una, varias, invitada o inactiva) solo lo conoce quien controla el buzón, y el inicio de la verificación no permite enumerar cuentas.

### 4.2 Por qué el código se escribe en WhatsApp y no se usa un enlace

Un enlace en el correo prueba que **alguien** abrió el buzón, pero no que sea la persona que escribe por WhatsApp. Ataque: el atacante inicia la verificación desde su WhatsApp con el email de la víctima, y la víctima, confundida, hace clic. Resultado: la cuenta de la víctima queda vinculada al WhatsApp del atacante.

Con el código tecleado en el chat, el atacante necesita que la víctima **le entregue** el código. El correo lo advierte: "no compartas este código; escríbelo solo en el chat de WhatsApp de PesasChile con el número +56…; si no lo pediste, ignóralo". El riesgo residual es la ingeniería social, como en cualquier OTP.

### 4.3 Controles obligatorios

| Requisito del mandato | Diseño (detalle en la propuesta §8) |
|---|---|
| Un solo uso y expiración | Código de 6 dígitos, guardado como HMAC con clave propia; TTL de 10 min; consumido al primer acierto; un desafío nuevo invalida el anterior |
| Intentos y frecuencia | 5 intentos por desafío y luego `locked`. Límites por sujeto (3 desafíos/hora, 6/día), por hash del email (5/día, también entre sujetos), por consumidor (volumen global con alerta) y espera de reenvío de 60 s |
| Prevención de enumeración | Respuesta idéntica en forma y tiempo exista o no la cuenta. El OTP se envía **siempre** al email declarado (la existencia se evalúa tras la prueba). El correo no menciona cuentas. Un límite de tasa responde 429 igual para todos |
| Vínculo con conversación, propósito y sujeto | El desafío guarda el sujeto (hash HMAC), `conversationRef` (hash), consumidor y propósitos pedidos. Confirmar desde otro sujeto, conversación o consumidor falla como código inválido |
| Reutilización controlada de evidencia | La evidencia `email_verified` pertenece a **un** sujeto y no se transfiere. Un vínculo `verified` se reutiliza en resoluciones posteriores hasta `revalidate_after` (propuesta: 90 días) sin un OTP nuevo. Un propósito nuevo no exige OTP si la política del consumidor lo permite. Nunca se reutiliza un código. **Revisado:** el acceso a datos privados exige además una verificación reciente (plano C, candidata 24 h; revisión §6) |
| Revocación y caducidad | Revocación por el cliente (a través del consumidor), un operador (auditado), o automática ante cambio de email, inactivación, borrado o desaparición de la cuenta en PrestaShop. Caducidad por `revalidate_after`. Efecto en la **siguiente resolución**. Los grants ya emitidos caducan por TTL (≤ 5 min) |
| Control del correo frente a identidad comercial | Dos hechos distintos y registrados por separado: `email_verified` (controla el buzón X) y `link verified` (la cuenta PrestaShop elegible cuyo email **actual** es X). El primero sin el segundo da `not_linked`. El segundo se revalida en cada resolución |
| Autenticación técnica del webhook | La firma `X-Hub-Signature-256` (R4-CODE `adapters/channels/whatsapp-cloud/src/inbound.ts:51-61`) prueba solo que el mensaje viene de ese `wa_id`. **Nunca** se usa como prueba de identidad comercial; es la condición previa para iniciar el desafío |

### 4.4 Riesgos residuales

| # | Riesgo | Tratamiento | Residuo |
|---|---|---|---|
| R-1 | **Cuentas compartidas** (un email familiar o de empresa) | Quien controla el buzón accede al historial de esa cuenta. Es la misma capacidad que da el restablecimiento de contraseña de PrestaShop | Aceptado: equivale al modelo de seguridad de la tienda |
| R-2 | **Números de WhatsApp reciclados** | `revalidate_after` (90 días propuestos); una sola vinculación `verified` por sujeto; revocación por el cliente | Ventana hasta la revalidación. Meta no avisa del reciclaje |
| R-3 | **Email cambiado en PrestaShop sin verificación** | Revalidación del email actual en cada resolución (caché ≤ 5 min) → `stale` | Un cambio de email por un tercero que ya controla la cuenta queda fuera del alcance de la CIA |
| R-4 | **Ingeniería social del código** | Texto del correo; código que solo vale en el chat; límites | Inherente al OTP |
| R-5 | **El código pasa por el modelo** si la confirmación es una capacidad (propuesta §3.3) | Vale una sola vez, por 10 min, para un sujeto que la CIA toma del binding y no del modelo. Una vez consumido no sirve para nada | Queda en el transcript (D7). La alternativa, interceptarlo en ChannelIngress antes del modelo, cambia la ingesta de R4: decisión aparte (OD-CIA-5). **Revisado:** se descarta la capacidad. El código se desvía entre `adapter.parse` e `ingest` (`ingress.ts:111-123`), antes de `recordInbound` y de `memory_entries` (revisión §4). Residuo: el código escrito dentro de una frase sigue la ingesta ordinaria (revisión §4.4) |
| R-6 | **Abuso del envío de correos** a terceros | Límites por email y por sujeto; plantilla sin contenido comercial; alertas | Envíos no solicitados acotados |
| R-7 | **Compromiso de la clave del webservice** (§3.2.5) | Clave dedicada solo GET, secreto, red restringida; o vista mínima (DEP-3) | Alto si se compromete: expone hashes de contraseña |
| R-8 | **Compromiso de la clave de firma de grants** | KMS o clave no exportable, `kid`, rotación, TTL corto | Fabricación de grants hasta la rotación (ADR-039 §5) |

---

## 5. Grants individuales (D2)

### 5.1 Opaco con introspección frente a token firmado

| Criterio | A. Firmado (JWS), verificado localmente por CP | B. Opaco, introspección por petición |
|---|---|---|
| Revocación | Acotada por el TTL (≤ 5 min). Inmediata solo con una lista de revocación (v1.1) | Inmediata |
| Disponibilidad | CP no depende de la CIA en cada lectura (solo del JWKS en caché) | Cada lectura depende de la CIA; si la CIA cae, CP no lee |
| Latencia | Verificación local | +1 llamada por lectura (presupuesto CP 2 500 ms, AP-11) |
| Trabajo en CP | Añadir `jose`, JWKS fijado en configuración, verificación en el router entre el scope y el producer (CP-CODE `customer-sales-context.ts:60-93`) | Cliente HTTP hacia la CIA, credencial, timeouts y caché |
| Postura previa | ADR-039 §5 recomienda A. CP CAG **descarta** la introspección por petición | — |
| Riesgo de la clave | Firmar exige custodia (R-8) | Sin clave de firma |

**Recomendación: A**, alineada con ADR-039 y con el diseño CAG de CP. TTL ≤ 5 min (menor que el `exp ≤ 15 min` de CAG). La revocación efectiva se da en la **resolución** (la CIA deja de emitir) más el TTL. Si el owner exige revocación inmediata, se añade en v1.1 una lista de revocación por vínculo que CP consulta cada ≤ 60 s, sin introspección por petición.

### 5.2 Contenido

El contrato está en la propuesta §6. Cubre todo lo pedido:
- **Emisor verificable:** `iss` + `kid` + JWKS fijado.
- **Sujeto autenticado:** el hash del sujeto (`sbh`), **solo para auditoría**, porque CP no puede verificarlo (ADR-039 §5).
- **Referencia comercial y namespace:** `sub=prestashop_customer:<id>`.
- **Servicio destinatario:** `aud=customer-profile`.
- **Consumidor:** `azp=r4-sales`, igual al principal autenticado por bearer.
- **Propósitos:** `purposes`.
- **Instantes:** `iat`, `nbf`, `exp`.
- **Identificador de autorización:** `jti`.
- **Prueba de autenticidad:** la firma ES256.
- **Revocación:** `lnk` + `lver`.
- **Política de reutilización:** multiuso dentro del TTL, solo para la misma tupla.

**El token de servicio `r4-sales` no sustituye al grant.** Con D2 activo, CP exige ambos y responde 403 si falta el grant (CP-DOC `CP_J4_R4_CONTRACT_ALIGNMENT.md:445`).

### 5.3 Relación con R2 y AG-3

- El puerto de R2 se conserva tal cual. `CustomerAccessGrant { token, expiresAt, purposes }` (R4-CODE `adapters/domains/src/customer/profile-port.ts:34-44`) transporta el JWS como `token` **opaco**: R4 no lo decodifica.
- La autenticidad la verifica CP. Así se satisface AG-3 / P2-3 (registro R1C §9.3) **a nivel de sistema**: un grant fabricado por R4 o por un modelo lo rechaza CP con 403.
- R4 añadirá, en su slice, una prueba sintética de grant fabricado → `unauthorized`. **No se modifica ni el puerto ni el harness.**

---

## 6. Alternativas arquitectónicas

| Criterio | **A.** CIA dentro de `pc-users` | **B.** CIA independiente, integrada con PrestaShop (y con `pc-users` solo si hace falta) | **C.** Delegar en un componente existente |
|---|---|---|---|
| Componentes candidatos | `pc-users` | Servicio nuevo pequeño (resolución, desafíos, vínculos, emisión de grants) | `pc-jwt-auth` (login), PrestaShop (restablecimiento), CRM (niveles L0–L3) |
| Auditabilidad | **No**: código no disponible (§1) | Sí, desde el inicio | `pc-jwt-auth`: no disponible. CRM: disponible, pero en retiro |
| Propiedad del dominio | Mezcla **crear** clientes con **certificar** a quién pertenecen (juez y parte) | Separada: la CIA no crea ni modifica clientes | `pc-jwt-auth` autentica sesiones, no guarda vínculos. CRM está descartado (ID-AUTHORITY-DECISION-01 §2.1) |
| Seguridad conocida | G4: rutas PrestaShop sin seguridad declarada, sin verificar. Bearer grueso, sin modelo de consumidores | Diseño a medida de CS-01 a CS-12 | `pc-jwt-auth` exige credenciales (R10) y no revoca en servidor |
| Consistencia | Comparte datos con el maestro, pero su relación con PrestaShop no está demostrada (G8) | Una sola fuente: PrestaShop por id, revalidada en cada resolución | — |
| Complejidad operacional | Menor si el equipo lo asume | Un servicio, un esquema de datos, una clave de firma, un proveedor de correo | Baja, pero no cubre la necesidad |
| Escalabilidad | Desconocida | Carga baja (una resolución por invocación de capacidad, con caché) | — |
| Riesgo de duplicar autoridades | Bajo sobre clientes; alto sobre identidad si se mezcla con `client-multiplatform` | Bajo: la CIA no toca `master_customer` ni cuentas | — |
| Veredicto | **Admisible solo con las condiciones** de ID-AUTHORITY-DECISION-01 §2.3 (código auditable, G4 cerrado, módulo separado, owner). **Hoy sin la evidencia necesaria** | **Recomendada** | **Insuficiente.** Lo que se reutiliza, como dependencias y no como autoridad: el webservice de PrestaShop (lectura de cuentas) y su correo transaccional, si es apto (DEP-5) |

**Recomendación: B, con la huella mínima.**
- Un dominio y un servicio pequeños, sin escritura sobre clientes.
- La necesidad está demostrada: ningún componente auditable ofrece OTP, vínculos, revocación ni grants (§2.3, §2.6).
- No se presupone infraestructura adicional (colas, caches distribuidas o bus).
- La ubicación del despliegue y del almacenamiento la decide su owner (DEP-1).
- `pc-users` no es una dependencia de v1: PrestaShop es la autoridad de cuentas y el maestro no participa. Si el negocio prefiere A, el diseño contractual no cambia; cambian el productor y sus condiciones previas.

---

## 7. Integración con R4 y Customer Profile

| Lado | Qué cambia (en slices futuros autorizados) | Qué no cambia |
|---|---|---|
| **R4** | Adaptador HTTP de `CustomerIdentityResolver` contra `POST /v1/identity/resolve`. Dos capacidades **de escritura gobernadas** nuevas para iniciar y confirmar la verificación (propuesta §3.2-§3.3); son una decisión de producto aparte, porque envían correo a un tercero. Envío del header `x-customer-access-grant` en el adaptador CP (`grantSent: true`), con los gates AG-1 a AG-5 | Harness, ADR-039, D3 (`bindingByTask`), puerto `CustomerProfilePort`, tipos `IdentityResolution` y `CustomerAccessGrant`, capacidades `customer.get_context@2` y `customer.get_purchase_history@1` de R2 |
| **CIA** | Todo el contrato (propuesta) | — |
| **Customer Profile** | Verificación del grant en el router (después del scope, antes del producer); `jose`; JWKS fijado; error 403 `grant_rejected` con motivo enumerado (hay que unificar con `customer_access_grant_required` y `grant_mismatch` de CAG); `authorizationBasis: customer_grant_verified`; `validUntil = min(asOf+15 min, grant.exp)`; auditoría por `jti` y hash de `customerRef` (hoy no registra el cliente, CP-CODE `customer-sales-context.ts:168-190`); límite por principal | Contrato v1-rc1 hasta una revisión aprobada |

**Garantía de extremo a extremo:** una identidad desconocida, ambigua o no autorizada **no produce grant**. Sin grant, R4 no llama a CP (R4-CODE `customer-profile-outputs.ts:90-115`), y si llamara, CP respondería 403. El historial queda protegido por dos barreras independientes.

---

## 8. Plan de validación

Fixtures, casos negativos y criterios: propuesta §9. Cubren cada caso exigido: cliente válido, inexistente, email duplicado, invitado e inactivo, OTP vencido y reutilizado, WhatsApp distinto, `customerRef` falsificado, grant caducado, revocado o de otro servicio, acceso cruzado y CP caído. Se ejecutan **solo** con identidades sintéticas, alineadas con el dataset sintético de CP (`900000201`–`900000313`, CP-CODE `synthetic-dataset.ts:6,41-47`).

---

## 9. Matriz D1/D2, dependencias e incertidumbres

### 9.1 Matriz D1/D2

| Decisión | Estado previo | Qué aporta este informe | Estado propuesto | Qué falta para ACCEPTED |
|---|---|---|---|---|
| **D1** Autoridad de identidad | BLOCKED (sin owner; F1–F4) | Inventario re-verificado; ninguna autoridad reutilizable; alternativas evaluadas con evidencia; método de prueba (OTP) fundamentado en el código de PrestaShop; modelo de resolución sobre PrestaShop 8.2.3 | **DECISION_READY** (recomendación B) | Que el negocio designe al owner de la CIA (o acepte A con sus condiciones); que acepte OD-CIA-1 (método); política de tiendas (OD-CIA-2); contrato v1 aprobado y publicado por el productor (CS-10); repositorio auditable |
| **D2** Grant individual | PROPOSED | Contrato JWS concreto que unifica ADR-039 §5 y CAG de CP: header, claims, verificación en CP, reutilización, revocación y errores | **CONTRACT_PROPOSED** | Aceptación de CIA + CP + owner de R4; implementación en CP (DEP-4); verificación sintética (I4); custodia de la clave (DEP-6) |
| D7 | PROPOSED_PRODUCTION_BLOCKER | La CIA guarda evidencia mínima (hashes, método, marcas de tiempo); el código del OTP puede quedar en el transcript de R4 (R-5) | Sin cambio | Política de retención y purga de R4 |
| G-16 | PENDING | — | Sin cambio | Aceptación formal del owner de CP |

### 9.2 Dependencias

| ID | Dependencia | Responsable | Bloquea |
|---|---|---|---|
| DEP-1 | Owner de la CIA designado, más su ubicación de despliegue y almacenamiento | Negocio | Todo |
| DEP-2 | Clave de webservice de PrestaShop dedicada (solo GET sobre `customers`) y acceso de red desde la CIA, o la vista mínima de DEP-3 | Owner de la tienda | Resolución contra datos reales |
| DEP-3 | Decisión entre webservice estándar (expone `passwd` y `secure_key`) y una vista o endpoint mínimo | Owner de la tienda + CIA | DEP-2 |
| DEP-4 | Implementación de la verificación de grants en CP | Owner de CP | Lecturas con `customer_grant_verified` |
| DEP-5 | Proveedor de correo transaccional con dominio propio, SPF/DKIM/DMARC y plantillas | Owner de la CIA + operación | OTP |
| DEP-6 | Custodia de la clave de firma (KMS o no exportable), `kid` y rotación | Owner de la CIA | Emisión de grants |
| DEP-7 | Política de tiendas (qué `id_shop` atiende cada consumidor) y de duplicados | Negocio + owner de la tienda | Resolución |
| DEP-8 | Capacidades de verificación en R4 (escritura gobernada) y su decisión de producto | Owner de R4 | Iniciar verificaciones desde WhatsApp |
| DEP-9 | Verificación de G4 en `pc-users` | Equipo de `pc-users` | Solo la alternativa A; independiente de J4 como incidente potencial |
| DEP-10 | Revisión legal (Ley 19.628 y Ley 21.719) del tratamiento del email y la evidencia | Negocio / legal | Datos reales |

### 9.3 Incertidumbres

1. **Versión instalada de PrestaShop** y configuración multitienda real (tiendas, `share_customer`): no verificadas. Todo §3 es código del tag `8.2.3`.
2. **Duplicados reales:** la cifra de 385 es documental (CP-DOC); no se re-verificó para no leer datos reales.
3. **`pc-users`:** sin código. Su relación con PrestaShop, `master_customer` y G4 sigue sin demostrar.
4. **Correo transaccional de la tienda:** no se sabe si sirve para la CIA (dominio, reputación, plantillas). Se supone un proveedor dedicado (DEP-5).
5. **psgdpr:** revisado en `master`; la versión instalada puede comportarse distinto.
6. **Comportamiento en ejecución** del listado multitienda del webservice: inferido del código.
7. **Códigos de error de CP** para grants: hay dos propuestas incompatibles (`grant_rejected` frente a `customer_access_grant_required`/`grant_mismatch`). Hay que unificarlos.
8. **R4-L/J5.5 (Checkout):** la evidencia `email_verified` sin cuenta podría servir para crear cuentas en el futuro. Queda fuera de J4 y no se diseña aquí.

### 9.4 Decisiones abiertas para el owner

| ID | Decisión | Recomendación |
|---|---|---|
| OD-CIA-1 | Método principal: `email_otp` en lugar de `account_login` (enmienda de ID-AUTHORITY-DECISION-01 §4.3) | Aceptar (§3.2.6) |
| OD-CIA-2 | Tiendas que resuelve cada consumidor | Para `r4-sales`, solo la tienda que atiende el canal; con duplicados en ella, `ambiguous` |
| OD-CIA-3 | `revalidate_after` | 90 días |
| OD-CIA-4 | Revocación inmediata de grants (lista v1.1) o solo por TTL | Solo TTL ≤ 5 min en v1 |
| OD-CIA-5 | Código del OTP por capacidad (pasa por el modelo) o interceptado en ChannelIngress | Capacidad en v1, con los controles de R-5 |
| OD-CIA-6 | Alternativa A o B | B |

> **Revisión OMNICHANNEL-ALIGNMENT-01:** el estado vigente está en la revisión §10.
> - OD-CIA-1: flujo funcional aprobado por el owner de R4; enmienda formal pendiente.
> - OD-CIA-3: B 90 días y C 24 h, ambos candidatos.
> - OD-CIA-5: capacidad descartada; O1 recomendada, sujeta a DEP-11.
> - OD-CIA-6: B seleccionada por el owner de R4, condicionada a la designación del owner productor.
> - OD-CIA-2 y OD-CIA-4: sin cambios, pendientes.

---

## 10. Dictamen

**Vigente tras OMNICHANNEL-ALIGNMENT-01** (revisión §16):

```text
CIA_V1_OMNICHANNEL_DESIGN_COMPLETE
CIA_CORE_CHANNEL_AGNOSTIC
CIA_CORE_ACCOUNT_PROVIDER_AGNOSTIC
D1_ARCHITECTURE_SELECTED_CONDITIONALLY
D2_PENDING_CP_ACCEPTANCE
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

Dictamen original del descubrimiento, conservado como histórico:

```text
CIA_V1_DISCOVERY_COMPLETE
D1_DECISION_READY                (recomendación: alternativa B; falta designar owner y aceptar OD-CIA-1/2)
D2_CONTRACT_PROPOSED             (R4_J4_R3_CIA_CONTRACT_PROPOSAL.md; no aprobado)
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_HARNESS_UNCHANGED
```

**Por qué `D1_DECISION_READY` y no `D1_REQUIRES_EVIDENCE`:**
- La evidencia basta para elegir entre A, B y C. Ningún componente auditable cumple los requisitos y la recomendación B no depende de evidencia faltante.
- La única alternativa que sí necesita evidencia ausente es A (código de `pc-users`, G4). Si el negocio la prefiere, D1 vuelve a `REQUIRES_EVIDENCE` para esa opción.
- **No se acepta D1 aquí:** aceptarla exige la designación del owner y un contrato aprobado y publicado por el productor.

**Lo que este informe no hace:** no implementa OTP, no emite grants, no consulta clientes reales, no crea cuentas, no modifica CP, CRM ni `pc-users`, no activa capacidades Customer, no modifica el harness, no integra Mercado Pago y no despliega.
