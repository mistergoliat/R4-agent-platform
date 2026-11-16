# ADR-045 — Carril de conversación: un segundo perfil en el gateway existente, sólo para conversaciones nombradas

- **Identificador:** `R4-CONVERSATION-LANE-01`
- **Estado:** **Propuesto.** Implementado en la rama `feat/r4-integrated-e2e`. Pendiente de revisión focalizada y
  merge. No desplegado ni activado.
- **Fecha:** 2026-11-05
- **Mandato:** «R4 — Integrated Commercial E2E Deployment» (owner, 2026-11-05), §C. El owner decide usar el número y
  la infraestructura de WhatsApp existentes. La recomendación B de `R4_CATALOG_V2_DISCOVER_ROUTING_DECISION.md`
  (número dedicado) queda descartada por decisión del owner, y este ADR es el que ese documento exigía para la opción A.
- **Autoridad superior:** Constitución; PRD; ADR-029 (modo productivo); ADR-036 (procedencia de entradas); EV-2 (los
  workers productivos declaran `servedAgents`); migraciones 0007, 0011 y 0013 (bindings).

## Contexto

`ChannelIngress` recibe un único perfil y una única `taskFactory`. El gateway de Sales fija cada tarea a la versión de
definición de ese perfil, y cada worker productivo sólo toma tareas de las versiones que declara. Para probar E1
desde el número real hace falta que **una** conversación (la del owner) abra sus tareas con otro perfil, sin cambiar
nada para las demás.

## Decisión

1. **Carril opcional en `ChannelIngress`** (`ConversationLane`): un conjunto cerrado de claves de conversación
   (hash con clave, nunca direcciones), un perfil y una `taskFactory`. Si no hay carril, el comportamiento es
   exactamente el de R4-I.
2. **La asignación se decide sólo al abrir el binding** y se persiste en `binding.profile`, como ya ocurría con el
   perfil único. Todo lo posterior sigue al binding: la fábrica de la tarea y la política de contenido no soportado
   salen del perfil persistido, **nunca de la configuración actual**. Como el binding y su `task_id` son inmutables
   (0011), una conversación no cambia de perfil mientras su tarea viva.
3. **El carril nunca amplía la autonomía.** Cada clave del carril debe estar también en la allowlist del rollout y
   fuera de la denylist. Si no, el gateway se niega a arrancar (`conversation_lane_refused`). El kill switch se
   aplica igual que siempre.
4. **Restos de una caída.** Puede quedar un binding abierto sin tarea (caída entre `openBinding` y `attachTask`)
   cuyo perfil ya no compone el gateway:
   - si la tarea ya se había creado (su clave de creación es `conversation-<bindingId>`), el binding la adopta, y no
     se crea una segunda tarea ni se ejecuta dos veces la misma entrada;
   - si no, se cierra (`profile_not_served`) y se reabre con la asignación actual.

   Esto también aplica sin carril. Antes, ese resto terminaba en `idempotency_key_reused` y el mensaje quedaba
   descartado como fallido.
5. **Separación de ejecución.** El perfil del carril corre una versión de definición propia, v13, y su propio worker
   (`servedAgents` = v13). Así ningún worker ejecuta tareas del otro. Por la FK `agent_tasks → agent_definitions`, v13
   debe estar registrada antes de activar el carril: un gateway con carril **se niega a arrancar** si no lo está
   (`lane_definition_not_registered`).
6. **Sales.**
   - `sales-production@13` es `@3` más Catalog V2, exigido por el perfil (`salesCatalogSourceOf`) y nunca por una
     variable, más `catalog.discover`.
   - No es seleccionable como perfil principal de un gateway, sólo por un worker y como carril.
   - El gateway lee `R4_PROD_LANE_PROFILE` y `R4_PROD_LANE_ALLOWLIST`: las dos o ninguna.
   - v13 es un archivo candidato. Sólo `production:sales:bootstrap --lane` la registra, y no registra ninguna otra.
7. **Rollback**, en este orden:
   1. Quitar el carril del entorno del gateway y reiniciarlo. Un binding abierto del carril sigue llevando sus mensajes
      a su tarea.
   2. **Mantener el worker del carril en marcha** hasta que esa tarea no tenga entradas sin procesar. Si se detiene
      antes, esos mensajes no se responden; si se cancela antes, se pierden.
   3. Cancelar la tarea del carril con el comando de control existente (`tasks cancel`).
   4. Detener el worker del carril.

   El siguiente mensaje abre un binding con el perfil principal.
8. **Límites conocidos:**
   - `/ready/r4` cuenta sólo los workers del perfil principal. El worker del carril se verifica por su log
     `service.composed` y por su presencia en `worker_presence`.
   - Registrar v13 la convierte en la última versión de Sales del registro. Una tarea Sales **sin versión fijada**
     resolvería v13, pero ningún proceso productivo crea tareas sin fijar (el gateway siempre fija, y la API no corre
     en producción).

## Consecuencias

- El carril comparte la base productiva y el gateway. Su aislamiento es lógico (binding, versión, worker), no físico.
  Es el costo de usar el número existente, y el owner lo aceptó al elegir esta vía.
- La historia se conserva: la tarea del carril ve las tareas anteriores de la misma conversación
  (`PriorConversationContextSource`, R7-4).
- Agregar un segundo carril o más perfiles requiere otro ADR. Este admite exactamente uno.

## Evidencia

`tests/integration/conversation-lane.test.ts`:

| Prueba | Qué cubre |
|---|---|
| L1 | Asignación determinista y exclusiva |
| L2 | Cada worker ejecuta sólo lo suyo; Discover se invoca de verdad |
| L3, L3b | Una ejecución y una respuesta, también con entregas duplicadas y con primeros mensajes concurrentes distintos |
| L4 | Historia |
| L5 | El binding sigue a su tarea aunque se quite el carril |
| L5b | Resto sin tarea → reapertura |
| L5c | Resto con tarea ya creada → adopción, sin segunda tarea |
| L6 | Rollback según el runbook, sin mensajes perdidos |
| L7 | Rechazos de configuración |
| L7b | Definición no registrada → el gateway no arranca; separadores de claves |
| L8 | Sin Discover configurado (puerto o clave) no hay worker |
| L9 | Con `@3` como perfil principal, su huella y su v4 intactas |

Mutaciones manuales:

- «el carril nunca asigna»: fallan 6 de 9;
- «la fábrica sigue a la configuración»: falla L5;
- «sin adopción de la tarea huérfana»: falla L5c;
- «sin chequeo de la definición al arrancar»: falla L7b.

## Enmienda 1 — el carril atiende también la cohorte del rollout (2026-11-16)

Mandato del owner: **allowlist del carril O cohorte del rollout → perfil del carril**. Antes, una conversación
elegible como `cohort` (`R4_PROD_ROLLOUT_PERCENT`) la atendía el perfil principal (`@3`), así que subir el porcentaje
no daba a clientes reales el perfil probado. Resuelve el prerrequisito P1 de `R4_CONTROLLED_ROLLOUT_PLAN.md` (opción a).

1. **Regla** (`laneRoute`, `packages/live-ops/src/rollout.ts`, pura): con carril compuesto, un binding NUEVO abre con
   el perfil del carril si su clave está en `R4_PROD_LANE_ALLOWLIST` o si su elegibilidad es `cohort`; si no, con el
   perfil principal. Sin carril, todo es exactamente como antes (la cohorte va al principal). La precedencia del
   rollout no cambia (deny > allowlist > porcentaje) y el bucket es el mismo (`rolloutBucket`, derivado de la clave):
   determinista y auditable, y `eligibility_reason` sigue registrando `allowlisted` o `cohort`.
2. **Sin variable nueva.** El porcentaje es el opt-in: en `0 %` (hoy) nada cambia. Una segunda variable («el carril toma
   la cohorte») agregaría justo el estado que el owner quiere evitar (porcentaje > 0 con la cohorte en `@3`). El
   carril sigue sin ampliar la autonomía: la cohorte ya es elegible por el rollout, y una conversación denegada nunca
   es `cohort`.
3. **Estabilidad.** Igual que en la decisión 2: la asignación se decide sólo al abrir el binding y se persiste
   (`profile`, `autonomy`, `eligibility_reason`, `rollout_fingerprint`). Cambiar el porcentaje no mueve un binding
   abierto: sigue con su perfil y su autonomía hasta que su tarea termina (completada, cancelada o fallida). Las
   conversaciones nuevas siguen el porcentaje vigente. Un binding no puede cambiar de perfil con la tarea viva sin
   partir la conversación en dos tareas, y eso es lo que este modelo evita.
4. **Sin doble proceso.** La tarea de un binding del carril se fija a la versión de la definición del carril, y sólo
   el worker del carril (`servedAgents`) la toma. El índice único de bindings abiertos y la clave de creación
   `conversation-<bindingId>` dan un binding y una tarea por conversación también con primeros mensajes concurrentes.
5. **Rollback.** Bajar `R4_PROD_ROLLOUT_PERCENT` (o a `0`) y reiniciar el gateway. Ninguna conversación nueva entra a
   la cohorte. Las abiertas de la cohorte **siguen atendidas por el carril** hasta que su tarea termina, así que el
   worker del carril debe seguir en marcha; no quedan tareas huérfanas. Para cortar ya: denylist (por clave) o
   interruptor de autonomía (todo). Para devolverlas al perfil principal: cancelar sus tareas (`tasks cancel`); el
   siguiente mensaje abre con la asignación vigente. Quitar el carril entero sigue el runbook de la decisión 7.

Evidencia: `tests/unit/live-ops/mode-profile-rollout.test.ts` (regla: allowlist, cohorte, denegada, fuera de
cohorte, sin carril) y `tests/integration/conversation-lane-cohort.test.ts`:

| Prueba | Qué cubre |
|---|---|
| C1 | `0 %` no cambia nada; a `20 %` la cohorte abre en el carril con `cohort`; el binding abierto antes no se mueve |
| C2 | Sin carril, la cohorte la atiende el perfil principal, como antes |
| C3 | Primeros mensajes concurrentes y reentregas: un binding, una tarea v13, una ejecución, sólo del worker del carril |
| C4 | Reentrega y reinicios del gateway (también con otro porcentaje): sin re-ruteo ni duplicados |
| C5 | Cambio de porcentaje con la tarea viva, conversaciones nuevas según el nuevo porcentaje, rollback a `0 %` |

Mutación manual «el carril no toma la cohorte»: fallan C1, C3, C4 y C5.
