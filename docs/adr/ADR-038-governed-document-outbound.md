# ADR-038 — Salida documental gobernada: entrega automática del artefacto de una escritura confirmada a la conversación de origen

- **Estado:** **PROPOSED / DEFERRED** (`ADR_038_STATUS=PROPOSED_DEFERRED`). No es `ACCEPTED`. **No autoriza implementación.** No habilita cambios en `packages/`, `apps/` ni `adapters/`, ni la migración `0011`, ni versiones nuevas de Sales, ni despliegue.
- **Disposición (decisión del owner, 2026-10-14):**
  - `J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA`: J3F no se implementa como parte de J3.
  - El diseño se conserva como insumo de la futura iniciativa transversal **R4 Media & Communications — Governed Multimodal Capabilities**.
  - Esa iniciativa tendrá fases independientes: audio entrante, transcripción, imágenes entrantes, comprensión multimodal, documentos entrantes, archivos salientes, PDFs de cotizaciones, transporte de medios por canales, autorización y seguridad, idempotencia de comunicaciones, estados de entrega y reconciliación.
  - Entregar un PDF no exige terminar todo el sistema multimedia.
  - **Terminología oficial:** *capacidad de plataforma* o *capability del harness*. Una skill agéntica puede usar esas capabilities, pero no implementa transporte, persistencia ni entrega.
- **Fecha:** 2026-10-14 (diseño y diferimiento)
- **Numeración:** `main` termina en ADR-035. ADR-036 y ADR-037 existen solo en la rama publicada `r4-j3e-c-deterministic-commercial-offer` (sin merge). Ninguna rama remota usa 038 (verificado el 2026-10-14). Si J3E-C1 no se fusiona antes que este ADR, 036–037 siguen reservados y 038 no cambia.
- **Autoridad superior:** Constitución §9, §21, §25 (1–5, 11, 13, 14); PRD §6 (Artifact, ActionReceipt), §11, §12, §19, §27, §28, §31, §41, §43, §44; ADR-016, ADR-017, ADR-018, ADR-019, ADR-020, ADR-022, ADR-029; ADR-037 (propuesto).
- **Enmienda (solo para lo que aquí se define):**
  - ADR-029: nuevo origen `platform` (con procedencia obligatoria), contenido `document` y la puerta de entrega para ese origen.
  - ADR-017: efectos derivados declarados.
  - ADR-016/ADR-020: registro inmutable del artefacto junto al recibo.
  - ADR-034 §8 ("Emisión ≠ entrega"): deja de aplicar solo en el perfil Sales que adopte este ADR.
- **Diseño detallado:** [`R4_J3F_DOCUMENT_DELIVERY_DESIGN.md`](../architecture/R4_J3F_DOCUMENT_DELIVERY_DESIGN.md). **Plan:** [`R4_J3F_IMPLEMENTATION_PLAN.md`](../architecture/R4_J3F_IMPLEMENTATION_PLAN.md).
- **Evidencia del problema:**
  - `R4_J3_FINAL_ACCEPTANCE.md` §8 y S10;
  - GAP-01 y GAP-03 del registro de brechas J3.
  - Ambos documentos están en la rama J3E-C1.

## Contexto

Una escritura gobernada puede producir un **documento oficial** cuyo dueño es un servicio de dominio externo. El caso que motiva este ADR es el PDF de una cotización emitida por Quote V2. Hoy R4 lo verifica por SHA-256 y descarta los bytes; el cliente nunca lo recibe (GAP-01).

La auditoría (diseño §2) estableció:

| Hecho | Fuente |
|---|---|
| El outbound es solo texto, desde la decisión hasta el cuerpo HTTP | `OutboundSubmission.text` (`packages/live-ops/src/channel.ts:73-81`); `type: 'text'` fijo (`adapters/channels/whatsapp-cloud/src/outbound.ts:51`); sin columnas de medio en `outbound_messages` (`0007`) |
| Solo hay dos orígenes de outbound: `agent` (un `respond` registrado) y `operator` | `delivery.ts:27`; CHECK de `0007` |
| No existe ningún efecto que la plataforma ejecute después de un recibo | `settleWithin` termina en la observation (`packages/task-runtime/src/action-runtime.ts:637-706`) |
| Un step de plataforma no puede ser `propose_action` | `0010_platform_step_decisions.sql:11` |
| La Policy Engine niega toda escritura de una task que no esté `running` | `engine.ts`, regla 2 |
| `EXTERNAL_COMMUNICATION` no lo usa ninguna capability; el outbound se gobierna con la puerta de entrega, no con la Policy Engine | `delivery.ts:86-98`; ADR-029, alternativa descartada `propose_action(send_message)` |

**No hay un mecanismo genérico reutilizable.** Hace falta extender el harness.

El owner fijó estas condiciones:
- D1: la entrega es una obligación de la plataforma, no una decisión del modelo.
- D2: el documento se obtiene bajo demanda del owner, verificado, sin almacenarlo en R4.
- D3: una entrada ordinaria del cliente no cancela la entrega.
- D4: los límites del proveedor se verifican contra su documentación.

## Opciones comparadas

| # | Opción | Depende del modelo | Gobernada | Atómica con la emisión | Cambio de harness | Veredicto |
|---|---|---|---|---|---|---|
| O1 | Capability `quote.share_document@1` invocada por el agente (propuesta de la aceptación J3 §8.3) | **Sí**: el modelo debe recordarlo | Sí (EXTERNAL_COMMUNICATION) | No | Medio | **Rechazada** por D1 |
| O2 | El handler de Sales envía (directo o vía `createOperatorOutbound`) | No | **No**: elude gate, rollout, kill switch y ownership; atribuye a un humano | No | No | **Rechazada** (ya lo fue en J3E-C, alternativa D) |
| O3 | Sales mantiene su propia cola y su propio emisor de documentos | No | Parcial | Sí (tabla Sales) | No en Core | **Rechazada**: dos dueños de la entrega (ADR-029 §7); el pack hablaría con el canal |
| O4 | La plataforma emite un `propose_action` sintético tras el recibo | No | Sí | No | Alto: rompe `0010`; la task debe estar `running`; consume presupuesto de run | **Rechazada**: la plataforma fabricaría intenciones atribuidas al agente y ataría la entrega a la vida del run |
| O5 | El worker descarga y guarda el PDF en R4; el gateway lo envía desde ahí | No | Sí | Sí | Alto, más purga | **Rechazada** por D2 (almacenamiento de PDFs sin necesidad demostrada) |
| O6 | Mensaje `document.link` con URL firmada | No | — | — | — | **Rechazada**: Quote V2 no expone URLs; Meta lo desaconseja; una URL portadora es una credencial |
| **O7** | **Efecto derivado declarado por la capability, autorizado por la Policy Engine junto con la acción, registrado con el recibo y entregado por el único dueño de la entrega desde una fuente de documentos verificada** | **No** | **Sí** | **Sí** (artefacto en la transacción del recibo) | Medio, aditivo | **Elegida** |

## Decisión

### 1. El artefacto lo declara la escritura, no el modelo

- Una capability de escritura puede declarar, en su definición versionada:

  ```ts
  derivedEffects?: [{ kind: 'artifact_delivery'; target: 'origin_conversation' }]
  ```

  - Como máximo uno.
  - Prohibido en `READ`.
  - `target` no es configurable: solo existe la conversación de origen.
- Si lo declara, su `applied` (en `execute` y en `reconcile`) **debe** traer exactamente un descriptor:

  ```ts
  artifact: {
    kind: 'document';
    source: string;               // id (slug) de un DocumentSource registrado
    ownerRef: string;             // referencia opaca del owner, 1..200 ASCII imprimible
    mimeType: 'application/pdf';  // único tipo de esta versión
    byteLength: number;           // 1..20 MiB (ver §6)
    sha256: string;               // hex(64), del manifiesto del owner
    integrity: 'verified' | 'unverified' | 'mismatch';  // verificación de bytes al emitir
    filename: string;             // ^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\.pdf$
    caption: string | null;       // texto del pack, ≤ 1024
    failureNotice: string | null; // texto del pack, ≤ 1024
  }
  ```

- Un `applied` sin descriptor válido, o con descriptor en una capability que no lo declaró, se clasifica `unknown` (misma regla que una salida fuera de esquema, ADR-018). Nunca hay un recibo `succeeded` sin su artefacto declarado.
- El modelo no aporta ningún campo del descriptor. `AgentDecision` no cambia: no hay destinatario, documento ni URL en ninguna decisión.

### 2. La Policy Engine autoriza el efecto derivado junto con la acción

- La configuración gana un campo **opcional y sin default**:

  ```ts
  derivedEffects?: Record<capabilityId, { artifact_delivery: 'allow' | 'deny' }>
  ```

  - Ausente ⇒ forma canónica idéntica ⇒ **hash idéntico** (`canonicalJson` omite `undefined`). Las huellas fijadas, como `515ce98f…` de `sales-production-autonomous-policy@1`, no cambian.
- Solo si la acción resulta `allow` (autónoma o aprobada por un humano), el motor evalúa el efecto declarado:
  - regla `allow` ⇒ `allow`;
  - regla `deny` o ausente ⇒ `deny` (**fail-closed**).
- `require_approval` no es representable para un efecto derivado en esta versión. La aprobación de entregas queda diferida.
- La evaluación es pura y determinista. Se persiste en la misma transacción que la `PolicyDecision`, en `policy_derived_decisions` (inmutable).
- `POLICY_ENGINE_VERSION` pasa a `r4.policy-engine.v2`. Las decisiones históricas conservan la suya.
- La política autoriza **la clase de efecto** ("comunicar a la conversación de origen el artefacto de esta escritura"). La **elegibilidad del momento** la decide la puerta de entrega (§5), igual que para el texto.

### 3. Registro inmutable del artefacto con el recibo

- `settleWithin` inserta el `ActionReceipt` `succeeded` y su fila `action_artifacts` en **una sola transacción**.
- `action_artifacts` es inmutable (trigger `action_ledger_immutable`) y admite una fila por recibo.
- La observation de la acción agrega, de forma aditiva:

  ```ts
  artifact: { kind, filename, delivery: 'permitted' | 'not_permitted' }
  ```

  - `permitted` = la política permite la entrega automática (efecto `allow`).
  - `not_permitted` = efecto `deny`.
  - `task-runtime` no conoce bindings ni canales. Si la entrega ocurre, y cuándo, lo informa el estado de entrega (§9). Una task sin binding de canal nunca materializa una entrega.
- Nunca hay bytes, URL ni referencia de medio en la observation.

### 4. Obligación de entrega: outbox transaccional consumido por el único dueño

- El par recibo + artefacto + decisión `allow` es la **obligación durable**. La crea la transacción de la emisión y sobrevive a cualquier caída posterior.
- `OutboundDeliveryRuntime` la materializa como un `OutboundMessage` en su `tick`, igual que materializa un `respond` registrado (ADR-029 §7):
  - `origin = 'platform'` con procedencia obligatoria `artifact_id`, y `content_kind = 'document'`;
  - FK a `action_artifacts` y al binding de la task.
- **Clave lógica:** `idempotency_key = 'r4-doc:' || hex(sha256(binding_id ‖ 0x00 ‖ source ‖ 0x00 ‖ ownerRef))`, única en la tabla.
  - Como máximo un envío por documento y por conversación, aunque dos recibos citen el mismo documento.
  - Rematerializar no crea filas: el anti-join es por clave lógica.
- Si `integrity = 'mismatch'` al emitir, la fila nace `failed` (`document_integrity_mismatch`) con 0 llamadas al proveedor.
- El kernel, el worker, el pack y el webhook nunca envían.

### 5. Puerta de entrega para el origen `platform` (evaluada en la transacción del claim)

Precedencia, de arriba hacia abajo:

| # | Condición | Decisión |
|---|---|---|
| 1 | Kill switch (global o `channel:<id>`) | **hold** `autonomy_disabled` |
| 2 | Denylist de rollout | **hold** `autonomy_denied` |
| 3 | Binding no autónomo | **hold** `rollout_excluded` |
| 4 | Integridad del binding: no existe, su `task_id` ≠ el del outbound, o su cuenta ≠ la del adaptador | **hold** `binding_mismatch` + alerta; nunca se envía |
| 5 | Task `cancelled`, o intención terminal de cancelación | **cancel** `task_cancelled` |
| 6 | Binding `closed` | **cancel** `conversation_closed` |
| 7 | Ventana del canal cerrada | **cancel** `window_closed` |
| 8 | Handoff pedido o activo, sin liberación del operador para este outbound | **hold** `human_owned` |
| 9 | Ninguna de las anteriores | **dispatch** |

**No aplican a artefactos:**
- `superseded_by_newer_input`: un mensaje nuevo del cliente no cancela (D3);
- `duplicate_content`;
- la antigüedad máxima del texto (`expired`).

**Otras reglas:**
- Una task `failed` o `completed` con el binding abierto **no** impide la entrega: el documento pertenece a la emisión, no al run.
- `manualReply` no cancela artefactos: `cancelPendingAgentOutbound` filtra `origin = 'agent'`. Con un handoff activo, el documento queda retenido.
- El operador puede **cancelar** (endpoint existente) o **liberar** (nuevo, scope `handoff.manage`, atribuido por `TrustedHumanContext`).

### 6. Documento bajo demanda, verificado por la plataforma antes de salir

- Puerto `DocumentSource` en `@r4/live-ops`, implementado fuera de Core (por el pack) y compuesto **solo** en el gateway:

  ```ts
  interface DocumentSource {
    readonly id: string;
    fetch(req: { ownerRef; taskId; expected: { sha256; byteLength; mimeType } },
          opts: { signal; maxBytes }): Promise<
      | { outcome: 'fetched'; bytes: Uint8Array; declaredSha256: string | null }
      | { outcome: 'not_available'; code: string }   // transitorio: nada salió de R4
      | { outcome: 'refused'; code: string }         // permanente: correspondencia o estado
    >;
  }
  ```

  - La fuente verifica la **correspondencia** con el owner: el documento pertenece a esta task y está en estado emitido. Es semántica del dominio.
- La **plataforma** verifica la **integridad** antes de cualquier byte hacia el proveedor:
  - SHA-256 de los bytes = descriptor;
  - longitud = descriptor;
  - cabecera `%PDF-`;
  - `declaredSha256` (si existe) = descriptor;
  - tamaño ≤ `min(20 MiB, límite declarado por el adaptador)`.
  - Cualquier discrepancia ⇒ `failed` con 0 llamadas al proveedor.
- Los bytes viven solo en memoria, dentro de un intento. Nunca van a disco, base de datos, logs, telemetría, observations, snapshots ni prompts.
- No hay streaming: la verificación debe preceder a la salida. 20 MiB acotan la memoria del gateway, que despacha de a uno.
- Las credenciales del owner viven solo en la `DocumentSource`. El adaptador de canal no recibe ninguna.

### 7. Adaptador de canal: subida y envío como fases separadas

- `OutboundSubmission` pasa a llevar contenido tipado: `{ kind: 'text', text } | { kind: 'document', mediaRef, filename, caption }`.
- El adaptador declara opcionalmente `documents: { maxBytes, mimeTypes, captionMax, uploadDocument(...) }`. Un adaptador sin esa capacidad ⇒ `failed` (`channel_document_unsupported`), 0 llamadas.
- Cada intento recorre fases. Cada registro de fase es una transacción con fencing y renueva el lease:

  `fetch → verify → upload → registro de inicio de envío → send`

- **Asimetría deliberada:**
  - Una subida de medio no es visible para el cliente. Toda falla o incertidumbre **antes** del registro de inicio de envío es `not_sent`: se reintenta de forma acotada, por plazo y no por intentos.
  - El envío del mensaje conserva la semántica de ADR-029 §8: solo "definitivamente no enviado" se reintenta; timeout, 5xx o una respuesta perdida ⇒ `unknown`, **nunca reenviado**.
- **Barrido de leases vencidos:**
  - sin inicio de envío registrado ⇒ `pending` (`lease_expired_before_send`);
  - con inicio registrado ⇒ `unknown` (comportamiento actual).
- **Correlación por evidencia:** el envío incluye un dato de callback opaco del proveedor con `r4o:<outboundId>:<attempt>`. Un evento de estado autenticado que lo trae puede ligar un `unknown` sin id del proveedor a su `provider_message_id`.
  - Es evidencia positiva, nunca negativa: la ausencia de callback no prueba que no se envió.

### 8. Honestidad del resultado

**R4 garantiza:**
- a lo sumo una obligación por (binding, documento);
- a lo sumo un envío del mensaje sin evidencia de no-envío;
- ningún reenvío automático tras un resultado incierto;
- ningún byte sin verificar hacia el proveedor;
- ningún documento a otro binding que el de la task emisora.

**R4 no afirma entrega física exactamente una vez.** El proveedor no documenta idempotencia: un `unknown` puede corresponder a un mensaje entregado. Solo la evidencia del proveedor o un operador lo resuelven.

### 9. Comunicación al cliente

- Los textos de plataforma son del pack, deterministas, y quedan en el artefacto (inmutable).
- **Caption:** viaja **con** el documento (por construcción es verdad cuando el cliente lo ve).
- **Aviso de falla:** neutral, sin afirmar emisión ni cifras. Es un outbound `origin = 'platform'`, `content_kind = 'text'`, con clave `r4-doc-notice:<outboundId>`.
  - Se crea en la misma transacción que lleva el documento a `failed`, por cualquier camino.
  - Pasa por la misma puerta.
- **Sin mensajes automáticos** para `accepted`, `delivered`, `read`, `unknown` ni `cancelled`.
- El agente consulta el estado por `DeliveryStateContextSource` (extendida a artefactos). El vocabulario es fijo:

  | Estado | Etiqueta |
  |---|---|
  | `pending` | pendiente de envío |
  | `accepted` | enviado, sin confirmación de entrega |
  | `delivered` / `read` | entregado según el canal |
  | `failed` | no se pudo enviar |
  | `unknown` | envío no comprobado |
  | `cancelled` | no se enviará, con motivo |

  Nunca ve bytes ni identificadores de medio.

### 10. Fuera de este ADR

- Aviso durable de "emisión pendiente" mientras una escritura autorizada está retenida (ADR-037 L3). Exige un cambio del ciclo de vida de acciones y un ADR propio (diseño §9).
- Reenvío de un documento por un operador.
- Plantillas fuera de la ventana de 24 h.
- Email.
- Tipos distintos de PDF.
- Más de un artefacto por recibo.
- `require_approval` para efectos derivados.

## Cambios al protocolo público

| Superficie | Cambio | Compatibilidad |
|---|---|---|
| `AgentDecision` (protocolo del modelo) | **Ninguno** | — |
| `CapabilityDefinition` | `derivedEffects?` | Aditivo; huellas de capabilities existentes sin cambio (campo ausente) |
| `WriteExecutionResult.applied` | `artifact?` | Aditivo |
| `ActionPolicyConfiguration` | `derivedEffects?` (sin default) | Hashes existentes idénticos |
| `PolicyDecision` | `derivedEffects: [{effect, outcome, rule, reasonCode}]` | Aditivo |
| Observation de acción `succeeded` | `artifact?` | Aditivo |
| `OutboundSubmission`, `OutboundChannelAdapter` | Contenido tipado; capacidad `documents?` | Cambio de tipo interno del monorepo; adaptadores sin documentos siguen válidos |
| `ProviderStatusEvent` | `correlationRef?` | Aditivo |
| HTTP API | `GET /v1/outbound/:id` y listados muestran `contentKind` y metadatos del documento (nombre, SHA-256, longitud; nunca bytes). Nuevo `POST /v1/outbound/:id/release` (`handoff.manage`) | Aditivo |
| Telemetría | `outbound.document.{fetched,verification_failed,uploaded,send_started}` | Aditivo; sin bytes, destinatario, caption ni tokens |

## Cambios a live-ops

- `delivery.ts`:
  - origen `platform` (procedencia: artefacto) y `content_kind`;
  - rama de `decideDispatch` (§5);
  - holds `human_owned`, `binding_mismatch` y `document_source_unavailable` (fuente no registrada: el documento espera, no se pierde);
  - disposición por fase;
  - clases de error `document_*`, `media_rejected`, `channel_document_unsupported`.
- `outbound.ts`:
  - `materialize()` también materializa artefactos;
  - despacho por fases (§7);
  - aviso de falla.
- `document.ts` (nuevo): puerto `DocumentSource`, registro por `id` y verificación de integridad.
- `ports.ts`:
  - `DispatchClaim` es una unión texto/documento;
  - registro de fase y liberación por operador.
- `context-source.ts`: estados de artefactos.
- `operator.ts`: `release`.
- `channel.ts`: §7.

## Cambios de persistencia

Una migración Core aditiva, `0011_governed_artifact_delivery.sql`:

1. **`action_artifacts`** (inmutable):
   - claves: PK `artifact_id`; `receipt_id` único (FK); `execution_id`; `task_id`;
   - columnas del descriptor (§1).
2. **`policy_derived_decisions`** (inmutable):
   - PK `(decision_id, effect)`;
   - `outcome ∈ {allow, deny}`, `rule`, `reason_code`.
3. **`outbound_messages`**:
   - `origin` admite `platform`;
   - `content_kind ∈ {text, document}` con default `text`;
   - `artifact_id` (FK);
   - `notice_for` (FK a sí misma);
   - `released_by` y `released_at`.
   - CHECKs:
     - `platform` ⇔ `artifact_id` no nulo ∧ `response_step_id`, `run_id` y `body` nulos;
     - `document` ⇒ `platform` ∧ `notice_for` nulo;
     - texto `platform` ⇒ `notice_for` no nulo.
   - Trigger: `binding.task_id = task_id` al insertar.
4. **`outbound_delivery_attempts`**: columnas de fase de escritura única:
   - `document_fetch_outcome` y `document_verification`;
   - `media_ref` y `media_outcome`;
   - `send_started_at`.
5. **`channel_conversation_bindings`**: trigger que inmoviliza `task_id`, `channel`, `account_ref`, `recipient_ref` y `conversation_key`. Hoy ningún código los cambia; esto lo vuelve irrepresentable.

Sin backfill. Las filas históricas quedan con `content_kind = 'text'` y sin artefactos. 0001–0010 intactas. Sin migraciones Sales.

## Cambios al adaptador de canal (WhatsApp Cloud)

- `POST /{phone-number-id}/media` (multipart: `messaging_product`, `type`, `file`) ⇒ `{id}`.
- `POST /{phone-number-id}/messages` con `type: 'document'` y `document: {id, filename, caption}`, más el callback opaco.
- **Clasificación de la subida:**

  | Resultado | Clasificación |
  |---|---|
  | 2xx con id | `uploaded` |
  | 2xx sin id, 5xx, timeout o red | `not_sent` |
  | 429 | `not_sent` + `Retry-After` |
  | 400 (131053 y otros), 413 | `rejected` |
  | 401/403 | `rejected` |

- **El envío** usa la misma clasificación que el texto, con 131047 ⇒ `window_closed`.
- **Inbound:** el mapeo de estados lee el dato opaco.
- Límites que se declaran:
  - PDF ≤ 100 MB (Meta) ⇒ efectivo 20 MiB por §6;
  - caption ≤ 1024;
  - id de medio válido 30 días.
  - Fuente y fecha en el diseño §4.
- No hay `link`, plantillas ni credenciales de dominio.

## Seguridad del destinatario

- El destinatario no es un dato: es el `recipient_ref` del binding enlazado por FK.
- El binding se elige en la materialización a partir del `task_id` del recibo, que sale de la ejecución, no del modelo.
- Los campos de identidad del binding son inmutables (trigger). El outbound y el binding comparten `task_id` (trigger). La puerta re-verifica ambos y la cuenta del adaptador.
- La `DocumentSource` re-verifica que el documento pertenece a esa task en el owner.
- Un binding nuevo (task nueva) nunca hereda documentos de otro.
- El test de no filtración con dos conversaciones concurrentes es obligatorio, con mutaciones (diseño §11).

## Autorización y Policy Engine

Resumen de §2 y §5. La política decide **si** una escritura puede comunicar su artefacto (decisión inmutable, con hash). La puerta decide **cuándo** (estado actual). Ninguna regla interpreta contenido ni texto del cliente. La política productiva Sales necesitará una versión nueva con `derivedEffects` explícito; la decisión es del owner.

## Idempotencia

| Nivel | Mecanismo |
|---|---|
| Emisión | Sin cambio (ADR-018; clave de ejecución) |
| Artefacto | Uno por recibo, en su transacción |
| Obligación | Clave lógica `r4-doc:` única; materialización idempotente |
| Aviso | `r4-doc-notice:<outboundId>` único |
| Subida | Reintentable (no visible) |
| Envío | Un intento sin evidencia de no-envío; `unknown` nunca se reintenta |
| Evidencia del proveedor | `UNIQUE(channel, event_key)`; monótona (ADR-029 §9) |

## Manejo de fallos y reconciliación

Los diez puntos de interrupción del mandato, con estado durable y comportamiento, están en el diseño §8. Resumen:

1. **Pérdida de respuesta del owner y reconciliación de una emisión ya aplicada.** El recibo y el artefacto nacen juntos cuando se establece `applied`, en ejecución o en reconciliación.
2. **Caída tras el recibo.** La obligación ya es durable.
3. **Fallas antes del envío.** Se reintentan.
4. **Envío incierto.** Queda `unknown`, sin reenvío; se resuelve por evidencia (incluido el callback opaco) o por un operador.
5. **Reinicio del gateway.** Barrido por fase.
6. **Fin del run.** No afecta: la entrega no depende del run.

## Compatibilidad histórica

- `quote.create@2–@5`, perfiles `sales-production@1–@7`, definiciones `sales@1–@7` y sus huellas: **sin cambio**.
  - Ninguna capability existente declara efectos derivados.
  - Ninguna política existente cambia de hash.
- El texto (`agent`, `operator`) conserva su puerta, sus estados y sus claves.
- El adaptador envía texto exactamente igual, salvo el callback opaco. Su inclusión para el texto queda a decisión del owner (diseño §15).
- Las decisiones históricas conservan `engineVersion = r4.policy-engine.v1`.

## Migraciones requeridas

- `0011_governed_artifact_delivery.sql` (Core): aditiva y hacia adelante.
- Ninguna migración Sales.
- Ninguna migración en Quote V2. Quote V2 no cambia: usa `GET /v2/quotes/{id}` y `GET /v2/quotes/{id}/document`, existentes.
- Dependencia operacional del owner de Quote V2: un principal de solo lectura (`quotes:read` y `quotes:document:read`) para el gateway (diseño §6.3).

## Impacto sobre otros agentes

- **Ninguno sin opt-in:** un agente adopta esto solo si una capability suya declara el efecto y su política lo permite.
- `platform-probe` no cambia.
- Un segundo vertical (PRD R4-K) puede entregar un artefacto propio (por ejemplo un informe PDF de una escritura gobernada) registrando su `DocumentSource`, sin tocar Core.
- Core no contiene "quote".

## Tests

Son obligatorios por capa (detalle y mutaciones en el diseño §11 y en el plan):
- **Unit:** política derivada, incluida la estabilidad de hashes fijados.
- **Unit:** tabla de la puerta.
- **Unit:** disposición por fase.
- **Unit:** verificación de integridad.
- **Unit:** clasificación del adaptador.
- **Unit:** golden de los textos del pack.
- **Contract:** sin imports de dominio en Core.
- **Contract:** el adaptador sin credenciales de dominio.
- **Contract:** protocolo del modelo sin cambio.
- **Integración PostgreSQL:** los diez puntos de interrupción.
- **Integración PostgreSQL:** la matriz D3.
- **Integración PostgreSQL:** no filtración.
- **Integración PostgreSQL:** materialización concurrente.
- **Integración PostgreSQL:** evidencia duplicada y desordenada.
- **Recovery:** SIGKILL real del gateway durante la subida y durante el envío.
- **E2E:** canal sintético con captura de documento.
- **Barrido:** sin bytes de PDF en logs ni en la base.

## Rollout y rollback

**Rollout:**
1. Código de las slices A y B fusionado e **inerte**: ninguna capability declara el efecto. La regresión completa prueba que el comportamiento no cambia.
2. Migración `0011` en la base del canary.
3. Perfil Sales nuevo en el canary con canal sintético y captura.
4. Canary EC2 aislado con Quote V2 real.
5. **J7:** número dedicado de WhatsApp con allowlist.

**Desactivación inmediata:**
- El kill switch (global o de canal) retiene los documentos pendientes, sin perderlos.
- Volver al perfil anterior deja de crear obligaciones nuevas.

**Rollback de código del gateway por debajo de la slice B:** antes, no debe quedar ningún outbound `platform` en `pending` ni `dispatching`. Se cancelan por el operador o se dejan terminar. El código anterior no sabe despachar documentos. La migración no se revierte (aditiva).

## Consecuencias

- La entrega del documento deja de depender del modelo y de la vida del run. Si el run vence o la reconciliación aplica la emisión fuera de un run, el cliente igual recibe el documento con su caption. Esto mitiga ADR-037 L4, pero no L2 ni L3.
- Un `unknown` del envío puede dejar al cliente sin confirmación hasta la evidencia o un operador. Se prefiere a un duplicado.
- Los textos de emisión que llegan como autoridad al cliente los escribe el pack. El texto libre del agente posterior a la emisión sigue siendo del modelo (ADR-031, R4-J1E-R2.2). Se mide post-hoc y ya no lleva las cifras de autoridad.

## Pendiente de decisión del owner

Diseño §15:
- OD-1: aceptar el modelo de efectos derivados (`allow|deny`).
- OD-2: principal de lectura de Quote V2 para el gateway.
- OD-3: callback opaco también para el texto.
- OD-4: retención por handoff.
- OD-5: entrega con la task `failed`.
- OD-6: textos del caption y del aviso.
- OD-7: clasificación del aviso de emisión pendiente.
- OD-8: numeración de `quote.create` frente a ADR-036.
- OD-9: sonda real de Meta en J3F-D o en J7.
- OD-10: residuo de GAP-03.
