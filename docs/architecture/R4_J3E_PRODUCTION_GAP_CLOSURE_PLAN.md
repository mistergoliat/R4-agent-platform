# R4-J3E — Plan de cierre de brechas para producción

Fecha: 2026-10-14 · Rama: `r4-j3e-c-deterministic-commercial-offer` (desde `main` `092715e`) · Tipo: **auditoría read-only y propuesta**. No hay código, migraciones, commits, canaries ni accesos a EC2.

Documento hermano: `R4-J3E_C_DETERMINISTIC_OFFER_ARCHITECTURE.md` (Fases 0 y 1: integridad de la oferta). Este documento cubre la procedencia (Fase 2), la robustez y el rendimiento (Fase 3), los riesgos de producción (Fase 4) y la propuesta de implementación consolidada (§8).

Etiquetas de evidencia:
- **SOURCE**: verificado en el código de `092715e`.
- **DOC**: afirmado en un informe o ADR.
- **LOCAL-ARTIFACT**: archivos ignorados por git en esta estación (`artifacts/`).
- **EXTERNAL**: documentación del proveedor.
- **HIPÓTESIS**: no verificado; requiere experimento.

```
R4_J3EC_PROVENANCE=GAP_CONFIRMED          actor persistido pero no expuesto; sourceRef falsificable vía API; orden con dos relojes
R4_J3EC_PROVENANCE_MIGRATION_REQUIRED=NO
R4_J3EC_JSON_MODE=ALREADY_ON_BY_DEFAULT   json_object por defecto; thinking habilitado en el perfil DeepSeek fijado por test
R4_J3EC_BASELINE=DEFINED_NOT_MEASURED     los datos de los canaries están solo en EC2
R4_J3EC_NEW_BLOCKERS=3                    el kill switch no frena escrituras Quote V2 en curso; un rollback deja reconciliaciones sin handler; handoff sin operadores
R4_J3EC_RECOMMENDED_NEXT=J3E-C1           solo Sales, sin harness, sin migración (§8)
```

> **Actualización 2026-10-14 (R4-J3E-C1 implementado, sin commit; ver `R4-J3E_C1_IMPLEMENTATION_REPORT.md`).**
> - **B1 y B3 cerrados en código para `@7`:**
>   - oferta exacta;
>   - liquidación estricta;
>   - guard del kill switch sobre `createAndIssue`.
> - **Verificado en EC2 (solo lectura):** los dos canaries corrieron con `R4_MODEL_RESPONSE_FORMAT` sin definir, que por defecto es `json_object`, con `thinking` habilitado y sin límite de salida. La "probabilidad" de §3.1 queda confirmada.
> - **Hallazgo nuevo (harness, no modificado):** `guardProductionWrites` devuelve los métodos de lectura sin `bind`. Aplicado directamente sobre `QuoteV2HttpClient`, que usa campos `#private`, rompe todas las lecturas. Sales lo evita con un adaptador de funciones planas.
> - **ADR-036** redactado (propuesto, no implementado): `docs/adr/ADR-036-contractual-input-provenance.md`.
> - **Línea base medida** (EC2, solo lectura; §3.4 pasos 1–2 hechos para los canaries):
>   - J3E-A: 34 llamadas, 1 fallo de formato;
>   - J3E-B: 31 llamadas, 2 fallos;
>   - los 3 fallos ocurrieron en el paso de oferta, 3 de las 8 llamadas que la redactaban.
> - **Experimento local con el modelo real** (`@7`, configuración productiva sin cambios): 108/108 copias exactas del mensaje de oferta y 0/108 fallos JSON.
>   - No es un experimento controlado; ver el informe §8 y §10.
>   - El control `@6` frente a `@7` en el mismo arnés queda disponible (41 llamadas de presupuesto restantes) con autorización.

## 1. Resumen

| # | Bloqueo para emisión autónoma en producción | Estado | Cierre propuesto | Tipo |
|---|---|---|---|---|
| B1 | Integridad de la oferta confirmada | Solo referencia y total (D1–D4 del documento hermano) | J3E-C1: mensaje de oferta renderizado por Sales e igualdad exacta | Sales |
| B2 | Procedencia contractual de la confirmación | Depende de la topología; además, el orden compara dos relojes distintos (§2.3) | J3E-C2: ADR-036 + cambio pequeño de harness, o aceptación explícita del gate por el owner | Harness + owner |
| B3 | **Nuevo.** El kill switch no impide llamar a Quote V2 desde un run en curso ni desde una reconciliación | `guardProductionWrites` existe y no se usa (§4, R8) | J3E-C1: envolver `createAndIssue` | Sales |
| B4 | Límites de producción | Solo valores de canary | Decisión del owner | Owner |
| B5 | **Nuevo.** Rollback compatible | Un cambio de perfil deja ejecuciones `quote.create@N` sin handler de reconciliación (§4, R9) | Runbook de drenaje, ensayado en canary | Operación |
| B6 | Robustez del formato y handoff | 3 fallos en 65 llamadas de canary; el segundo fallo consecutivo termina en handoff, y no hay operadores OIDC | Línea base (§3.4) y un handoff con personal | Medición + operación |
| B7 | Observabilidad mínima | `finishReason` solo en logs; ninguna métrica de decisiones autónomas | J3E-C3 | Sales + harness pequeño |
| — | Entrega del PDF | Fuera del alcance de la emisión | Hito siguiente (§4, R10) | — |

## 2. Fase 2 — Procedencia contractual

### 2.1 Estado actual (SOURCE)

**`ThreadEntry`** (`packages/live-ops/src/ports.ts:229-237`): `refs` es `Record<string, string | null>`, sin tipo por clase. Valores por clase (`packages/persistence-postgres/src/production-store.ts`):

| Clase | `refs` | Fuente SQL |
|---|---|---|
| `contact` | `{inputId}` | `task_inputs ⋈ memory_entries`, **todas** las filas de la tarea, sin filtro (`:554-555`) |
| `agent` | `{stepId, runId}` | pasos `respond` registrados ⟕ `outbound_messages` (`:556-563`) |
| `operator` | `{humanRef}` | `outbound_messages` con origen `operator` (`:565-566`) |
| `event` | `{type, actorRef, initiatedBy, reason}` | `temporal_events` de handoff y cancelación (`:567-575`) |

**Lo que ya está persistido y no se expone.** `task_inputs` (`migrations/0005_temporal_human_runtime.sql:145-158`) tiene `source_ref`, `actor_kind` y `actor_ref`, todos `not null`, inmutables (trigger) y sin `CHECK` de valores. Existe un solo `INSERT` (`temporal-store.ts:182-187`), alcanzado solo por `submitInput` y `createTaskWithInput` (`temporal-runtime.ts:346-381`, `:408`).

**Exponer el actor no requiere migración ni backfill.**

**Productores de inputs**

| Productor | `sourceRef` | Actor | ¿Autenticado? |
|---|---|---|---|
| `ChannelIngress.receive` (gateway) | `channel:<canal>` (`ingress.ts:209`); en WhatsApp `channel:whatsapp` | `user` / `<canal>:<conversationKey[0..32]>` (`:211`) | Sí: firma HMAC y filtro de `phone_number_id` (`whatsapp-cloud/src/inbound.ts:51-58`, `:80-83`) |
| `ChannelIngress.ingest` invocado directamente | igual | igual | **No**: método público que omite `authenticate` (`ingress.ts:136-162`). Hoy solo lo usa el canary. |
| Canary Sales (`sendSynthetic`) | `channel:r4-synthetic` | `user` / `r4-synthetic:…` | No (CLI del operador contra la base del canary) |
| API `POST /v1/tasks/:id/inputs` | **Elegido por quien llama**, sin restricción (`apps/api/src/app.ts:167-174`) | Siempre del `resolvePrincipal`, nunca del cuerpo; por defecto `unauthenticated/anonymous` (`apps/api/src/principal.ts:8-17`) | No. La ruta no exige `humanContext` ni verifica si la tarea está ligada a un canal. |
| Harness y shadow Sales | `harness`, `shadow`, … | `user` o `unauthenticated` | En proceso |

No crean inputs: los operadores (crean outbound `operator`, `live-ops/src/operator.ts:72-88`), las aprobaciones y respuestas humanas (`temporal_events`), el scheduler, los timers y el modelo.

**Consumidores de `thread()`:**
- `live-ops/src/operator.ts:37-56`;
- `GET /v1/tasks/:id/thread` (`app.ts:252-258`, con `humanContext`);
- `quote.create@4` (`quote-v4.ts:151`, mediante un tipo estructural propio).

Hay un solo implementador (`PostgresProductionStore`); los dobles de test son casts. **Ningún test fija `refs` exactamente**, así que agregar claves no rompe nada.

### 2.2 Debilidades confirmadas

| # | Debilidad | Evidencia | Riesgo |
|---|---|---|---|
| P1 | `thread()` no expone actor ni `sourceRef` (el gap documentado en ADR-035). | `production-store.ts:554-555` | Un input de API es indistinguible de uno del cliente. |
| P2 | **`sourceRef` es falsificable por la API**: `channel:whatsapp` se acepta. Exponerlo sin restringirlo no prueba nada. | `app.ts:171`; `contracts/src/temporal.ts:93` (string libre) | Alto si la API corre contra producción. |
| P3 | **El orden compara dos relojes.** `contact.at` = `received_at` del reloj de la base (`r4_now()` = `clock_timestamp()`, `temporal-runtime.ts:387`; `0005:10`). `agent.at` = `created_at` del paso, tomado del **reloj de la aplicación del worker** (`execution-runtime.ts:441`; `apps/worker/src/platform.ts:93`). | Contradice ADR-035:20 y J3E-B §1:61 ("mismo reloj") | Bajo en la práctica (§2.3); defecto contractual. |
| P4 | La ruta de inputs de la API no tiene autorización ni chequeo de binding. Si la API corre, un input inyectado produce una respuesta que se entrega al cliente real. | `app.ts:167-174`; `ports.ts:316-322` | Solo lo mitiga que la API no corra (gate), y eso **no está verificado** en el host. |
| P5 | Idempotencia compartida `(task, source_ref, external_key)` entre API e ingress: una pre-carga por API con el id de proveedor correcto bloquea el mensaje real (`idempotency_key_reused`). | `temporal-runtime.ts:389-391`; `ingress.ts:251-254` | Requiere adivinar el id; bajo. |
| P6 | Los placeholders de contenido no soportado (`[unsupported inbound content: …]`) son entradas `contact` con actor `user`. | `ingress.ts:51-54`, `:139` | La gramática los rechaza; "texto de contact = palabras del cliente" no es estrictamente cierto. |
| P7 | El contexto de la capacidad no trae el canal del binding; `execution.actor` es el principal de servicio del ingress. | `action-runtime.ts:296-297`; `composition.ts:201` | Para comparar `sourceRef` hay que leer `bindingByTask` (ya existe en el puerto). |

Correctos tal como están:
- dedupe de inbound `unique(channel, provider_event_id)`;
- un binding abierto por conversación y uno por tarea (`0007:66-67`, `:99`);
- `attachTask` no reasigna (`production-store.ts:194-198`);
- verificación de firma WhatsApp.

### 2.3 Impacto real de P3

Los casos de borde:
- Si el worker atrasa Δ respecto de la base, un mensaje del cliente recibido hasta Δ **antes** de registrar la oferta se ordena **después** de ella.
- Si ese mensaje no estaba en el contexto de la oferta, el gate de despacho cancela la oferta (`superseded_by_newer_input`, `production-store.ts:336-343`). `quote.create@4` la rechaza entonces por `offer_not_delivered`: **falla cerrado**.
- Si sí estaba en el contexto, la respuesta ya se consumió. `respond` termina el turno, así que hace falta un mensaje nuevo para que el modelo proponga, y ese mensaje pasa a ser el último `contact`.

Explotarlo es difícil. Si la base y el worker comparten host, la diferencia de reloj es mínima, pero eso **no está verificado** en EC2. Igual es un defecto de contrato: la regla "la confirmación es posterior a la oferta" no puede depender de dos relojes.

### 2.4 Extensión mínima propuesta (ADR-036, harness, **no implementada**)

| Cambio | Dónde | Detalle |
|---|---|---|
| **H1.** Exponer el origen del input | `production-store.ts:554-555`; JSDoc en `ports.ts:229-237` | `contact.refs = {inputId, actorKind, actorRef, sourceRef}`. Un `SELECT` más amplio. Aditivo: el tipo `refs` no cambia y `noUncheckedIndexedAccess` obliga a los consumidores a tratar la ausencia (falla cerrado). |
| **H2.** Reservar el espacio `channel:` para ChannelIngress | `app.ts:168-174` | La ruta rechaza (`422`) un `sourceRef` que empiece con `channel:`. No puede ir en `inputSubmissionSchema` porque el propio ingress lo usa (`ingress.ts:209`). Contradice el comentario "any channel adapter" (`app.ts:167`): requiere decisión explícita. |
| **H3.** Orden causal, sin relojes | `production-store.ts:556-563` | `agent.refs.contextFrontierInputId`: el último input que evaluó el contexto del paso, con la misma lógica de `context_snapshot_items` que ya usa `materializeResponses` (`:243-275`). Una oferta entregada más una confirmación **no vista** por su contexto implica que la confirmación llegó después del despacho, porque el gate habría cancelado la oferta en caso contrario. |
| H3' (alternativa) | `execution-runtime.ts:441` | Registrar `created_at` del paso con el reloj de la base. Cambia la semántica temporal de todos los pasos del Core: más amplio que H3. |

**Uso desde Sales** (`quote.create@6` y perfil nuevo, o dentro del perfil de C1 si se autoriza junto):
- ampliar el lector estructural a `Pick<ProductionStore, 'thread' | 'bindingByTask'>` (ambos existen; `options.store` ya los cumple);
- exigir que exista el binding, que `confirmation.refs.actorKind === 'user'` y que `confirmation.refs.sourceRef === 'channel:' + binding.channel`;
- rechazar (no filtrar) si algún `contact` posterior a la oferta viene de otro origen: `customer_confirmation_unverified_source`;
- exigir que la confirmación no esté en el contexto de la oferta (H3);
- comparar con `binding.channel`, **nunca** con `profile.channel.id`: en el canary el perfil declara `whatsapp` y los bindings son `r4-synthetic`, y `sales-confirmed-intent.test.ts:141` prohíbe el literal `whatsapp` en la capacidad.

| Aspecto | Evaluación |
|---|---|
| Compatibilidad | H1 y H3 son aditivos: un implementador, sin cambio de tipos, nuevas claves en el JSON de `/v1/tasks/:id/thread` (la UI de operador del CRM es consumidora prevista, `OWNERSHIP_MATRIX.md:229`). H2 rechaza un valor antes aceptado; ningún test ni productor conocido usa `channel:` vía API. |
| Seguridad | Cierra P1, P2 y P3 frente a la API y frente al modelo. Queda el código en proceso (`ingest`, harness), con un nivel de confianza igual al de tener credenciales de la base. |
| Versionado | `live-ops` no tiene versión de puerto. La compatibilidad del worker es `coreSchemaHead:profile` (`worker-presence.ts:39-43`) y no cambia sin migración. Puerto y consumidor se despliegan en el mismo build (`cli/production.ts:243`). Lo que se versiona es Sales (capacidad, perfil, definición). |
| Migraciones | Ninguna. Un `CHECK` sobre `actor_kind` sería endurecimiento opcional y movería `coreSchemaHead`; no es necesario. |
| Tests | Integración Postgres (`live-ops-reference.test.ts`): `refs` de ingress frente a input de API en la misma tarea; `contextFrontierInputId` antes y después de un input nuevo. API (`temporal-api.test.ts`): `channel:whatsapp` → 422; `api-test` → 201. Contrato: claves de `refs` fijadas; solo `ingress.ts` construye `channel:` fuera de tests. Sales: matriz offline (origen ajeno, confirmación vista por la oferta, binding ausente) y canary E2E. |
| Gate | Con H1–H3 y su uso en Sales, `single-input-producer` deja de ser condición de corrección. Se mantiene "API no expuesta" como defensa en profundidad. |

## 3. Fase 3 — Robustez y rendimiento

### 3.1 Hechos (SOURCE)

- **Transporte.** Una decisión JSON en el texto del mensaje, sin tool calls (`agent-kernel/src/decision-parser.ts:33-34`). Tres mensajes por llamada (`openai-compatible/src/render.ts:17-24`):
  1. system: el protocolo (≈ 3,4 KB);
  2. system: la instrucción de salida y el JSON Schema (≈ 6,3 KB);
  3. user: el contexto completo en un solo JSON.
- **JSON mode.** `R4_MODEL_RESPONSE_FORMAT` vale `json_object` **por defecto** (`config.ts:70`), y el adaptador envía `response_format: {type: 'json_object'}` (`provider.ts:85`). `R4_MODEL_EXTRA_BODY` **no puede** fijar `response_format` (`config.ts:45`, `:58`). No existe modo `json_schema`.
- **Perfil DeepSeek fijado por test** (`tests/unit/sales/openai-compatible-provider.test.ts:163-181`, "pm2 env on the host"): `deepseek-flash`, `json_object`, `thinking: enabled`, sin `max_tokens`. Los canaries reportan ese mismo `providerId` (J3E-A §15.5). El env exacto del canary no está en el repositorio: **probable, no verificado**.
- **Parseo.**
  1. El adaptador recorta, quita un fence solo si envuelve todo el contenido y aplica `JSON.parse` (`render.ts:65-75`).
  2. El kernel reintenta `JSON.parse` y, si falla, devuelve `invalid_structured_output` (`decision-parser.ts:105-118`).
  - No hay reparación ni extracción.
  - **`finishReason` no se consulta**: un `length` y un `stop` con prosa producen el mismo error.
- **Registro de un fallo.**
  - En la base (`agent_run_steps`) quedan `outcome`, `error_code`, `error_message` y tokens.
  - **No quedan** `finishReason`, el texto, el largo, la clase de fallo ni `requestId`.
  - `model.call.completed` (`model-gateway/src/gateway.ts:113-122`) emite `finishReason`, tokens y latencia, **solo en logs pino** (`observability/src/telemetry.ts:3-9`).
- **Uso.** Solo `prompt_tokens` y `completion_tokens` (`provider.ts:25`). Se descartan `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `reasoning_tokens` y `requestId`.
- **Recuperación ADR-028.** Una sola recuperación por defecto (`execution-runtime.ts:71-72`; `R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`). El segundo fallo consecutivo deja la tarea `blocked` con handoff (`:636-650`), que es lo que pasó en J3E-B A-1. La salida fallida **no** se devuelve al modelo (ADR-028), así que la recuperación ve un contexto casi idéntico. HIPÓTESIS: los fallos consecutivos están correlacionados.
- **Contexto y caché de prefijo.** Lo único idéntico byte a byte entre llamadas son los dos mensajes system (≈ 9,7 KB ≈ 2,4k tokens, estimado con bytes/4). El mensaje user empieza con:
  - `asOf` (milisegundos, `context-compiler/src/compiler.ts:498`; `render.ts:28-31`);
  - `iteration`;
  - la sección `task`, con contadores de presupuesto restantes que cambian en cada llamada.

  Las instrucciones (≈ 6,6 KB) y las capacidades (≈ 11,4 KB) quedan **después** de esos campos variables. En los canaries no hay compactación: el presupuesto es `unbounded` y la compactación solo corre en `fixed`.

### 3.2 Correcciones a documentos previos

| Documento | Afirmación | Corrección |
|---|---|---|
| J3E-B §7 y §12.2 | "Provider JSON mode … configured via `R4_MODEL_EXTRA_BODY`"; "no JSON mode" | JSON mode ya es el valor por defecto, y `R4_MODEL_EXTRA_BODY` no puede fijarlo. Lo que sí se puede variar es `thinking` (vía `R4_MODEL_EXTRA_BODY`) y `R4_MODEL_RESPONSE_FORMAT`. |
| J3E-B §11.4 | Fallos de 685, 1 165 y 1 638 tokens de salida | Con `thinking` activo, esos conteos **incluyen razonamiento**. En las corridas R4-H (LOCAL-ARTIFACT), el texto visible de salidas no parseadas fue mucho menor que los tokens: 626 caracteres para 979 tokens; 805 para 2 558. |
| J3E-B §7 | "≈ 90 % of input repeats" (para caché) | Se repite el **contenido**, no un **prefijo** idéntico. El prefijo cacheable estimado es 15–27 % del input. |
| ADR-035:20; J3E-B §1:61 | Mismo reloj para inputs y pasos | Falso (P3). |

### 3.3 Evidencia histórica

| Fuente | Llamadas | `invalid_structured_output` | Detalle |
|---|---|---|---|
| Canary J3E-A (`@5`, DOC) | 34 | 1 | Tras `quote.preview`; recuperado |
| Canary J3E-B (`@6`, DOC) | 31 | 2 | Consecutivos en la misma conversación, tras `quote.preview` → handoff |
| R4-H shadow en vivo (definición v4, LOCAL-ARTIFACT, 2 corridas del 2026-09-24) | 523 no inyectadas | 8 | Por forma: 2 solo prosa; 3 una decisión + texto extra; 2 dos decisiones; 1 vacía con `finish=length` a 8 192 tokens. Aparecen también en `read_capability`, no solo al redactar ofertas. |

Lectura honesta:
- La tasa de canary (3/65 ≈ 4,6 %) y la de shadow (8/523 ≈ 1,5 %) no son comparables: distinta definición, carga y n.
- n = 3 en canary no permite atribuir causa.
- La concentración tras `quote.preview` es una observación, no una causa.
- Con los registros actuales no se distingue la prosa de un JSON con un salto de línea sin escapar dentro de un string.

### 3.4 Línea base reproducible (definida, no medida)

**Métricas y fuentes**

| Métrica | Fuente hoy | Falta |
|---|---|---|
| Llamadas por conversación y turno | `agent_run_steps` | — |
| Tokens de entrada y salida por llamada | `agent_run_steps.input_tokens/output_tokens` | Un `usage` ausente queda en 0 en silencio |
| Tokens de razonamiento | — | El adaptador los descarta |
| Tokens con acierto y fallo de caché | — | El adaptador los descarta |
| `finishReason` por llamada | Solo logs | No persiste; `insufficient_system_resource`/`aborted` → `other` |
| Latencia por llamada y turno | `latencyMs` en logs; aproximación con `step.created_at − snapshot.created_at` | No persiste |
| Tasa de fallo de formato | `agent_run_steps.outcome='invalid'`; `ProtocolAdherenceEvaluator` | — |
| Clase de fallo | Solo los recorders de shadow y live | Falta en canary y producción |
| Posición del fallo (capacidad previa) | Secuencia de pasos en la base | — |
| Resultado de la recuperación | `agent_runs.termination_details` | — |
| Contexto por llamada | `context_snapshots.estimated_tokens` / `compiled_context` | Estimación bytes/4 |
| Configuración del modelo por llamada | — | El canary no registra `describeModelConfig` |
| Costo por cotización | tokens × precio | Necesita el split de caché |

**Procedimiento**
1. **Exportación read-only** de la base y los logs del canary J3E: `context_snapshots.compiled_context`, `agent_run_steps` y `agent_runs` de `j3e-pos-1`, `j3eb-pos-1` y `j3eb-neg-1`; las líneas `model.call.completed`/`agent.decision`; los valores no secretos de `R4_MODEL_*`. Requiere autorización: es un acceso a EC2, aunque sea de lectura. Los datos **no están** en el repositorio ni en esta estación.
2. **Replay congelado por llamada** (script nuevo, fuera del harness):
   - reconstruye el request exacto con `renderMessages` y el `compiled_context` de cada snapshot, incluidos los que fallaron;
   - llama al modelo K veces (propuesta: K = 20) con `ShadowRecordingModelProvider`;
   - variantes: `thinking` activado/desactivado y `json_object` activado/`none` (control);
   - resultado: P(fallo) por prompt exacto, clase, `finishReason`, largo visible, tokens y latencia;
   - no toca owners ni EC2.
3. **Captura de uso en el adaptador** (harness, pequeño y aditivo): campos opcionales en `ModelUsage` para caché, razonamiento y `requestId`, emitidos en `model.call.completed`. Es requisito previo de cualquier afirmación sobre caché o costo.
4. **Clase de fallo en telemetría** (kernel, sin migración): un evento `agent.decision` invalid con `finishReason`, caracteres visibles y forma (prosa / decisión + texto / varias decisiones / vacío / `length`).
5. **Fidelidad de copia** para J3E-C1: replay del turno de oferta con el mensaje renderizado, N ≥ 30, midiendo igualdad exacta y fallos de formato.

### 3.5 Experimentos candidatos (no se afirma ninguna mejora)

| # | Experimento | Cambio | Métrica de decisión | Riesgo |
|---|---|---|---|---|
| E1 | Oferta determinista (C1) | Sales | Fallos de formato y tokens visibles en el turno de oferta; fidelidad de copia | Rechazos `offer_not_presented` |
| E2 | `thinking` desactivado para las decisiones de Sales | Config (`R4_MODEL_EXTRA_BODY`) | Tasa de fallo, latencia, calidad (suite de evaluación) | Peor calidad de decisión |
| E3 | Prefijo estable: mover `asOf`, `iteration` y el ítem `execution` después del contenido estático | Harness (`render.ts`/compilador) | Tokens con acierto de caché (requiere el paso 3) | Ordenar el contexto es una decisión de arquitectura (ADR-010/015) |
| E4 | Menos lecturas (omitir `get_product_context` cuando la búsqueda ya dio la clave y el precio exactos) | Instrucción | Llamadas por conversación | Ninguno de corrección: el snapshot relee Catalog |
| E5 | `R4_EXEC_MAX_RUN_FAILURE_RECOVERIES=2` | Config | Solo si el paso 2 muestra que los fallos **no** se repiten con el mismo prompt | Más latencia antes del handoff |

Descartado: devolver al modelo la salida fallida o "pistas de reparación" (lo prohíbe ADR-028).

**Rendimiento y costo observados (DOC):**
- Turnos de 13,9 a 31,9 s en J3E-B. El modelo domina; las capacidades tardan 0,02–0,7 s.
- Conversación positiva: ~150–166k tokens de entrada y ~10–11k de salida.
- Costo estimado (precios EXTERNAL del 2026-10, horario punta, todo sin caché; HIPÓTESIS): **≈ US$ 0,06 por conversación con cotización**.

El costo no es un bloqueo. La latencia y la robustez del formato sí afectan la operación.

## 4. Fase 4 — Riesgos adicionales de producción

Clasificación:
- **BO** = bloqueo obligatorio para emisión autónoma;
- **ED** = pertenece al hito de entrega documental;
- **M** = mejora no bloqueante.

| # | Riesgo | Estado (SOURCE/DOC) | Clase | Cierre |
|---|---|---|---|---|
| R1 | Límites definitivos de autonomía | Siete variables sin valor por defecto (`autonomy-limits.ts`). Solo hay valores de canary: ≤ 250 000 CLP, ≤ 3 líneas, ≤ 5 unidades totales, 1 por conversación, ≤ 2 por hora. Los contadores valen **por base de datos** (advisory lock, `store.ts:384`), no entre despliegues. | BO | El owner aprueba valores. Propuesta: empezar con los del canary y un solo despliegue por base. |
| R2 | Idempotencia y reconciliación | Sólida: clave de ejecución = `Idempotency-Key`; cuerpo congelado; `unknown` → lookup; nunca una clave nueva (`action-lifecycle.ts:56-87`); un snapshot autorizado no se reemite. | — | Ver R9 para el caso de rollback. |
| R3 | Integridad del mensaje presentado | Solo referencia y total | BO | J3E-C1 (documento hermano) |
| R4 | Procedencia de la confirmación | §2 | BO | J3E-C2 (H1–H3), o el owner acepta el gate de topología **y** se verifica en el host que no corre la API y que los relojes coinciden |
| R5 | Errores de formato | Fallan cerrados (handoff tras 2) | BO operacional | Línea base (§3.4) y un handoff atendido (R11) |
| R6 | Errores de owners y degradación | Catalog o Shipping caídos → `quote_evidence_unavailable`, reintentable, sin decisión (`quote-v4.ts:131-136`). Quote V2 no disponible → `failed` reintentable con la misma clave; resultado incierto → `unknown` → reconciliación (`quote-v2.ts:375-383`). 422 → rechazo, sin reemisión del snapshot. PDF `mismatch`/`unavailable` → emitida con la marca correspondiente (`quote-v2.ts:338-347`). | M (+ alertas, R7) | Comportamiento correcto; falta aviso al operador |
| R7 | Observabilidad | Falta un reporte de decisiones autónomas por `reason_code`, la tasa de `offer_not_presented`, la clase de fallo de formato, `finishReason` persistido, tokens de caché y razonamiento, y alertas. `ProductionMetrics` tiene `writes_by_capability`, `model_calls`, `run_failure_recoveries` y `human_handoffs` (`ports.ts:261-291`). | BO (mínimo) / M | Mínimo: un reporte Sales read-only, más alertas por ejecuciones `unknown`/`needs_reconciliation`, handoffs y PDF `mismatch`. Resto en §3.4. |
| R8 | **Control de rollout y kill switch** | Un perfil por despliegue: el ingress recibe un solo perfil (`ingress.ts:72-80`); el rollout por porcentaje decide si una conversación es autónoma, no qué perfil usa (`rollout.ts:37-43`). El kill switch retiene inputs (`ingress.ts:200-235`), retiene outbound (`delivery.ts:88`) y bloquea **nuevos** claims del worker (`apps/worker/src/worker.ts:20-23`, "never mid-run"). **No detiene** un `quote.create` de un run en curso ni un *replay* tras reconciliación: `guardProductionWrites` (`live-ops/src/guard.ts:13-39`), escrito para eso, **no se usa en ningún lugar**. | **BO** | J3E-C1: envolver `options.quotes.createAndIssue` con `guardProductionWrites` en la composición autónoma. El error de bloqueo debe ser `DomainError` con categoría `temporarily_unavailable`: `classifySend` lo devuelve como `failed` reintentable, sin efecto (`quote-v2.ts:379`). **Corregido en C1:** después de autorizar, ese bloqueo deja el comando `unknown` y retenido en su clave, no `failed` (informe C1 §6.2). Rollout a clientes: número dedicado (como declara `@6`), allowlist y luego porcentaje. |
| R9 | **Rollback compatible** | Volver a `@3`: (a) las tareas fijadas a la definición nueva siguen corriendo en un worker sin sus capacidades; (b) una ejecución `quote.create@N` pendiente de reconciliar llega a `capability_unavailable` (`action-executor.ts:112-113`) → `write_reconciliation_failure` → manual (`action-lifecycle.ts:33`, `:76-79`). Las cotizaciones emitidas no se afectan (son de Quote V2); las tablas Sales son append-only; no hay migración que revertir. | **BO** | Runbook: kill switch → esperar a que no quede ninguna ejecución `quote.create` no terminal ni `needs_reconciliation` → cerrar o pasar a humano los bindings abiertos del perfil → cambiar el perfil. Ensayarlo en el canary. |
| R10 | Entrega del PDF | Faltan: capacidad de entrega (EXTERNAL_COMMUNICATION, `require_approval` bajo la política autónoma), principal `quotes:delivery:email`, destinatario verificado (J4), medios en WhatsApp y política para `mismatch`/`unavailable` (J3E-A §12). | ED | Hito siguiente. Decisión de producto previa: si emitir sin entregar tiene valor para el cliente. |
| R11 | **Handoff sin operadores** | Un handoff (por ejemplo tras dos fallos de formato) deja la conversación a cargo de humanos. No hay OIDC real (J3D: falta el cliente OAuth). | **BO operacional** | Operadores habilitados y un tiempo de atención acordado antes de exponer clientes |
| R12 | Despliegue | Producción está en `ef5a354` con `@3`. Faltan las migraciones Sales `0008` y `0009` en la base productiva, el registro de definiciones y el canary del perfil final. | BO | Gates de perfil, como `SALES_PRODUCTION_PROFILE_V6_GATE` |
| R13 | Test de recovery obsoleto | `production-bootstrap-process.test.ts:48` espera solo `sales@3` | M | Cambio aparte, pequeño |

## 5. Bloqueos productivos restantes

**Obligatorios para emisión autónoma:**
1. B1 / R3: integridad exacta de la oferta. **J3E-C1.**
2. B3 / R8: kill switch efectivo sobre Quote V2. **J3E-C1.**
3. B2 / R4: procedencia contractual y orden causal. **J3E-C2** (ADR-036, harness), o decisión explícita del owner de mantener el gate de topología con verificación en el host.
4. B4 / R1: valores de límites aprobados por el owner.
5. B5 / R9: runbook de rollback y drenaje ensayado.
6. B6 / R5 / R11: línea base de fallos de formato medida y handoff atendido por operadores autenticados.
7. B7 / R7: reporte y alertas mínimos.
8. R12: despliegue (migraciones, definición, canary del perfil final y autorización explícita).

**Hito de entrega documental (no bloquea la emisión):** R10 y J4 Customer Profile.

## 6. Roadmap consolidado

| Slice | Contenido | Harness | Migración | Autorización |
|---|---|---|---|---|
| **J3E-C1** | Oferta determinista (`quote.preview@3`, `quote.create@5`, definición v7, `@7`); `settle` estricto; guard del kill switch sobre Quote V2 | No | No | Implementación (§8) |
| J3E-C2 | ADR-036: H1–H3 y su uso en Sales (`quote.create@6`, perfil siguiente) | Sí, pequeño | No | ADR + implementación |
| J3E-C3 | Observabilidad: uso completo en el adaptador, clase de fallo en telemetría, reporte Sales read-only, lista de alertas | Sí, pequeño (adaptador, kernel) | No | Implementación |
| J3E-C4 | Línea base (§3.4: exportación read-only, replay congelado, fidelidad de copia) y experimentos E1–E5 | No (script) | No | Gasto de modelo; lectura de EC2 |
| J3E-C5 | Operación: límites, runbook de rollback, operadores OIDC, canary EC2 del perfil final | No | Solo en la base del canary | Owner; EC2 |
| J3E-C6 | Decisión de producción (número dedicado, allowlist, porcentaje) | — | `0008`/`0009` en producción | Explícita |
| J4 / entrega | Customer Profile, entrega del PDF | — | — | Hito siguiente |

C1 y C2 son independientes. Si se autorizan juntos, Sales puede consumir ambos en una sola versión de capacidad y perfil.

## 7. Criterios de aceptación para emisión autónoma en producción

1. Ninguna cotización se emite sin que el mensaje confirmado sea idéntico a la renderización Sales del snapshot emitido (C1, criterios del documento hermano §10).
2. Ninguna confirmación cuenta si su origen no es el canal del binding, demostrado por contrato (C2) o por una decisión explícita del owner con verificación en el host.
3. La confirmación es causalmente posterior a la oferta, sin depender de relojes (H3) o con la equivalencia de relojes demostrada.
4. Con el kill switch activo, ningún run ni reconciliación llama a `createAndIssue`. Probado con un test de integración.
5. Límites aprobados y configurados; composición fallida sin ellos (ya existe).
6. Runbook de rollback ensayado en canary: después de volver al perfil anterior, no queda ninguna ejecución sin handler.
7. Línea base de fallos de formato medida con el procedimiento §3.4, y umbral aceptado por el owner.
8. Reporte y alertas mínimos operativos; operadores autenticados capaces de atender un handoff.
9. Huellas `@1–@6`, hashes de política y migraciones liberadas sin cambios.
10. Canary EC2 del perfil final aprobado y autorización explícita de despliegue.

## 8. Propuesta de implementación con alcance cerrado: J3E-C1

**Objetivo:** cerrar B1 y B3 sin tocar el harness ni migrar.

**Dentro del alcance:**
1. `renderOfferMessage` y la plantilla `r4-sales-offer-es-v1` (documento hermano §5.2).
2. `quote.preview@3`: `@2` + `offerTemplate`, `offerMessage`, `offerMessageSha256`.
3. `quote.create@5`: `@4` + igualdad exacta (`sha256`) entre el mensaje de oferta del hilo y la renderización del snapshot recalculado; si no, `offer_not_presented`. La versión de plantilla y el hash esperado se guardan en `0008.quote_request`.
4. `settle` estricto (montos por línea y de despacho), solo para `@5`.
5. Guard del kill switch sobre `createAndIssue` en la composición de `@7`.
6. Definición Sales v7, perfil `sales-production@7` con su lista de gates, y el canary local que acepta `@7`.
7. Tests (documento hermano §7), más un test de integración del kill switch: un run en curso con el switch activado → `failed` reintentable, sin llamada al owner; la reconciliación con el switch activado no hace replay. **Corregido en C1 (informe C1 §6.2):** `failed` solo antes de decidir; después de autorizar, el comando queda retenido en su clave y se envía una vez al liberar (probado en el ciclo de vida completo).

**Fuera del alcance:**
- harness (`packages/`, `apps/`, `adapters/`) y migraciones;
- EC2 y canaries reales; perfiles productivos;
- C2–C6;
- el test de recovery obsoleto (R13).

**Archivos:** los listados en el documento hermano §6, más el guard en `production/composition.ts` (rama `@7`).

**Evidencia a entregar:**
- build, lint y typecheck;
- suites unit, contract, integration (`--no-file-parallelism`), sales y shadow;
- huellas fijadas;
- `git diff -- packages apps adapters` vacío;
- informe `R4-J3E_C1_…_REPORT.md`.

**Tamaño estimado** (HIPÓTESIS): ≈ 450 líneas de código Sales y ≈ 800 de tests.

**Decisiones que se piden al owner:**

| # | Decisión | Recomendación |
|---|---|---|
| D1 | Autorizar J3E-C1 con este alcance | Sí |
| D2 | Aceptar la igualdad estricta: el mensaje de oferta es fijo y las preguntas laterales van en otro turno | Sí, para v1 |
| D3 | Umbral de fidelidad de copia | ≥ 95 % con N ≥ 30 |
| D4 | Gasto de modelo para la fidelidad de copia y el replay congelado (sin EC2, sin Quote V2) | Sí, después de C1 |
| D5 | ADR-036 (H1–H3) o mantener el gate de topología | ADR-036 |
| D6 | Exportación read-only de la base y los logs del canary para la línea base | Sí |
| D7 | Valores de producción de los siete límites | Empezar con los del canary |
