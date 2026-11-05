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
   cuyo perfil ya no compone el gateway. En ese caso se cierra (`profile_not_served`) y se reabre con la asignación
   actual, en lugar de crear sobre él una tarea de otro perfil.
5. **Separación de ejecución.** El perfil del carril corre una versión de definición propia, v13, y su propio worker
   (`servedAgents` = v13). Así ningún worker ejecuta tareas del otro. Por la FK `agent_tasks → agent_definitions`, v13
   debe estar registrada antes de activar el carril.
6. **Sales.**
   - `sales-production@13` es `@3` más Catalog V2, exigido por el perfil (`salesCatalogSourceOf`) y nunca por una
     variable, más `catalog.discover`.
   - No es seleccionable como perfil principal de un gateway, sólo por un worker y como carril.
   - El gateway lee `R4_PROD_LANE_PROFILE` y `R4_PROD_LANE_ALLOWLIST`: las dos o ninguna.
   - v13 es un archivo candidato. Sólo `production:sales:bootstrap --lane` la registra, y no registra ninguna otra.
7. **Rollback.** Se quita el carril del entorno del gateway y se lo reinicia. Luego se cancela, con el comando de
   control existente (`tasks cancel`), la tarea abierta del carril, porque su binding la sigue hasta que termina.
   Por último se detiene el worker del carril. El siguiente mensaje abre un binding con el perfil principal.

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
| L3 | Una ejecución y una respuesta, también con entregas duplicadas |
| L4 | Historia |
| L5, L5b | Reinicio y restos de caída |
| L6 | Rollback |
| L7 | Rechazos de configuración |
| L8 | Sin Discover no hay worker |

Mutaciones manuales:

- «el carril nunca asigna»: 6 de 9 pruebas fallan;
- «la fábrica sigue a la configuración»: falla L5.
