---
title: R4-J4-R7-4 — seguimientos de continuidad y hallazgos para el backlog de Sales/J5
status: backlog — NOT AUTHORIZED
mandate: «R4 — R7-4 Final PR Review» (owner, 2026-11-04), §2 y §3
date: 2026-11-04
---

# R7-4: seguimientos y backlog Sales/J5

**Origen.** Revisión del PR #36 (continuidad entre tasks).
- **Fuentes:** el informe `R4_R7_4_CROSS_TASK_CONTINUITY_REPORT.md`, §12.4 (campaña) y §12.6 (revisión independiente).
- **Autorización:** registrar un ítem no lo autoriza. Cada ítem requiere un mandato explícito.
- **Restricción:** ninguno amplía el alcance del PR #36.

## A. Seguimientos de R7-4 (plataforma)

| ID | Problema | Decisión pendiente | Entregable | Criterio de salida |
|---|---|---|---|---|
| **IR-2** | Los avisos de plataforma de una task anterior no se proyectan a la task siguiente, aunque el contacto los haya recibido: aviso fijo de falla de run (ADR-041) o de contingencia (R7-1). La task nueva no sabe que el cliente leyó «una persona del equipo seguirá la conversación» | **Qué avisos deben quedar visibles** para una task posterior, y con qué autoridad: CONVERSATIONAL atribuido a la plataforma, nunca al agente. ¿Sólo los entregados? ¿También los que siguen `pending` o están en `unknown`? ¿Hace falta el estado del handoff (tomado o liberado)? | Rama `platform` en `earlierConversationTurns`, con su entrega y un rol distinto de `agent`; encuadre en el episodio | Prueba que muestra el aviso con su estado de entrega y como de la plataforma; mutación que lo atribuye al agente o lo omite; sin cambios en el aislamiento |
| **IR-3** | `earlierTurnsOmitted` es verdadero cuando hay exactamente `maxTasks` tasks anteriores con turnos dentro de la ventana, aunque no se haya omitido nada. Comportamiento sin cambios tras la corrección de IR-1 | Ninguna; es una corrección | Pedir `maxTasks + 1` tasks al store y marcar la omisión sólo si existe una task más o si se recortaron turnos | Unit con exactamente `maxTasks` y con `maxTasks + 1`; la mutación que restaura el criterio actual es detectada |

## B. Backlog Sales/J5 (instrucciones comerciales y presupuesto de escrituras)

Ninguno se modifica dentro de R7-4.

| ID | Hallazgo | Evidencia | Relación | Opciones (decisión del owner) |
|---|---|---|---|---|
| **DS-1** | El modelo **ofrece** «dejar anotada» la selección o «agregarla» aunque la escritura no está disponible (`maxWriteActions` 0: `workspace.update` no se le ofrece). Si el cliente acepta, el modelo intenta una escritura no ofrecida, el presupuesto se agota (`run_budget_exhausted`) y la conversación pasa a una persona | Campaña R7-4: 4 de 12 respuestas (K1#1, K1#2, K3#1, K3#2). Producción, 2026-11-04: primer `run_budget_exhausted` real, con handoff abierto y el cliente sin respuesta | D-7 (revisión de `maxWriteActions`), registrado en R7. **Afecta a producción hoy** | (a) Dar a `R4_EXEC_MAX_WRITE_ACTIONS` un valor bajo mayor que 0 en producción, para que `workspace.update` registre la selección; requiere su propio mandato y validación. (b) Quitar de las instrucciones del perfil la oferta de anotar mientras no haya presupuesto. (c) Que la plataforma trate una propuesta de escritura no ofrecida como rechazo devuelto al modelo, no como contingencia; es un cambio de runtime con su ADR |
| **DS-2** | El modelo ofrece «retirar en tienda» sin haberlo verificado con ninguna capacidad | Campaña R7-4: K5#1 | R-3 (las instrucciones de Sales no hablan de la conversación anterior); hallazgo «más compacto» de la validación R7 en EC2 | Revisar las instrucciones de Sales: no ofrecer modalidades de entrega que ninguna capacidad confirme |

## Criterios comunes

- Cada corrección trae su prueba y su mutación, según `R4_TEST_STRATEGY_02`.
- Si un cambio toca las instrucciones de un perfil, crea una versión nueva del perfil. No se modifica uno publicado.
- Ningún cambio de comportamiento comercial se valida sólo con fixtures. Requiere una campaña acotada con el modelo real, autorizada aparte.
