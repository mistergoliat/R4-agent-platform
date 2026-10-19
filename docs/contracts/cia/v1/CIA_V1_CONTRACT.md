# Customer Identity Authority — Contrato v1 (candidato CIA-S0)

| Campo | Valor |
|---|---|
| Revisión | `v1-s0-candidate` (2026-10-19), endurecida por HARDENING-01: idempotencia (§4.1) e invariantes temporales del grant (§6.3) |
| Mandatos | R4-J4-CIA-S0-CONTRACT-FOUNDATION-01; R4-J4-CIA-S0-CONTRACT-HARDENING-01 |
| Estado | **CANDIDATO. No aprobado.** Requiere la aprobación del owner productor de la CIA (por designar, D1) y, para §6–§8, del owner de Customer Profile (D2) |
| Dirección de diseño | Omnicanal, seleccionada (OMNICHANNEL-ALIGNMENT-01). Arquitectura B: CIA independiente |
| Base | [Revisión omnicanal](../../../architecture/R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md) (prevalece), [propuesta de contrato](../../../architecture/R4_J4_R3_CIA_CONTRACT_PROPOSAL.md), [informe de descubrimiento](../../../architecture/R4_J4_R3_CIA_DISCOVERY_REPORT.md). Esos tres documentos quedan como **históricos**: este documento es la **única especificación normativa** de la API de consumidores v1 |
| Artefactos | [`schemas/`](schemas/) (JSON Schema 2020-12), [`fixtures/`](fixtures/) (sintéticos), [`MANIFEST.json`](MANIFEST.json) (procedencia y hashes) |
| Pruebas | [`tests/contract/cia-s0-contract.test.ts`](../../../../tests/contract/cia-s0-contract.test.ts) · generador [`tests/support/generate-cia-s0-fixtures.mjs`](../../../../tests/support/generate-cia-s0-fixtures.mjs) |
| Fuera de alcance | Servicio CIA, OTP real, grants reales, despliegue, cambios en Customer Profile, en `packages/live-ops` o en el harness de R4, datos reales |

Palabras normativas: **DEBE**, **NO DEBE**, **PUEDE**.

---

## 1. Alcance

**Incluye:** verificación del control de un email por código de un solo uso (OTP); vínculo de un sujeto de canal con **una** cuenta comercial existente; resolución por sujeto y propósitos; emisión de grants individuales; revocación a pedido del cliente.

**Excluye:** creación o modificación de cuentas (Checkout, R4-L/J5.5); `master_customer` y fusiones; hechos comerciales (Customer Profile); pagos; búsquedas o listados; API de operadores y `/.well-known/jwks.json` (§6.5, fuera del contrato de consumidores).

## 2. Núcleo agnóstico

El núcleo **NO DEBE** contener nombres de canales, proveedores de canal, proveedores de cuentas ni consumidores en sus tipos. Son **valores registrados en configuración**:

| Registro | Contenido | Ejemplo del despliegue v1 (adaptadores) |
|---|---|---|
| Canales | `channel` → formato de `subjectRef`, `subjectAssurance` mínimo | `whatsapp` → `wa_id` normalizado (dígitos), `provider_signed` |
| Proveedores de cuentas | namespace → patrón del id, adaptador `AccountProvider` | `prestashop_customer` → `^[1-9][0-9]{0,9}$` |
| Consumidores | principal → scopes, `channel`/`channelAccountRef` permitidos, propósitos de datos permitidos, ámbito del proveedor (tiendas, OD-CIA-2) | `r4-sales` (agent), `r4-sales-channel` (channel-integration) |
| Propósitos de datos | identificadores | `sales_context`, `purchase_history` |
| Emisor | `iss`, `kid`, audiencias | `aud = customer-profile` |

Los schemas solo fijan la forma léxica de esos valores. La prueba de contrato verifica que ningún schema nombra canales, proveedores ni consumidores.

## 3. Separación de identidades y propósitos

| Concepto | Dónde viaja | Lo aporta | Clase |
|---|---|---|---|
| **Consumidor autenticado** | `Authorization: Bearer` (nunca en el cuerpo) | Credencial por principal, rotable | Autenticado por la CIA |
| **Sujeto del canal** | `context.channel`, `context.channelAccountRef`, `context.subjectRef`, `context.subjectAssurance` | Channel Integration del consumidor, desde un evento firmado por el proveedor del canal | Afirmación confiable del adaptador; allowlist por consumidor |
| **Sesión** | `context.sessionRef` | Consumidor (R4: `bindingId`) | Afirmación confiable; DEBE coincidir entre inicio y confirmación |
| **Propósito de verificación** | `verificationPurpose` (solo en el inicio) | Constante del handler | Afirmación del consumidor, nunca del modelo |
| **Propósitos de acceso a datos** | `purposes` (inicio y `resolve`); `grant.purposes`; claim `purposes` | Constante del handler | Allowlist por consumidor; solo los grants los conceden |
| Email | `email` | El usuario (puede pasar por un modelo) | Dato declarado, **no confiable** |
| Código | `code` | El usuario, vía la Channel Integration | Dato declarado, **no confiable**; solo por la ruta protegida |
| `verificationId` | Respuesta del inicio; cuerpo de la confirmación | La CIA | Lo guarda la Channel Integration; **nunca** llega al modelo |

Regla: un modelo **NO DEBE** poder construir el `context`. Las capacidades del consumidor no aceptan argumentos de contexto.

## 4. Convenciones

- Solo `POST` con cuerpo `application/json`. Ningún identificador en path ni query.
- `Authorization: Bearer <credencial del principal>`.
- `x-correlation-id`: `^[A-Za-z0-9._:-]{1,128}$`.
- `idempotency-key`: `^[A-Za-z0-9._:-]{16,128}$`, **obligatorio** en las operaciones con efecto (§5.1, §5.2, §5.4). Semántica completa en §4.1.
- `schemaVersion: 1` obligatorio en peticiones y respuestas 2xx.
- Peticiones **cerradas**: una propiedad desconocida es 400 `invalid_request`.
- Respuestas: los schemas describen v1 exactamente. Un consumidor DEBE ignorar campos que no conoce (cambios aditivos solo con una revisión nueva del contrato).
- `Cache-Control: no-store` en todas las respuestas.
- Errores: [`error.v1.schema.json`](schemas/error.v1.schema.json), `{ "error": { "code", "retryable" } }`, sin texto libre:

| HTTP | `code` | `retryable` | Cuándo |
|---|---|---|---|
| 400 | `invalid_request` | false | Cuerpo inválido (incluye email con `\|`, `%`, `[`, `]` o espacios) |
| 401 | `unauthenticated` | false | Credencial ausente o inválida |
| 403 | `consumer_not_allowed` | false | Scope ausente; `channel`, `channelAccountRef` o propósito fuera de la allowlist; `subjectAssurance` insuficiente. Error de configuración, **nunca** un estado del cliente |
| 409 | `idempotency_conflict` | false | Clave reutilizada con otro cuerpo (§4.1) |
| 409 | `operation_in_progress` | true | Misma clave y mismo cuerpo mientras la primera petición sigue ejecutándose; header `Retry-After` ≤ lease restante (§4.1) |
| 429 | `rate_limited` | true | Cualquier límite, sin indicar cuál; idéntico para todos |
| 503 | `dependency_unavailable` | true | Proveedor de cuentas no disponible. **Nunca** se responde un estado falso |
| 503 | `delivery_unavailable` | true | Proveedor de correo no disponible |

Objeto `context` ([`cia-common.v1.schema.json`](schemas/cia-common.v1.schema.json)), obligatorio en las cuatro operaciones:

```json
"context": {
  "channel": "whatsapp",
  "channelAccountRef": "100000000000001",
  "subjectRef": "15555550101",
  "sessionRef": "bnd_synthetic_0001",
  "subjectAssurance": "provider_signed"
}
```

### 4.1 Idempotencia

Aplica a `verifications`, `verifications/confirm` y `links/revoke`. `resolve` es de lectura y no lleva clave.

**Identidad de la operación:** `(principal autenticado, método y ruta, idempotency-key)`. La misma clave en otra ruta o de otro principal es otra operación (I09).

**Fingerprint:** `HMAC-SHA256(clave de fingerprint, JCS(cuerpo))`, con JCS = RFC 8785 (JSON canónico). Una clave con otro fingerprint es 409 `idempotency_conflict` sin efecto (I02).

**Antes de reservar:** autenticación, autorización, validación del cuerpo y límites de tasa se evalúan **antes** de tocar el registro. Sus errores (400, 401, 403, 429) no crean registro.

**Registro** (uno por identidad):

| Estado | Significado | Otra petición con la misma identidad y el mismo fingerprint |
|---|---|---|
| — (ausente) | Nunca vista, liberada o retención vencida | Reserva **atómica** (insert-if-absent): una sola gana y ejecuta |
| `in_progress` | Reservada; lease de 30 s | 409 `operation_in_progress` (`retryable: true`, `Retry-After` ≤ lease restante). **No** ejecuta (I01) |
| `in_progress`, lease vencido | El ejecutor murió sin confirmar | Toma el control y ejecuta. Es seguro: ningún efecto se confirma sin completar el registro en la misma transacción (I05) |
| `completed` | Resultado terminal guardado | Misma respuesta (estado HTTP y cuerpo), **sin** efecto, hasta 24 h después de completarse (I01, I04, I06, I07) |

**Regla de confirmación:** el efecto interno de la operación (contador de intentos, consumo del desafío, vínculo, revocación, creación del desafío y su entrada en la cola de envío) y el paso a `completed` se confirman en **una sola transacción**. Por eso un reintento nunca repite el efecto y un intento de OTP nunca se cuenta dos veces (I04).

**Resultado por operación:**

| Operación | Terminal (`completed`) | Fallo transitorio sin efecto (registro **liberado**: el siguiente reintento ejecuta) |
|---|---|---|
| `verifications` | 202 (desafío y envío encolado confirmados) | 503 `delivery_unavailable`: la entrega se sabe no disponible **antes** de crear el desafío; uniforme para cualquier email (I08) |
| `verifications/confirm` | 200 con cualquier `outcome`, incluidos `invalid_code`, `expired` y `locked` | 503 `dependency_unavailable`: código correcto con el proveedor de cuentas caído; nada se consume (I03) |
| `links/revoke` | 200 | 503 `dependency_unavailable` (almacenamiento) |

**Efecto externo: envío del correo del desafío.** Lo hace la entrega de la CIA fuera de la petición; el 202 no depende de él (respuesta uniforme). La clave de deduplicación ante el proveedor es el `verificationId`.

| Estado del envío | Transición |
|---|---|
| `pending` | Se llama al proveedor |
| `sent` | **Efecto externo confirmado** (aceptación del proveedor). Terminal |
| `pending` (reintento) | Rechazo transitorio definitivo: no se envió nada (D04) |
| `pending` (reintento) | Resultado **desconocido** (timeout) **y** el proveedor deduplica de forma fiable por la clave durante todo el TTL del desafío: se reintenta con la **misma** clave (D01) |
| `reconciliation_required` | Resultado desconocido **sin** deduplicación fiable: **no** se reenvía. Se reconcilia consultando al proveedor: `sent` (D02), `not_sent` → `pending` (D03), desconocido hasta la expiración del desafío → `abandoned` (D05) |

Un envío tardío o duplicado de un código viejo es inocuo: un desafío nuevo invalida el anterior. El cliente puede pedir un desafío nuevo (otra clave), sujeto a reenvío ≥ 60 s y a los límites.

**Contenido del registro (regla 7):** identidad, fingerprint, estado, lease, retención y la respuesta terminal. **Nunca** el OTP, el email, el `context` ni el cuerpo de la petición. Las respuestas guardadas no contienen secretos: `outcome`, o el 202 con `verificationId`, que sin el código no sirve.

**Plazos:**

| Plazo | Valor | Relación |
|---|---|---|
| Lease de `in_progress` | 30 s | ≪ TTL del desafío (600 s). Acota la espera de `operation_in_progress` |
| TTL del desafío | 600 s | Los reintentos tras un 503 solo tienen sentido dentro de él; después, `confirm` responde `expired` (I07) |
| Retención de `completed` | 24 h desde la terminación | Una repetición dentro de 24 h devuelve la respuesta guardada **aunque el desafío ya haya expirado o se haya consumido**. No crea un desafío ni envía un correo (I06, I07) |
| Tras 24 h | — | La clave se olvida: reutilizarla es una operación nueva. `verifications` crearía otro desafío (con límites, e invalidando el anterior); `confirm` vería el desafío consumido o expirado, sin efecto. Un consumidor **NO DEBE** reutilizar claves después de 24 h |

Conformidad: escenarios I01–I09 y D01–D05 ([`fixtures/idempotency/`](fixtures/idempotency/)), ejecutados contra un modelo de referencia en la prueba de contrato. **No** es almacenamiento de producción (CIA-S1).

## 5. Operaciones

| Operación | Scope (credencial) | Efecto | Schema |
|---|---|---|---|
| `POST /v1/identity/verifications` | `identity.verification.start` (agent) | Envía un correo | [`verification-start.v1`](schemas/verification-start.v1.schema.json) |
| `POST /v1/identity/verifications/confirm` | `identity.verification.confirm` (**solo** channel-integration) | Consume el desafío; crea o renueva el vínculo | [`verification-confirm.v1`](schemas/verification-confirm.v1.schema.json) |
| `POST /v1/identity/resolve` | `identity.resolve` (agent) | Ninguno (lectura; emite grant) | [`resolve.v1`](schemas/resolve.v1.schema.json) |
| `POST /v1/identity/links/revoke` | `identity.link.revoke` (agent) | Revoca el vínculo | [`link-revoke.v1`](schemas/link-revoke.v1.schema.json) |

Ninguna credencial tiene a la vez `identity.verification.confirm` y otro scope.

### 5.1 Iniciar verificación

Petición ([fixture](fixtures/verification-start/request.valid.json)):

```json
{ "schemaVersion": 1, "context": { … }, "verificationPurpose": "link_commercial_account",
  "email": "valid@synthetic.test", "purposes": ["sales_context", "purchase_history"] }
```

Respuesta **202** ([fixture](fixtures/verification-start/response.challenge-issued.json)), **idéntica en forma y tiempo para cualquier email bien formado**:

```json
{ "schemaVersion": 1, "verificationId": "Vf0SyntheticChallenge1", "status": "challenge_issued",
  "expiresAt": "2026-10-19T17:50:00Z", "resendAvailableAt": "2026-10-19T17:41:00Z" }
```

- La CIA **NO DEBE** consultar al proveedor de cuentas en este paso. El OTP se envía siempre al email declarado.
- Un desafío nuevo invalida el anterior del mismo sujeto.
- El email se guarda cifrado solo hasta consumir o expirar el desafío; después, solo su HMAC.
- Errores: 400, 401, 403, 409 (`idempotency_conflict`, `operation_in_progress`), 429, 503 `delivery_unavailable` (sin desafío creado; §4.1).

### 5.2 Confirmar verificación

Petición ([fixture](fixtures/verification-confirm/request.valid.json)): `{ schemaVersion, context, verificationId, code }`, con `code` = `^[0-9]{6}$` ya normalizado por la Channel Integration.

Respuesta **200**: `{ "schemaVersion": 1, "outcome": … }` (+ `attemptsRemaining` 0–4 **solo** con `invalid_code`).

| `outcome` | Significado | Fixture |
|---|---|---|
| `linked` | Código correcto y exactamente una cuenta elegible. Vínculo `verified` creado, o `last_verified_at` renovado si ya existía con la misma cuenta | VC10 |
| `no_eligible_account` | Código correcto; ninguna cuenta (o solo borradas). **Cuenta inexistente** | VC11 |
| `ineligible_account` | Código correcto; solo cuentas no elegibles según el adaptador (p. ej. invitada, inactiva) | VC12 |
| `ambiguous` | Código correcto; más de una cuenta elegible. **Nunca** se elige una | VC13 |
| `conflicted` | El sujeto ya tiene un vínculo `verified` con otra cuenta | VC14 |
| `invalid_code` | Código incorrecto **o** `context`, `sessionRef` o consumidor distintos de los del desafío, sin revelar cuál | VC15 |
| `expired` | Desafío vencido | VC16 |
| `locked` | Intentos agotados | VC17 |

- **NUNCA** devuelve una referencia de cuenta ni un grant (VC92 es inválido).
- Con cualquier principal sin el scope de confirmación: 403 `consumer_not_allowed`, sin tocar el desafío.
- 503 `dependency_unavailable`: el desafío **no** se consume, el intento **no** cuenta y la clave se libera; el reintento con la misma `idempotency-key` ejecuta de nuevo dentro del TTL del desafío (§4.1, I03). Un código incorrecto nunca da 503: no necesita al proveedor.
- La Channel Integration **NO DEBE** mostrar al usuario un 503 de forma distinta a "procesando": un 503 tras un código implica que el código era correcto.
- Revelar el resultado a quien probó controlar el buzón no es enumeración.

### 5.3 Resolver

Petición ([fixture](fixtures/resolve/request.valid.json)): `{ schemaVersion, context, purposes }`.

Respuesta **200**: el tipo `IdentityResolution` de R4-J4-R2 más `schemaVersion` (§7).

| `status` | Cuándo | Fixture |
|---|---|---|
| `verified` | Vínculo vigente (plano B) **y** revalidado contra el proveedor **y** verificación reciente vigente para **cada** propósito pedido (plano C) **y** todos los propósitos permitidos. Lleva `customerRef` y un grant nuevo | RS10 |
| `not_linked` | Sin vínculo; vínculo revocado; email verificado sin cuenta; cuenta desaparecida | RS11 |
| `not_verified` | Verificación iniciada sin confirmar; vínculo `stale` o `expired` (B); verificación reciente vencida (C) | RS12 |
| `ambiguous` | Evidencia de email con más de una cuenta elegible | RS13 |
| `conflicted` | Intento de segundo vínculo | RS14 |
| `not_authorized` | Solo cuentas no elegibles, o propósito denegado por la política del cliente | RS15 |

- `customerRef` y `grant` **solo** con `verified` (RS92, RS93 inválidos). Sin PII y sin `masterCustomerId` (RS94 inválido).
- `grant.expiresAt` = `exp`; `grant.purposes` = propósitos pedidos (si no se conceden todos: `not_authorized`); `customerRef` = `sub`.
- Errores: 400, 401, 403, 429, 503 `dependency_unavailable` (revalidación imposible y caché vencida).

Vigencias (revisión §6): A evidencia de email (histórica); B vínculo, `revalidate_after` candidato 90 días; C verificación reciente, candidata 24 h para datos privados; D grant ≤ 300 s. B y C son **candidatas** (OD-CIA-3).

### 5.4 Revocar

Petición ([fixture](fixtures/link-revoke/request.valid.json)): `{ schemaVersion, context, reason: "customer_request" }`. Respuesta **200**: `outcome` ∈ `revoked`, `no_active_link`. Efecto en la siguiente `resolve`; los grants ya emitidos caducan por TTL. `revoked` es terminal.

## 6. Grant (D2 — propuesta formal, pendiente de CP)

### 6.1 Formato

JWS compacto, **ES256** (P-256), **TTL máximo 300 s**. Schema: [`grant.v1.schema.json`](schemas/grant.v1.schema.json).

```json
{ "alg": "ES256", "kid": "<kid fijado>", "typ": "cia-grant+jwt" }
```

| Claim | Contenido | Obligatorio |
|---|---|---|
| `cv` | Versión de claims (`1`) | Sí |
| `iss` | URI del emisor, fijada en el verificador | Sí |
| `aud` | Servicio destinatario (`customer-profile` en v1) | Sí |
| `azp` | Principal consumidor; DEBE ser igual al principal autenticado ante el verificador | Sí |
| `sub` | Referencia de cuenta con namespace (`prestashop_customer:<id>` en v1) | Sí |
| `purposes` | Propósitos de datos concedidos (1–8, únicos) | Sí |
| `iat`, `nbf`, `exp` | Segundos Unix enteros. El emisor fija `iat = nbf` = instante de emisión y `exp ≤ iat + 300`, sin superar la ventana de verificación reciente (plano C) ni `revalidate_after` del vínculo (plano B). Invariantes en §6.3 | Sí |
| `jti` | ULID | Sí |
| `lnk`, `lver` | Vínculo y su versión (revocación v1.1) | Sí |
| `amr` | `["email_otp"]` | Sí |
| `vat` | Instante de la última prueba de control (plano C) | Sí |
| `sbh` | HMAC del sujeto, base64url; **solo auditoría**, el verificador no puede comprobarlo | Sí |

No contiene email, código, `verificationId`, `subjectRef` ni `sessionRef` en claro.

### 6.2 Transporte

Header `x-customer-access-grant: <JWS>` junto al `Authorization: Bearer` del consumidor; el token de servicio **no** sustituye al grant. El consumidor trata el JWS como **opaco**: no lo decodifica, no lo registra, no lo persiste y no lo muestra al modelo. Tamaño máximo 2048 bytes. Multiuso dentro de su TTL solo para la misma tupla (`azp`, `aud`, `sub`, propósito ∈ `purposes`).

### 6.3 Verificación (orden normativo, propuesto a CP)

| # | Comprobación | Fallo (`reason`) | Fixture |
|---|---|---|---|
| 1 | Header presente | `missing` | G16 |
| 2 | ≤ 2048 bytes, tres segmentos, base64url y JSON válidos | `malformed` | G15 |
| 3 | `alg` en la allowlist (`ES256`); `none` y `HS*` rechazados | `unsupported_alg` | G11, G12 |
| 4 | Header conforme al schema y `typ = cia-grant+jwt` | `malformed` | G17 |
| 5 | `kid` en el JWKS fijado | `unknown_key` | G13 |
| 6 | Firma ES256 | `bad_signature` | G10, G14 |
| 7 | Claims conformes al schema | `malformed` | G18 |
| 8 | `cv` soportado | `unsupported_version` | G28 |
| 9 | `iss` fijado | `wrong_issuer` | G27 |
| 10 | `aud` = el verificador | `wrong_audience` | G23 |
| 11 | `azp` = principal autenticado | `consumer_mismatch` | G24 |
| 12 | Coherencia interna: `vat ≤ iat ≤ nbf < exp` **y** `iat − vat ≤ 90 días` | `invalid_time_claims` | G31–G35 |
| 13 | `exp − iat ≤ 300` | `ttl_too_long` | G22 |
| 14 | `iat ≤ ahora + 60 s` | `issued_in_future` | G30 |
| 15 | `nbf ≤ ahora + 60 s` | `not_yet_valid` | G21 |
| 16 | `exp > ahora` (sin tolerancia) | `expired` | G20 |
| 17 | `sub` = `customerRef` del cuerpo | `customer_mismatch` | G25 |
| 18 | `purpose` del cuerpo ∈ `purposes` | `purpose_not_granted` | G26 |
| 19 | (v1.1, OD-CIA-4) `lnk`/`lver` no revocados | `revoked` | — |

Un claim temporal que no es un entero ≥ 0 (cadena, fracción, negativo) falla en el paso 7 como `malformed` (G36, G37).

**Invariantes temporales:**

| # | Invariante | Motivo |
|---|---|---|
| T1 | Todos los instantes son segundos Unix enteros | Sin ambigüedad de unidad ni de redondeo |
| T2 | `vat ≤ iat` | La prueba de control no puede ser posterior a la emisión |
| T3 | `iat ≤ nbf < exp` | Sin `nbf` retroactivo ni ventana vacía o invertida |
| T4 | `exp − iat ≤ 300` | TTL máximo del grant (plano D) |
| T5 | `iat − vat ≤ 90 días` (`maxProofAgeSeconds`, fijado en el verificador) | Defensa en profundidad: ningún grant puede apoyarse en una prueba más vieja que el vínculo más largo (plano B). La ventana por propósito (plano C, 24 h candidata) la aplica el **emisor** |
| T6 | `iat ≤ ahora + 60 s` y `nbf ≤ ahora + 60 s` | Tolerancia de desfase **acotada a 60 s** y solo hacia el futuro: absorbe un reloj del emisor adelantado. Impide emisiones arbitrariamente futuras |
| T7 | `exp > ahora`, **sin** tolerancia | Un verificador adelantado invalida el grant hasta 60 s antes (fallo cerrado); nunca lo prolonga más allá de 300 s |

Consecuencia: la vida efectiva máxima de un grant en cualquier verificador es `exp − (iat − 60) ≤ 360 s` de reloj del verificador, y nunca más de 300 s de reloj del emisor. Bordes aceptados: G03 (un segundo antes de `exp`) y G04 (emisor 60 s adelantado). Los pasos 12–13 no dependen del reloj del verificador.

Aceptación: G01–G04. Fallo: **403** `{ "error": "grant_rejected", "reason": <motivo> }` (`grant.v1.schema.json#/$defs/rejection`), **propuesto**: el formato de error de CP no cambia hasta que su owner lo acepte. Para R4 no cambia nada: cualquier 403 es `unauthorized` sin reintento.

### 6.4 Revocación

v1: la CIA deja de emitir en la siguiente `resolve` y los grants emitidos caducan en ≤ 300 s. v1.1 (opcional, OD-CIA-4): lista de vínculos revocados consultada por el verificador cada ≤ 60 s. Sin introspección por petición.

### 6.5 Claves

JWKS publicado en `GET /.well-known/jwks.json` (fuera de este contrato) y **fijado en la configuración** del verificador. Clave de firma no exportable (KMS), `kid` por clave, rotación con solapamiento ≥ TTL + 24 h (DEP-6). Los fixtures usan claves P-256 **efímeras y sintéticas**; las privadas se descartaron.

## 7. Compatibilidad con R4-J4-R2

El puerto `IdentityResolution` / `CustomerAccessGrant` (`adapters/domains/src/customer/profile-port.ts`) **no cambia**:

| Wire CIA v1 | Puerto R2 | Regla |
|---|---|---|
| `schemaVersion` | — | El adaptador lo comprueba y lo descarta |
| `status` (6 valores) | `IdentityResolution.status` (mismos 6) | Idéntico |
| `customerRef` (namespace genérico) | `customerRef` con `CUSTOMER_REF_PATTERN` | El adaptador R4 exige además el namespace `prestashop_customer`; otro namespace es `contract_violation` |
| `grant.token`, `grant.expiresAt`, `grant.purposes` | `CustomerAccessGrant` | Idéntico; `purposes` ⊆ `CUSTOMER_PURPOSES` |
| `resolvedAt` | `resolvedAt` | Idéntico |

La prueba de contrato comprueba los seis estados, los campos exactos por estado y que el ejemplo `verified` concuerda con el grant G01 que lleva (`sub`, `exp`, `iat`, `purposes`).

## 8. Matriz de compatibilidad con CAG (Customer Profile)

Fuente CAG: `MS-pesaschile-customer-profile@de6c04a`, `docs/audits/CP_V2_ARCHITECTURE_AUDIT.md` §11 (PROPOSED), y `docs/reviews/CP_J4_R4_CONTRACT_ALIGNMENT.md`. **No se modificó el contrato de CP. D2 no está aceptada.**

| Tema | CIA v1 (este contrato) | CAG de CP | Estado |
|---|---|---|---|
| Formato y algoritmo | JWS compacto ES256 | JWS compacto, EdDSA o ES256 | Compatible (subconjunto) |
| `typ` | `cia-grant+jwt` | No definido | **Pendiente CP** (aditivo) |
| `iss`, JWKS fijado, `kid` | Sí | Sí | Compatible |
| `aud` | `customer-profile` | `customer-profile` | Compatible |
| `azp` = principal | Sí | Sí | Compatible |
| `sub` | `prestashop_customer:<id>` | `prestashop_customer:<id>` | Compatible |
| Propósito | `purposes[]`; CP comprueba `purpose ∈ purposes` | `purpose` + `scope[]` | **Pendiente CP** (decisión: el scope pertenece al bearer) |
| Nivel de prueba | `amr: ["email_otp"]` + `vat` | `assurance` (CP lo divulga) | **Pendiente CP** (alternativa: un `assurance` enumerado en lugar de `amr`) |
| Vínculo con el sujeto | `sbh` (solo auditoría) | `cnf` = hash de `conversationRef` | **Pendiente CP** (`cnf` es prueba de posesión en RFC 7800) |
| TTL | `exp − iat ≤ 300 s` | `exp ≤ 15 min` | **Pendiente CP** (más estricto; compatible si CP acepta ≤ 300) |
| `nbf` | Obligatorio, tolerancia 60 s | No definido | **Pendiente CP** (aditivo) |
| `jti` | ULID; CP lo audita | `jti`; CP lo audita | Compatible |
| Versión de claims `cv` | Obligatoria | No definida | **Pendiente CP** (aditivo) |
| Revocación | TTL (v1); `lnk`/`lver` para v1.1 | No definida; descarta la introspección por petición | **Pendiente CP + OD-CIA-4** |
| Orden de verificación | §6.3 (17 pasos) | 5 pasos | **Pendiente CP** (superconjunto) |
| Error | 403 `grant_rejected` + `reason` enumerado | 403 `customer_access_grant_required` o `grant_mismatch` | **Pendiente CP** (cambia su error plano, AP-06) |
| Header | `x-customer-access-grant` | `x-customer-access-grant` (reservado) | Compatible |
| Portador | `resolve` perezosa por invocación (ADR-039 §3) | "lo recibe en `afterOpen`" | **Diferencia documental en CP** |
| Efecto en la respuesta de CP | `authorizationBasis: customer_grant_verified`; `validUntil = min(asOf + 15 min, exp)` | `service_scope_only` hoy | **Pendiente CP** (DEP-4) |

Decisiones pendientes para aceptar D2 (DEP-12): las nueve filas **Pendiente CP**, más la implementación en CP (DEP-4) y V-13 a V-18 y V-26 en verde con datos sintéticos.

## 9. Requisitos de seguridad

| ID | Requisito | Dónde se materializa |
|---|---|---|
| SR-01 | El OTP **NO DEBE** entrar al contexto del modelo ni a la memoria conversacional permanente del consumidor | Credencial exclusiva de confirmación (§5); SEC-OTP-01/02 (§10) |
| SR-02 | Mismo sujeto (`channel`, `channelAccountRef`, `subjectRef`) **y** misma `sessionRef` para iniciar y confirmar; si no, `invalid_code` | §5.2; VC15 |
| SR-03 | Confirmación solo con la credencial de Channel Integration (`identity.verification.confirm`, exclusivo) | §5; ER03 |
| SR-04 | Prevención de enumeración: inicio uniforme en forma y tiempo; búsqueda de cuentas **después** del código; 429 idéntico; correo sin datos de cuenta | §5.1; ER05 |
| SR-05 | Límites: código de 6 dígitos (CSPRNG), guardado como `HMAC(clave, verificationId‖código)`, TTL 10 min, 5 intentos y `locked`, reenvío ≥ 60 s; por sujeto 3/h y 6/día; por `email_hash` 5/día entre sujetos; por consumidor con alerta; `resolve` por consumidor y por sujeto | Implementación CIA-S1 |
| SR-06 | Identidad comercial **única y elegible**: exactamente una cuenta elegible; nunca "la primera"; revalidación en cada `resolve` | §5.2, §5.3 |
| SR-07 | Grants limitados por sujeto (`sub`), audiencia (`aud`), consumidor (`azp`), propósito (`purposes`) y TTL ≤ 300 s | §6 |
| SR-08 | Sin acceso a datos reales mientras D1 y D2 estén pendientes | §11 |
| SR-09 | Minimización: sin email, `subjectRef`, código ni token en claro en respuestas, logs o auditoría; claves separadas (HMAC, cifrado de email, firma, proveedor) | §5, §6.1 |
| SR-10 | Email validado antes de cualquier filtro del proveedor (`\|`, `%`, `[`, `]`, espacios) | VS90 |
| SR-11 | Idempotencia sin doble efecto: reserva atómica, efecto y terminación en una transacción, ningún secreto en el registro, ningún reenvío ciego de correo | §4.1; I01–I09, D01–D05 |
| SR-12 | Grants temporalmente coherentes, con desfase acotado a 60 s y sin emisión futura | §6.3 T1–T7; G03, G04, G20–G22, G30–G37 |

## 10. Bloqueos de integración

### SEC-OTP-01 — Entrega del código desde la ingesta de R4 (bloquea O1)

**Hecho.** La opción O1 de la revisión (§4.3–§4.5) llama a `confirm` de forma **síncrona dentro del webhook**. El invariante de R4-I lo prohíbe: *"No model, domain owner or delivery is called inside the request; workers execute asynchronously"* (`packages/live-ops/src/ingress.ts:56-61`).

**Consecuencia.** O1 **no puede implementarse tal como está diseñada**. R4-S6 queda bloqueado hasta que exista un diseño de entrega diferida y fiable aprobado. Este slice **no modifica `packages/live-ops`**.

**Requisitos para el diseño futuro** (investigación pendiente, sin solución elegida):

| Tema | Requisito |
|---|---|
| Diferido | El webhook solo persiste y responde; un worker entrega a la CIA fuera de la petición |
| Secreto en reposo | El código **NO DEBE** quedar en `inbound_events.content`, `memory_entries`, `task_inputs`, telemetría ni ningún almacenamiento conversacional. Si debe esperar a un worker, solo en un almacén dedicado, cifrado, con TTL ≤ TTL del desafío y borrado al entregar |
| Idempotencia | `idempotency-key` derivada de `(channel, providerEventId)`: un reenvío del proveedor o un reintento del worker no consume un segundo intento. 409 `operation_in_progress` y 503 se reintentan con la **misma** clave; 409 `idempotency_conflict` es un error de programación, terminal (§4.1) |
| Fallos de la CIA | 503/timeout: reintento con backoff dentro del TTL del desafío. 4xx: terminal. Al agotar el TTL, la tarea se reanuda con un marcador sin código (`outcome` no disponible) |
| Orden | Respetar el orden de llegada por conversación: un código no puede adelantar a un desafío nuevo que lo invalidó |
| Reanudación | Entrada de plataforma sin código (patrón `unsupportedContentMarker`) |

Alternativas a evaluar: O1 diferido (puerto de desvío + almacén cifrado efímero + worker), O2 (relay externo, sin cambios en R4) y O3 (formulario nativo del canal). La enmienda del invariante R4-I y DEP-11 siguen siendo prerrequisitos de cualquier cambio en `live-ops`.

### SEC-OTP-02 — Respuestas OTP reconocibles con formato incorrecto

**Hecho.** La revisión §4.4 desvía solo `^[0-9]{3}[ -]?[0-9]{3}$` y acepta como residuo que "mi código es 123456" siga la ingesta ordinaria (N-09).

**Decisión de este mandato.** Ese residuo **ya no se acepta**. Durante un desafío activo para la conversación, una respuesta OTP **reconocible**, aunque tenga formato incorrecto (frase con el código, dígitos separados de otra forma, 5 o 7 dígitos, dígitos de ancho completo), **NO DEBE** llegar sin tratamiento a la memoria ni al modelo.

**Requisitos para el diseño futuro:**
- Clasificación antes de cualquier persistencia, solo con expectativa activa, mismo sujeto y misma sesión.
- Tratamiento mínimo: redactar la secuencia candidata antes de persistir (marcador de plataforma), y entregar a la CIA solo un código normalizado de 6 dígitos (§5.2) por la ruta de SEC-OTP-01.
- Los falsos positivos (un número de pedido escrito durante el desafío) se redactan igualmente; la conversación pide reescribirlo.
- N-09 cambia su resultado esperado: el texto llega redactado y el código no aparece en `memory_entries` ni en el contexto del modelo.

**Estado:** bloqueante para R4-S6 y para cualquier OTP con clientes, sintético o real, a través de R4.

## 11. Decisiones y dependencias pendientes

| ID | Decisión | Estado |
|---|---|---|
| D1 | Owner productor de la CIA | **Pendiente** (DEP-1). B seleccionada por el owner de R4 |
| D2 | Grant individual (§6, §8) | **Pendiente de aprobación por CP** (DEP-12) |
| OD-CIA-1 | `email_otp` en lugar de `account_login` | Flujo aprobado por el owner de R4; enmienda formal pendiente |
| OD-CIA-2 | Tiendas por consumidor | Pendiente |
| OD-CIA-3 | Vigencias B (90 días) y C (24 h) | Candidatas |
| OD-CIA-4 | Revocación de grants | Pendiente (v1: solo TTL) |
| OD-CIA-5 | Captura del OTP | O0 descartada; O1 **bloqueada** por SEC-OTP-01; SEC-OTP-02 abierto |
| DEP-11 | `live-ops` fuera del harness + enmienda de R4-I | Pendiente |
| DEP-2/3/5/6/10 | Credencial del proveedor, endpoint mínimo, correo, custodia de claves, legal | Pendientes; bloquean datos reales |

## 12. Artefactos y verificación

| Artefacto | Contenido |
|---|---|
| `schemas/` | 7 schemas: común, 4 operaciones (`$defs/request`, `$defs/response`), error, grant (`header`, `claims`, `rejectionReason`, `rejection`) |
| `fixtures/` | 45 cuerpos (29 válidos, 16 inválidos), 30 casos de grant (4 aceptados, 26 rechazados), `grants/verifier-config.json` (JWKS público sintético y límites temporales), 9 escenarios de idempotencia (I01–I09) y 5 de envío de correo (D01–D05) |
| `MANIFEST.json` | Procedencia, escenarios exigidos → fixtures, y `sha256(JSON.stringify(JSON.parse(file)))` de cada schema y fixture |

Verificar:

```bash
npx vitest run --project contract tests/contract/cia-s0-contract.test.ts
node tests/support/generate-cia-s0-fixtures.mjs   # recalcula hashes; sin cambios en git = reproducible
```

`--grants` regenera claves y grants: las firmas ECDSA cambian, así que solo se usa al cambiar el contrato del grant.

## 13. Estado

```text
CIA_S0_CONTRACT_HARDENED
CIA_S0_READY_FOR_OWNER_REVIEW
CIA_S1_SYNTHETIC_IMPLEMENTATION_READY
D1_OWNER_PENDING
D2_CP_APPROVAL_PENDING
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

Histórico (FOUNDATION-01): `CIA_S0_CONTRACT_CANDIDATE_READY`, `CIA_CORE_CHANNEL_AGNOSTIC`, `CIA_CORE_ACCOUNT_PROVIDER_AGNOSTIC`. Siguen vigentes.

## 14. Preparación de CIA-S1

CIA-S1 (núcleo con buzón falso y proveedor de cuentas falso, revisión §12) puede empezar como **implementación sintética aislada**, en un repositorio o paquete propio de la CIA, sin tocar R4.

| Entrada para S1 | Artefacto |
|---|---|
| Contrato de la API | §4–§5 y los schemas |
| Vectores de conformidad de cuerpos | Fixtures VS/VC/RS/LR/ER |
| Vectores de idempotencia y envío | I01–I09, D01–D05 y el modelo de referencia de la prueba |
| Vectores del grant (para S4) | G01–G37 y el verificador de referencia |
| Requisitos de seguridad | SR-01 a SR-12 |

**No** requiere para S1: D1 (lo requiere publicar el contrato, CS-10), D2 (lo requiere S4/CP-S5), SEC-OTP-01/02 (lo requiere R4-S6) ni datos reales (S8). Requiere una **autorización explícita** del slice y la ubicación del código de la CIA.
