# R4-J3F — Plan de implementación por slices

| | |
|---|---|
| **Fecha** | 2026-10-14 |
| **Rama de diseño** | `r4-j3f-document-delivery-design` |
| **Estado** | **DEFERRED** (decisión del owner, 2026-10-14; `J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA`). Ningún slice está autorizado. Al retomarlo en **R4 Media & Communications**, las slices se re-planifican como fases de esa iniciativa: cada una requiere autorización explícita del owner, y A y B además autorización de cambio de harness. Las dependencias de J3 de este plan (GAP-02, cierre de J3) quedan sin efecto: J3 se cierra sin J3F |
| **Decisión** | [ADR-038](../adr/ADR-038-governed-document-outbound.md) (propuesto) |
| **Diseño** | [R4_J3F_DOCUMENT_DELIVERY_DESIGN.md](R4_J3F_DOCUMENT_DELIVERY_DESIGN.md) |

Los identificadores de tests (T-…, C-…, M…) y de criterios (AC-…) remiten al diseño §11 y §12.

## 1. Secuencia corregida

Los nombres provisionales del mandato se conservan. La auditoría obliga a cuatro correcciones:

1. **Una sola migración, en A.** `0011_governed_artifact_delivery.sql` incluye también las columnas de fase que usa B. Un único paso de esquema por despliegue. Se puede enmendar mientras no esté aplicada en ninguna base compartida.
2. **C no puede partir de código sin fusionar.** `quote.create@6` extiende `@5` (con GAP-16), que hoy solo existe en la rama J3E-C1. Por eso C empieza después del merge de J3E-C1 en `main`. A y B no dependen de Sales y pueden empezar desde `main` ya.
3. **GAP-02 (canary de `@7`) es prerrequisito de D**, y conviene que lo sea también de C. J3F se apoya en una emisión validada contra el owner real.
4. **El acuse de emisión pendiente no entra en J3F.** Requiere su propio slice y ADR (diseño §9.4; OD-7).

```text
J3E-C1 revisión + merge ──────────────┐
                                      ├─► J3F-C ─► J3F-D ─► J3 CLOSED
main ─► J3F-A ─► J3F-B ───────────────┘             ▲
        (en paralelo) canary EC2 @7 (GAP-02) ───────┘
```

**Opción de revisión:** si A resulta grande, se parte en dos:
- A1: contratos, política y artefacto (`contracts`, `capability-runtime`, `policy-engine`, `task-runtime`, migración);
- A2: outbox y puerta (`live-ops`, `persistence-postgres`, API).

A1 se fusiona primero.

## 2. J3F-A — Contrato del artefacto, autorización derivada y outbox

**Objetivo.**
- Una escritura que declara un artefacto produce, en la transacción de su recibo, un registro inmutable autorizado por la política.
- El dueño de la entrega lo materializa como una obligación idempotente y le aplica la puerta.
- **Nada se despacha todavía**: sin fuentes registradas, los documentos quedan en hold `document_source_unavailable`.
- **Inerte** para todos los perfiles existentes.

**Base:** `main`.

### Archivos

| Archivo | Cambio |
|---|---|
| `packages/contracts/src/capability.ts` | `derivedEffects?` en `CapabilityDefinition`. Refinamientos: prohibido en `READ`; requiere `writeRecovery`; máximo uno |
| `packages/contracts/src/action.ts` | `governedArtifactSchema` (descriptor, ADR-038 §1). `PolicyDecision.derivedEffects`. `PolicyInput.capability.derivedEffects`. `ActionAttemptReport.artifact?` |
| `packages/contracts/src/index.ts` | Exportaciones |
| `packages/capability-runtime/src/registry.ts` | `WriteExecutionResult.applied.artifact?`. `registerWrite` verifica que declaración y handler sean coherentes |
| `packages/capability-runtime/src/action-executor.ts` | `classify`: si la capability declaró el efecto y el artefacto falta o es inválido ⇒ `unknown`. Si trae artefacto sin haberlo declarado ⇒ `unknown` |
| `packages/policy-engine/src/configuration.ts` | `derivedEffects?` opcional **sin default**. `POLICY_ENGINE_VERSION = 'r4.policy-engine.v2'` |
| `packages/policy-engine/src/engine.ts` | Evaluación del efecto derivado solo tras un `allow` (`derived_allowed`, `derived_denied`, `derived_not_configured`) |
| `packages/task-runtime/src/action-runtime.ts`, `ports.ts` | `authorizeAction` persiste `policy_derived_decisions` en su transacción. `settleWithin` inserta `action_artifacts` junto al recibo `succeeded` y agrega `artifact` a la observation |
| `packages/persistence-postgres/migrations/0011_governed_artifact_delivery.sql` | **Nueva** (ver Migración) |
| `packages/persistence-postgres/src/action-store.ts`, `rows.ts` | Inserción y lectura del artefacto y de las decisiones derivadas |
| `packages/persistence-postgres/src/production-store.ts` | `materializeArtifactDeliveries`: anti-join por clave lógica; `integrity = mismatch` ⇒ `failed` + aviso. El claim se ramifica por `content_kind`. Hechos de la puerta para `platform`: handoff, integridad del binding, liberación. `releaseOutbound`. `outboundForTask` y las listas de atención incluyen `platform`. Helper transaccional del aviso de falla |
| `packages/live-ops/src/delivery.ts` | `OUTBOUND_ORIGINS += 'platform'`, `content_kind`, rama `platform` de `decideDispatch` (diseño §7). Holds `human_owned`, `binding_mismatch`, `document_source_unavailable` |
| `packages/live-ops/src/ports.ts` | `DispatchClaim` como unión texto/documento; métodos nuevos de `ProductionStore` |
| `packages/live-ops/src/outbound.ts` | `materialize()` también materializa artefactos. Un claim documental sin fuente registrada ⇒ hold |
| `packages/live-ops/src/context-source.ts` | Documentos `platform` en todos sus estados, con el vocabulario del diseño §9.2 |
| `packages/live-ops/src/operator.ts`, `apps/api/src/app.ts` | `POST /v1/outbound/:id/release` (`handoff.manage`, `TrustedHumanContext`). Las vistas exponen `contentKind` y los metadatos del documento, sin bytes |
| `tests/support/*` | Capability de escritura de prueba que declara el efecto (sin dominio real) |

### Contratos que congela

- Esquema del descriptor.
- `derivedEffects` en la capability y en la política.
- Origen `platform` y `content_kind`.
- Clave lógica `r4-doc:`.
- Precedencia de la puerta `platform`.
- Vocabulario de estados.
- Payload aditivo de la observation.

### Migración `0011_governed_artifact_delivery.sql` (Core, aditiva, hacia adelante)

- **`action_artifacts`:**
  - claves: PK; `receipt_id` único (FK `action_receipts`); `execution_id` (FK); `task_id`;
  - columnas del descriptor con CHECKs: MIME, longitud `1..20971520`, hex64, regex del nombre, `length(caption|notice) ≤ 1024`, `integrity`;
  - inmutable (`action_ledger_immutable`).
- **`policy_derived_decisions`:**
  - PK `(decision_id, effect)`, FK `policy_decisions`;
  - CHECKs de `effect` y `outcome ∈ {allow, deny}`;
  - inmutable.
- **`outbound_messages`:**
  - `origin` admite `platform`;
  - `content_kind text not null default 'text'`;
  - `artifact_id` (FK); `notice_for` (FK a sí misma); `released_by`, `released_at`.
  - CHECKs (ADR-038, "Cambios de persistencia").
  - Trigger: `binding.task_id = new.task_id`.
  - Índice parcial para la materialización.
- **`outbound_delivery_attempts`:** `document_fetch_outcome`, `document_verification`, `media_ref`, `media_outcome`, `send_started_at`. Se escriben una sola vez (trigger) y se usan en B.
- **`channel_conversation_bindings`:** trigger de inmutabilidad de `task_id`, `channel`, `account_ref`, `recipient_ref` y `conversation_key`.
- **Lo que no hace:** backfill, cambios a 0001–0010 ni migraciones Sales.

### Compatibilidad

- Ninguna capability ni política existente declara efectos: 0 cambios de comportamiento.
- Los hashes fijados no cambian: `canonicalJson` omite `undefined`.
- El nuevo `engineVersion` se registra solo en decisiones nuevas. Los tests que fijan `r4.policy-engine.v1` como constante se actualizan; cambio autorizado y listado.
- El texto `agent` y `operator` es idéntico.

### Tests obligatorios

- T-POL.
- C-HASH.
- T-GATE.
- T-MAT.
- T-D3-1…11, a nivel de store y runtime con la capability de prueba.
- T-INT-1, T-INT-2 y T-INT-3, con la capability de prueba y un owner falso: recibo + artefacto atómicos; caída inyectada entre el recibo y la materialización.
- T-NOT, en el camino de materialización `mismatch`.
- Tests de migración: UPDATE y DELETE rechazados sobre las tablas nuevas; CHECKs; inmutabilidad del binding; trigger de `task_id`.
- C-CORE.
- C-PROTO.
- C-FP.
- Regresión completa.

**Mutación mínima:** si se quita el artefacto de `settleWithin`, T-INT-3 debe fallar.

### Criterio de salida

- Todo lo anterior en verde.
- `git diff` sin cambios en `agents/` ni en `adapters/`.
- Revisión del owner.

## 3. J3F-B — Fuente de documentos, verificación y adaptador WhatsApp

**Objetivo.**
- Despachar documentos por fases, con la verificación de integridad de la plataforma antes de salir.
- Subida y envío por WhatsApp, y correlación por callback opaco.
- **Inerte en producción:** ningún perfil compone fuentes.

**Base:** A fusionada.

### Archivos

| Archivo | Cambio |
|---|---|
| `packages/live-ops/src/document.ts` | **Nuevo.** Puerto `DocumentSource`, registro por `id`, `verifyDocument`: SHA-256, longitud, `%PDF-`, cabecera declarada, `maxBytes = min(20 MiB, límite del adaptador)` |
| `packages/live-ops/src/channel.ts` | `OutboundSubmission` con contenido tipado. Capacidad opcional `documents { maxBytes, mimeTypes, captionMax, uploadDocument }`. `ProviderStatusEvent.correlationRef?` |
| `packages/live-ops/src/outbound.ts` | `dispatchDocument`: claim → fetch → verify → registrar fase → upload → registrar `media_ref` + `send_started_at` → send → registrar. Aviso de falla en la transacción de `failed` |
| `packages/live-ops/src/delivery.ts` | Disposición por fase: antes del envío ⇒ `pending` hasta el plazo; envío ⇒ semántica de ADR-029. Clases de error `document_*`, `media_rejected`, `channel_document_unsupported` |
| `packages/live-ops/src/mode.ts` | `R4_PROD_DOCUMENT_PRESEND_DEADLINE_MS` (default propuesto 3 600 000). Validación: lease > mayor timeout de fase |
| `packages/persistence-postgres/src/production-store.ts` | `recordDocumentPhase`, con fencing y renovación del lease. Barrido por `send_started_at` (antes ⇒ `pending`, después ⇒ `unknown`). `applyProviderStatus` con `correlationRef`: solo filas `dispatching` o `unknown` del mismo canal e intento |
| `adapters/channels/whatsapp-cloud/src/outbound.ts` | `uploadDocument` (multipart nativo) y el mensaje `type: 'document'` con `{id, filename, caption}`. `biz_opaque_callback_data = r4o:<outboundId>:<attempt>`. Clasificación del diseño §5.4 |
| `adapters/channels/whatsapp-cloud/src/config.ts` | Límites declarados (PDF 100 MB, caption 1024), con fuente y fecha |
| `adapters/channels/whatsapp-cloud/src/inbound.ts` | Leer `biz_opaque_callback_data` en `statuses` |
| `adapters/channels/whatsapp-cloud/src/testing.ts` | El proveedor falso acepta `/media` y `type: document`, emite estados con el dato opaco e inyecta fallas por fase. Registra el SHA, nunca los bytes |
| `apps/channel-gateway/src/platform.ts` | `GatewayBindings.documentSources` (opcional) |
| `tests/recovery/*` | SIGKILL real del gateway |

### Contratos que congela

- Interfaz `DocumentSource`.
- Capacidad `documents` del adaptador.
- Fases y su semántica de reintento.
- Formato del dato opaco.

**Migración:** ninguna (está en `0011`).

### Compatibilidad

- Texto: mismo cuerpo, más el dato opaco (si OD-3 = sí; si no, solo en documentos).
- Clasificación del texto sin cambios.
- Adaptadores sin `documents` siguen válidos.

### Tests obligatorios

- T-VER.
- T-DISP.
- T-WA.
- T-INT-4…8 y T-INT-6b (falsificación del dato opaco).
- T-NOT, por todos los caminos a `failed`.
- T-REC-1/2.
- C-ISO.
- T-PRIV, sobre los bytes reales del PDF de prueba.

**Mutaciones obligatorias:**
- M4: quitar la verificación del SHA.
- M5: reintentar un `unknown`.

### Criterio de salida

- Todo en verde.
- `git diff` sin cambios en `agents/`.
- Revisión del owner.

## 4. J3F-C — Integración Sales, mensajes deterministas y E2E

**Objetivo.**
- Sales declara el documento de la cotización, aporta la fuente `quote-v2` y los textos deterministas.
- Un perfil nuevo lo activa.
- Pruebas de punta a punta en el ciclo de vida real.

**Base:** `main` con J3E-C1 fusionada, más A y B. Conviene tener GAP-02 cerrado.

### Archivos

| Archivo | Cambio |
|---|---|
| `agents/sales/src/capabilities/quote-v6.ts` | **Nuevo** (número según OD-8). `@5` + `derivedEffects` + descriptor en `execute` y en `reconcile`. Misma clave, reconciliación y retención de GAP-16. `@2–@5` intactas |
| `agents/sales/src/capabilities/issued-document.ts` | **Nuevo.** Función pura `documentArtifactOf(issued)`: mapeo del diseño §5.2. **No modifica `settle`** |
| `agents/sales/src/capabilities/issued-presentation.ts` | **Nuevo.** Plantillas `r4-sales-issued-es-v1` (caption) y `r4-sales-document-failed-es-v1` (aviso), puras, sin aritmética |
| `agents/sales/src/production/document-source.ts` | **Nuevo.** `DocumentSource` `quote-v2`: `getQuote` (estado `issued`, `externalReference = taskId`, manifiesto) + `getDocument`; errores según el diseño §6.5 |
| `agents/sales/src/production/profile-v8.ts` | **Nuevo.** `sales-production@8` = `@7` + `quote.create@6` + `sales-production-autonomous-policy@2` (`derivedEffects: { 'quote.create': { artifact_delivery: 'allow' } }`) + definición v8. Se retira la nota "no PDF to the channel" solo en `@8` |
| `agents/sales/sales.v8.agent.json` | **Nuevo.** Quita "cannot share its document". Indica que el documento oficial llega automáticamente; no repetir cifras; usar el vocabulario de estados. Corrige la mención a `customer.get_context` (GAP-15) |
| `agents/sales/src/production/composition.ts` | Worker: registra `quote.create@6` en `@8`. Gateway: compone `quote-v2` con el token de solo lectura. Sin él, `@8` no arranca (fail-closed) |
| `adapters/domains/quote/http/src/config.ts` | Lectura de `R4_QUOTE_DOCUMENT_BEARER_TOKEN` para la composición del gateway (mismas validaciones) |
| `agents/sales/src/production/{control,bootstrap,index}.ts`, `definition.ts` | Registro de v8 y `@8` |
| `agents/sales/src/cli/canary/{channel,runtime}.ts` | `CaptureOutboundAdapter` con `documents`. Registra SHA, longitud, nombre, hash del caption y destinatario; **nunca los bytes** |
| `scripts/experiments/j3f-document-delivery/` | `run.mjs`, `analyze.mjs`, `README.md` (métricas del diseño §11.4) |

### Contratos que congela

- Plantillas Sales (golden).
- Mapeo del descriptor.
- Política `@2` (hash nuevo y fijado).
- Huella de `@8`.

**Migración:** ninguna (ni Sales ni Core).

### Compatibilidad

- `@1–@7`, `quote.create@2–@5`, `sales@1–@7` y la política `@1` no cambian (C-FP y C-HASH).
- La producción sigue en `@3`.

### Tests obligatorios

- T-TPL.
- C-SALES.
- C-FP.
- T-LEAK, con M1–M3 detectadas.
- T-E2E en el ciclo de vida real (ingress sintético, worker, kernel, ActionRuntime, ActionExecutor, scheduler, gateway con captura). Escenarios:
  - emisión normal;
  - respuesta perdida;
  - owner no disponible y luego disponible (GAP-16);
  - run vencido (T-INT-9);
  - `mismatch` del fixture ⇒ 0 capturas;
  - D3-1, D3-3, D3-4 y D3-12 con conversación real del pack.
- T-PRIV de punta a punta.

**Mutación:** si se quita la verificación de correspondencia en `quote-v2`, falla T-LEAK.

### Criterio de salida

- Todo en verde.
- Regresión completa.
- Revisión del owner.

## 5. J3F-D — Aceptación funcional final, canary aislado y cierre de J3

**Objetivo.** Demostrar AC-1…AC-12 con evidencia etiquetada y decidir el estado de J3.

**Base:** C fusionada. GAP-02 cerrado.

| Paso | Contenido | Autorización requerida |
|---|---|---|
| 1 | Regresión completa (build, lint, typecheck, unit, contract, integration, sales, shadow, recovery). **No correr experimentos en paralelo con `test:recovery`**: cierra las conexiones de la base | — |
| 2 | Experimento con el modelo real (owners fixture), N conversaciones. Umbrales de AC-9 **congelados antes de correr**. Costo estimado y tope declarados | Owner (costo) |
| 3 | Canary EC2 aislado: base aislada, `0011` solo ahí, perfil `@8`, canal sintético con captura, **1** cotización real de Quote V2, principal de solo lectura. Verificar AC-12 y producción intacta (`@3`) | Owner + acceso EC2 legítimo |
| 4 | (Opcional, OD-9) Sonda de Meta: 1 subida + 1 documento sintético a un número **interno** allowlisted. Verificar el dato opaco en `sent`/`delivered`/`failed`, el nombre y el caption | Owner, explícita |
| 5 | Documentación: informe `R4-J3F_ACCEPTANCE_REPORT.md`. Actualizar `R4_J3_FINAL_ACCEPTANCE.md` (estado, S10, líneas obsoletas sobre ADR-037 y GAP-16) y el registro de brechas (GAP-01 y GAP-03). El estado de ADR-038 lo decide el owner | — |

**Criterio de salida:** AC-1…AC-12 cumplidos ⇒ J3 **CLOSED**. AC-13 queda para J7.

## 6. Lo que este plan no hace

- No implementa nada en esta rama.
- No modifica el harness, Sales ni Quote V2 hasta autorizar cada slice.
- No despliega ni aplica migraciones en bases compartidas o productivas.
- No incluye:
  - acuse de emisión pendiente (slice y ADR propios);
  - reenvío por un operador;
  - plantillas fuera de la ventana;
  - email;
  - otros tipos de documento;
  - aprobación humana de entregas.
- No cambia la semántica de `respond` (ADR-031, R4-J1E-R2.2) ni el protocolo de decisión del modelo.

## 7. Riesgos de implementación y cómo se acotan

| Riesgo | Acotación |
|---|---|
| A demasiado grande para revisar | Partir en A1/A2 (§1) |
| Romper hashes fijados al tocar la configuración de la política | C-HASH es lo primero que se escribe en A |
| Tests de integración inestables por contención de CPU (observado en J3) | Re-ejecución aislada de los fallos y registro honesto (patrón de la aceptación J3 §14.5) |
| El lease del gateway no cubre una subida grande | La validación de composición (lease > timeouts de fase) y la renovación por fase. Perilla de calibración si una medición lo exige |
| Discrepancia entre el fixture de Quote V2 (409) y el owner (404) en `document_not_available` | La fuente trata ambos igual (diseño §6.5) |
| Colisión de versión `quote.create@6` con ADR-036 | OD-8, antes de empezar C |
