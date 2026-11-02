# ADR-041 — Aviso de plataforma cuando una falla del modelo entrega la conversación a una persona

- **Estado:** Propuesto (corrección P0 de confiabilidad, mandato «R4 — J5 Reliability Gap and Commercial Knowledge», 2026-10-26). Requiere revisión independiente: toca `packages/live-ops`, `packages/persistence-postgres` (migración Core `0012`) y `apps/channel-gateway`.
- **Fecha:** 2026-10-26
- **Base:** `main` `09d6579`
- **Autoridad superior:** Constitución; PRD; ADR-008 (protocolo de decisión), ADR-028 (runs fallidas recuperables), ADR-038 (outbound gobernado)
- **No modifica:** el kernel (`packages/agent-kernel`), `packages/task-runtime`, ADR-008 ni ADR-028.
- **Enmienda:** R4-J4-R7-1 (2026-10-28) — avisos generalizados a las contingencias de runtime; columna `human_request_id`. Ver la sección final.

## Contexto

ADR-008 rechaza toda salida del modelo que no sea exactamente un documento JSON de decisión, sin reparación. ADR-028 reintenta con una run nueva: con el presupuesto por defecto (`maxRunFailureRecoveries = 1`), la segunda falla consecutiva bloquea la task con un handoff de plataforma (`run_failure_recovery_exhausted`). Una falla no reintentable hace lo mismo de inmediato (`non_retryable_model_failure`).

Lo que nadie decidió es qué ve el **contacto**. El handoff deja la task `blocked` con un `WAIT_FOR_HUMAN`, y el gate de entrega cancela toda salida de agente de una task con handoff pedido (`humanOwned`). Resultado: el cliente queda sin respuesta, y los mensajes que siga enviando tampoco reciben respuesta, hasta que un operador actúe.

**Evidencia (canary J4-R5 en EC2, 2026-10-26, datos sintéticos, `deepseek-flash`, JSON mode activo):**
- 5 respuestas malformadas en ~73 llamadas, todas con `finish_reason = stop` (no truncadas).
- 2 de 11 conversaciones quedaron en silencio. Una de ellas (`p7-a`) recibió **0** respuestas en 5 mensajes del cliente.
- La reproducción de los 5 contextos fallidos, 5 veces cada uno con el mismo modelo, dio **11/25** respuestas malformadas: 6 con 2–3 documentos `read_capability` seguidos, 4 con JSON seguido de prosa y 1 objeto sin `type`. Un mismo contexto falló 4 de 5 veces: el reintento de ADR-028, con contexto nuevo pero equivalente, tiende a repetir la falla.

## Decisión

1. **El dueño de la entrega envía un aviso de plataforma, una vez por handoff de falla de run.** `OutboundDeliveryRuntime` gana la opción `runFailureFallback: { text }`. En cada `materialize`, además de las respuestas, crea **un** outbound de origen nuevo `platform` por cada handoff que cumpla todo esto:
   - `kind = handoff`;
   - `status = requested`;
   - `initiatedBy = platform`;
   - `reason ∈ {run_failure_recovery_exhausted, non_retryable_model_failure}`;
   - la task tiene binding de canal.

   La unicidad la garantiza la base: `handoff_request_id` único.
2. **El texto es del agent pack, nunca del modelo.** Es fijo y no afirma efectos: no dice que una cotización, verificación, pedido o pago ocurrió o no. Anuncia un problema técnico y que una persona continuará. Sales lo compone en el gateway productivo y en el canary (`SALES_RUN_FAILURE_FALLBACK_TEXT`). Sin la opción, el comportamiento es exactamente el anterior.
3. **Gate de entrega del origen `platform`.** Es habla automatizada sobre una task que el handoff volvió humana:
   - aplican el kill switch, el deny, el rollout, la task terminal, el binding cerrado, la antigüedad y la ventana del canal, igual que a la salida de agente;
   - se envía mientras su handoff siga `requested`;
   - se cancela (`superseded_by_operator`) en cuanto una persona tomó, liberó o canceló el handoff;
   - los inputs posteriores **no** lo cancelan: son el cliente que sigue esperando.
4. **Entrega, reintentos y recuperación sin mecanismos nuevos.** El aviso usa el ciclo de vida existente: claim con lease y fencing, reintentos solo para «definitivamente no enviado», `unknown` nunca reenviado y sweep tras la caída del proceso. El aviso se materializa desde el estado durable del handoff, así que un reinicio del worker o del gateway no lo pierde ni lo duplica.
5. **Visibilidad.**
   - Al modelo, cuando la persona libera la task: un episodio OBSERVED dice que la plataforma (no el agente) envió el aviso fijo.
   - Al operador: un evento `platform.fallback` en el hilo, con su estado de entrega.
6. **Migración Core `0012_platform_fallback_outbound`.**
   - `origin ∈ {agent, operator, platform}`.
   - Columna `handoff_request_id` (única, FK a `human_requests`).
   - Check: `platform` ⇔ handoff, texto, sin step de respuesta y sin `human_ref`.
   - Como toda migración, se aplica solo con una orden explícita (`db:migrate` o `sales:canary init`), nunca por el merge.

## Alternativas descartadas

- **Reparar la salida (tomar el primer documento, cortar la prosa).** Contradice ADR-008: un documento parcial o elegido por la plataforma podría ejecutar una lectura o una acción que el modelo no decidió como única. Se mantiene «sin reparación».
- **Un step `respond` de plataforma en la run fallida.** El esquema lo permite (`0010`), pero exige cambiar el kernel y el task-runtime (Core). Además el gate igual lo cancelaría por `humanOwned`.
- **Subir `maxRunFailureRecoveries`.** Reduce la frecuencia, pero no elimina el silencio: un contexto falló 4 de 5 veces. Queda como ajuste de configuración opcional (`R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`), no como corrección.
- **Aceptar varias lecturas por turno (protocolo v6).** Atacaría la causa de 6 de las 11 fallas, pero es un cambio versionado del protocolo de decisión (ADR-008) y del kernel. Se propone por separado (ver el informe P0), no en este cambio.

## Consecuencias

- **Invariante nuevo:** una respuesta malformada del modelo nunca abandona en silencio una conversación de canal activa. Tras la recuperación acotada, el contacto recibe un aviso persistido y entregado por el dueño de la entrega.
- El aviso no sustituye a la persona: el handoff sigue pedido y visible en `attention()`.
- Producción (`sales-production@2` en EC2) no cambia hasta un despliegue autorizado, con su `db:migrate`.

## Enmienda R4-J4-R7-1 (2026-10-28)

- **Mandato:** «R4 — Implementation Mandate J4-R7-1: Runtime Contingency & Recovery», R7-1B.
- **Integración:** los commits del PR #27 (`387b720`, `93fe35a`) se integraron por *cherry-pick* en la rama
  `feat/r4-j4-r7-1-runtime-contingency`, sobre `0356388` (= `main` `d0bb7a7` + documentación R7). El PR #27 **no se
  modificó ni se fusionó**. Si esta rama se acepta, el PR #27 queda reemplazado por ella.

**Generalización de las razones.** El aviso se materializa para todo handoff de plataforma `requested` cuya razón
pertenezca a `RUN_FAILURE_HANDOFF_REASONS` (`@r4/contracts`). Desde R4-J4-R7-1 son siete:
- `run_failure_recovery_exhausted` y `non_retryable_model_failure` (ADR-041 original);
- `run_output_filtered`, `run_budget_exhausted`, `run_capability_failure`, `run_internal_failure` y `run_abandoned`
  (ADR-028, enmienda R4-J4-R7-1).

El gate (`decidePlatformDispatch`), la unicidad por solicitud, el texto fijo del pack, el ciclo de vida del outbound y
la exclusión por kill switch, deny, rollout y ventana no cambian. Las restricciones del canal se respetan igual: fuera
de ventana el aviso se cancela `window_closed` y aparece en `attention()` (`undeliveredOutbound`).

**Columna `human_request_id` (D-8).** La migración `0012_platform_fallback_outbound` usa `human_request_id` en vez de
`handoff_request_id`, y `OutboundRecord.humanRequestId` en vez de `handoffRequestId`. Así R7-3 podrá anunciar también
consultas y aprobaciones sin otra migración. La migración nunca se aplicó en producción (`main` termina en `0011`). Una
base de canary que la hubiera aplicado con el nombre anterior la verá como `modified` y será rechazada por
`migrationStatus`; hay que recrearla. Los textos del episodio de contexto (`DeliveryStateContextSource`) se
generalizaron: "la task no pudo continuar de forma autónoma".

**Condición pendiente (R7-2).** El diseño R7 materializa el aviso sólo si la última entrada del contacto no tiene
respuesta (`UNANSWERED`). Esa consulta llega con el guard de R7-2. Hasta entonces se conserva la regla de ADR-041: un
aviso por handoff de falla, aunque no haya entrada pendiente (por ejemplo, un presupuesto agotado en una run
despertada por un timer).
