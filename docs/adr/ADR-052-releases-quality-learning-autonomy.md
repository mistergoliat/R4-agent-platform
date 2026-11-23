# ADR-052 — Lanzamientos, calidad, aprendizaje y autonomía: lecturas deterministas (v1)

- **Identificador:** `R4-INSIGHTS-01`
- **Estado:** **Propuesto** (owner autorizó «lanzamientos, calidad, aprendizaje y autonomía», 2026-11-19).
  Desplegar necesita autorización explícita del owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-19: completar la Fase 4 de ADR-049 (mejora continua) y adelantar la parte de autonomía y
  aprendizaje de la Fase 5 que no depende de otros servicios.
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «la evaluación se entrega con la
  implementación»; «no guardar razonamiento»); ADR-049 (consola, Decisión 6: lector de servicio); ADR-050 (identidad
  de operador); ADR-051 (incidentes).

## Contexto

La consola ya muestra actividad, incidentes y el detalle de cada conversación. Le faltan cuatro vistas para decidir
qué mejorar: comparar versiones del agente (lanzamientos), ver hasta dónde llegan las conversaciones (calidad), juntar
lo que el agente no pudo resolver solo (aprendizaje) y ver qué decide la política en cada capability (autonomía).
Todo lo necesario ya está en tablas durables: tareas, runs, pasos, decisiones de política, recibos, pedidos humanos y
eventos temporales.

## Decisión 1 — Lecturas deterministas, sin modelo

Las cuatro vistas son consultas SQL sobre tablas existentes, calculadas al leer, sobre una ventana de `N × 24 h` hasta
ahora (sin límite superior, como ADR-051). **Ninguna llama a un modelo.** No hay proceso ni infraestructura nueva.

**Core genérico.** Ninguna vista conoce un dominio: las etapas de calidad son prefijos de capability que entrega quien
llama (la consola), y las acciones se cuentan por `capability_id` tal cual.

Todas usan el lector de servicio (ADR-049, Decisión 6) o una persona verificada. Ninguna devuelve texto de mensajes,
razonamiento ni datos de contacto, **salvo** las brechas de aprendizaje (Decisión 4).

Implementación: `packages/persistence-postgres/src/insights.ts` (`PostgresInsights`).

## Decisión 2 — Lanzamientos: `GET /v1/production/versions?days=N`

`days` de 1 a 31 (14 por defecto). Una fila por `agentId` + `agentVersion`, ordenadas por agente ascendente y versión
descendente:

- `tasks`: tareas creadas en la ventana con esa versión.
- `runs`, `failedRuns`, `modelCalls`, `inputTokens`, `outputTokens`, `capabilityCalls`: runs iniciados en la ventana
  con esa versión.
- `agentHandoffs`, `platformHandoffs`: traspasos (`human_requests` de tipo `handoff`) creados en la ventana, por
  `payload.initiatedBy` (`agent` / `platform`), atribuidos a la versión de la tarea. Los del operador no cuentan.
- `actionsSucceeded`: recibos `succeeded` registrados en la ventana, por `capability_id`; la versión es la de la
  propuesta.
- `customerTurn`: p50, p95 y cantidad de la latencia de respuesta, con la **misma** definición que `activity`,
  `metrics()` y el detector `slow_reply` (`customerTurns`), atribuida a la versión del run que respondió.
- `incidents`: suma de ocurrencias por gravedad de los grupos de ADR-051 de esa versión en la misma ventana.
- `firstSeen` / `lastSeen`: primer y último inicio de run en la ventana; si la versión no tuvo runs, el primer y
  último hecho de cualquiera de las fuentes anteriores.

## Decisión 3 — Calidad: `GET /v1/quality/funnel?days=N&stage=<prefijo>&stage=...`

`days` de 1 a 31 (14 por defecto); de 1 a 6 `stage`, cada uno `^[a-z][a-z0-9_.-]{0,63}$`, en el orden que se den.
Por versión del agente de la tarea, sobre las tareas creadas en la ventana:

- **«Llegó» a una etapa** una tarea que, en cualquier momento de su vida, tiene:
  1. un paso `read_capability` cuya `decision.capabilityId` empieza con el prefijo **y** cuya observación salió
     `succeeded` (una lectura rechazada o fallida no cuenta), **o**
  2. un recibo de acción `succeeded` (una acción gobernada que nació de un `propose_action`) cuyo `capability_id`
     empieza con el prefijo. Una propuesta denegada, rechazada por una persona o pendiente de aprobación no cuenta.

  «Empieza con» es literal (`starts_with`): `_` y `%` no son comodines.
- `conversations`: tareas creadas en la ventana; `reached[i]`: tareas que llegaron a `stages[i]`.
- `handedOff`: tareas con algún traspaso (de cualquier origen). `idleClosed`: estado `cancelled` con motivo
  `idle_timeout` (ADR-047). `cancelled`: el resto de las canceladas. `failed`: estado `failed`. Es el estado actual de
  la tarea.
- `repeatedReads`: tareas con algún run que leyó la misma capability 4 veces o más (`REPEATED_READS`), cualquiera
  haya sido el resultado de la lectura.

## Decisión 4 — Aprendizaje: brechas y una base de conocimiento curada

**Brechas** — `GET /v1/learning/gaps?days=N` (1 a 31, 14 por defecto): lo que el agente no pudo resolver solo, del más
nuevo al más antiguo, hasta 200. Consultas, traspasos pedidos por el agente y traspasos de la plataforma creados en la
ventana (no los del operador). Cada una trae:

- `text`: la pregunta de la consulta o el resumen del traspaso del agente (texto escrito por el agente); `null` en
  traspasos de la plataforma.
- `reason`: el código de motivo del traspaso de la plataforma.
- `answer`: el contenido de la última respuesta humana (`temporal_events.data.content` de un evento con
  `response_key`, sobre el pedido o una toma de control de él). Las liberaciones de la plataforma no cuentan.

**Esta es la única lectura de este ADR con texto.** Se acepta porque la consola es privada y la lectura exige el
lector de servicio o una persona verificada. Aun así, `text` y `answer` pasan por `maskContact`: cualquier correo y
cualquier serie de 8 o más dígitos (se permiten hasta dos separadores entre dígitos: espacios, puntos, guiones,
paréntesis) se reemplazan por `[masked]`. Así quedan fuera teléfonos, RUT y correos.

**Base de conocimiento** — migración Core `0018_knowledge_entries`:

- `knowledge_entries (entry_id, topic 1..120, statement 1..2000, source 1..300, source_ref, state, created_by/at,
  verified_by/at, signed_by/at, retired_by/at, expires_at date)`, con `state` en `proposed`, `verified`, `signed`,
  `retired`. La fila guarda el estado actual.
- `knowledge_entry_events`: cada cambio (la creación incluida) con estado de origen y destino, nota, quién, cuándo y
  correlation id; append-only con el mismo disparador de inmutabilidad que los demás libros. Evento y fila se escriben
  en una transacción; las horas son de la base.
- `GET /v1/learning/knowledge` (lector): `{ entries }`, todos los estados, del más nuevo al más antiguo, hasta 500.
- `POST /v1/learning/knowledge` con `{ topic, statement, source, sourceRef?, expiresAt? (YYYY-MM-DD) }`: crea la
  entrada `proposed` y responde `201 { entry }`. Exige el ámbito `knowledge.curate`.
- `POST /v1/learning/knowledge/transition` con `{ entryId, to, note (1..500) }`: responde `{ entry }`.

  | De | A | Ámbito |
  |---|---|---|
  | `proposed` | `verified` | `knowledge.curate` |
  | `verified` | `signed` | `knowledge.sign` |
  | `proposed`, `verified`, `signed` | `retired` | `knowledge.curate` |

  Cualquier otra transición responde `409 invalid_transition`; una entrada inexistente, `404
  knowledge_entry_not_found`; sin el ámbito de esa transición, `422 human_scope_denied`. La firma separa a quien
  verifica de quien firma solo si el registro de operadores asigna los ámbitos así.

**La base es curada pero ningún agente la consume todavía.** No entra en el contexto de ninguna tarea. Consumirla es
una versión nueva de una definición de agente (o de un carril) con su propia evaluación, y necesita autorización del
owner. `expires_at` es informativo: nada cambia de estado solo.

## Decisión 5 — Autonomía: `GET /v1/autonomy?days=N`

`days` de 1 a 31 (30 por defecto). Por versión del agente y capability, ordenado por agente, versión descendente y
capability:

- `decisions`: decisiones de política (`policy_decisions`) evaluadas en la ventana, por resultado. Una aprobación
  humana vuelve a evaluar la propuesta: esa segunda decisión (`allow`, `human_approved`) también cuenta.
- `denyReasons`: `reason_code` de las denegaciones.
- `approvals`: pedidos de aprobación creados en la ventana, por capability del `payload` y versión de la propuesta:
  `approved`, `rejected` y `pending` (`requested`). Cancelados y vencidos no cuentan.
- `receipts`: recibos registrados en la ventana por estado.
- `riskClass` y `lastDecisionAt`: los de la última decisión en la ventana; `null` si no hubo decisiones en la ventana.

**Los límites de autonomía del host no son de R4.** El carril, el porcentaje de clientes y demás variables de entorno
del despliegue se cambian con las operaciones de host de la consola (ADR-049, Fase 3), no con esta API. Esta vista
solo muestra lo que la política decidió.

## Fuera de alcance

- **Un auditor de calidad con modelo.** Necesita una decisión de presupuesto del owner. `packages/evaluation` ya tiene
  evaluadores por rúbrica y semánticos para cuando se autorice.
- Que un agente consuma la base de conocimiento (Decisión 4).
- Cambiar límites de autonomía desde R4 (Decisión 5).
- Costo en dinero por versión: se muestran tokens, como en ADR-049.

## Consecuencias

- Una migración Core nueva (`0018_knowledge_entries`) y dos ámbitos humanos nuevos (`knowledge.curate`,
  `knowledge.sign`). La migración cambia la cabeza del esquema Core y con ella la compatibilidad que declaran gateway
  y workers (`0018_knowledge_entries:<perfil>`): se despliegan juntos, como con toda migración Core.
- El registro de operadores de la consola (ADR-050) debe incluir esos ámbitos en los `scopes` de quien cure o firme.
- Las lecturas dependen de los códigos que ya guardan las tablas fuente (`initiatedBy`, `idle_timeout`,
  `decision.capabilityId`, estados de recibos y pedidos); las pruebas de integración los fijan.
- Sin procesos ni infraestructura nueva.
