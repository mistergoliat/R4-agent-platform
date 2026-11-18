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
   perfil principal. La precedencia del rollout no cambia (deny > allowlist > porcentaje) y el bucket es el mismo
   (`rolloutBucket`, derivado de la clave): determinista y auditable. `eligibility_reason` sigue registrando
   `allowlisted` o `cohort`, y `rollout_fingerprint` la configuración con que se abrió el binding.
2. **Sin variable nueva; el porcentaje es el opt-in.** En `0 %` (hoy) nada cambia. Una segunda variable («el carril
   toma la cohorte») agregaría justo el estado que el owner quiere evitar (porcentaje > 0 con la cohorte en `@3`).
3. **Composición que se niega** (`assertSalesGatewayCohort`, gateway de WhatsApp de Sales). Con
   `R4_PROD_ROLLOUT_PERCENT > 0` el gateway no arranca:
   - **sin carril**: la cohorte abriría autónoma en el perfil principal;
   - **con un perfil de carril fuera de `SALES_COHORT_LANE_PROFILES`**, que hoy son `sales-production@22` (el perfil vivo del carril) y `sales-production@21`, su rollback declarado.
     Por decisión del owner del 2026-11-18, volver el carril de @22 a @21 no exige bajar el porcentaje a 0.
     `salesGatewayLane` acepta @13–@22 (por ejemplo @16, con F-ADV-1, o @15, el carril de Checkout; @19 y @20 están superados), y ninguno de los otros
     está aprobado para clientes reales. La lista es una constante en código: agregar un perfil es un cambio revisado.

   En `0 %` no se exige nada, con o sin carril (exactamente como antes). El gateway web (ADR-046) no cambia.
4. **Estabilidad.** Igual que en la decisión 2: la asignación se decide sólo al abrir el binding y se persiste
   (`profile`, `autonomy`, `eligibility_reason`, `rollout_fingerprint`). Cambiar el porcentaje no mueve un binding
   abierto ni le quita la autonomía: sigue con su perfil hasta que su tarea termina (completada, cancelada o fallida).
   Las conversaciones nuevas siguen el porcentaje vigente. Mover un binding con la tarea viva partiría la conversación
   en dos tareas fijadas a dos definiciones, y eso es lo que este modelo evita.
5. **Sin doble proceso.** La tarea de un binding del carril se fija a la versión de la definición del carril, y sólo
   el worker del carril (`servedAgents`) la toma. El índice único de bindings abiertos y la clave de creación
   `conversation-<bindingId>` dan un binding y una tarea por conversación también con primeros mensajes concurrentes.
6. **Rollback y su alcance real.** Bajar `R4_PROD_ROLLOUT_PERCENT` (o a `0`) y reiniciar el gateway corta la
   **entrada**: ninguna conversación nueva entra a la cohorte. **No revoca** la autonomía de los bindings de cohorte ya
   abiertos. Una tarea de conversación de Sales termina cuando se cancela, falla o, con `R4_PROD_CASE_IDLE_CLOSE_HOURS`
   (#97; en producción `=24` desde el 2026-11-18 16:11 UTC), cuando espera al cliente ese tiempo sin mensajes; el
   binding se cierra (`idle_timeout`) y el siguiente
   mensaje se evalúa contra el porcentaje vigente. Sin el cierre por inactividad, «hasta que su tarea termina» suele
   significar indefinidamente. El worker del carril debe seguir en marcha mientras existan, y no quedan tareas
   huérfanas. Para cortarlas:
   - **dirigido**: listar los bindings abiertos con `eligibility_reason = 'cohort'` (y, si hace falta, los de un
     `rollout_fingerprint` anterior) y cancelar cada tarea con `tasks cancel`. Advertencia de la decisión 7.2: cancelar
     descarta las entradas aún no procesadas, así que primero se deja que el worker del carril las responda. El
     siguiente mensaje de esa conversación abre con la asignación vigente;
   - **por clave**: denylist (retiene esas conversaciones para una persona);
   - **total**: interruptor de autonomía global.

   Seguimiento recomendado, **no implementado**: un comando de control que retenga (hold) o drene los bindings de
   cohorte cuyo `rollout_fingerprint` ya no es el vigente.
7. **Clientes que vuelven.** Un cliente con un binding `@3` abierto desde antes de subir el porcentaje no entra a la
   cohorte hasta que esa tarea termina. Los clientes recurrentes quedan sub-representados en la cohorte respecto de los
   nuevos, y las métricas por etapa deben leerse con ese sesgo.
8. **Clave de identidad.** Rotar `R4_PROD_IDENTITY_HASH_KEY` cambia todas las claves de conversación y, con ellas, los
   buckets. Las conversaciones abiertas dejan de encontrar su binding. La rotación pendiente se hace **antes** de subir
   el porcentaje, nunca durante la etapa 2.

Evidencia: `tests/unit/live-ops/mode-profile-rollout.test.ts` (regla: allowlist, cohorte, denegada, fuera de
cohorte, sin carril), `tests/unit/sales/gateway-cohort.test.ts` y `tests/contract/sales-gateway-cohort.test.ts`
(composiciones que se niegan), y `tests/integration/conversation-lane-cohort.test.ts`, con el carril `@22`:

| Prueba | Qué cubre |
|---|---|
| C1 | `0 %` no cambia nada; a `20 %` la cohorte abre en el carril con `cohort` y la huella vigente; el binding abierto antes conserva perfil, elegibilidad y huella |
| C2 | Porcentaje > 0 rechazado sin carril y con `@13`; `0 %` sin carril arranca como antes; un redespliegue no entra al estado rechazado |
| C3 | Primeros mensajes concurrentes y reentregas: un binding y una tarea fijada a v19; el worker principal no la toma |
| C4 | Reentrega y reinicios del gateway (también con otro porcentaje): sin re-ruteo ni duplicados |
| C5 | Cambio de porcentaje con la tarea viva; conversaciones nuevas según el nuevo porcentaje; rollback a `0 %` sin revocar la autonomía abierta; cancelación → ruteo de hoy |
| C6 | Ciclo de vida en `@22`: el worker del carril responde y el principal no toma nada; tras rollback a `0 %` el binding sigue en `@22`; el cierre por inactividad de 24 h (#97) lo cierra y el siguiente mensaje sigue el porcentaje vigente |
| C7 | El interruptor de autonomía retiene las conversaciones de cohorte igual que las de la allowlist, también las abiertas con el interruptor activo |
| C8 | Rollback del carril de `@22` a `@21` con el porcentaje en 20 %: el gateway arranca, el binding `@22` abierto sigue con su tarea y una conversación nueva de la cohorte abre en `@21` |

El worker del carril `@22` responde en C6. El reclamo sólo de su definición fijada y el drenaje tras un cambio de
configuración están cubiertos además por L2, L3 y L6 sobre `@13`: la forma en que se ruteó el binding no cambia cómo se
reclaman las tareas.

Mutación manual «el carril no toma la cohorte»: fallan C1, C3, C4 y C5.
