# R4-J4-R3-CIA-OMNICHANNEL-ALIGNMENT-01 — Revisión de diseño omnicanal de la CIA v1

| Campo | Valor |
|---|---|
| Fecha | 2026-10-19 |
| Mandato | R4-J4-R3-CIA-OMNICHANNEL-ALIGNMENT-01: consolidación arquitectónica y contractual de la Customer Identity Authority v1 |
| Modo | **Solo diseño y documentación.** Sin microservicio, sin OTP, sin capacidades ejecutables, sin grants reales, sin cambios en el harness de R4, Customer Profile ni PrestaShop, sin consultas a clientes reales, sin despliegue ni merge |
| Documentos revisados | [Informe de descubrimiento](R4_J4_R3_CIA_DISCOVERY_REPORT.md) y [propuesta de contrato](R4_J4_R3_CIA_CONTRACT_PROPOSAL.md), ambos actualizados por este mandato (bloque "Revisión OMNICHANNEL-ALIGNMENT-01") |
| Decisión del owner de R4 recogida | Flujo funcional OTP-por-email descrito en el mandato (pasos 1–8) y **dirección arquitectónica B** (CIA independiente). La designación formal del owner productor de la CIA sigue **pendiente** |
| Estado | **PROPUESTA.** Nada de este documento es una decisión aceptada salvo lo que el mandato atribuye expresamente al owner de R4 |
| **Dictamen** | §16 |

## 0. Evidencia

Se usan las etiquetas del informe de descubrimiento §0 (R4-CODE, CP-CODE, CP-DOC, PS-SOURCE, SPEC, OWNER, INFERRED), más:

| Etiqueta | Fuente |
|---|---|
| **R4-CODE** | `R4-agent-platform` @ `3e7b4ee` (worktree `r4-j4-r3-cia-discovery`, idéntico a `origin/main`) |
| **META-DOC** | Documentación pública de Meta consultada el 2026-10-19: [Receiving Flow Response](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/receiveflowresponse), [Response Message Webhook](https://developers.secure.facebook.com/docs/whatsapp/flows/reference/responsemsgwebhook), [Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/). Es lo que declara Meta, **no** comportamiento verificado contra la cuenta de PesasChile |

---

## 1. Baseline Git

| Elemento | Estado | Fuente |
|---|---|---|
| Worktree | `../r4-j4-r3-cia-discovery`, rama `docs/r4-j4-r3-cia-discovery` @ `3e7b4ee` (merge del PR #11) | GIT |
| Estado antes de modificar | Limpio salvo los dos documentos sin commit `R4_J4_R3_CIA_DISCOVERY_REPORT.md` y `R4_J4_R3_CIA_CONTRACT_PROPOSAL.md` (untracked). Se preservaron: solo se les añadieron bloques de revisión y se modificaron las secciones indicadas | GIT |
| Otras ramas | No se incorporó nada de `docs/r4-j4-r2-postmerge-closure`, `docs/r4-j55-roadmap-registration` ni `feat/r4-j4-customer-adapter-r2` | GIT |
| Customer Profile | Consultado con `git show origin/main:` (`de6c04a`), sin checkout ni escritura | GIT; CP-DOC |
| PrestaShop | Sin contacto con ningún host. Hechos del código del tag `8.2.3`, ya recogidos en el informe §3 | PS-SOURCE |

---

## 2. Arquitectura objetivo

### 2.1 Tres responsabilidades

```text
                 ┌──────────────────────────── canal (WhatsApp hoy; otros después) ───────────────────────────┐
 usuario ──────► │ proveedor del canal (Meta) ──firma──► CHANNEL INTEGRATION (en el consumidor, p. ej. R4)  │
                 └───────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                                 │ contexto afirmado {channel, channelAccountRef,
                                                                 │ subjectRef, sessionRef} + email declarado / código
                                                                 ▼
                       ┌────────────────────────────── CIA CORE ──────────────────────────────┐
                       │ desafíos OTP · evidencia de control de email · vínculos sujeto↔cuenta │
                       │ vigencia y revocación · auditoría · emisión de grants (JWS ES256)     │
                       └───────────────┬───────────────────────────────────────┬──────────────┘
                                       │ puerto AccountProvider                │ JWKS fijado
                                       ▼                                       ▼
                     ACCOUNT PROVIDER INTEGRATION                    CUSTOMER PROFILE (verifica el grant)
                     (PrestaShop 8.2.3 en v1)
```

| Responsabilidad | Contiene | No contiene |
|---|---|---|
| **CIA Core** | Desafíos OTP (emisión, HMAC, TTL, intentos, consumo); evidencia `email_verified` por sujeto y sesión; vínculos sujeto ↔ referencia de cuenta con namespace; vigencia (A–D, §6); revocación; auditoría; emisión de grants y JWKS; políticas por consumidor (allowlists, límites) | Ningún nombre de canal ni de proveedor de cuentas en el código. `channel` y `accountProvider` son cadenas registradas en configuración |
| **Channel Integration** | Autentica el origen (firma del proveedor), deriva el contexto afirmado, inicia la verificación, reconoce la respuesta OTP esperada en el mismo contexto, la entrega a la CIA por una ruta protegida, reanuda la conversación | Lógica de OTP, cuentas o grants. Nunca pone el código en el contexto del modelo |
| **Account Provider Integration** | `findByVerifiedEmail`, `revalidate`; elegibilidad del proveedor (invitada, inactiva, borrada, tiendas); detección de duplicados; credencial de mínimo privilegio | Decisión de vincular (la toma el núcleo con el resultado tipado del adaptador). Creación o modificación de cuentas |

### 2.2 Puertos del núcleo (contrato interno de la CIA, propuesto)

```ts
// Canal: el núcleo solo conoce la tupla afirmada y la política del consumidor.
interface AssertedChannelContext { channel: string; channelAccountRef: string; subjectRef: string; sessionRef: string; subjectAssurance: 'provider_signed' }

// Proveedor de cuentas: uno por namespace registrado ('prestashop_customer' en v1).
interface AccountProvider {
  readonly namespace: string;                                   // prefijo de accountRef
  findByVerifiedEmail(email: string, scope: ProviderScope): Promise<AccountCandidate[]>;   // 0..N, nunca "el primero"
  revalidate(accountRef: string, scope: ProviderScope): Promise<AccountState>;
}
type AccountCandidate = { accountRef: string; eligibility: 'eligible' | 'guest' | 'inactive' | 'deleted'; emailHash: string; providerScope: string };
type AccountState = { kind: 'eligible'; emailHash: string } | { kind: 'ineligible'; reason: 'guest' | 'inactive' | 'deleted' } | { kind: 'gone' } | { kind: 'unavailable' };
```

Un solo proveedor en v1. El puerto existe porque el mandato exige un núcleo agnóstico del proveedor, no como abstracción especulativa: es la frontera que impide que `ps_customer` aparezca en el núcleo.

### 2.3 Adaptadores v1

Solo dos, como exige el mandato:

| Adaptador | Ubicación | Alcance |
|---|---|---|
| WhatsApp (Channel Integration) | Consumidor R4: `adapters/channels/whatsapp-cloud` y el desvío de ingesta (§4) | `channel="whatsapp"`, `channelAccountRef=phone_number_id`, `subjectRef=wa_id` normalizado, `sessionRef=bindingId` |
| PrestaShop (Account Provider) | Dentro del despliegue de la CIA, como módulo separado del núcleo | Namespace `prestashop_customer`, tiendas por consumidor (OD-CIA-2) |

Un canal futuro (Instagram, web autenticada) añade un adaptador de canal en su consumidor y una entrada en la allowlist del consumidor. **No** añade endpoints, tablas ni código en la CIA.

---

## 3. Diferencias frente al diseño anterior

| Tema | Diseño anterior (descubrimiento + propuesta) | Diseño revisado |
|---|---|---|
| Cuerpo de las operaciones | Campos planos `channel`, `accountRef`, `subjectRef`, `conversationRef` | Objeto `context` genérico (§5.1). `accountRef` pasa a `channelAccountRef` para no confundirlo con la cuenta comercial |
| Propósito | Solo propósitos de datos (`sales_context`, `purchase_history`) | Se separa `verificationPurpose` (`link_commercial_account`) de los propósitos de datos del grant |
| Captura del OTP | Capacidad gobernada `customer.confirm_identity_verification@1`: el código **pasa por el modelo** (R-5, OD-CIA-5 = capacidad) | El código **nunca** pasa por el modelo: desvío en la ingesta de R4 fuera del harness (§4). `confirm` exige una credencial distinta de la de las capacidades |
| Vigencia | Un vínculo con `revalidate_after` de 90 días daba acceso a datos privados | Cuatro planos separados: evidencia (A), vínculo (B), verificación reciente (C, candidata 24 h) y grant (D, ≤ 5 min). Ver §6 |
| Identidad comercial en el modelo de datos | `prestashop_customer_id`, `id_shop` | `account_provider`, `account_ref` con namespace y `provider_scope`. PrestaShop solo en el adaptador |
| Canales | WhatsApp en el texto del contrato y del correo | Canal como dato de configuración; la plantilla del correo nombra el canal desde la configuración del consumidor |
| Dirección arquitectónica | B recomendada | B **seleccionada por el owner de R4**, condicionada a la designación del owner productor |
| D2 | Propuesta de claims con diferencias frente a CAG | Matriz de alineamiento con CP (§7); sigue `D2_PENDING_CP_ACCEPTANCE` |
| Sin cambios | Orden "OTP antes de buscar cuentas"; respuesta uniforme; resolución perezosa por invocación; `IdentityResolution` y `CustomerAccessGrant` de R2; JWS ES256; header `x-customer-access-grant`; no usar `master_customer`; no crear cuentas | — |

---

## 4. Captura protegida del OTP en R4

### 4.1 Recorrido real de un mensaje entrante (evidencia)

| # | Paso | Qué ocurre con el texto | Evidencia R4-CODE |
|---|---|---|---|
| 1 | `POST /v1/channels/:channel/webhook` (Fastify, cuerpo crudo como string) | Fastify no registra peticiones (`disableRequestLogging: true`) | `apps/channel-gateway/src/platform.ts:113,165-168` |
| 2 | `ChannelIngress.receive` → `adapter.authenticate` (HMAC `X-Hub-Signature-256`) | En memoria | `packages/live-ops/src/ingress.ts:103-110`; `adapters/channels/whatsapp-cloud/src/inbound.ts:51-60` |
| 3 | `adapter.parse` → `CanonicalInbound` (`conversationRef = senderRef = wa_id`; texto ≤ 8000; no-texto → `unsupported`) | En memoria. **Último punto en que el texto existe sin haberse persistido** | `inbound.ts:62-119` (base en 112, texto en 113-117) |
| 4 | `ingest` → `store.recordInbound` | **Primera persistencia:** `inbound_events.content` = texto completo | `ingress.ts:136-155`; `persistence-postgres/src/production-store.ts:142-153`; migración `0007_governed_production.sql:76-102` |
| 5 | `#process` → `temporal.submitInput` / `createTaskWithInput` | **Segunda persistencia, permanente:** `memory_entries` tipo `CONVERSATIONAL` con `text: body.content`. La tabla es append-only y "nothing is deleted" | `ingress.ts:209-233`; `task-runtime/src/temporal-runtime.ts:403-407`; migración `0003_context_and_memory.sql:9,38-51` |
| 6 | `settleInbound` | Borra `content` y `conversation_ref` de `inbound_events` (el CHECK lo exige para `ingested`) | `production-store.ts:155-164`; `0007…sql:101` |
| 7 | Context compiler | La memoria `CONVERSATIONAL` entra al prompt | `context-compiler/src/sources/memory.ts:65` |
| — | Telemetría | `inbound.received`/`ingested` llevan ids y `contentKind`, **nunca** el texto | `ingress.ts:160,238` |

**Conclusiones con evidencia:**
1. **Hoy no existe una ruta de interceptación.** `receive` pasa de `parse` a `ingest` sin ningún punto de extensión (`ingress.ts:111-127`).
2. La ingesta **persiste el mensaje antes de que cualquier componente pueda inspeccionarlo**: en el paso 4 (transitorio) y en el 5 (permanente, append-only). Un OTP escrito hoy en el chat quedaría para siempre en `memory_entries` y llegaría al modelo.
3. El único punto donde el texto existe sin persistir es **entre `adapter.parse` y `this.ingest`** (`ingress.ts:111`→`123`). Ahí se puede desviar sin tocar el harness.

### 4.2 Qué es "harness" en esta revisión

- Este documento llama harness a la ejecución del agente: `agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler` y `model-gateway`.
- `ChannelIngress` vive en `packages/live-ops` (ingesta de producción R4-I), **fuera** de esa definición.
- **Ambigüedad documental:** `OWNERSHIP_MATRIX.md:116` describe el binding de conversación como "Ingress Sales (harness / futuro channel adapter)". **El owner de R4 debe confirmar** que modificar `live-ops` no cuenta como modificar el harness (DEP-11). Si no lo confirma, solo queda la opción O2 (§4.3), que no toca código de R4.

### 4.3 Opciones

| | **O1. Desvío en la ingesta de R4 (`live-ops`)** | **O2. Relay externo ante el webhook** | **O3. Formulario nativo del canal (WhatsApp Flow)** | O0. Capacidad (diseño anterior) |
|---|---|---|---|---|
| Mecanismo | Entre `parse` e `ingest`, un puerto genérico consulta una **expectativa de verificación** local para `(channel, conversationKey)` y, si el mensaje coincide (§4.4), lo envía a `confirm` en la CIA sin persistir el texto | Componente fuera de R4 que recibe el webhook del número (override por número de teléfono, META-DOC), detecta la respuesta, la envía a la CIA y reenvía el resto a R4 | El código se escribe en un formulario de WhatsApp cuyo endpoint es la Channel Integration. La finalización llega al webhook como mensaje `interactive`/`nfm_reply` con un `response_json` que controla el endpoint (META-DOC) | El modelo pasa el código a una capacidad |
| ¿El código llega al modelo? | No | No | No | **Sí** (y a `memory_entries` para siempre) |
| ¿Persistencia en R4? | Solo un registro sin contenido para deduplicar | Ninguna | Solo el marcador `[unsupported inbound content: interactive]` (`inbound.ts:118`; `ingress.ts:52-54,139`) | Permanente |
| ¿Toca el harness? | No (sujeto a DEP-11) | No | No (el adaptador de canal y la ingesta, sí) | No |
| Cambios en R4 | Puerto de desvío en `ChannelIngress`; tabla de expectativas; entrada de reanudación (§4.5) | Una ruta autenticada de reanudación; nada en la ingesta | El adaptador debe reconocer `nfm_reply` con un `flow_token` de verificación. **Hoy** la política es `handoff`: la tarea se retendría para un operador (`profile-v7.ts:34`; `autonomy.ts:56`) | Capacidades nuevas |
| Riesgos | Llamada síncrona a la CIA dentro de la petición del webhook, contra el invariante de R4-I "No model, domain owner or delivery is called inside the request" (`ingress.ts:60-61`): requiere enmienda documentada | En el camino crítico de **todo** el tráfico del número; debe custodiar el `appSecret`; no puede quitar un mensaje de un lote sin romper la firma, salvo que vuelva a firmar con el secreto compartido | Publicar un Flow y operar un endpoint con el cifrado de Flows; si el cliente escribe el código como texto, se cae a O1 u O0 | Rechazada por este mandato |
| Reutilizable por otros canales | Sí: el puerto es genérico | Uno por canal | Solo WhatsApp | — |

**Recomendación: O1 para v1**, condicionada a DEP-11 y a la enmienda del invariante de R4-I. **O3 como mejora opcional posterior** para WhatsApp, que reduce errores de tecleo. **O2 solo si el owner considera la ingesta parte del harness.**

### 4.4 Reconocimiento de un OTP esperado (O1)

Se desvía un mensaje **solo si se cumplen todas** las condiciones:

1. Existe una expectativa **activa** para `(channel, conversationKey)`. La crea el handler de la capacidad que inicia la verificación, con el `verificationId` y el `expiresAt` que devuelve la CIA. Nunca la crea el modelo.
2. El remitente es el sujeto del binding: `senderRef == conversationRef` (WhatsApp, `inbound.ts:112`) y el mismo `accountRef`.
3. `occurredAt` está entre `issuedAt` y `expiresAt` de la expectativa.
4. El contenido es `text` y, tras recortar espacios, coincide con `^[0-9]{3}[ -]?[0-9]{3}$`.
5. La expectativa no está consumida ni bloqueada.

Cualquier otro mensaje, incluidos "mi código es 123456", un número de pedido escrito sin expectativa o seis dígitos de otra conversación, **sigue la ingesta ordinaria**. No se intercepta cualquier secuencia numérica.

**Residuo aceptado y declarado:** si el cliente escribe el código dentro de una frase, el código entra al transcript y al modelo. Mitigaciones:
- el mensaje de la conversación pide "responde solo con el código";
- el código vale una vez y 10 minutos;
- **el modelo no tiene forma de usarlo**: `confirm` exige la credencial de la Channel Integration, que ninguna capacidad tiene (§5.3).

### 4.5 Secuencia O1

```text
1. Capacidad R4 "iniciar verificación" (escritura gobernada; el modelo aporta solo el email declarado)
     handler: context ← bindingByTask (nunca del modelo) → CIA POST /verifications (credencial agent)
     → guarda expectativa {conversationKey, verificationId, issuedAt, expiresAt}   (sin código)
2. Cliente escribe "123456" en el mismo chat
3. ChannelIngress.receive: authenticate → parse → DESVÍO (§4.4) antes de recordInbound
     → CIA POST /verifications/confirm (credencial channel-integration, timeout ≤ 2 s)
     → registra inbound sin contenido: status='rejected', content=null,
       failureCode='verification_response_diverted'   (deduplicación por (channel, provider_event_id))
     → marca la expectativa como consumida o actualiza intentos
     → envía a la tarea una entrada de la plataforma, sin código:
       "[identity verification response handled by the platform: outcome=linked]"
       sourceRef='platform:identity-verification', externalKey=providerEventId
4. La tarea despierta (WAIT_FOR_INPUT, temporal-runtime.ts:410-413) y la conversación de Sales sigue
5. Cuando haga falta un dato privado, la capacidad customer.* llama a resolve (perezoso, ADR-039 §3)
```

Detalles:
- **Fallo de la CIA en el paso 3:** el webhook responde 500 y Meta reenvía. Es seguro: el desvío no persistió nada para ese mensaje y los demás del lote se deduplican (`ingress.ts:96-102`). Se reutiliza la estructura `rejected` de `inbound_events` sin migración, pero el valor `rejected` es semánticamente impreciso; el slice de R4 decide si añade un `content_kind` propio.
- **`outcome` hacia el modelo:** `linked`, `no_eligible_account`, `ineligible_account`, `ambiguous`, `conflicted`, `invalid_code` (con intentos restantes), `expired` o `locked`. Revelarlo no es enumeración: quien lo escribió probó controlar el buzón (propuesta §3.3).
- **Telemetría:** `inbound.verification_diverted` con `inboundId`, `outcome` y `correlationId`. Nunca el texto, el código ni el email.
- **Reanudación sin contenido:** sigue el patrón de los marcadores de la plataforma (`unsupportedContentMarker`, `ingress.ts:51-54`).

### 4.6 Veredicto de viabilidad

```text
OTP_CAPTURE_ROUTE_TODAY            = NONE           (ingress.ts:111-127; persiste en el paso 4 y en memory_entries)
OTP_CAPTURE_WITHOUT_MODEL          = FEASIBLE       (O1: desvío entre parse e ingest, fuera del harness; requiere DEP-11 y la enmienda de R4-I)
OTP_CAPTURE_WITHOUT_R4_CODE_CHANGE = FEASIBLE_COSTLY (O2: relay con override por número, en el camino crítico)
```

---

## 5. Contratos revisados

Detalle normativo en la [propuesta de contrato](R4_J4_R3_CIA_CONTRACT_PROPOSAL.md) §2–§3 revisadas. Resumen:

### 5.1 Contexto omnicanal

```json
"context": {
  "channel": "whatsapp",
  "channelAccountRef": "<phone_number_id>",
  "subjectRef": "<wa_id normalizado>",
  "sessionRef": "<id opaco de la sesión o conversación del consumidor>",
  "subjectAssurance": "provider_signed"
}
```

El **consumidor** no viaja en el cuerpo: es el principal autenticado por el bearer.

### 5.2 Afirmaciones confiables frente a datos declarados

| Campo | Lo aporta | Clase | Control en la CIA |
|---|---|---|---|
| Consumidor | Bearer | Autenticado por la CIA | Credencial por principal, rotable |
| `channel`, `channelAccountRef` | Adaptador de canal, desde su configuración y el evento firmado | **Afirmación confiable del adaptador** | Allowlist por consumidor |
| `subjectRef` | Adaptador, desde el evento autenticado del proveedor | **Afirmación confiable del adaptador** | Se guarda solo como HMAC; formato por canal registrado en configuración |
| `sessionRef` | Consumidor (R4: `bindingId`) | **Afirmación confiable del adaptador** | Debe coincidir entre `verifications` y `confirm` |
| `subjectAssurance` | Adaptador | **Afirmación confiable del adaptador** | Nivel mínimo por consumidor (v1: `provider_signed`) |
| `verificationPurpose`, `purposes` | Código del handler (constantes) | Afirmación del consumidor, **nunca del modelo** | Allowlist de propósitos por consumidor |
| `email` | El usuario (puede pasar por el modelo) | **Dato declarado, no confiable** | Validación estricta (RFC 5321, ≤ 254, sin `|`, `%`, `[`, `]`, espacios); el OTP prueba el control |
| `code` | El usuario | **Dato declarado, no confiable** | Solo por la ruta protegida; HMAC; intentos |
| `verificationId` | La CIA | Emitido por la CIA y guardado por la Channel Integration | Nunca llega al modelo |

**Regla:** el modelo **no puede** construir el contexto. En R4, el handler lo toma de `bindingByTask` (D3) y el desvío lo toma del evento autenticado. Un modelo que inventara otro `subjectRef` no tiene ninguna vía para enviarlo: las capacidades no aceptan argumentos de contexto.

### 5.3 Operaciones

| Operación | Cambio frente a la propuesta anterior | Credencial (scope) |
|---|---|---|
| `POST /v1/identity/verifications` | `context` + `verificationPurpose` + `email` + `purposes` | Agent (`identity.verification.start`) |
| `POST /v1/identity/verifications/confirm` | `context` + `verificationId` + `code`. Mismos `outcome` | **Channel Integration** (`identity.verification.confirm`), exclusiva |
| `POST /v1/identity/resolve` | `context` + `purposes`. **Respuesta sin cambios:** es `IdentityResolution` de R2 (`profile-port.ts:41-44`). La verificación reciente vencida (§6) da `not_verified` | Agent (`identity.resolve`) |
| `POST /v1/identity/links/revoke` | `context` + `reason` | Agent (`identity.link.revoke`) |

- Las cuatro rutas se mantienen. El cambio de cuerpo es compatible porque el contrato **no está publicado** y no tiene consumidores.
- Con R2 es compatible porque el puerto solo fija la respuesta de `resolve` (`IdentityResolution`, `CustomerAccessGrant`). R2 ya pliega `ambiguous` y `conflicted` en `not_verified` hacia el modelo (`customer-profile-outputs.ts:90-103`), así que un estado de vigencia nuevo no hace falta: cabe en `not_verified`.
- **No se altera el puerto de R2** ni sus capacidades.

### 5.4 Modelo de datos revisado

| Entidad | Cambio |
|---|---|
| `channel_subject` | `(channel, channel_account_ref, subject_hash)`, sin columnas por canal |
| `verification_challenge` | + `session_hash`, `verification_purpose`; `subject_id` y `consumer_id` sin cambio |
| `email_evidence` (A) | + `session_hash`, `method='email_otp'`. Pertenece a un sujeto; no se transfiere entre canales |
| `account_link` (B, antes `identity_link`) | `account_provider`, `account_ref` (con namespace), `provider_scope` (`id_shop` en PrestaShop), `email_hash`, `state`, `linked_at`, **`last_verified_at`** (base de C), `revalidate_after`, `version`, campos de revocación. Como máximo un vínculo `verified` por sujeto |
| `grant_issuance` (D) | Sin cambio: `jti`, `link_id`, `link_version`, `consumer_id`, `purposes`, `iat`, `exp`. Nunca el token |
| `link_event`, `resolution_audit` | Sin cambio (append-only, sin PII en claro) |

---

## 6. Vigencia de la identidad

### 6.1 Cuatro planos

| Plano | Qué prueba | Dónde vive | Vigencia candidata | Se renueva con |
|---|---|---|---|---|
| **A. Evidencia de control de email** | El sujeto, en esa sesión, controló el buzón X en el instante T | `email_evidence` | Hecho histórico, inmutable | — |
| **B. Vínculo** | El sujeto del canal corresponde a la cuenta comercial R, cuyo email actual es X | `account_link` | 90 días (`revalidate_after`) | Un OTP nuevo |
| **C. Verificación reciente** | El control del buzón se probó hace poco para **este** sujeto | `account_link.last_verified_at` + ventana por propósito | 24 h para datos privados | Un OTP nuevo (al mismo email vinculado) |
| **D. Grant** | La CIA autoriza a este consumidor a leer estos propósitos de R ahora | JWS | ≤ 5 min | Una nueva `resolve` |

`resolve` emite un grant solo si **B está vigente y revalidado contra el proveedor** y **C está vigente para cada propósito pedido**.

### 6.2 90 días frente a 24 horas

| Criterio | Solo vínculo de 90 días (anterior) | Vínculo 90 días + verificación reciente de 24 h (candidata) |
|---|---|---|
| Número reciclado o robado | Expuesto hasta 90 días | Expuesto ≤ 24 h + 5 min |
| Fricción | Un OTP cada 90 días | Un OTP por día de uso con datos privados |
| Qué aporta B | Acceso | Continuidad: saber qué cuenta reverificar, detectar `conflicted`, evitar una búsqueda ambigua |
| Equivalencia con PrestaShop | Más débil que una sesión de tienda | Comparable a una sesión de tienda |

**Propuesta para decidir (OD-CIA-3):** ventana C por propósito. `purchase_history` (datos privados): 24 h. `sales_context` (indicador `present`/`none`/`unknown`): podría bastar B. Ambos plazos son **candidatos**, no políticas aprobadas.

### 6.3 Escenarios

| Escenario | Resultado |
|---|---|
| Vuelve después de que venció C, con B vigente | `resolve` → `not_verified`. La conversación ofrece reverificar. El OTP va al email del vínculo o al que el cliente declare de nuevo. Al confirmar se actualiza `last_verified_at` y se revalida la cuenta |
| Vuelve después de que venció B | `not_verified`. Un OTP nuevo crea o renueva el vínculo, tras una nueva búsqueda de cuentas |
| Cambia de canal (p. ej., de WhatsApp a Instagram) | Es otro sujeto: `not_linked`. Necesita su propio OTP. **No hay vinculación cruzada automática entre canales**. La cuenta comercial puede tener varios sujetos |
| Pierde el control de su número | Revocación por un operador, por cuenta (todos los sujetos de `account_ref`). C limita la exposición a ≤ 24 h. Que el cliente revoque desde otro sujeto verificado es candidato para v1.1 |
| Pierde el control de su email | Quien controle el buzón puede vincular, igual que con el restablecimiento de contraseña de PrestaShop (informe §3.2.6). Fuera del alcance de la CIA |
| Pide revocación | `links/revoke` → `revoked` (terminal). Efecto en la siguiente `resolve`; los grants ya emitidos caducan en ≤ 5 min |
| Cambia el email en PrestaShop | En la revalidación: `stale` → `not_verified`. Necesita un OTP al email nuevo |

---

## 7. Grants D2: alineamiento con Customer Profile

| Tema | Propuesta CIA | CAG de CP (CP-DOC `CP_V2_ARCHITECTURE_AUDIT.md`, §11) | Recomendación | Estado |
|---|---|---|---|---|
| Propósito | `purposes[]` | `purpose` + `scope[]` | `purposes[]`. El scope pertenece al bearer de CP y el puerto de R4 ya usa una lista (`profile-port.ts:34-40`). CP comprueba `purpose ∈ purposes` | **Pendiente CP** |
| Nivel de prueba | `amr: ["email_otp"]` | `assurance` (CP lo divulga) | Un solo claim. Si CP necesita divulgarlo, `assurance` con un valor enumerado (p. ej. `email_otp_recent`) y sin `amr` | **Pendiente CP** |
| Vínculo con el sujeto | `sbh` (HMAC del sujeto, solo auditoría) | `cnf` (hash de `conversationRef`) | `sbh`. En RFC 7800, `cnf` significa prueba de posesión de clave, y CP no puede verificar ninguno de los dos | **Pendiente CP** |
| TTL | ≤ 300 s (`exp − iat`) | `exp ≤ 15 min` | 5 min. R4 resuelve en cada invocación | **Pendiente CP** |
| Revocación | v1: la CIA deja de emitir + caducidad del TTL. v1.1 opcional: lista por vínculo (`lnk`, `lver`) consultada cada ≤ 60 s | No definida; descarta la introspección por petición | Solo TTL en v1 (OD-CIA-4) | **Pendiente CP** |
| Errores | 403 `{ "error": "grant_rejected", "reason": <enum> }` | 403 `customer_access_grant_required` o `grant_mismatch` | Un solo código (`grant_rejected`) con un `reason` enumerado. Para R4 no cambia nada: cualquier 403 es `unauthorized` (`client.ts:239-242`) | **Pendiente CP** |
| Algoritmo | ES256 | EdDSA o ES256 | ES256 | Compatible |
| Header, emisor, `aud`, `azp`, `sub`, `jti`, JWKS fijado | `x-customer-access-grant`; `iss`, `aud=customer-profile`, `azp`=principal, `sub=prestashop_customer:<id>`, `jti`, `kid` | Iguales | — | Compatible |
| Portador | Lo obtiene una `resolve` perezosa en cada invocación | "lo recibe en `afterOpen`" | Resolución perezosa (ADR-039 §3). Además, `afterOpen` fija `customerRef: null` en un binding de una sola escritura (`composition.ts:215-217`; `OWNERSHIP_MATRIX.md:116`) | Diferencia documental en CP |

**D2 no está aprobada.** Hace falta que el owner de CP acepte esta matriz.

---

## 8. Identidad comercial y seguridad

### 8.1 Casos de cuenta (adaptador PrestaShop)

La identidad es `prestashop_customer:<id_customer>`. `master_customer` no es autoridad (informe §2.4).

| Caso | Tratamiento | Fuente |
|---|---|---|
| Email con varias cuentas | `ambiguous`, derivado a un operador. **Nunca** se elige la primera | Informe §3.2.1 |
| Multitienda | Filtrar `id_shop` según la política del consumidor (OD-CIA-2). Duplicados dentro de las tiendas permitidas → `ambiguous` | PS-SOURCE `Shop.php:162-201` |
| Invitada | No elegible → `ineligible_account` / `not_authorized` | `CustomerLoginForm.php:77` |
| Inactiva | Igual que invitada | `CustomerLoginForm.php:75-78` |
| Eliminada | `deleted=1` → no elegible. Borrado físico → `gone` → vínculo `revoked` | `DeleteCustomerHandler.php:50-59` |
| Cambio de email | Vínculo `stale` en la revalidación | `IdentityController.php:57-69` |
| Inexistente | `no_eligible_account` / `not_linked` | — |
| Creación de cuenta | **No** en J4 (Checkout, R4-L/J5.5) | Mandato |

### 8.2 Webservice estándar frente a un endpoint mínimo

| Criterio | Webservice `customers` (clave solo GET) | Endpoint mínimo de solo lectura (módulo o vista del owner de la tienda) |
|---|---|---|
| Privilegio real | La clave **puede** leer `passwd` (bcrypt) y `secure_key` de todos los clientes. `display` reduce la respuesta, no el privilegio (informe §3.1) | Solo `id`, `email` normalizado o su hash, `is_guest`, `active`, `deleted`, `id_shop` y `date_upd` |
| Impacto si se filtra la clave | Hashes de contraseña y llaves de restablecimiento de toda la tienda | Existencia y estado de cuentas por email |
| Inyección de filtro | El `|` y el `%` cambian la consulta (`SQLUtils.php:45-80`): la CIA debe validar | Parámetro tipado; igualdad exacta |
| Búsqueda por hash | No | Posible: la CIA no tendría que enviar el email en claro |
| Coste | Ninguno en la tienda (oficial) | Desarrollo y mantenimiento en la tienda, y pruebas tras cada actualización |
| Actualizaciones de PrestaShop | Contrato oficial estable | Riesgo de rotura |

**Recomendación:** el endpoint mínimo para datos reales, y el webservice estándar solo contra el doble sintético o con una aceptación de riesgo explícita del owner de la tienda (DEP-3). El puerto `AccountProvider` hace que la elección no afecte al núcleo.

### 8.3 Controles que se mantienen

Sin cambios respecto de la propuesta §7–§8:
- OTP de un solo uso, de 6 dígitos, guardado como HMAC, con TTL de 10 min, 5 intentos y reenvío cada ≥ 60 s;
- respuesta uniforme al iniciar y búsqueda de cuentas solo después de la prueba;
- límites por sujeto, por `email_hash` y por consumidor;
- claves separadas (HMAC, cifrado del email, firma y credencial del proveedor);
- autenticación servicio a servicio;
- verificación de sujeto, sesión y propósito en `confirm`;
- minimización de datos;
- mínimo privilegio en PrestaShop.

**Nuevo:** el scope `identity.verification.confirm` es exclusivo de la credencial de la Channel Integration. Ninguna capacidad de R4 la tiene.

---

## 9. Cambios por componente (futuros, cada uno con su autorización)

| Componente | Cambios |
|---|---|
| **CIA** (servicio nuevo, owner por designar) | Todo el núcleo. El adaptador PrestaShop como módulo separado. JWKS. API de operadores fuera del contrato de consumidores |
| **R4 — Channel Integration** (`live-ops`, `adapters/channels/whatsapp-cloud`, fuera del harness, DEP-11) | Puerto genérico de desvío en `ChannelIngress` entre `parse` e `ingest`; tabla de expectativas de verificación (sin código); entrada de reanudación de la plataforma; credencial `confirm`; telemetría sin contenido; enmienda documentada del invariante de R4-I |
| **R4 — pack Sales** | Capacidad gobernada "iniciar verificación" (DEP-8: envía correo a un tercero). Adaptador HTTP de `resolve` que entrega `IdentityResolution`. Header `x-customer-access-grant` en el adaptador CP. Capacidad de revocación a pedido del cliente. **Sin** capacidad de confirmación |
| **R4 — harness** | **Ninguno** |
| **Customer Profile** | Verificación del grant en el router (propuesta §6.3), `jose`, JWKS fijado, `authorizationBasis: customer_grant_verified` y `validUntil` limitado por `exp`. Pendiente de la matriz §7 |
| **PrestaShop** | Ninguno en J4. Con el endpoint mínimo (DEP-3), un módulo de solo lectura que decide el owner de la tienda |

---

## 10. Matriz de decisiones OD-CIA-1 a OD-CIA-6

| ID | Decisión | Estado | Recomendación | Quién decide |
|---|---|---|---|---|
| OD-CIA-1 | Método: `email_otp` en lugar de `account_login` | **Flujo funcional aprobado por el owner de R4** (mandato). **Pendiente** la enmienda formal de ID-AUTHORITY-DECISION-01 §4.3 por el owner de la CIA | Formalizar la enmienda | Owner de la CIA |
| OD-CIA-2 | Tiendas que resuelve cada consumidor | **Pendiente** | `r4-sales`: solo la tienda que atiende el canal; con duplicados, `ambiguous` | Negocio + owner de la tienda |
| OD-CIA-3 | Vigencias de B y C | **Pendiente** (candidatas) | B: 90 días; C: 24 h para `purchase_history`; decidir si `sales_context` exige C | Owner de la CIA + owner de R4 |
| OD-CIA-4 | Revocación de grants | **Pendiente** | Solo TTL ≤ 5 min en v1; lista por vínculo en v1.1 si se exige revocación inmediata | Owner de la CIA + owner de CP |
| OD-CIA-5 | Captura del OTP | **Revisada:** se descarta O0 (capacidad). **Pendiente** elegir entre O1, O2 y O3 | O1 (desvío en `live-ops`), condicionada a DEP-11 y a la enmienda de R4-I. O3 como mejora posterior | Owner de R4 |
| OD-CIA-6 | Alternativa A o B | **B seleccionada por el owner de R4**, condicionada a la designación del owner productor | — | Negocio (designación) |

---

## 11. Dependencias pendientes

Se mantienen DEP-1 a DEP-10 (informe §9.2), con estos cambios:

| ID | Cambio |
|---|---|
| DEP-1 | Sigue abierta: la selección de B no designa al owner productor |
| DEP-8 | Se reduce a una capacidad "iniciar verificación" y una de revocación. Ya no hay capacidad de confirmación |
| **DEP-11** (nueva) | El owner de R4 confirma que `packages/live-ops` queda fuera del harness y autoriza el desvío en la ingesta junto con la enmienda del invariante de R4-I (`ingress.ts:56-61`) |
| **DEP-12** (nueva) | El owner de CP acepta la matriz §7 |
| **DEP-13** (nueva, solo O2/O3) | Override del webhook por número o publicación de un WhatsApp Flow. Configuración de Meta que decide el owner del número |

---

## 12. Plan mínimo de implementación por slices

Cada slice necesita una autorización explícita, sigue usando datos sintéticos y entrega su evaluación junto con la implementación.

| Slice | Contenido | Repositorio | Requiere | Cierre |
|---|---|---|---|---|
| **CIA-S0** | Contrato publicable: JSON Schema de las cuatro operaciones, fixtures y SHA (CS-10) | CIA | DEP-1 | Schemas validados contra los fixtures |
| **CIA-S1** | Núcleo: sujetos, desafíos, evidencia, límites y auditoría, con un buzón falso y un proveedor de cuentas falso | CIA | S0 | V-08 a V-11, V-22, V-23, V-25, N-01 a N-04 |
| **CIA-S2** | Adaptador PrestaShop contra un doble sintético (contrato de §5.1 de la propuesta, o del endpoint mínimo) | CIA | S1, DEP-3 (decisión, no acceso) | V-02 a V-07, V-21 |
| **CIA-S3** | Vínculos, `resolve`, vigencias B y C, y revocación | CIA | S2, OD-CIA-3 | V-12, V-16, V-19, N-05 a N-07 |
| **CIA-S4** | Emisión de grants con claves de prueba y JWKS | CIA | S3, DEP-12 | Grants contra un verificador de referencia |
| **CP-S5** | Verificación del grant en CP | CP | DEP-12, DEP-4 | V-13 a V-18 y V-26 |
| **R4-S6** | Channel Integration: desvío, expectativas, reanudación y telemetría | R4 (`live-ops`) | DEP-11 | N-08 a N-14 |
| **R4-S7** | Pack Sales: capacidad "iniciar verificación", adaptador de `resolve` y header de grant | R4 (`agents/sales`, `adapters/domains`) | S4, S6, DEP-8 | AG-3 cerrado; V-01 E2E sintético |
| **S8** | Puertas para datos reales: proveedor de correo, custodia de claves, legal y credencial PrestaShop | Operación | DEP-2, 3, 5, 6, 10 | Revisión del owner; `CUSTOMER_REAL_DATA_ACCESS` sigue bloqueado hasta entonces |

S1–S4 y R4-S6 pueden avanzar en paralelo. S7 integra los dos frentes.

---

## 13. Pruebas negativas y criterios de aceptación

Se mantienen V-01 a V-26 (propuesta §9.2). Se añaden:

| # | Caso | Resultado esperado | Capa |
|---|---|---|---|
| N-01 | `confirm` con la credencial del agente (scope `identity.verification.start`/`resolve`) | 403 `consumer_not_allowed`; el desafío no cambia | CIA |
| N-02 | `confirm` con otro `sessionRef` (binding cerrado y reabierto) | `invalid_code`, sin revelar el motivo | CIA |
| N-03 | `context.channel` o `channelAccountRef` fuera de la allowlist | 403 `consumer_not_allowed` | CIA |
| N-04 | Un `subjectRef` mal formado para el canal registrado | 400 `invalid_request` | CIA |
| N-05 | C vencido con B vigente | `resolve` → `not_verified`; sin grant | CIA |
| N-06 | El mismo email en dos canales (dos sujetos) | Dos vínculos independientes; revocar uno no afecta al otro; ninguno se crea sin su propio OTP | CIA |
| N-07 | Revocación por operador por `account_ref` | Todos los sujetos de esa cuenta → `revoked` | CIA |
| N-08 | Mensaje de 6 dígitos **sin** expectativa activa | Ingesta ordinaria; ninguna llamada a la CIA | R4 |
| N-09 | "mi código es 123456" con expectativa activa | Ingesta ordinaria (residuo declarado, §4.4) | R4 |
| N-10 | Código correcto desde otro `wa_id` u otro `phone_number_id` | Ingesta ordinaria; la expectativa sigue activa | R4 |
| N-11 | Código desviado | Ninguna fila en `memory_entries` ni `task_inputs` con el código; `inbound_events.content` nulo; la telemetría sin el texto; la tarea recibe la entrada de reanudación con `outcome` | R4 |
| N-12 | La CIA no responde durante el desvío | Webhook 500; nada persistido para ese mensaje; el reenvío de Meta lo procesa una vez | R4 |
| N-13 | Reenvío duplicado de un mensaje ya desviado | Un solo `confirm`; deduplicado por `(channel, provider_event_id)` | R4 |
| N-14 | El modelo intenta iniciar una verificación para otro sujeto | Imposible: la capacidad no acepta argumentos de contexto; el handler usa `bindingByTask` | R4 |
| N-15 | Barrido de búsqueda en `memory_entries`, observaciones, step log y artifacts tras un E2E sintético | El código OTP sintético no aparece en ninguno | R4 |

**Criterios de aceptación de CIA v1:**
1. V-01 a V-26 y N-01 a N-15 en verde, con datos sintéticos.
2. Ningún nombre de canal ni de proveedor en el código del núcleo, verificado con una búsqueda en CI (`whatsapp`, `prestashop`, `instagram`, `r4`).
3. El harness de R4 sin cambios (`git diff` vacío en `packages/agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler` y `model-gateway`).
4. Puerto R2 sin cambios: `profile-port.ts` idéntico.
5. D2 aceptada por el owner de CP antes de CP-S5.

---

## 14. Incertidumbres

1. **Clasificación de `live-ops`** frente a "harness" (DEP-11).
2. **WhatsApp Flows:** comportamiento verificado solo con la documentación de Meta; no se probó con la cuenta.
3. **Lotes de Meta:** el diseño admite varios mensajes por notificación (`inbound.ts:75-98`). No se midió con qué frecuencia ocurre; afecta a O2, no a O1.
4. Se mantienen las incertidumbres del informe §9.3 (versión instalada de PrestaShop, multitienda real, duplicados, correo de la tienda, psgdpr).

---

## 15. Archivos

| Archivo | Acción |
|---|---|
| `docs/architecture/R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md` | Creado |
| `docs/architecture/R4_J4_R3_CIA_DISCOVERY_REPORT.md` | Actualizado: bloque de revisión, §4.1, §4.3, R-5, §9.4 y §10 |
| `docs/architecture/R4_J4_R3_CIA_CONTRACT_PROPOSAL.md` | Actualizado: bloque de revisión, §2, §3, §4, §6.1, §8 y §12 |

Sin commit, sin merge y sin cambios en ningún otro repositorio.

---

## 16. Dictamen

```text
CIA_V1_OMNICHANNEL_DESIGN_COMPLETE
CIA_CORE_CHANNEL_AGNOSTIC              (contexto genérico §5.1; canal como configuración; criterio de aceptación 2)
CIA_CORE_ACCOUNT_PROVIDER_AGNOSTIC     (puerto AccountProvider §2.2; PrestaShop solo en su adaptador)
D1_ARCHITECTURE_SELECTED_CONDITIONALLY (B, seleccionada por el owner de R4; owner productor por designar, DEP-1)
D2_PENDING_CP_ACCEPTANCE               (matriz §7, DEP-12)
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
