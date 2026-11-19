# ADR-051 — Incidentes: detectores deterministas, agrupación y triage

- **Identificador:** `R4-INCIDENTS-01`
- **Estado:** **Propuesto** (owner autorizó iniciar la Fase 4 de ADR-049, 2026-11-19). Desplegar y abrir pedidos en
  GitHub necesitan autorización explícita del owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-18: «que el propio sistema detecte sus propios errores… que quede el registro para ver si
  vale o no la pena abrir un pedido a revisión».
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «la evaluación se entrega con la
  implementación»); ADR-028 (fallas de run); ADR-041 (avisos de plataforma); ADR-044 (cierre de turno);
  ADR-049 (consola, Fase 4); ADR-050 (identidad de operador).

## Contexto

Hoy las fallas se encuentran a mano, revisando logs. R4 ya guarda en tablas durables todo lo necesario para
detectarlas: runs con su terminación, pasos con su código de error, traspasos con su motivo, envíos y entrantes con su
estado, y la latencia de cada respuesta. Lo que falta es juntarlas, agruparlas y decidir qué hacer con cada grupo.

Datos de producción, últimos 14 días (2026-11-19), solo agregados:

| Señal | Cantidad |
|---|---|
| Runs fallidos por salida inválida del modelo (`invalid_decision/invalid_structured_output`) | 3 |
| Run fallido por evidencia desconocida (`invalid_decision/unknown_evidence`) | 1 |
| Run fallido por caída del proveedor (`model_failure/provider_error`) | 1 |
| Run fallido por tope de escrituras (`budget_exhausted/max_write_actions`) | 1 |
| Traspasos hechos por la plataforma (contenido no soportado, falla del modelo, presupuesto, kill switch, rollout) | 7 |
| Entrantes rechazados por venir de otro número de negocio (`foreign_business_number`) | 53 |
| Envíos fallidos, desconocidos o no entregados | 0 |

## Decisión 1 — Detectores deterministas, calculados al leer

Un **incidente** es un grupo de ocurrencias con la misma **firma**: `detector + agente + versión + código`. Los
detectores son consultas SQL sobre tablas que ya existen, sin modelo y sin proceso nuevo: se calculan cuando la
consola los pide, sobre una ventana de días. No hay tabla de ocurrencias que mantener.

| Detector | Qué detecta | Gravedad |
|---|---|---|
| `customer_unanswered` | El último mensaje del cliente en una tarea no tiene respuesta aceptada por el canal después de 10 minutos, la tarea no la tiene una persona y la conversación es autónoma | crítica |
| `run_failed` | Run terminado en `failed`, por `termination_reason/termination_code` | alta si es `model_failure` o `budget_exhausted`; media en el resto |
| `platform_handoff` | Traspaso iniciado por la plataforma, por motivo | media; informativa para `autonomy_disabled` y `rollout_excluded` |
| `step_error` | Paso rechazado o inválido aunque el run se haya recuperado, por `error_code` | baja |
| `outbound_problem` | Envío `failed`, `unknown` o cancelado por `expired`/`window_closed` | alta (`unknown`: crítica) |
| `inbound_problem` | Entrante `failed` (alta) o `rejected` por código (informativa) | según el caso |
| `slow_reply` | Respuesta al cliente que tardó más de 60 s | media |

Cada grupo entrega: firma, detector, gravedad, agente y versión, código, cantidad, primera y última vez, y hasta 5
tareas de ejemplo (identificadores opacos). **Nunca** texto de mensajes, datos de contacto ni razonamiento.

Los umbrales (10 minutos, 60 s) son constantes con nombre en el código; cambiarlos es un cambio revisado.

**Implementación** (`packages/persistence-postgres/src/incidents.ts`, `UNANSWERED_AFTER_MS`, `SLOW_REPLY_MS`):

- Firma: `` `${detector}:${agentId ?? '-'}@${agentVersion ?? '-'}:${code}` `` (hasta 300 caracteres). Agente y versión
  salen del run (`run_failed`, `step_error`, `slow_reply`) o de la tarea (el resto); un entrante sin tarea va con
  `-@-`.
- Códigos: `run_failed` usa `termination_reason/termination_code`; `platform_handoff` el motivo del traspaso;
  `step_error` el `error_code` del paso (solo `refused` e `invalid`; `model_failed` ya queda en `run_failed`);
  `outbound_problem` usa `failed/<error_code>`, `unknown` o `cancelled/expired|window_closed`; `inbound_problem` usa
  `failed/<failure_code>` (alta) o el `failure_code` del rechazo tal cual (informativa, p. ej.
  `foreign_business_number`); `slow_reply` usa `customer_turn_over_60s`; `customer_unanswered` usa
  `no_accepted_reply`.
- «Respondido» en `customer_unanswered`: existe un envío de la tarea (de cualquier origen) con `accepted_at` igual o
  posterior a la última entrada de la tarea (`task_inputs.received_at`). Además la conversación debe tener un binding
  `autonomy = 'autonomous'` y la tarea no tener un traspaso `requested` ni `active`.
- `slow_reply` reutiliza la definición de latencia de turno de la consola (`customerTurns`, la misma de `activity` y de
  `metrics().latency.customerTurnMs`).
- Ventana: las últimas `N × 24 h` hasta ahora, sin límite superior (una diferencia de reloj entre la API y la base no
  esconde ocurrencias). Los ejemplos son tareas distintas, la más reciente primero.

## Decisión 2 — Triage durable y mínimo

La única tabla nueva guarda la decisión humana sobre una firma: `incident_triage (signature, state, note,
request_url, decided_by, decided_at)`, con `state` en `ignored` (con motivo) o `requested` (con el enlace al pedido).
Una firma sin fila está `open`. El triage es append-only por historia: cada decisión nueva se registra como evento y
la fila guarda la última. La historia vive en `incident_triage_events` (mismo disparador de inmutabilidad que los
demás libros); evento y fila se escriben en una transacción y `decided_at` es la hora de la base (la misma que la de
las tablas fuente con que se compara para reabrir).

- **Lectura:** `GET /v1/incidents?days=N` (1 a 31) devuelve los grupos con su triage. Usa el lector de servicio
  (ADR-049, Decisión 6).
- **Escritura:** `POST /v1/incidents/triage` con `{ signature, state, note, requestUrl? }`. Exige una persona
  verificada con el ámbito nuevo `incident.triage` (ADR-050). La consola lo firma como cualquier otra acción.
  `note` de 1 a 1000 caracteres; `requestUrl` debe ser `https://` y es obligatoria con `requested`; la firma se valida
  por formato. Responde `{ signature, triage: { state, note, requestUrl, decidedBy, decidedAt } }`.
- **Reabrir solo:** un grupo `ignored` o `requested` cuya última ocurrencia es posterior a la decisión vuelve a
  mostrarse como `reopened`, sin cambiar la fila.
- **Resuelto (`quiet`): no implementado en esta entrega.** Necesita saber cuándo fue el último despliegue, dato que R4
  no guarda hoy; queda para un paso siguiente de la Fase 4. Los estados que devuelve la lectura son `open`,
  `ignored`, `requested` y `reopened`.

## Decisión 3 — Pedidos en GitHub, desde la consola

El pedido es un issue en el repositorio de R4, creado por el backend de la consola con un token de GitHub de alcance
mínimo (issues de ese repositorio). R4 no habla con GitHub.

- **El repositorio de R4 es público:** el issue lleva solo la firma, el detector, la gravedad, conteos, fechas,
  versión y los identificadores opacos de tareas. Nunca texto de conversaciones, teléfonos, correos ni nombres de
  clientes. La evidencia completa se ve en la consola.
- Al crearlo, la consola registra el triage `requested` con el enlace.

## Fuera de alcance de esta decisión (siguientes pasos de la Fase 4)

- Reglas que abren pedidos solas (cliente sin respuesta, repetición, error nuevo tras un despliegue).
- Un agente de código que prepare el PR en borrador desde el issue.
- El detector de lecturas repetidas del mismo producto (falta guardar una huella de los argumentos de cada lectura).
- Lanzamientos (comparación de versiones), calidad, aprendizaje y autonomía.

Cada uno necesita su propia autorización; los dos primeros, además, decisiones del owner (token y presupuesto).

## Consecuencias

- Una migración Core nueva (`0017_incident_triage`) y un ámbito humano nuevo (`incident.triage`). La migración
  cambia la cabeza del esquema Core, y con ella la compatibilidad que declaran gateway y workers
  (`0017_incident_triage:<perfil>`): se despliegan juntos, como con toda migración Core.
- El registro de operadores de la consola (ADR-050) debe incluir `incident.triage` en los `scopes` del operador que
  hará el triage; sin él, `POST /v1/incidents/triage` responde `human_scope_denied`. Los roles del registro de Sales
  (ADR-033) no lo incluyen.
- Sin procesos ni infraestructura nueva: los detectores son lecturas acotadas por ventana.
- Los incidentes dependen de que las tablas fuente sigan guardando su código de error; un cambio de esos códigos debe
  revisar los detectores (las pruebas los fijan).
