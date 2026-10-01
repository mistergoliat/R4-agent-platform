---
title: R4-I — Cutover del número productivo de WhatsApp a R4 — inventario y gate de readiness
status: BLOQUEADO antes del cutover live (ver §5)
owner: architecture
last_reviewed: 2026-09-28
r4_baseline: 34e83c687a8375a29fbabe55166a6652c6b1da2d (R4-I PRE-CUTOVER BASELINE; HEAD = origin/main)
r4_production_control_baseline: 9c3e080e41d6496aa7aa9916a55ed428c3fec784 (D-5/D-6 implementados offline sobre este commit; §8)
r4_worker_readiness_baseline: 8c366fbd52e40549654eb5e09cc46e3efc3da956 (auditoría de readiness del worker; §9)
r4_worker_readiness_implementation_baseline: b561178b2324a525b3ce538651cdf14aa1310dc3 (0008 + presencia + `/ready/r4` implementados offline sobre este commit; §9)
r4_production_bootstrap_baseline: da941ef (registro explícito de la AgentDefinition de Sales; §10)
crm_ref: CRM-Customer-360 @ 8298723 (sólo lectura; working tree limpio)
supersedes: decisión D-1 (c) de R4-I_CRM_WHATSAPP_AUDIT.md — reemplazada por la decisión de proyecto "R4 dueño del número productivo" (tarea de cutover R4-I, 2026-09-28)
---

# R4-I — Cutover del número productivo: inventario y readiness

Decisión de proyecto (autoritativa, no se reabre): el número productivo de
WhatsApp pasa de CRM-Customer-360 a R4 con un único escritor outbound (R4), sin
coexistencia, sin puente y al 100 %. La incompletitud comercial (Customer,
Catalog, Shipping, Quote) y la identidad del operador **no** bloquean R4-I.

Este documento registra evidencia **previa** al cutover. Nada de lo descrito
aquí ha cambiado todavía el estado de producción: el número productivo **no**
apunta a R4 al momento de escribirlo.

## 1. Inventario de caminos actuales (código real)

Evidencia: búsqueda en CRM-Customer-360 @ 8298723 de todo caller de
`graph.facebook.com/.../messages` y de sus entry points; export n8n de
`tmp/n8n-backups/2026-06-12-postventa-sprint1/`.

| # | Componente | Repo / proceso | Inbound | Outbound | Llama a Meta | Reintenta | Genera texto | Puede correr tras el cutover | Gate que lo habilita hoy | Acción |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `POST/GET app/api/integrations/whatsapp/webhook/route.ts` → `processNativeWhatsAppInbound` (+ `applyMetaDeliveryStatus`) | CRM web (Next.js) | Sí (sólo wa_id en allowlist; el resto se audita y **no** se persiste) | No directo | No | — | Sí (indirecto: `runNativeAutonomousCycle` en el request) | Sólo si Meta sigue apuntando a él | URL de callback en Meta + `META_WHATSAPP_APP_SECRET` | DISABLE (Meta deja de apuntar aquí) |
| 2 | `runNativeAutonomousCycle` → `brain_message_outbox` | CRM web | — | Escribe outbox | No | — | Sí (modelo `BRAIN_MODEL_*`) | Sólo con inbound del #1 | `BRAIN_AUTONOMOUS_REPLY_ENABLED` | DISABLE |
| 3 | `scripts/autonomous-outbox-worker.ts` (`npm run worker:outbox`) → `autonomousOutboxTick` → `metaClient.sendMetaWhatsAppTextMessage` | CRM worker | — | Sí | **Sí** | Sí (network/timeout/429/5xx, hasta 5) | No | **Sí** (drena outbox pendiente) | `BRAIN_META_SEND_ENABLED=true` + allowlist + `META_WHATSAPP_ACCESS_TOKEN` | DISABLE (parar proceso + flag + token) |
| 4 | `POST app/api/brain/outbox/worker/route.ts` → `outboxWorker.ts` | CRM web | — | Sí | **Sí** | Sí | No | **Sí** | `BRAIN_OUTBOX_WORKER_ENABLED` + `BRAIN_META_SEND_ENABLED` + auth AI-orchestration | DISABLE |
| 5 | `scripts/autonomous-followup-worker.ts` (`worker:followup`) | CRM worker | — | Escribe outbox | No directo (vía #3/#4) | — | Sí | **Sí** | flags followup | DISABLE (parar proceso) |
| 6 | `scripts/autonomous-commercial-work-worker.ts` (`worker:commercial-work`) | CRM worker | — | Escribe outbox (vía steps) | No directo | — | Sí | **Sí** | `BRAIN_COMMERCIAL_WORK_RUNTIME_ENABLED` | DISABLE (parar proceso) |
| 7 | `scripts/autonomous-turn-settle-worker.ts` → `postMetaWhatsAppTypingIndicator` | CRM worker | — | Sí (read + typing) | **Sí** | No | Sí (dispara ciclo) | **Sí** | `BRAIN_META_SEND_ENABLED` + `BRAIN_WHATSAPP_TYPING_INDICATOR_ENABLED` | DISABLE |
| 8 | `POST app/api/conversations/[id]/reply` → `manual-reply.ts` → `metaClient` | CRM web (operador) | — | Sí | **Sí** | No | No (humano) | **Sí** | `BRAIN_META_SEND_ENABLED` + allowlist + token | DISABLE |
| 9 | `POST app/api/cases/[id]/reply` → `caseActions.manualReply` → **`lib/meta.ts#sendWhatsAppText`** | CRM web (operador, legacy) | — | Sí (texto o plantilla) | **Sí** | No | No (humano) | **Sí** | **sólo `META_ACCESS_TOKEN`** + `requireWriteAccess`; **sin** `BRAIN_META_SEND_ENABLED` y **sin** allowlist | DISABLE (quitar `META_ACCESS_TOKEN`; revocar token) |
| 10 | `POST app/api/brain/messaging/send-test` → `metaSendAdapter` | CRM web | — | Sí | **Sí** | No | No | **Sí** | `BRAIN_META_SEND_ENABLED` + token | DISABLE |
| 11 | `POST app/api/brain/process-inbound` (legacy n8n) → `processInbound` | CRM web | Sí (desde n8n) | Plan de outbox (`BRAIN_PROCESS_INBOUND_ALLOW_OUTBOX_PLAN`) | No directo | — | Sí (legacy, `BRAIN_LEGACY_SALES_CONSULTATIVE_ENABLED`) | Si n8n lo llama | auth AI-orchestration | DISABLE |
| 12 | n8n `WA_00_Webhook_Master` (webhook `wa-webhook`), `active: true` en el export 2026-06-12 → `OPS_Response_Executor_SendWhatsApp` | n8n (fuera de ambos repos) | Sí | Sí | Sí (sub-workflow con credencial Meta propia en n8n) | desconocido | Sí (`AI_Orchestrator`, `AI_AGENT_Postventa` vía DeepSeek) | — | — | **FUERA DE ALCANCE** — registro histórico del export; n8n pertenece a otro entorno productivo (ver corrección de alcance abajo) |
| 13 | `scripts/e2e-autonomous-harness.ts`, `scripts/manual-test/whatsapp-r2-smoke.ts`, `npm run autonomy:live` | CRM scripts manuales | — | Sí (vía #3) | **Sí** con token + flag | — | Sí | Sí, si alguien con el token los ejecuta | token + flag | DISABLE (revocación del token) |
| 14 | `lib/brain/messaging/whatsapp-transport/*` | CRM | — | — | No (sandbox, `FakeWhatsAppHttpClient`) | — | — | No | — | KEEP (inerte) |
| 15 | Lecturas de estado (`lib/system.ts`, `lib/dashboard.ts`, `/whatsapp` page) | CRM web | — | — | No | — | — | Sí (sólo lectura de env) | — | KEEP |
| 16 | `apps/channel-gateway` (webhook + dispatcher) + worker de producción | R4 | Sí | Sí | Sí (único dueño previsto) | Sólo "definitivamente no enviado" | Sí (modelo real) | objetivo | ver §3 | KEEP (dueño) |

Hallazgos que cambian el diagnóstico de "dueño actual":

- El webhook nativo del CRM sólo persiste y responde a wa_id de allowlist
  (`BRAIN_WHATSAPP_ALLOWED_WA_IDS` / `BRAIN_AUTONOMOUS_TEST_WA_IDS`), y
  `metaClient` exige esa misma allowlist para enviar. Si Meta apunta al CRM,
  los clientes reales **no** reciben respuesta automática hoy; si Meta apunta a
  n8n (`wa-webhook`), el dueño efectivo del número productivo es **n8n**, no el
  CRM. Cuál de los dos es cierto sólo lo resuelve la configuración de webhooks
  de la app de Meta (y los overrides por WABA/número). **No verificado.**
  *(Registro histórico; ver la corrección de alcance siguiente.)*
- **Corrección de alcance (2026-09-28): n8n queda fuera de R4-I.** n8n
  pertenece a un entorno productivo externo y separado; no es parte del runtime
  productivo que se migra a R4. Por lo tanto n8n **no** es dependencia de R4-I,
  **no** bloquea el cutover, **no** forma parte de la readiness del worker y
  **no** entra en la prueba de escritor único — salvo que evidencia futura
  demuestre que comparte exactamente el número productivo o la autoridad de
  credencial de Meta. Las filas y hallazgos sobre n8n de este documento son
  registro de la auditoría histórica, no gates de cierre.
- El camino #9 (respuesta manual legacy) no pasa por ningún flag de
  `BRAIN_*`: apagar los flags del brain **no** lo apaga.

## 2. Invariante de escritor único — cómo se garantiza de forma determinista

Apagar flags de entorno del CRM es necesario pero **no suficiente**: los
scripts (#13) pueden ejecutarse fuera del
proceso desplegado. El único control determinista sobre "quién puede crear un
efecto en Meta para este número" es la credencial:

1. **Rotar/revocar** todo access token con permiso `whatsapp_business_messaging`
   sobre el WABA del número (system user(s) y cualquier token de usuario usado
   por el CRM). Emitir un token nuevo **sólo** al almacén de secretos de R4
   (`R4_WHATSAPP_ACCESS_TOKEN`). Todo portador antiguo (CRM web, workers,
   scripts, portátiles) queda sin capacidad de envío, corra o no.
2. Además, por higiene y para evitar ruido de errores: en el entorno productivo
   del CRM `BRAIN_META_SEND_ENABLED=false`, `BRAIN_OUTBOX_WORKER_ENABLED=false`,
   `BRAIN_AUTONOMOUS_REPLY_ENABLED=false`, `BRAIN_WHATSAPP_TYPING_INDICATOR_ENABLED=false`,
   eliminar `META_ACCESS_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`; detener
   `worker:outbox`, `worker:followup`, `worker:commercial-work`,
   `worker:turn-settle`; reiniciar el web.
3. *(Fuera de alcance — corrección de alcance en §1.)* n8n no se inspecciona
   ni se modifica en R4-I. Si evidencia futura mostrara que comparte este
   número o su autoridad de credencial Meta, la revocación del paso 1 lo cubre.
4. Verificación: el token viejo debe ser rechazado por Graph con error de
   autenticación en una llamada de sólo lectura (p. ej. `GET /{phone-number-id}`),
   sin enviar nada a un cliente; y la herramienta de depuración de tokens de
   Meta debe mostrarlo inválido.

Ningún cambio de código en el CRM es necesario para garantizar el invariante:
la revocación del token es más fuerte que cualquier parche.

## 3. Composición productiva de R4 (auditada en código)

| Elemento | Fuente | Estado en código |
|---|---|---|
| Modo producción | `R4_EXECUTION_MODE=production`; `loadProductionConfig` exige `R4_PROD_POLICY_PROFILE`, `R4_PROD_ROLLOUT_PERCENT` (0–100), `R4_PROD_IDENTITY_HASH_KEY`, `R4_PROD_ALLOW_NETWORK` | Fail-closed |
| Adapter de canal | `@r4-adapters/whatsapp-cloud`; exige `R4_WHATSAPP_APP_SECRET`, `R4_WHATSAPP_VERIFY_TOKEN`, `R4_WHATSAPP_ACCESS_TOKEN`, `R4_WHATSAPP_PHONE_NUMBER_ID` (numérico); `R4_WHATSAPP_GRAPH_VERSION`, `R4_WHATSAPP_GRAPH_BASE_URL` (https si no es loopback; red sólo con `R4_PROD_ALLOW_NETWORK=true`) | Fail-closed; firma siempre exigida; sólo acepta el `phone_number_id` configurado |
| Fixtures/shadow | `assertProductionProfile` rechaza `FIXTURE/SHADOW`; el gateway rechaza un outbound de tipo distinto al declarado | Fail-closed |
| Arranque del gateway | esquema al día (`migrationStatus`), controles legibles, perfil = declarado | Fail-closed |
| `/ready` del gateway | DB + migraciones + controles legibles — readiness del **canal**; no depende de workers | Correcto (no false-green); `/health` es liveness |
| `/ready/r4` del gateway | `/ready` **y** ≥ 1 worker de producción fresco, compatible y `ready` (`worker_presence`, reloj de BD) | Agregado de la plataforma (§9) |
| Worker | `production:sales:worker`; exige modelo `R4_MODEL_*` y red; publica presencia durable renovada por el progreso de su bucle | Sin HTTP; su readiness se observa en `/ready/r4` (§9) |
| Scheduler (R4-J1E-R2.1) | `start:scheduler` (apps/scheduler, ADR-022); exige esquema al día y `R4_RECONCILIATION_*` sin default; único consumidor de schedules (WAIT_UNTIL, expiraciones, reintentos, despacho de reconciliación) | Proceso obligatorio; sin presencia durable ni readiness propia (gap diferido) |
| Kill switch | `autonomy_controls`, creado deshabilitado por migración; lectura fallida = deshabilitado | Legible y administrable desde el host productivo con `production:sales:control` (§8); B-3 resuelto offline |
| Rollout | `R4_PROD_ROLLOUT_PERCENT` 0–100 + allow/deny por hash | 100 % admitido por código |
| Secretos en logs | pino `redact` (authorization, cookie, `*.token`, `*.secret`, …); gateway sin request logging | Correcto |
| "Canary" | sólo nombre/descripción del perfil y comentarios; ninguna restricción de código impide el número productivo | Cambiar la descripción del perfil implica nuevo fingerprint de perfil (decisión: ver §6) |
| Despliegue | **no hay** Dockerfile, IaC, unidad de servicio ni target AWS en el repo | Target de despliegue indefinido |

## 4. Gate de readiness previo al cutover (§30)

| # | Condición | Estado | Evidencia |
|---|---|---|---|
| 1 | Build de producción | ver informe de regresión offline | `npm run build` |
| 2 | Esquema de BD al día | **NO VERIFICADO** — no hay BD productiva de R4 accesible | — |
| 3 | Modo producción explícito | En código sí; entorno productivo inexistente/inaccesible | §3 |
| 4 | Adapter real seleccionado | Sí (código) | gateway `production_composition_refused` |
| 5 | Fixtures no pueden entrar | Sí (código + tests) | `contract/live-ops-boundaries` |
| 6 | Secretos/config de Meta disponibles | **NO** — ausentes en este entorno | `.env` sólo tiene `R4_MODEL_*`/DB local |
| 7 | Health del gateway | **NO** — no desplegado | — |
| 8 | Health del worker | Mecanismo implementado y validado **offline** (`/ready/r4`); **NO** verificado live — no desplegado | §9 |
| 9 | Health de BD | **NO** — sin BD productiva | — |
| 10 | Kill switch legible y ON | Legible por construcción; se cambia y se liberan retenciones `autonomy_disabled` con `production:sales:control` — **validado offline, no live** | §8 |
| 11 | Secuencia de apagado del CRM | Definida (§2) — no ejecutable desde aquí (host CRM no identificado) | §2 |
| 12 | Secuencia de apagado n8n/legacy | **Fuera de alcance** — n8n es otro entorno productivo (corrección de alcance §1) | §1 |
| 13 | Endpoint/config de rollback conocidos | **NO** | — |
| 14 | Endpoint de webhook actual registrado | **NO** — sólo visible en la app de Meta | — |
| 15 | Endpoint R4 verificado | **NO** — no hay URL pública desplegada | — |
| 16 | Ningún escritor UNKNOWN | Dentro del alcance (CRM + scripts) cubierto por la revocación del token (§2), **pendiente de ejecución live**; n8n fuera de alcance (§1) | §2 |
| 17 | Logs sin secretos | Sí (código) | §3 |
| 18 | Gate de red entendido | Sí: `R4_PROD_ALLOW_NETWORK` + https | §3 |

## 5. Bloqueos (condiciones STOP alcanzadas)

- **B-1 (STOP A, C, K, §60).** Identificadores productivos no verificados: app
  de Meta, WABA, `phone_number_id`, URL de callback actual, host
  del CRM, target AWS de R4, BD productiva de R4. Este entorno
  no tiene AWS CLI/credenciales, llaves SSH ni acceso a Meta Business.
- **B-2 — RECLASIFICADO FUERA DE ALCANCE (2026-09-28).** Registro original:
  escritor UNKNOWN n8n `OPS_Response_Executor_SendWhatsApp` con credencial
  propia. n8n pertenece a otro entorno productivo (corrección de alcance §1) y
  ya no bloquea R4-I. El escritor único dentro del alcance se garantiza con §2
  (revocación del token) ejecutado y verificado por quien tenga acceso.
- **B-3 (STOP G) — hallazgo de plataforma. RESUELTO OFFLINE (§8)** — sin
  validación live. Registro original: el kill switch se lee pero **no
  hay camino productivo gobernado para cambiarlo**: `POST /v1/production/controls`
  exige un `TrustedHumanContext` y ningún entry point productivo compone un
  `humanContext` (responde 422 `trusted_human_required`, por diseño). Lo mismo
  aplica a liberar tasks retenidas (`autonomy_disabled`, `request_handoff`,
  contenido no soportado): quedan en `/v1/attention` sin superficie humana.
  Consecuencias tras el cutover: (a) el paso "kill switch OFF" (§31 paso 11)
  sólo sería posible por escritura SQL directa, que no deja
  `autonomy_control_events` coherente con el runtime; (b) toda conversación
  retenida durante la fase con kill switch ON, o entregada a humanos por el
  agente, queda **sin respuesta indefinidamente** — el CRM ya no ve ese hilo.
  Requiere decisión (§6 D-5, D-6).
- **B-4 (STOP L).** Sin artefacto/target de despliegue reproducible en el repo.
- **B-5 — readiness del worker. RESUELTO OFFLINE (§9)** — sin validación live.
  Registro original: el `/ready` del gateway podía responder listo con el
  worker muerto (gateway vivo + BD + esquema + kill switch legible) y ningún
  primitivo existente probaba entre procesos que hubiera un worker productivo
  compatible vivo. Resuelto con la migración aditiva 0008 (`worker_presence`),
  aprobada por separado, y la vista agregada `/ready/r4`.

B-1 a B-4 no requieren migración ni cambio de protocolo; B-5 requirió la migración aditiva 0008 (§9), sin cambio de protocolo. B-3 se resolvió con una
única operación genérica nueva en `TemporalRuntime` (`releasePlatformHold`, la
inversa de `holdForHumansWithin`: misma transición existente, sin estado ni
ciclo de vida nuevos; §8).

## 6. Decisiones requeridas

- **D-5 — Control del kill switch sin IAM. DECIDIDO E IMPLEMENTADO (§8).**
  La propuesta original de abajo (construir un `TrustedHumanContext` con un
  `humanRef` de host) fue **rechazada**: la administración productiva no
  finge ser un operador humano ni usa la API del operador. Propuesta original:
  un comando de host `production:sales:control --autonomy on|off --reason "…"` que construye
  un `TrustedHumanContext` con `humanRef = "host-operator:<nombre declarado>"` y
  scope `autonomy.control` y llama `AutonomyControls.setControl` (auditado en
  `autonomy_control_events`). Frontera de confianza = acceso de shell al host
  productivo. No es IAM; no abre la API HTTP. Alternativa: aceptar SQL directo
  documentado (no recomendado).
- **D-6 — Conversaciones entregadas a humanos tras el cutover. DECIDIDO E
  IMPLEMENTADO (§8) como (a), acotado a `autonomy_disabled`, task por task, sin
  liberación masiva.** Registro original: sin UI de
  operador, las tasks retenidas no tienen salida. Opciones: (a) el mismo
  comando de host con `release <taskId>` / liberación masiva de retenciones
  `autonomy_disabled` tras soltar el kill switch (hoy diferida en ADR-029);
  (b) aceptar el riesgo explícitamente para R4-I. Recomendación: (a), acotado
  a `autonomy_disabled`; `request_handoff` del agente sigue requiriendo humano
  y queda como riesgo comercial visible (evidencia R4-J).
- **D-7 — Perfil.** Actualizar la descripción del perfil Sales ("canary on a
  dedicated number") ⇒ nuevo fingerprint `R4_PROD_POLICY_PROFILE`; o dejarlo y
  documentarlo. Recomendación: nueva versión del perfil sólo si se cambia
  comportamiento; si no, documentar.

## 7. Rollback (a completar con los valores registrados en el paso 1)

**Nivel 1 — autonomía (preferido).** Kill switch ON:
`npm run production:sales:control -- autonomy off --reason "<incidente>"` (§8). R4 sigue
dueño; inbound durable; callbacks continúan; sin cognición ni efectos nuevos;
outbound `pending` retenido (no cancelado).

**Nivel 2 — canal (falla severa de plataforma).** En este orden: (1) kill
switch ON en R4; (2) detener el dispatcher del gateway (SIGTERM, termina el
envío en vuelo); (3) restaurar en Meta la URL de callback y el verify token
**registrados** en el paso 1 (app/WABA/número según dónde estaba el override);
(4) entregar un token al único escritor restaurado (el que era
dueño) y reactivar sólo ese camino; (5) verificar el challenge. Nunca dejar a
R4 y al escritor restaurado con token válido a la vez. Outbound de R4 en
`unknown` se listan para revisión manual antes de reactivar el escritor viejo.

Valores a registrar (sin secretos): URL de callback actual y nivel del override,
app de Meta (id), WABA (id), `phone_number_id`, qué sistema(s) tienen token,
flags `BRAIN_*` productivos actuales, procesos CRM
activos, SHA/versión de R4 desplegada, versión de migración, estado del kill
switch.

## 8. Administración productiva: `production:sales:control` (D-5, D-6)

Implementado y validado **offline** (BD desechable, proveedor fake local,
modelo con guion). No se ejecutó contra ninguna BD productiva ni contra Meta.

```
npm run production:sales:control -- autonomy status
npm run production:sales:control -- autonomy off --reason "<motivo operacional>"
npm run production:sales:control -- autonomy on  --reason "<motivo operacional>"
npm run production:sales:control -- holds list
npm run production:sales:control -- holds release --task <task-id> --reason "<motivo operacional>"
npm run production:sales:control -- tasks cancel   --task <task-id> --reason "<motivo operacional>"
```

**Frontera de confianza.** Es tooling de administración del despliegue, no el
plano del operador. Lo protege el acceso al host productivo (shell + entorno
del proceso): quien puede ejecutarlo contra la BD productiva ya está dentro
de la frontera administrativa del despliegue. **No** sustituye la
autenticación de operadores, **no** construye un `TrustedHumanContext`,
**no** llama `/v1/production/*` y **no** debe exponerse como servicio.
La identidad del operador sigue fuera de R4 (integración futura CRM/operador).

**Atribución.** Cada cambio queda como `changed_by = platform:production-control`
(`autonomy_control_events`) o `actor_ref = platform:production-control`
(`temporal_events`), con el motivo del administrador y un `correlation_id`
`production-control:<host>:<pid>:<aleatorio>`. Significa "acción
administrativa desde el host productivo", **no** una persona verificada.

**Requisitos (fail-closed).** `R4_EXECUTION_MODE=production` y la
configuración productiva completa (`loadProductionConfig`), perfil
`sales-production@1`, `R4_DATABASE_URL` del despliegue y esquema al día
(migraciones Core + Sales, sin pendientes ni modificadas). Lee sólo el entorno
del proceso (nunca `.env`). No necesita credenciales de Meta ni del modelo y
no compone canal, entrega ni modelo. Códigos de salida: 0 hecho, 2 comando
inválido (incluye motivo ausente o vacío), 1 rechazo o fallo (configuración,
esquema, BD, elegibilidad, mutación). Nunca imprime URL de BD ni secretos.

**Semántica.**

- `autonomy off|on` usa `AutonomyControls.set` (scope `global`), la misma
  primitiva durable y auditada del kill switch. Repetir el mismo estado
  registra la intención repetida (versión + evento), como la primitiva
  existente. **`autonomy on` no libera ninguna task retenida**, no toca
  canal, rollout, bindings, inbound ni outbound.
- `holds list` muestra sólo handoffs `requested` con
  `payload.initiatedBy = platform` y `payload.reason = autonomy_disabled`
  (identificadores, fecha, estado de la task; sin contenido de la conversación).
- `holds release` libera **una** task, y sólo si su handoff abierto es una
  retención de plataforma `autonomy_disabled` aún `requested` **y** la
  autonomía está habilitada para su canal (si no: rechazo; evita el ciclo
  liberar/re-retener). Usa `TemporalRuntime.releasePlatformHold`: la misma
  transición que un humano que cancela un handoff solicitado
  (`requested → cancelled`, WAIT_FOR_HUMAN completado vía `wakeWithin`; una
  intención terminal o un efecto incierto siguen ganando). No ejecuta el
  worker, no llama al modelo, no despacha: la task queda reclamable y el
  worker normal compila un ContextSnapshot nuevo con todos los inputs durables
  (incluidos los llegados durante la retención). El gate de entrega sigue
  siendo la autoridad: una respuesta pendiente anterior queda
  `superseded_by_newer_input`/`superseded_by_operator`; un `unknown` sigue
  `unknown` y nunca se reintenta. Reintentar la liberación ⇒ rechazo
  `platform_hold_not_open` sin cambios.
- Se rechazan (sin tocarlos): handoff pedido por el agente
  (`platform_hold_mismatch`), toma del operador o retención aceptada por un
  humano (`handoff_owned_by_human`), otras causas de plataforma
  (`rollout_excluded`, `autonomy_denied`, contenido no soportado, recuperación
  ADR-028 agotada), consultas, aprobaciones y reconciliación.
- `tasks cancel` retira **una** task (UUID explícito, motivo obligatorio;
  sin comodines ni operación masiva). Usa `TemporalRuntime.cancelTaskByPlatform`,
  que ejecuta **la misma transición** que `cancelTask` de un operador (un
  único cuerpo compartido): run activo `cancelled` (el worker que lo tenía
  pierde el lease y sus escrituras fenced fallan), lease liberado, wait
  abierta `cancelled`, human requests abiertos `cancelled` (o `released` si
  un humano los había aceptado), timers cancelados y la task `cancelled`. Si
  un efecto de la task es incierto, la cancelación queda **diferida**
  (`cancellation_deferred`: la task sigue `blocked` con intención terminal
  hasta que la reconciliación establezca el resultado). Una task ya terminal
  ⇒ `already_terminal`, sin cambios (repetir es seguro). Una task inexistente
  ⇒ `task_not_found`, código 1. Atribución: transición con actor
  `system:platform:production-control`, eventos `handoff.cancelled` /
  `task.cancelled` con `actor_ref = platform:production-control`,
  `initiatedBy = platform` y el motivo como evidencia. **No** toca el binding
  de la conversación (sólo lo informa), **no** cambia rollout ni autonomía,
  **no** llama al modelo ni a Meta.

**Recuperación: retirar una conversación existente para que el rollout se
re-evalúe en el próximo inbound.** La elegibilidad de rollout se decide al
abrir el binding y es **pegajosa** mientras el binding siga abierto: si una
identidad escribió antes de estar en el allowlist (o antes de habilitar la
autonomía), su binding queda `autonomy = excluded` y ni `autonomy on`, ni
cambiar el allowlist, ni `holds release` la vuelven autónoma (el siguiente
inbound la re-retendría como `rollout_excluded`). El caso se detectó en el
primer smoke productivo de WhatsApp. Procedimiento:

1. Confirmar que la autonomía está habilitada (`autonomy status`) y que el
   rollout desplegado ya incluye la identidad.
2. Retirar la task asociada al binding:
   `npm run production:sales:control -- tasks cancel --task <task-id> --reason "retire pre-rollout smoke conversation"`.
   La salida muestra `outcome: cancelled` y el binding **aún** `open`/`excluded`.
3. En el próximo inbound de esa conversación, ChannelIngress ve la task
   terminal, cierra el binding antiguo (`closed_reason = task_cancelled`) y
   abre uno **nuevo** con evaluación de rollout fresca (p. ej.
   `autonomy = autonomous`, `eligibility_reason = allowlisted`) y una task
   nueva ejecutable por el worker normal. La task antigua sigue `cancelled`
   (sin resurrección ni memoria entre tasks).

Si la salida fuera `cancellation_deferred`, el binding se cierra igual en el
próximo inbound (la ingress trata una intención terminal como terminal).

**Limitación conocida (evidencia R4-J / plano del operador).** Una task que el
agente de Sales entrega a humanos (`request_handoff`) queda esperando hasta que
exista integración CRM/operador. Este comando no ofrece atajo para ella.

**Evidencia.** `tests/integration/production-control.test.ts` (incluye el
incidente completo: binding excluido → rollout cambia → `tasks cancel` →
binding nuevo autónomo), `tests/integration/human-collaboration.test.ts` y
`tests/integration/reconciliation.test.ts` (cancelación de plataforma con run
activo y con efecto incierto), `tests/unit/live-ops/administration.test.ts`,
`tests/contract/live-ops-boundaries.test.ts`,
`tests/recovery/production-control-process.test.ts` (un proceso real por
comando), `npm run test:mutation:production-control`.

**Siguen bloqueando el cutover live:** B-1 (target de despliegue y acceso,
identificadores/credenciales productivos de Meta), verificación live de
escritor único (CRM; n8n fuera de alcance, §1), B-4 (despliegue reproducible),
verificación del target de rollback y el cutover live en sí. B-5 (readiness
del worker) quedó resuelto offline (§9).

## 9. Readiness del worker (B-5) — auditoría e implementación

Auditoría sobre `8c366fb` (sólo código; sin red, sin BD productiva). La
solución mínima correcta requería una migración: la tarea se detuvo antes de
crearla y la decisión se revisó por separado (D1–D9 aprobadas). Lo
implementado está al final de esta sección.

**Problema.** `/ready` del gateway = BD alcanzable + esquema al día +
controles legibles. Con el worker muerto responde 200: el inbound se acepta y
persiste pero nadie lo ejecuta, y operaciones ve "listo".

**Lo que ya prueba el worker por sí mismo (SUFICIENTE, sólo en el arranque).**
`production:sales:worker` falla cerrado y el proceso termina si: el modo no
es `production` o la configuración productiva es inválida
(`loadProductionConfig`), falta el modelo o la red (`R4_MODEL_*`,
`R4_PROD_ALLOW_NETWORK`), la configuración del worker es inválida
(`loadWorkerConfig`/`validateWorkerConfig`), la BD no responde o el esquema
Core no está al día (`createWorkerPlatform` → `migrationStatus`). Un worker
que llegó a `worker.started` estaba bien compuesto en ese momento. Después,
el bucle tolera fallos de BD (reintenta) y el kill switch sólo niega la
admisión de trabajo nuevo (`worker.admission.refused`), sin detener el
proceso. Nada de esto es visible para otro proceso.

**Evidencia existente para otro proceso (clasificación).**

| Mecanismo | Qué prueba | Clasificación | Por qué no basta |
|---|---|---|---|
| Leases de task (`agent_tasks`: owner, generation, expires_at, heartbeat) | Un worker ejecuta *esa* task | REUTILIZABLE PERO INCOMPLETO | Sólo existe mientras hay una task reclamada: un worker ocioso sano no deja rastro. Su semántica de expiración en reloj de BD sí es reutilizable. |
| `pg_stat_activity` (`application_name = r4-worker:<workerId>`) | Una sesión de BD abierta | REUTILIZABLE PERO INCOMPLETO | Sesión ≠ bucle de claim vivo; con partición de red o caída del host el backend semiabierto persiste hasta el keepalive TCP (frescura no acotada); el worker de **shadow** usa el mismo `runWorkerProcess` y el mismo nombre, así que un worker no productivo lo satisfaría; sin modo ni compatibilidad; depende de privilegios de rol y del `idleTimeoutMillis` del pool. |
| Telemetría (`worker.started/stopped`, `worker.admission.*`) | Eventos en logs | SIN MECANISMO ADECUADO | No consultable ni durable entre procesos. |
| `autonomy_controls`, `*_events`, `temporal_events` | Control/auditoría | SIN MECANISMO ADECUADO | Semántica distinta; eventos inmutables. |
| Actividad (último Run/AgentDecision/outbound) | Trabajo pasado | Excluido por diseño | Un worker sano puede no tener trabajo. |
| Build/SHA en runtime | — | SIN MECANISMO ADECUADO | El runtime no conoce su SHA (sólo los artefactos del evaluador). |

**Conclusión:** SIN MECANISMO ADECUADO para readiness entre procesos. Hace
falta presencia de worker durable, genérica y con frescura acotada.

**Implementado (offline, sobre `b561178`).** Diseño completo en
[arquitectura §19.6](R4_ARCHITECTURE.md). Resumen operativo:

| Superficie | Significado | Uso |
|---|---|---|
| `/health` | El proceso gateway vive | Liveness |
| `/ready` | El canal puede aceptar y persistir trabajo (BD, esquema, controles, canal). **No** depende de workers | Readiness del balanceador/ingress |
| `/ready/r4` | `/ready` **y** ≥ 1 worker de producción fresco, compatible y `ready` | Gate previo al cutover y observación operativa |

- **Presencia** (`worker_presence`, 0008 aditiva): una fila por proceso worker,
  renovada **sólo por progreso real** (ciclo del bucle completado — ocioso,
  admisión rechazada o ejecutado — o renovación de lease con una task en
  curso); `expires_at = clock_timestamp() + R4_WORKER_LEASE_MS` (30 s) con
  renovaciones cada `R4_WORKER_HEARTBEAT_MS` (10 s). Un bucle atascado o un
  proceso muerto vencen solos; un apagado ordenado publica `stopping` y nunca
  vuelve a `ready`. Filas vencidas > 24 h se purgan al registrar y como
  máximo cada hora (nunca en cada heartbeat).
- **Quién cuenta**: sólo `execution_mode = production`, `state = ready`, no
  vencida y `compatibility = 0008_worker_presence:sales-production@1` (cabeza
  de esquema Core + versión del perfil; nada de configuración). Shadow, test,
  vencidos, incompatibles, `not_ready` y `stopping` no cuentan.
- **Diagnóstico** (`checks.execution.status`): `ready`, `no_worker`, `stale`,
  `incompatible`, `not_ready`, `stopping`, `unavailable` (presencia ilegible:
  nunca listo) + conteos, razones y `buildRefs`. Fallas de BD/esquema/canal se
  ven en `checks.channel`. Sin secretos, URLs, entorno ni datos de cliente.
- **Kill switch**: no participa (autonomía deshabilitada ⇒ worker sigue `ready`).
- **Modelo**: sin llamada de readiness; validación estática al arrancar.
- **`build_ref`**: diagnóstico. El despliegue entrega el SHA Git inmutable como
  `R4_BUILD_REF` (opcional; 1–64 caracteres `[A-Za-z0-9._-]`, recortado) y el
  worker lo registra tal cual en `worker_presence.build_ref`; nunca lo deriva de
  git ni de una rama. Ausente ⇒ `NULL`. No participa en compatibilidad ni
  readiness; se ve en `checks.execution.workers.buildRefs` de `/ready/r4`.
- **Ingress durante caída del worker**: `/ready` 200, inbound persistido
  (Task/input durables), `/ready/r4` 503; al volver un worker compatible el
  trabajo se procesa por la semántica normal de Tasks.
- **Rollback**: gateway nuevo + worker anterior ⇒ `/ready/r4` no listo
  (intencional). Worker nuevo sobre BD en 0007 ⇒ no arranca (`schema_not_current`).

**Consecuencia para el cutover.** Antes de mover el webhook de Meta a R4:
`/ready` **y** `/ready/r4` en 200 en el entorno productivo. Después del
cutover, una caída temporal del worker se ve en `/ready/r4` sin afectar la
aceptación durable del inbound (`/ready` es la única que debe usar un
balanceador).

**Evidencia.** `tests/integration/worker-readiness.test.ts` (worker muerto,
retorno, multi-worker, shadow/test, incompatible, kill switch, apagado, bucle
atascado, ingress durante caída, sin efectos, sin secretos, `build_ref`,
BD/esquema), `tests/unit/worker/presence.test.ts`,
`tests/unit/task-runtime/worker-presence.test.ts`,
`tests/contract/worker-presence-boundaries.test.ts`,
`tests/recovery/worker-presence-process.test.ts` (procesos reales, SIGKILL),
`npm run test:mutation:worker-readiness`.

**Estado:** B-5 **RESUELTO OFFLINE** — no validado live (no hay despliegue).

## 10. Bootstrap productivo: registro de la AgentDefinition de Sales

**Hallazgo del primer inbound live.** Meta → HTTPS/Nginx → gateway, la
autenticación del webhook, la persistencia del inbound, el dedupe de
reentregas y el binding de conversación funcionaron; la apertura de la Task
falló con `agent_not_found` (`agent "sales" is not registered`) y
`agent_definitions` tenía 0 filas. Causa: el único que registra definiciones
(`loadAgentDefinitionsFromDirectory` + `AgentRegistry.sync`) es `apps/api` al
arrancar; el despliegue productivo corre gateway + worker, y ninguno registra
(a propósito: el registro es un acto explícito, no un efecto de arrancar un
proceso). El inbound queda durable y sin asentar; el gateway responde 5xx y
Meta reentrega.

**Solución.** `npm run production:sales:bootstrap`: registra sólo
`agents/sales/sales.agent.json` por el mismo límite del Agent Registry
(`registerAgentDefinitions` en `@r4/api`, sin HTTP). Primera vez
`registered: sales@1`; repetido `unchanged: sales@1`; misma versión con
contenido distinto ⇒ `agent_definition_version_immutable` (publicar versión
nueva). Fail-closed sin `R4_EXECUTION_MODE=production` y configuración
productiva completa, sin `R4_DATABASE_URL` válida, con esquema Core/Sales no
al día, con definición ausente/ilegible/inválida o con la BD caída. No habilita
autonomía, no toca rollout, no llama al modelo ni a Meta, no usa red salvo
PostgreSQL y no arranca procesos. No es una migración.

**Orden canónico de despliegue:** `db:migrate` → `sales:migrate` →
`production:sales:bootstrap` → `production:sales:plan` → gateway → worker.

Tras el bootstrap, el inbound que quedó sin asentar se ingiere solo: el gateway
lo reanuda (`R4_GATEWAY_RESUME_AFTER_MS`, 30 s por defecto) o llega por la
reentrega de Meta; sin segunda cola ni intervención manual.

**Evidencia.** `tests/integration/production-bootstrap.test.ts` (registro,
idempotencia, inmutabilidad, sólo Sales, definición ausente/ilegible/inválida,
modo no productivo, BD caída, esquema pendiente, sin efectos; y el hueco real:
gateway sin API ⇒ `agent_not_found` ⇒ bootstrap ⇒ el mismo inbound durable
abre la Task `sales@1`), `tests/recovery/production-bootstrap-process.test.ts`
(el comando construido, un proceso por ejecución),
`tests/contract/live-ops-boundaries.test.ts` (sólo `AgentRegistry.sync`;
gateway y worker nunca registran).
