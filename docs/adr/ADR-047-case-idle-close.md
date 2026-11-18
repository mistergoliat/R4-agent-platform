# ADR-047 — Cierre de caso por inactividad del contacto, y respuestas canceladas fuera del contexto

- **Identificador:** `R4-CASE-IDLE-CLOSE-01`
- **Estado:** **Propuesto.** Implementado en la rama `feat/r4-case-idle-close`. Pendiente de revisión y merge. No
  desplegado ni activado (apagado por defecto).
- **Fecha:** 2026-11-17
- **Mandato:** decisión del owner (2026-11-17): un caso se cierra tras **24 horas sin mensaje del cliente**, siguiendo la
  ventana de atención de WhatsApp. El mensaje siguiente abre un caso nuevo que recuerda el anterior por los turnos
  recuperados. No hay resumen generado.
- **Autoridad superior:** Constitución; PRD; ADR-021/022 (Temporal Runtime, reloj temporal); ADR-029 (modo productivo);
  R4-J4-R7-4 (continuidad entre tasks, `PriorConversationContextSource`); ADR-044 (Turn Completion Guard).

## Contexto

Una task de conversación casi nunca termina: espera input indefinidamente y sólo acaba con `tasks cancel`, un
`complete` del agente o una intención terminal. Así los presupuestos por task no se reinician, el contexto crece sin
límite (~55k tokens de entrada por llamada tras un día) y una baja posterior del rollout nunca saca a un cliente del
carril, porque la elegibilidad se decide al abrir el binding. Cuando una task termina, la ingesta cierra su binding y el
mensaje siguiente abre binding y task nuevos, que reciben los últimos turnos de la conversación (R7-4). Eso ya funciona.

## Decisión 1 — cierre por inactividad

1. **Capacidad genérica de plataforma, fuera de Sales.** La regla vive en el Core (`idleRefusal` y
   `TemporalRuntime.cancelIdleTaskByPlatform`, `@r4/task-runtime`). El barrido vive en live-ops
   (`CaseIdleCloser`) y lo compone el channel gateway. No hay conceptos de dominio.
2. **Qué se cierra.** Una task ligada a un binding **abierto** del canal del gateway, en estado `waiting` sobre una
   espera `WAIT_FOR_INPUT`, cuyo input más nuevo (o su creación, si no tiene) es al menos tan antiguo como el umbral,
   medido en el reloj temporal `r4_now()`, el mismo de `task_inputs.received_at`.
3. **Qué nunca se cierra:** una ejecución de acción sin resolver (`prepared`, `executing`, `needs_reconciliation`), un
   outbound `pending` (también retenido), `dispatching` o `unknown`, una consulta, aprobación o handoff `requested` o
   `active`, una intención terminal diferida, ni un resultado de aprobación pendiente de aplicar. Tampoco una task
   `WAIT_UNTIL`: es el temporizador del propio agente y lo despierta el scheduler. El Core comprueba todas estas
   condiciones bajo el lock (`idleRefusal`; los outbounds los lee `idleActivity`, con el mismo lock de task que toman
   la materialización y el claim de despacho). La preselección SQL aplica las mismas exclusiones, para que un
   candidato que siempre se rechazaría no ocupe la cabeza de cada lote. Además, deja fuera una conversación con un
   mensaje recibido pero aún no ingerido (`inbound_events.status = 'received'`, por ejemplo una imagen en
   percepción): eso también es actividad.
4. **Tasks bloqueadas en `human_handoff` (o en un hold de plataforma): nunca se cierran solas** (decisión del owner,
   2026-11-18). Quedan abiertas para los operadores, como un ticket. Una persona es dueña de la conversación; cerrarla
   cortaría su trabajo, y el siguiente mensaje del cliente llegaría a una task nueva y autónoma sin que el operador lo
   sepa. El operador la libera o la cancela con `tasks cancel`. Mientras el kill switch esté activo, las tasks
   retenidas tampoco se cierran.
5. **Cómo se cierra.** Por la misma transición que `tasks cancel` (`cancelTaskByPlatform`: corrida, lease, espera,
   solicitudes y temporizadores), con estado `cancelled` y razón de estado **`idle_timeout`**. El evento
   `task.cancelled` registra al actor `platform:case-idle-close`, `reason: idle_timeout`, `lastActivityAt` y
   `idleForMs`, y aparece en el hilo del operador. El binding se cierra con `closed_reason = idle_timeout`. **No se
   envía nada al cliente.**
6. **Concurrencia e idempotencia, sólo con estado durable.** La consulta del store únicamente preselecciona. La regla se
   vuelve a decidir dentro de la transacción del Temporal Runtime, bajo el lock de fila de la task, que también toma
   cada input. Hay dos órdenes posibles:
   - el mensaje entra primero: despierta la task, que deja de estar `waiting`, y el cierre se rechaza (`not_idle`);
   - el cierre entra primero: la ingesta encuentra la task terminal, cierra el binding (con `idle_timeout`, por la
     razón de estado) y abre binding y task nuevos.
   En ningún orden se pierde el mensaje. Dos barridos simultáneos cancelan una sola vez, porque el segundo encuentra la
   task terminal, y `closed_reason` es definitivo (migración 0011). Si el proceso cae entre la task y el binding, el
   barrido siguiente vuelve a seleccionar el binding abierto de una task `idle_timeout` y lo cierra. Un candidato que
   falla se registra (`conversation.idle_close.skipped`, `reason: failed`) y no detiene a los demás. Un proceso nunca
   solapa dos barridos.
7. **Una reacción (👍) a una oferta de un caso cerrado por inactividad** llega al caso nuevo sin su vínculo: la ingesta
   sólo enlaza una reacción a un mensaje de la task del binding actual (`ingress.ts`, `reactionTarget`). Por eso ya no
   se liga a la oferta anterior, y el agente la ve como reacción a un mensaje desconocido. Es aceptable: esa oferta
   tiene más de 24 h y el agente vuelve a leer lo que necesite.
8. **Apagado por defecto.** Con `R4_PROD_CASE_IDLE_CLOSE_HOURS` ausente o `0`, no se compone nada, y la configuración
   productiva y su huella quedan idénticas a las de antes.

## Decisión 2 — una respuesta cancelada no aparece como dicha

Caso real: dos mensajes con 4 s de diferencia. La respuesta al primero se creó y se canceló antes de enviarse
(`superseded_by_newer_input`), y aun así el contexto siguiente la mostraba como turno del agente.

1. **Se retira de la conversación toda respuesta `respond` que el contacto nunca recibirá:** su outbound está
   `cancelled`, por cualquier razón (`superseded_by_newer_input`, `superseded_by_operator`, `duplicate_content`,
   `conversation_closed`, `task_cancelled`, `expired`, `window_closed`, `cancelled_by_operator`,
   `document_unavailable`), o está superada causalmente (existe un input que el contexto de esa respuesta nunca evaluó)
   mientras su outbound está `pending` **o todavía no existe** en una task ligada a un canal. Esa es la regla exacta
   del gate de despacho, bajo la cual el outbound sólo puede retenerse o cancelarse: `materializeResponses` convierte
   cada `respond` de una task ligada en un outbound, la superación es permanente y `decideDispatch` nunca despacha uno
   superado. Sin esto, la corrida que despierta el segundo mensaje (reclamada en ~1 s, antes del siguiente tick del
   gateway) compila antes de que la respuesta se materialice o se cancele, y el error aparece igual. El cálculo está en `interactionRecords` del store temporal (como `turnObligation`, que ya
   leía `outbound_messages`). Las fuentes `platform.run` y `platform.interaction` omiten esos pasos. Donde nada
   entrega respuestas, la lista está vacía y todo sigue igual.
2. **Los turnos de tasks anteriores** (`earlierConversationTurns`) excluyen los mensajes de agente y de operador
   cancelados. El hilo del operador (`thread`) los sigue mostrando con su estado de entrega.
3. **Nota para el agente: sí, sin el texto.** Se mantiene el episodio OBSERVED de `DeliveryStateContextSource`
   (estado `cancelled` y razón), con un significado explícito: el contacto nunca lo vio, no es parte de la conversación
   y no debe citarse como dicho. El texto del borrador no se incluye. Así el agente no lo repite ni lo da por dicho, no
   gasta tokens, y la corrida nueva responde a todos los mensajes con lo que el cliente realmente vio. `duplicate_content`
   también queda cubierto: el original que sí se envió sigue en la conversación una sola vez. Una respuesta retirada
   que sigue `pending` se describe como «no se enviará» (no «aún no enviada»). Si aún no se materializó, no hay
   episodio: el agente simplemente no la ve.
4. **Una respuesta `failed`** (rechazada por el proveedor) sigue mostrándose como turno, con su episodio «el contacto
   NO la recibió», para que el agente pueda decidir reenviar (decisión del owner, 2026-11-18).

## Procedimiento de operación

- **Variable:** `R4_PROD_CASE_IDLE_CLOSE_HOURS`, en horas enteras de 1 a 720. Ausente o `0` significa apagado. Cualquier
  otro valor impide componer producción (`invalid_production_config`). Decisión del owner: `24`.
- **Dónde corre:** en el proceso channel gateway (`npm run production:sales:gateway`; también en el web gateway si se
  define allí). Cada gateway barre sólo su canal, cada 60 s, en lotes de 50 casos. No requiere migración, worker ni
  scheduler. Varias instancias pueden barrer a la vez sin riesgo.
- **Activar:** agregar `R4_PROD_CASE_IDLE_CLOSE_HOURS=24` al archivo de entorno del gateway y reiniciarlo. Hay que
  verificar que `/ready` muestre `checks.caseIdleCloseHours: 24`. Desde el primer barrido (a los 60 s), los casos que
  ya llevan más de 24 h inactivos y cumplen las reglas se cierran por orden de antigüedad, **a lo sumo 50 por barrido**,
  es decir 50 por minuto, hasta agotar el atraso. Para ver de antemano cuántos serán, ejecutar la consulta de solo
  lectura de `idleConversations` (`production-store.ts`) con el umbral deseado.
- **Desactivar:** quitar la variable, o ponerla en `0`, y reiniciar el gateway. Los casos ya cerrados quedan cerrados:
  el mensaje siguiente abre uno nuevo, como después de un `tasks cancel`.
- **Auditoría:** en `agent_tasks`, `status = 'cancelled' and status_reason = 'idle_timeout'`. En
  `channel_conversation_bindings`, `closed_reason = 'idle_timeout'`. En `temporal_events`,
  `event_type = 'task.cancelled' and actor_ref = 'platform:case-idle-close'`. En telemetría,
  `conversation.binding.closed` (`reason: idle_timeout`) y `conversation.idle_close.skipped` (candidato rechazado
  bajo el lock, con su razón, o `failed`).
- **Rollback de código:** un build anterior ignora la variable. Las tasks ya cerradas son tasks `cancelled` normales.

## Consecuencias

- Los presupuestos y el contexto se reinician por caso. El caso nuevo recibe los últimos 20 turnos (hasta 10 tasks y 30
  días) como conversación, nunca como evidencia.
- Al abrir el binding nuevo se reevalúa el rollout, así que una baja del porcentaje saca al cliente en su próximo caso.
- La decisión 2 cambia lo que ve el modelo en casos de mensajes seguidos, así que una evaluación del texto del agente
  sobre ese patrón queda como verificación recomendada antes de activar.

## Decisiones del owner (2026-11-18)

- Las 24 h se cuentan desde el último mensaje del cliente (implementado).
- Una respuesta `failed` sigue visible en la conversación (implementado).
- Un caso en handoff nunca se cierra solo: queda abierto para los operadores, como un ticket (implementado).
