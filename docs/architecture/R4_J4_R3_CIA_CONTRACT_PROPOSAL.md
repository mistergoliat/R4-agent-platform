# R4-J4-R3 — Propuesta de contrato Customer Identity Authority (CIA) v1

| Campo | Valor |
|---|---|
| Fecha | 2026-10-19 |
| Estado | **PROPUESTA. No aprobada.** No es un contrato publicado por el productor (CS-10): no existe productor ni owner designado (D1). Sin implementación |
| Evidencia y alternativas | [Informe de descubrimiento](R4_J4_R3_CIA_DISCOVERY_REPORT.md). Las etiquetas (R4-CODE, CP-CODE, CP-DOC, PS-SOURCE, SPEC…) son las de ese informe §0 |
| Requisitos que satisface | CS-01 a CS-12 ([requisitos](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md)); ADR-039 §3–§5; gates AG-1 a AG-3 del [registro](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §9.3 |
| Aprobación requerida | Owner de la CIA (por designar), owner de Customer Profile (D2), owner de R4 y owner de la tienda (DEP-2/3/7) |
| Destinatarios | Owner de R4; futuro owner de la CIA; equipo de Customer Profile; owner de la tienda PrestaShop |
| Revisión | **OMNICHANNEL-ALIGNMENT-01 (2026-10-19)**, ver [revisión de diseño](R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md). Cambia: §2 (Channel Integration y Account Provider), §3 (objeto `context`, `verificationPurpose`, credencial exclusiva de `confirm`), §3.6 (sin capacidad de confirmación), §4 (modelo genérico), §6.1 (matriz con CP), §8 (verificación reciente) y §12. Sigue siendo **PROPUESTA** |

---

## 1. Alcance

**Incluye:**
- verificación del control de un email por OTP;
- vínculo de un sujeto de canal con **una** cuenta PrestaShop existente;
- resolución por sujeto y propósito;
- emisión de grants individuales;
- revocación y caducidad;
- auditoría.

**Excluye:**
- creación o modificación de cuentas PrestaShop (Checkout, R4-L/J5.5);
- `master_customer` y cualquier fusión de clientes;
- hechos comerciales, que siguen en Customer Profile;
- pagos;
- búsquedas o listados para consumidores.

## 2. Actores y confianza

| Actor | Rol | Credencial |
|---|---|---|
| Consumidor (`r4-sales`) | Inicia verificaciones, resuelve sujetos y revoca a pedido del cliente | Principal **agent**: bearer opaco, rotable, con scopes `identity.verification.start`, `identity.resolve` e `identity.link.revoke`. Allowlist de `channel`, `channelAccountRef`, propósitos y tiendas |
| Channel Integration del consumidor (R4: desvío en la ingesta) | Entrega la respuesta OTP desde el contexto autenticado del canal | Principal **channel-integration**: bearer separado con el scope **exclusivo** `identity.verification.confirm`. Ninguna capacidad lo tiene |
| Account Provider (adaptador PrestaShop, dentro de la CIA) | Busca y revalida cuentas para el núcleo con el puerto `AccountProvider` (revisión §2.2) | Credencial del proveedor (fila PrestaShop) |
| CIA | Autoridad de vínculos y emisora de grants | Clave de firma ES256 (no exportable) |
| Customer Profile | Verifica grants antes de devolver datos privados | JWKS fijado en su configuración |
| PrestaShop 8.2.3 | Autoridad de cuentas. La CIA solo lee | Clave de webservice dedicada, solo GET sobre `customers`, o vista mínima (DEP-3) |
| Proveedor de correo | Entrega del OTP | Credencial de la CIA (DEP-5) |
| Operador | Revocación y resolución de ambigüedades, auditada | Credencial separada; fuera de la API de consumidores |

Reglas:
- **El sujeto lo afirma el consumidor:** R4 lo toma de `bindingByTask` (D3), **nunca** del modelo.
- **El núcleo no conoce canales ni proveedores:**
  - `channel` es una cadena registrada en la configuración del consumidor, con el formato de `subjectRef` asociado;
  - `accountRef` lleva el namespace de un proveedor registrado.
- Clasificación de cada campo (afirmación confiable del adaptador o dato declarado por el usuario): revisión §5.2.
- La CIA confía en el consumidor dentro de su allowlist y lo limita y audita (CS-07, CS-08).
- La firma del webhook de Meta **no** es prueba de identidad comercial.

## 3. Operaciones (API de consumidores)

**Convenciones comunes:**
- Solo `POST` con cuerpo JSON. Ningún identificador en path ni query (CS-01; AP-02).
- `Authorization: Bearer <consumidor>`.
- `x-correlation-id` con el patrón `^[A-Za-z0-9._:-]{1,128}$`.
- Respuestas con `Cache-Control: no-store`.
- `schemaVersion: 1` obligatorio y cerrado.
- Las peticiones rechazan propiedades desconocidas (400). Las respuestas son tolerantes a campos aditivos.
- Errores como `{ "error": { "code", "retryable" } }`, sin texto libre (CS-04).
- **Contexto omnicanal** (revisión OMNICHANNEL-ALIGNMENT-01). Todas las operaciones lo llevan:
  ```json
  "context": { "channel": "whatsapp", "channelAccountRef": "<phone_number_id>", "subjectRef": "<wa_id>", "sessionRef": "<id opaco de sesión>", "subjectAssurance": "provider_signed" }
  ```
  - El cuerpo de cada operación sigue cerrado (`strict`).
  - Los campos planos `channel`, `accountRef`, `subjectRef` y `conversationRef` de los ejemplos de §3.1–§3.4 se **reemplazan** por `context`. `conversationRef` pasa a `context.sessionRef`.
  - Las rutas no cambian.
  - Es compatible porque el contrato no está publicado. La respuesta de `resolve` (`IdentityResolution` de R2) no cambia.

### 3.1 `POST /v1/identity/resolve` (solo lectura, CS-01/CS-02)

Petición:
```json
{ "schemaVersion": 1, "channel": "whatsapp", "accountRef": "<phone_number_id>", "subjectRef": "<wa_id>", "purposes": ["purchase_history"] }
```

Respuesta 200. Es exactamente el tipo `IdentityResolution` de R2 (R4-CODE `adapters/domains/src/customer/profile-port.ts:42-44`), sin cambios en el puerto:
```json
{ "schemaVersion": 1, "status": "verified", "customerRef": "prestashop_customer:900000201",
  "grant": { "token": "<JWS compacto, §6>", "expiresAt": "2026-10-19T18:05:00Z", "purposes": ["purchase_history"] },
  "resolvedAt": "2026-10-19T18:00:00Z" }
```
```json
{ "schemaVersion": 1, "status": "not_linked", "resolvedAt": "2026-10-19T18:00:00Z" }
```

| `status` | Cuándo |
|---|---|
| `verified` | Vínculo `verified` vigente **y** revalidado contra PrestaShop (§5.3) **y** todos los propósitos pedidos permitidos para el consumidor y el cliente. Se emite un grant nuevo |
| `not_linked` | Sin vínculo; vínculo revocado; email verificado sin cuenta elegible; cuenta borrada |
| `not_verified` | Verificación iniciada sin confirmar; vínculo `stale` (cambió el email en PrestaShop) o `expired` (pasó `revalidate_after`); **verificación reciente vencida** para algún propósito pedido (plano C, §8) |
| `ambiguous` | Email verificado con más de una cuenta elegible en las tiendas permitidas |
| `conflicted` | El sujeto intentó vincular una segunda cuenta con una vigente (ID-AUTHORITY-DECISION-01 §4.2) |
| `not_authorized` | Cuenta solo invitada o inactiva (AP-09, fail-closed), o propósito denegado por política del cliente |

Reglas:
- `customerRef` y `grant` van **solo** con `verified`.
- `grant.expiresAt` = `exp` del JWS.
- `grant.purposes` = los propósitos pedidos y concedidos; si no se conceden todos, el estado es `not_authorized` (CS-06).
- Sin PII y sin `masterCustomerId` (CS-02).

**Errores:**

| Código HTTP | `code` | Notas |
|---|---|---|
| 400 | `invalid_request` | Petición mal formada |
| 401 | `unauthenticated` | Credencial del consumidor ausente o inválida |
| 403 | `consumer_not_allowed` | Canal, `accountRef` o propósito fuera de la allowlist del consumidor: es un error de configuración, **no** un estado del cliente |
| 429 | `rate_limited` | — |
| 503 | `dependency_unavailable` | PrestaShop no responde y la revalidación en caché venció. **Nunca** se responde un `not_linked` falso (CS-11) |

### 3.2 `POST /v1/identity/verifications` (inicia el desafío; escritura con efecto: envía un correo)

Petición:
```json
{ "schemaVersion": 1, "channel": "whatsapp", "accountRef": "…", "subjectRef": "…", "conversationRef": "…", "email": "cliente@example.cl", "purposes": ["sales_context", "purchase_history"] }
```

Respuesta 202, **idéntica en forma y tiempo para cualquier email bien formado**:
```json
{ "schemaVersion": 1, "verificationId": "<128 bits aleatorios, base64url>", "status": "challenge_issued", "expiresAt": "…", "resendAvailableAt": "…" }
```

- El OTP se envía **siempre** al email declarado. La CIA **no** consulta PrestaShop en este paso (anti-enumeración).
- El email se valida (RFC 5321, ≤ 254 caracteres, sin `|`, `%`, `[`, `]` ni espacios), se normaliza en minúsculas y se guarda **cifrado solo hasta consumir o expirar el desafío**. Después queda solo su HMAC.
- Iniciar un desafío nuevo invalida el anterior del mismo sujeto.
- **Revisión:** el cuerpo lleva `context` y `verificationPurpose: "link_commercial_account"`, separado de `purposes` (propósitos de datos del grant). Credencial agent.
- `verificationId` y `expiresAt` los guarda la Channel Integration como expectativa de verificación (revisión §4.4). **Nunca llegan al modelo.**

**Errores:** 400 `invalid_request` (email inválido incluido), 401, 403 `consumer_not_allowed`, 429 `rate_limited` (todos los límites, sin indicar cuál) y 503 `delivery_unavailable`.

### 3.3 `POST /v1/identity/verifications/confirm`

Petición:
```json
{ "schemaVersion": 1, "verificationId": "…", "channel": "whatsapp", "accountRef": "…", "subjectRef": "…", "conversationRef": "…", "code": "123456" }
```

Respuesta 200:
```json
{ "schemaVersion": 1, "outcome": "linked" }
```

| `outcome` | Significado |
|---|---|
| `linked` | Código correcto y exactamente una cuenta elegible: vínculo `verified` (`method=email_otp`) |
| `no_eligible_account` | Código correcto; email verificado sin cuentas (o solo borradas). La evidencia queda registrada para este sujeto |
| `ineligible_account` | Código correcto; solo hay cuentas invitadas o inactivas |
| `ambiguous` | Código correcto; varias cuentas elegibles. Se deriva a un operador |
| `conflicted` | El sujeto ya tiene otro vínculo `verified` vigente |
| `invalid_code` | Incluye `attemptsRemaining`. **También** se usa si el sujeto, la conversación o el consumidor no coinciden con el desafío: no se revela la diferencia |
| `expired` | Desafío vencido |
| `locked` | Intentos agotados |

- **Revisión:**
  - solo la acepta el principal **channel-integration** (scope `identity.verification.confirm`);
  - con cualquier otro principal responde 403 `consumer_not_allowed`;
  - `context.sessionRef` debe coincidir con el del desafío; si no, `invalid_code`.
- La confirmación **nunca** devuelve `customerRef` ni grant. R4 los obtiene con `resolve` (§3.1), que sigue siendo la única vía.
- Revelar el resultado a quien probó controlar el buzón no es enumeración.
- **Errores:** 400, 401, 403, 429 y 503 `dependency_unavailable` (PrestaShop no responde: el desafío **no** se consume y puede reintentarse dentro de su TTL).

### 3.4 `POST /v1/identity/links/revoke` (a pedido del cliente, por el consumidor)

Petición: `{ schemaVersion, channel, accountRef, subjectRef, reason: "customer_request" }`.

Respuesta 200: `{ "schemaVersion": 1, "outcome": "revoked" | "no_active_link" }`.

Tiene efecto en la siguiente resolución (CS-09).

### 3.5 Fuera de la API de consumidores

- **Operadores:** revocación por sujeto o por cuenta, resolución de `ambiguous` y consulta de auditoría. Credencial separada, mínimo privilegio, cada acción auditada. No forma parte de este contrato.
- **`GET /.well-known/jwks.json`:** claves públicas vigentes y la siguiente (`kid`). CP las **fija en su configuración** (diseño CAG) y no las descarga en cada petición. La rotación publica la clave nueva antes de usarla, con un solapamiento ≥ TTL máximo + 24 h.

### 3.6 Correspondencia con R4

| Operación CIA | R4 (slices futuros) |
|---|---|
| `resolve` | Adaptador de `CustomerIdentityResolver` (puerto de R2, sin cambios) |
| `verifications` | Capacidad de **escritura gobernada** nueva (p. ej. `customer.start_identity_verification@1`). El modelo puede pasar el email que el cliente escribió; el sujeto y `conversationRef` los pone el handler desde el binding |
| `verifications/confirm` | ~~Capacidad gobernada nueva~~ **Revisado:** **no** es una capacidad. La llama el desvío de la ingesta de R4, entre `adapter.parse` e `ingest` y fuera del harness, sin que el código llegue al modelo ni a `memory_entries` (revisión §4, OD-CIA-5). Después, la plataforma reanuda la tarea con una entrada sin código |
| `links/revoke` | Capacidad gobernada nueva, a pedido explícito del cliente |

Las capacidades nuevas son una **decisión de producto de R4** (DEP-8) y no forman parte de este contrato. El harness no cambia: usan la ejecución gobernada existente.

---

## 4. Modelo de datos y estados

Parte de ID-AUTHORITY-DECISION-01 §4.2, con estos cambios.

> **Revisión OMNICHANNEL-ALIGNMENT-01** (detalle en la revisión §5.4):
> - `identity_link` pasa a `account_link`: `prestashop_customer_id` + `id_shop` se reemplazan por `account_provider`, `account_ref` (con namespace) y `provider_scope`, y se añade `last_verified_at` (plano C).
> - `channel_subject` usa `channel_account_ref`.
> - `verification_challenge` y `email_evidence` añaden `session_hash`; el desafío añade también `verification_purpose`.
> - El resto se mantiene.

| Entidad | Campos clave | Restricciones |
|---|---|---|
| `channel_subject` | `id`, `channel`, `account_ref`, `subject_hash` (HMAC con clave propia) | Único `(channel, account_ref, subject_hash)`. **No se guarda `wa_id` en claro**: el OTP va por email, no por el canal |
| `verification_challenge` | `id`, `subject_id`, `consumer_id`, `conversation_hash`, `purposes`, `email_enc` (se borra al cerrar), `email_hash`, `code_hmac`, `issued_at`, `expires_at`, `attempts`, `consumed_at`, `outcome` | Un solo uso; como máximo un desafío abierto por sujeto |
| `email_evidence` | `id`, `subject_id`, `email_hash`, `verified_at`, `challenge_id` | Pertenece a un sujeto; no se transfiere |
| `identity_link` | `id`, `subject_id`, `prestashop_customer_id`, `id_shop`, `email_hash` (el verificado), `state`, `method`, `verified_at`, `revalidate_after`, `version`, `revoked_at`, `revoked_by`, `revocation_reason` | **Como máximo un vínculo `verified` por sujeto** (índice único parcial). Una cuenta puede tener varios sujetos |
| `identity_link_event` | `link_id`, `from_state`, `to_state`, `actor`, `reason`, `at`, `correlation_id` | Append-only |
| `grant_issuance` | `jti`, `link_id`, `link_version`, `consumer_id`, `purposes`, `iat`, `exp` | Append-only. **Nunca** el token |
| `resolution_audit` | `consumer_id`, `purposes`, `subject_hash`, `status`, `correlation_id`, `at` | Append-only, sin PII en claro |

**Estados del vínculo:**
- `verified` →
  - `stale`: el email actual de la cuenta ya no coincide con `email_hash`;
  - `expired`: pasó `revalidate_after`;
  - `revoked`: por el cliente, un operador, o porque la cuenta pasó a inactiva, `deleted=1`, desapareció (404) o se volvió invitada.
- `stale` y `expired` vuelven a `verified` solo con un OTP nuevo.
- `revoked` es terminal: un vínculo nuevo es una fila nueva.
- Cada transición incrementa `version`, que viaja en el grant como `lver`.

---

## 5. Resolución contra PrestaShop 8.2.3

### 5.1 Consulta tras la verificación del email

```text
GET /api/customers?output_format=JSON
    &display=[id,email,is_guest,active,deleted,id_shop,id_shop_group,date_upd]
    &filter[email]=[<email normalizado y validado>]
    &filter[id_shop]=[<tiendas permitidas al consumidor, separadas por |>]
```

- **`display` siempre explícito.** Nunca se piden `passwd`, `secure_key` ni `reset_password_token` (informe §3.1).
- Las respuestas no se registran.
- El `|` solo lo construye la CIA, nunca a partir de la entrada (PS-SOURCE `SQLUtils.php:45-80`).
- Con la vista mínima de DEP-3, la misma consulta se hace contra ella.

### 5.2 Elegibilidad y resultado

Una cuenta es **elegible** si cumple `is_guest=0`, `active=1`, `deleted=0` e `id_shop ∈ tiendas permitidas`.

| Resultado de la consulta | `outcome` (§3.3) | Estado en `resolve` |
|---|---|---|
| 1 elegible | `linked` | `verified` |
| >1 elegibles | `ambiguous` | `ambiguous`. **Nunca** se elige una |
| 0 elegibles, con alguna invitada o inactiva | `ineligible_account` | `not_authorized` |
| 0 filas, o solo `deleted=1` | `no_eligible_account` | `not_linked` |

### 5.3 Revalidación en cada `resolve`

`GET /api/customers/<id>` con el mismo `display`, en caché de hasta 5 min por vínculo:

| Resultado | Transición |
|---|---|
| Elegible y con `email_hash` igual | Se emite el grant |
| Email distinto | `stale` |
| Inactiva, borrada, invitada o 404 | `revoked` (automático, auditado) |
| PrestaShop no responde y la caché venció | 503 |

---

## 6. Grant individual (D2)

### 6.1 Formato

**JWS compacto**, algoritmo **ES256**. Se aceptan solo los algoritmos de una allowlist; `none` y `HS*` se rechazan.

Header:
```json
{ "alg": "ES256", "kid": "cia-2026-10", "typ": "cia-grant+jwt" }
```

Claims:
```json
{
  "cv": 1,
  "iss": "<URI del emisor CIA, fijado en CP>",
  "aud": "customer-profile",
  "azp": "r4-sales",
  "sub": "prestashop_customer:900000201",
  "purposes": ["purchase_history"],
  "iat": 1792432800, "nbf": 1792432800, "exp": 1792433100,
  "jti": "<ULID>",
  "lnk": "<id del vínculo>", "lver": 3,
  "amr": ["email_otp"], "vat": 1792000000,
  "sbh": "<HMAC del sujeto, solo auditoría>"
}
```

| Requisito del mandato | Claim |
|---|---|
| Emisor verificable | `iss` + `kid` + firma contra JWKS fijado |
| Sujeto autenticado | `sbh`, **solo para auditoría**: CP no puede verificarlo (ADR-039 §5). La autenticación del sujeto la garantiza la CIA al emitir |
| Referencia comercial y namespace | `sub` con `^prestashop_customer:[1-9][0-9]{0,9}$` |
| Servicio destinatario | `aud` |
| Consumidor | `azp`, que debe ser igual al principal autenticado por bearer en CP |
| Propósito | `purposes` |
| Emisión y expiración | `iat`, `nbf`, `exp`, con `exp − iat ≤ 300 s` |
| Identificador | `jti` |
| Prueba de autenticidad | Firma ES256 |
| Revocación | `lnk` + `lver` (§6.4) |
| Método | `amr`, `vat` |

**Diferencias con el diseño CAG de CP** (CP-DOC `CP_V2_ARCHITECTURE_AUDIT.md:752-768), que hay que acordar:
- `purposes[]` en lugar de `purpose` + `scope[]`: el scope pertenece al bearer y el puerto de R4 ya usa una lista;
- `amr` en lugar de `assurance`;
- `sbh` en lugar de `cnf` (hash de `conversationRef`);
- TTL de 5 min en lugar de 15.

**Revisión:**
- La matriz completa de alineamiento con CP está en la revisión §7. Cubre `purposes[]`/`purpose`, `amr`/`assurance`, `sbh`/`cnf`, TTL, revocación, errores y portador.
- Ningún punto está aceptado por CP: **D2_PENDING_CP_ACCEPTANCE**.

### 6.2 Transporte

- Header **`x-customer-access-grant: <JWS>`**: el nombre reservado por CP (CP-DOC `CP_J4_R4_CONTRACT_ALIGNMENT.md:333`).
- Va junto al `Authorization: Bearer` de `r4-sales`. **El token de servicio no sustituye al grant:** con D2 activo, CP exige los dos.
- R4 trata el JWS como opaco (`CustomerAccessGrant.token`): no lo registra, no lo persiste en observaciones y no lo muestra al modelo (ADR-039 I6).
- Tamaño máximo: 2 KiB.

### 6.3 Verificación en Customer Profile, en orden

Lugar: el router, después del principal y el scope y antes del producer (CP-CODE `src/http/routes/customer-sales-context.ts:60-93`).

1. Principal autenticado y scope `customer.sales_context.read` (existente).
2. Header presente; si falta, `missing`.
3. JWS bien formado, ≤ 2 KiB, `alg` en la allowlist, `typ` correcto y `kid` en el JWKS fijado.
4. Firma válida.
5. `iss` igual al fijado; `aud == "customer-profile"`; **`azp ==` principal autenticado**.
6. `nbf ≤ ahora + 60 s`; `exp > ahora`; `exp − iat ≤ 300`.
7. **`sub ==` `customerRef` del cuerpo.**
8. **`purpose` del cuerpo ∈ `purposes`.**
9. `cv` soportado.
10. (v1.1, OD-CIA-4) `lnk` no revocado en una versión ≥ `lver`.

Si todo pasa:
- `provenance.authorizationBasis = "customer_grant_verified"`;
- `validUntil = min(asOf + 15 min, exp)`;
- se audita `jti`, el principal y el hash de `customerRef`.

Si algo falla: **403** `{ "error": "grant_rejected", "reason": "<motivo>" }`, donde `reason` ∈ `missing`, `malformed`, `unsupported_alg`, `unknown_key`, `bad_signature`, `wrong_issuer`, `wrong_audience`, `consumer_mismatch`, `not_yet_valid`, `expired`, `ttl_too_long`, `customer_mismatch`, `purpose_not_granted`, `unsupported_version`, `revoked`.

- Esto unifica `grant_rejected` (alineamiento CP) con los motivos de CAG. Hay que acordarlo con CP, porque cambia su error plano (AP-06).
- R4 ya trata cualquier 403 como `unauthorized` / `profile_unauthorized` sin reintento (R4-CODE `client.ts:239-242`).

### 6.4 Reutilización y revocación

- **Reutilización:** un grant es **multiuso dentro de su TTL**, solo para la misma tupla (`azp`, `aud`, `sub`, propósito ∈ `purposes`). No es de un solo uso, porque eso exigiría estado en CP.
- R4 no lo guarda más allá de la invocación que lo resolvió (ADR-039 §3: resolución perezosa por invocación).
- **Revocación v1:** la CIA deja de emitir en la siguiente `resolve`, y los grants emitidos caducan en ≤ 5 min (ADR-039 §8).
- **v1.1, opcional:** `POST /v1/grants/revocations/query` de solo lectura para CP, que devuelve los vínculos revocados desde un cursor. CP lo consulta cada ≤ 60 s y rechaza `lnk` con `lver` revocada. No hay introspección por petición.

---

## 7. Controles por consumidor y auditoría

| Control | Valor propuesto |
|---|---|
| Allowlist de `r4-sales` | `channel=whatsapp`; `accountRef` ∈ los `phone_number_id` de R4; propósitos `sales_context` y `purchase_history`; tiendas según OD-CIA-2 |
| Límites de `resolve` | Por consumidor (p. ej. 20/s) y por sujeto (p. ej. 60/h). Alerta si un consumidor resuelve más de N sujetos distintos por hora (CS-08) |
| Límites de verificación | §8 |
| Auditoría | Cada `resolve`, desafío, confirmación, transición, emisión y revocación, con consumidor, `correlationId` y hashes. Sin email, `wa_id`, código ni token en claro |
| Secretos | Clave HMAC de hashes, clave de cifrado del email, clave de firma (DEP-6) y clave del webservice: separadas y rotables |

## 8. OTP y correo

| Parámetro | Valor propuesto |
|---|---|
| Código | 6 dígitos de un CSPRNG; guardado como `HMAC(clave, verificationId‖código)`; comparación en tiempo constante |
| TTL | 10 min |
| Intentos | 5 por desafío; luego `locked` |
| Reenvío | Cada 60 s como mínimo; reenviar invalida el código anterior |
| Límites por sujeto | 3 desafíos por hora y 6 por día |
| Límites por `email_hash` | 5 desafíos por día, entre todos los sujetos |
| Límites por consumidor | Volumen global con alerta |
| Probabilidad de adivinar | ≤ 5 × 10⁻⁶ por desafío, y ≤ 3 × 10⁻⁵ por sujeto y día |
| Respuesta uniforme | Mismo cuerpo y misma latencia; el envío del correo es asíncrono |
| Plantilla | Sin enlaces y sin datos de cuenta. Texto: código, vigencia, "escríbelo solo en `<nombre visible del canal del consumidor>`", "nunca te pediremos tu contraseña", "si no lo pediste, ignora este mensaje". **Revisión:** el nombre del canal viene de la configuración del consumidor (p. ej., "el chat de WhatsApp de PesasChile (+56…)"), no del código del núcleo |
| Entrega | Dominio propio con SPF, DKIM y DMARC (DEP-5) |
| `revalidate_after` del vínculo (plano B) | 90 días (OD-CIA-3, **candidato**) |
| Verificación reciente para datos privados (plano C) | `last_verified_at` + 24 h para `purchase_history`; `sales_context` por decidir (OD-CIA-3, **candidato**). Si vence, `resolve` da `not_verified` (revisión §6) |

---

## 9. Plan de validación

Todo se ejecuta con datos **sintéticos**: un doble de PrestaShop servido desde fixtures (mismo contrato que el webservice §5.1), un buzón de prueba, claves de prueba y CP sintético. Ninguna prueba toca clientes reales.

### 9.1 Fixtures de cuentas (doble de PrestaShop)

Ids alineados con el dataset sintético de CP (`900000201`–`900000313`) donde aplica.

| Fixture | Cuentas |
|---|---|
| FX-VALID | `900000201`: registrada, activa, tienda 1, `valid@synthetic.test` |
| FX-NONE | `none@synthetic.test`: sin filas |
| FX-DUP-SHOP | `dup@synthetic.test`: dos registradas activas en la tienda 1 |
| FX-DUP-XSHOP | `xshop@synthetic.test`: registrada en la tienda 1 y en la tienda 2 |
| FX-GUEST | `guest@synthetic.test`: solo `is_guest=1` (varias filas) |
| FX-INACTIVE | Registrada con `active=0` |
| FX-SOFTDEL | Registrada con `deleted=1` |
| FX-GONE | Vínculo existente cuya cuenta devuelve 404 (borrado físico) |
| FX-EMAILCHG | Vínculo existente cuya cuenta cambió de email |
| FX-B | `900000202`: segunda cliente válida, para acceso cruzado |

### 9.2 Casos

| # | Caso | Resultado esperado | Capa |
|---|---|---|---|
| V-01 | Cliente válido: desafío, código correcto, `resolve` | `linked`; luego `verified` con grant; CP 200 con `authorizationBasis: customer_grant_verified` | CIA, CP, E2E sintético |
| V-02 | Cliente inexistente (FX-NONE) | 202 uniforme al iniciar; tras el código, `no_eligible_account`; `resolve` da `not_linked`; 0 llamadas a CP | CIA, R4 |
| V-03 | Email duplicado en una tienda (FX-DUP-SHOP) | `ambiguous`; ningún grant | CIA |
| V-04 | Duplicado entre tiendas con la política "solo tienda 1" (FX-DUP-XSHOP) | `linked` a la cuenta de la tienda 1; con ambas tiendas permitidas, `ambiguous` | CIA |
| V-05 | Invitada (FX-GUEST) e inactiva (FX-INACTIVE) | `ineligible_account`; `resolve` da `not_authorized` | CIA |
| V-06 | Borrada (FX-SOFTDEL) | `no_eligible_account` | CIA |
| V-07 | Cuenta desaparecida (FX-GONE) o cambio de email (FX-EMAILCHG) tras el vínculo | `revoked` o `stale` en el siguiente `resolve`; ningún grant | CIA |
| V-08 | OTP vencido | `expired`; un desafío nuevo funciona | CIA |
| V-09 | OTP reutilizado tras `linked` | `invalid_code` (consumido); sin efectos | CIA |
| V-10 | 5 códigos erróneos | `locked`; el código correcto posterior también falla | CIA |
| V-11 | Confirmación desde un WhatsApp distinto (otro `subjectRef`), otra conversación u otro consumidor | `invalid_code`, sin revelar el motivo; el desafío original sigue válido | CIA |
| V-12 | `resolve` de un sujeto sin vínculo cuya cuenta existe | `not_linked`; la coincidencia de email o teléfono **nunca** da `verified` | CIA |
| V-13 | `customerRef` falsificado: grant válido de A y petición a CP con `customerRef` de B | CP 403 `customer_mismatch` | CP |
| V-14 | Grant fabricado (firma inválida, `alg: none`, `HS256` con clave pública, `kid` desconocido) | CP 403 `bad_signature` / `unsupported_alg` / `unknown_key`; R4 `unauthorized` (cierra AG-3) | CP, R4 |
| V-15 | Grant caducado y grant con `exp − iat > 300` | CP 403 `expired` / `ttl_too_long` | CP |
| V-16 | Vínculo revocado | `resolve` da `not_linked` y no se emite grant. Un grant ya emitido vale hasta su `exp` (v1) o se rechaza con `revoked` (v1.1) | CIA, CP |
| V-17 | Grant destinado a otro servicio (`aud` distinto) u otro consumidor (`azp` ≠ principal) | CP 403 `wrong_audience` / `consumer_mismatch` | CP |
| V-18 | Propósito no concedido (grant de `sales_context` usado para `purchase_history`) | CP 403 `purpose_not_granted`; R4 no llama a CP (`incoherent_grant`, R4-CODE `customer-profile-outputs.ts:106-115`) | CP, R4 |
| V-19 | Acceso cruzado: el sujeto de A no puede obtener nada de B | `resolve` de A solo da `sub` de A; el grant de A contra B se rechaza (V-13). Un segundo vínculo para A da `conflicted` | CIA, CP |
| V-20 | Customer Profile caído (503 o timeout) | R4 `temporarily_unavailable`, **nunca** `unavailable`/`not_on_file`; la CIA no se ve afectada | R4 |
| V-21 | PrestaShop caído durante `resolve` o `confirm` | 503 `dependency_unavailable`; nunca `not_linked`; el desafío no se consume | CIA |
| V-22 | Enumeración: iniciar con un email existente o inexistente | Cuerpo idéntico; diferencia de latencia p95 bajo un umbral fijado; mismo 429 | CIA |
| V-23 | Inyección en el filtro (`a|b@x.cl`, `%@x.cl`, `[`) | 400 `invalid_request`; ninguna consulta a PrestaShop | CIA |
| V-24 | Consumidor fuera de la allowlist (otro `accountRef` o canal) | 403 `consumer_not_allowed` | CIA |
| V-25 | Minimización: respuestas y logs de la CIA | Sin email, `wa_id`, código ni token en claro; `display` nunca incluye `passwd` ni `secure_key` | CIA |
| V-26 | Rotación de claves | Un grant con `kid` nuevo, publicado y fijado, se acepta; el retirado se rechaza tras el solapamiento | CP |

**Gates de R4** (registro R1C §9.3):
- **AG-3** se cierra con V-13, V-14, V-17 y V-18 en verde.
- **AG-1** (aislamiento sintético) sigue siendo un requisito del adaptador CP de R4, independiente de este contrato.
- **AG-2** también.

---

## 10. Alternativas consideradas en el contrato

| Tema | Elegida | Descartada y motivo |
|---|---|---|
| Formato del grant | JWS ES256 verificado localmente | Opaco con introspección: acopla la disponibilidad de CP a la CIA y CAG lo descarta. HMAC compartido: CP podría fabricar grants |
| Dónde se escribe el código | Chat de WhatsApp | Enlace en el correo: permite vincular la cuenta de la víctima al WhatsApp del atacante (informe §4.2) |
| Momento de la búsqueda en PrestaShop | Después del OTP | Antes: permite enumerar cuentas o filtrar su existencia por el tiempo de respuesta |
| `confirm` devuelve `customerRef` | No; solo `resolve` | Un segundo camino de emisión duplicaría controles |
| Método | `email_otp` | `account_login`: credenciales fuera del chat, pero exige una página de la CIA y una vía de verificación de contraseñas que PrestaShop no ofrece de forma oficial (informe §3.1) |
| TTL del grant | 5 min | 10 min (ADR-039) o 15 min (CAG): más exposición sin beneficio, porque R4 resuelve por invocación |

## 11. Matriz D1/D2 y dependencias

| Decisión | Estado tras esta propuesta | Condición para aceptarla |
|---|---|---|
| D1 | `DECISION_READY` (informe §9.1) | Owner de la CIA designado; OD-CIA-1, OD-CIA-2 y OD-CIA-6 decididas; este contrato aprobado y publicado por el productor con JSON Schema, fixtures y SHA (CS-10) |
| D2 | `CONTRACT_PROPOSED` | Acuerdo de CIA, CP y R4 sobre §6 (incluidas las diferencias con CAG y los códigos de error); implementación en CP; V-13 a V-18 y V-26 en verde con datos sintéticos |

Dependencias DEP-1 a DEP-10: informe §9.2.

**Correspondencia con CS-01 a CS-12:**

| Requisito | Dónde se cumple |
|---|---|
| CS-01 | §3.1 |
| CS-02 | §3.1 |
| CS-03 | §4–§5 |
| CS-04 | §3 |
| CS-05 | §6 |
| CS-06 | §3.1 |
| CS-07 | §7 |
| CS-08 | §7 |
| CS-09 | §3.4 y §6.4 |
| CS-10 | Pendiente del productor |
| CS-11 | §3.1 (503) y §5.3; falta fijar los objetivos de servicio |
| CS-12 | §9 |

## 12. Estado

Tras OMNICHANNEL-ALIGNMENT-01:

```text
CIA_V1_CONTRACT=PROPOSED              (no aprobado; owner productor por designar)
CIA_CORE_CHANNEL_AGNOSTIC  CIA_CORE_ACCOUNT_PROVIDER_AGNOSTIC
D1_ARCHITECTURE_SELECTED_CONDITIONALLY  D2_PENDING_CP_ACCEPTANCE
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_HARNESS_UNCHANGED  R2_PORT_UNCHANGED
```

Estado original, como histórico:

```text
CIA_V1_CONTRACT=PROPOSED              (no aprobado; sin productor ni owner)
D1_DECISION_READY  D2_CONTRACT_PROPOSED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_HARNESS_UNCHANGED  R2_PORT_UNCHANGED
```
