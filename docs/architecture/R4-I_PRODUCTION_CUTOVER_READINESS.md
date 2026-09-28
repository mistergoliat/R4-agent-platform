---
title: R4-I — Cutover del número productivo de WhatsApp a R4 — inventario y gate de readiness
status: BLOQUEADO antes del cutover live (ver §5)
owner: architecture
last_reviewed: 2026-09-28
r4_baseline: 34e83c687a8375a29fbabe55166a6652c6b1da2d (R4-I PRE-CUTOVER BASELINE; HEAD = origin/main)
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
| 12 | n8n `WA_00_Webhook_Master` (webhook `wa-webhook`), `active: true` en el export 2026-06-12 → `OPS_Response_Executor_SendWhatsApp` | n8n (fuera de ambos repos) | **Sí** | **Sí** | **Sí** (sub-workflow con credencial Meta propia en n8n) | desconocido | Sí (`AI_Orchestrator`, `AI_AGENT_Postventa` vía DeepSeek) | **Sí** — independiente del CRM | estado vivo en n8n + credencial n8n | **UNKNOWN** (estado actual, credencial y URL de callback no verificables desde aquí) |
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
- El camino #9 (respuesta manual legacy) no pasa por ningún flag de
  `BRAIN_*`: apagar los flags del brain **no** lo apaga.

## 2. Invariante de escritor único — cómo se garantiza de forma determinista

Apagar flags de entorno del CRM es necesario pero **no suficiente**: n8n (#12)
tiene su propia credencial y los scripts (#13) pueden ejecutarse fuera del
proceso desplegado. El único control determinista sobre "quién puede crear un
efecto en Meta para este número" es la credencial:

1. **Rotar/revocar** todo access token con permiso `whatsapp_business_messaging`
   sobre el WABA del número (system user(s) y cualquier token de usuario usado
   por CRM o n8n). Emitir un token nuevo **sólo** al almacén de secretos de R4
   (`R4_WHATSAPP_ACCESS_TOKEN`). Todo portador antiguo (CRM web, workers, n8n,
   scripts, portátiles) queda sin capacidad de envío, corra o no.
2. Además, por higiene y para evitar ruido de errores: en el entorno productivo
   del CRM `BRAIN_META_SEND_ENABLED=false`, `BRAIN_OUTBOX_WORKER_ENABLED=false`,
   `BRAIN_AUTONOMOUS_REPLY_ENABLED=false`, `BRAIN_WHATSAPP_TYPING_INDICATOR_ENABLED=false`,
   eliminar `META_ACCESS_TOKEN`, `META_WHATSAPP_ACCESS_TOKEN`; detener
   `worker:outbox`, `worker:followup`, `worker:commercial-work`,
   `worker:turn-settle`; reiniciar el web.
3. En n8n: desactivar `WA_00_Webhook_Master`, `OPS_Response_Executor_SendWhatsApp`
   y cualquier workflow que use la credencial WhatsApp/Meta; borrar esa
   credencial.
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
| `/ready` del gateway | DB + migraciones + controles legibles | Correcto (no false-green); `/health` es liveness |
| Worker | `production:sales:worker`; exige modelo `R4_MODEL_*` y red | **Sin superficie de health/readiness** (proceso sin HTTP) |
| Kill switch | `autonomy_controls`, creado deshabilitado por migración; lectura fallida = deshabilitado | Legible; **no liberable en producción** (ver §5 B-3) |
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
| 8 | Health del worker | **NO** — no desplegado; sin superficie de health | §3 |
| 9 | Health de BD | **NO** — sin BD productiva | — |
| 10 | Kill switch legible y ON | Legible por construcción; **no se puede liberar después** | §5 B-3 |
| 11 | Secuencia de apagado del CRM | Definida (§2) — no ejecutable desde aquí (host CRM no identificado) | §2 |
| 12 | Secuencia de apagado n8n/legacy | Definida (§2) — estado vivo de n8n **desconocido** | §1 #12 |
| 13 | Endpoint/config de rollback conocidos | **NO** | — |
| 14 | Endpoint de webhook actual registrado | **NO** — sólo visible en la app de Meta | — |
| 15 | Endpoint R4 verificado | **NO** — no hay URL pública desplegada | — |
| 16 | Ningún escritor UNKNOWN | **NO** — §1 #12 | — |
| 17 | Logs sin secretos | Sí (código) | §3 |
| 18 | Gate de red entendido | Sí: `R4_PROD_ALLOW_NETWORK` + https | §3 |

## 5. Bloqueos (condiciones STOP alcanzadas)

- **B-1 (STOP A, C, K, §60).** Identificadores productivos no verificados: app
  de Meta, WABA, `phone_number_id`, URL de callback actual (CRM vs n8n), host
  del CRM, instancia n8n, target AWS de R4, BD productiva de R4. Este entorno
  no tiene AWS CLI/credenciales, llaves SSH ni acceso a Meta Business.
- **B-2 (STOP A).** Escritor UNKNOWN: n8n `OPS_Response_Executor_SendWhatsApp`
  con credencial propia. Se resuelve con §2 (revocación del token + desactivar
  n8n) ejecutado y verificado por quien tenga acceso.
- **B-3 (STOP G) — hallazgo de plataforma.** El kill switch se lee pero **no
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

No hace falta migración ni cambio de protocolo/Core para ninguno de ellos.

## 6. Decisiones requeridas

- **D-5 — Control del kill switch sin IAM.** Propuesta mínima: un comando de
  host `production:sales:control --autonomy on|off --reason "…"` que construye
  un `TrustedHumanContext` con `humanRef = "host-operator:<nombre declarado>"` y
  scope `autonomy.control` y llama `AutonomyControls.setControl` (auditado en
  `autonomy_control_events`). Frontera de confianza = acceso de shell al host
  productivo. No es IAM; no abre la API HTTP. Alternativa: aceptar SQL directo
  documentado (no recomendado).
- **D-6 — Conversaciones entregadas a humanos tras el cutover.** Sin UI de
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

**Nivel 1 — autonomía (preferido).** Kill switch ON (requiere D-5). R4 sigue
dueño; inbound durable; callbacks continúan; sin cognición ni efectos nuevos;
outbound `pending` retenido (no cancelado).

**Nivel 2 — canal (falla severa de plataforma).** En este orden: (1) kill
switch ON en R4; (2) detener el dispatcher del gateway (SIGTERM, termina el
envío en vuelo); (3) restaurar en Meta la URL de callback y el verify token
**registrados** en el paso 1 (app/WABA/número según dónde estaba el override);
(4) entregar un token al único escritor restaurado (CRM **o** n8n, el que era
dueño) y reactivar sólo ese camino; (5) verificar el challenge. Nunca dejar a
R4 y al escritor restaurado con token válido a la vez. Outbound de R4 en
`unknown` se listan para revisión manual antes de reactivar el escritor viejo.

Valores a registrar (sin secretos): URL de callback actual y nivel del override,
app de Meta (id), WABA (id), `phone_number_id`, qué sistema(s) tienen token,
flags `BRAIN_*` productivos actuales, estado de los workflows n8n, procesos CRM
activos, SHA/versión de R4 desplegada, versión de migración, estado del kill
switch.
