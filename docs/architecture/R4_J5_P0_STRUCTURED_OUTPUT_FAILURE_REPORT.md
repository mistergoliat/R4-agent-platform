---
title: R4-J5 P0 — Respuestas malformadas del modelo y conversaciones abandonadas
status: for-independent-review
mandate: R4 — J5 Reliability Gap and Commercial Knowledge (owner, 2026-10-26)
date: 2026-10-26
base: main 09d6579
---

# R4-J5 P0: respuestas malformadas y conversaciones sin respuesta

```text
P0_ROOT_CAUSE_CLASSIFIED
P0_CORRECTION_IMPLEMENTED                 (ADR-041; rama fix/r4-p0-run-failure-fallback)
P0_REGRESSION_TESTED                      (ver §7)
SILENT_CONVERSATION_FAILURE_CLOSED_BY_FALLBACK   (la tasa de malformadas del modelo sigue abierta: bloqueante J5)
R4_KERNEL_UNCHANGED                       (agent-kernel y task-runtime sin cambios)
PLATFORM_CHANGE_NEEDS_INDEPENDENT_REVIEW  (live-ops, migración Core 0012, channel-gateway)
```

## 1. Qué falló

La falla crítica no es el JSON inválido en sí. **Respuestas malformadas consecutivas dejaron conversaciones activas sin ninguna respuesta al cliente.**

En el canary J4-R5 (EC2, datos sintéticos, 2026-10-26):

| Conversación | Perfil | Runs | Qué vio el cliente |
|---|---|---|---|
| `c8-cpdown` (`01a17997`) | `@8` | run 3 y run 4 `invalid_structured_output` → `exhausted` | 2 respuestas y luego silencio. Sus 2 mensajes siguientes quedaron `human_owned` sin respuesta |
| `p7-a` (`01a179c1`) | `@7` | run 1 y run 2 `invalid_structured_output` → `exhausted` | **0 respuestas a 5 mensajes** |

Ambas tasks quedaron `blocked`, con un handoff de plataforma `requested` que nadie atendió, y con 0 outbound después de la falla (`evidence/p0-failure-chain.txt`).

## 2. Reconstrucción (evidencia sanitizada, sin texto de conversación)

| # | Aspecto | Hallazgo |
|---|---|---|
| 1 | Petición, proveedor y formato pedido | `openai_compatible`, perfil `deepseek-v4-flash`, modelo `deepseek-flash`. `R4_MODEL_EXTRA_BODY={"thinking":{"type":"enabled"}}`. `response_format: json_object` (default del adaptador, `config.ts:70`). Sin `max_tokens`. La petición lleva las instrucciones del protocolo `r4.agent_decision.v5` (system) y el contexto compilado. El esquema JSON de la decisión viaja como `outputContract`, pero el proveedor solo recibe `json_object` |
| 2 | Estructura cruda | `finish_reason = stop` en las 5 fallas (output de 81 a 2.672 tokens, incluido el razonamiento): no hubo truncamiento. **Reproducción** de los 5 contextos fallidos (`scripts/canary-j4/replay-shapes.mjs`, el mismo request que arma el kernel, 5 veces cada uno): **11/25 malformadas**. 6 con 2–3 documentos `read_capability` seguidos (lecturas «en paralelo»), 4 con un JSON válido seguido de 41–306 caracteres de prosa, 1 objeto sin `type` más texto. Un contexto falló 4 de 5 veces (`evidence/p0-replay-shapes.jsonl`) |
| 3 | Parser y esquema | El adaptador solo quita un code fence (`render.ts` `jsonDocumentOf`). `decision-parser.ts:105-118` hace `JSON.parse` del contenido completo; si falla, `invalid_structured_output` («model output is not a JSON document»). Sin reparación (ADR-008), correcto |
| 4 | Reintentos | ADR-028, `maxRunFailureRecoveries = 1` (`R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`). La recuperación es una run nueva con contexto fresco **equivalente**: la falla depende del contexto (punto 2), así que el reintento tiende a repetirla. El contador es durable (`termination.details.runFailureRecovery`) |
| 5 | Estados de la task | `running` (run fallida, task sigue) → segunda falla → `blocked` (`run_failure_recovery_exhausted`) |
| 6 | Handoff | `handOffAfterRunFailureWithin` crea un handoff `initiatedBy: platform` y un `WAIT_FOR_HUMAN`. En el canary no hay operador |
| 7 | Outbound | **No se crea ninguno.** Además, el gate de entrega cancela la salida de agente de toda task con handoff pedido (`humanOwned` → `superseded_by_operator`). Los inputs siguientes entran como `human_owned`, sin runs |
| 8 | Reinicios | El conteo de ADR-028 es durable: un reinicio del worker no reinicia la cuenta. Un reinicio no reabre la conversación |

## 3. Clasificación de la causa raíz

- **Disparador:** incumplimiento del protocolo por el modelo. Varias decisiones por turno o comentario tras el JSON. No es el transporte del adaptador, ni truncamiento, ni un defecto del parser. El JSON mode del proveedor no impide documentos concatenados.
- **Defecto del sistema (lo que vuelve grave al disparador):** el flujo de **handoff humano** y la **entrega de outbound** no tenían respuesta para el cliente cuando la plataforma se rinde. Faltaba un punto de extensión genérico: el texto de aviso que aporta el pack, entregado por el dueño de la entrega.
- **No es** un defecto del kernel ni del task-runtime: ambos se comportan como ADR-008 y ADR-028 especifican.

| Opción del mandato | ¿Pertenece la corrección? |
|---|---|
| Adaptador de modelo | No: reparar la salida contradice ADR-008 |
| Protocolo de salida estructurada | Mejora futura (propuesta §6), no la corrección del silencio |
| Integración capacidad/runtime | No |
| Orquestación de tasks | No (ADR-028 correcto) |
| **Flujo de handoff humano** | **Sí**: el handoff de plataforma ahora tiene un aviso |
| **Entrega de outbound** | **Sí**: origen `platform`, gate y materialización |
| **Punto de extensión genérico faltante** | **Sí**: `runFailureFallback` del pack (`OutboundDeliveryRuntime`, `GatewayBindings`) |

## 4. Corrección (ADR-041)

- `packages/live-ops`:
  - origen `platform` (`delivery.ts`) y gate propio (`decidePlatformDispatch`);
  - opción `runFailureFallback` y materialización (`outbound.ts`);
  - puerto `materializeRunFailureFallbacks` (`ports.ts`);
  - episodio para el modelo tras la liberación (`context-source.ts`).
- `packages/persistence-postgres`:
  - migración `0012_platform_fallback_outbound` (origen, `handoff_request_id` único, check);
  - store: materialización, hecho `handoffPending` en el claim, evento `platform.fallback` en el hilo del operador.
- `apps/channel-gateway`: `GatewayBindings.runFailureFallback`, pasado al runtime.
- `agents/sales`: `SALES_RUN_FAILURE_FALLBACK_TEXT`, compuesto en el gateway productivo y en el canary.

**Invariante.** Una respuesta malformada nunca abandona en silencio una conversación de canal activa. Tras la recuperación acotada, el dueño de la entrega persiste **un** aviso fijo por handoff y lo entrega con reintentos acotados.

El aviso dice: «Disculpa, tuve un problema técnico y no pude responder tu último mensaje. Ya avisé a una persona del equipo de PesasChile, que seguirá la conversación por este mismo chat. No hace falta que repitas lo que escribiste.» No afirma ninguna mutación comercial.

## 5. Pruebas

| Requisito del mandato | Prueba |
|---|---|
| Una respuesta malformada | integración: recupera, responde el agente, sin aviso |
| Dos malformadas consecutivas | integración: handoff, **un** aviso entregado, idempotente con más pasadas y más mensajes |
| JSON sintácticamente válido pero inválido en esquema | integración (`{"type":"respond"}`) |
| Respuestas truncadas | integración (`finish_reason: length`) |
| Timeout del proveedor | integración (dos timeouts) y falla no reintentable (`non_retryable_model_failure`) |
| Reinicio del worker durante la recuperación | integración: worker 1 falla y se cierra; worker 2 falla; aviso único |
| Falla antes y después de una mutación | integración: escritura gobernada con recibo `succeeded` y luego dos malformadas; el aviso no reclama nada. Antes de la escritura no hay recibos |
| Persistencia y reintentos de entrega | integración: 429 → `not_sent` → reintento → `accepted` (2 intentos registrados) |
| Gate | unidad: envío con task humana y handoff pendiente; cancelación con operador o handoff cerrado; kill switch, deny y rollout; terminal, cerrado, antigüedad y ventana; inputs nuevos no lo cancelan |
| Operador antes del envío; kill switch | integración: cancelado `superseded_by_operator`; retenido y luego enviado |
| Esquema | integración: una fila `platform` sin handoff es rechazada por `outbound_messages_platform_fallback` |
| Mutaciones | `test:mutation:run-failure-fallback`: ver §7 |

## 6. Lo que sigue abierto (bloqueantes J5)

1. **Tasa de malformadas del modelo** (~7 % por llamada en el canary; 44 % en los contextos difíciles). El aviso evita el silencio, pero no la pérdida del turno. Propuestas, cada una con su propia decisión:
   - **a.** Protocolo `r4.agent_decision.v6` con lecturas múltiples en un turno (6 de 11 fallas eran lecturas en paralelo). Cambio versionado del protocolo y del kernel: requiere ADR y revisión independiente.
   - **b.** Subir `R4_EXEC_MAX_RUN_FAILURE_RECOVERIES` a 2 en Sales. Es configuración; reduce los handoffs, sin garantía.
   - **c.** Evaluar otro modelo o perfil, o `thinking` desactivado, con la herramienta pareada.
2. Registrar en la telemetría la forma (`shapeOf`) de una salida rechazada, como ya hace el harness de Sales en vivo, para medir la causa en producción sin guardar texto.
3. Repetir el canary J4-R5 con esta corrección (ver el informe del canary §7).

## 7. Evidencia de regresión (rama `fix/r4-p0-run-failure-fallback`, PostgreSQL local)

| Suite | Resultado |
|---|---|
| lint, typecheck | ✓ |
| unit | 1523 passed, 4 skipped (incluye 4 pruebas nuevas del gate en `delivery.test.ts`, 27/27) |
| contract | 450 passed |
| integration (corrida completa) | 609 passed, 12 skipped, 12 fallos: todos inventarios de la cabeza del esquema Core, que ahora es `0012` (`migrations`, `migration-upgrade`, `migration-upgrade-c2`, `binding-identity-immutability`, `worker-readiness`). Se actualizaron y la nueva corrida de esos 5 archivos más `run-failure-fallback` dio **62/62** |
| `run-failure-fallback` (nuevo) | 14/14 |
| sales, shadow | 29, 5 |
| `test:mutation:run-failure-fallback` | **6/6** detectadas, fuentes restauradas |
| recovery | Pendiente: se corre al final y solo, porque termina conexiones de otras sesiones de la misma base |

La máquina estaba cargada con otras corridas en paralelo. Por eso `run-failure-fallback` declara un timeout de 90 s por prueba, igual que otras suites lentas de integración.
