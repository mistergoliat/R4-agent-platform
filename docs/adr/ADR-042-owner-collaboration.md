# ADR-042 — R4-OWNER-COLLABORATION-01: el agente comercial consulta directamente al responsable comercial

- **Identificador:** `R4-OWNER-COLLABORATION-01`
- **Estado:** **Propuesto.** Registrado por mandato del owner («R4 — Implementation Mandate J4-R7-1», §3,
  2026-10-28). **No implementado.** Hito: **J5-B** (roadmap §1.1). No se inicia sin autorización explícita.
- **Fecha:** 2026-10-28
- **Autoridad superior:** Constitución; PRD; ADR-002 (cognición vs. autoridad de plataforma), ADR-016/017 (propuestas
  y Policy Engine), ADR-021 (runtime temporal y humano), ADR-033 (identidad de operador para aprobaciones), ADR-037
  (semántica de escrituras comerciales autorizadas), ADR-038 (outbound gobernado), ADR-043 (autonomía comercial)
- **Relacionado:** R4-J4-R7 (diseño §5.4 *Approval Horizon Hold*, BLK-AP1; §3.2 steering durable; §3.6 J5-A)

## Decisión

> **El agente comercial opera autónomamente dentro de sus políticas y consulta directamente al responsable
> comercial cuando necesita una decisión excepcional.**

La comunicación usa un **canal privado**, inicialmente WhatsApp, separado de la conversación con el cliente.

### El agente podrá

- Solicitar excepciones comerciales (por ejemplo, un precio o condición fuera de política).
- Consultar decisiones que requieren criterio humano.
- Presentar los antecedentes de una operación.
- Recibir instrucciones en lenguaje natural.
- Interpretar las respuestas del responsable.
- Continuar la conversación con el cliente después de una decisión válida.

### El sistema deberá

| Requisito | Cómo se garantiza (dirección de diseño, a detallar en J5-B) |
|---|---|
| Autenticar al responsable | Identidad del responsable resuelta por un adaptador de canal confiable (registro de responsables, como ADR-033 para operadores). Nunca desde el contenido del mensaje ni por el modelo |
| Vincular cada consulta con una operación específica | Cada consulta es un `human_request` durable ligado a la task, a la propuesta o a la operación concreta (id, versión del workspace, argumentos) |
| Persistir las decisiones | La respuesta del responsable es evidencia durable con procedencia humana (`temporal_events`), idempotente por mensaje del canal |
| Respetar vigencia, políticas e idempotencia | La consulta tiene vencimiento (TTL); la decisión es **evidencia** para una nueva evaluación del Policy Engine, nunca un ALLOW por sí sola; las escrituras conservan sus claves de ejecución |
| Mantener separadas las conversaciones del cliente y del responsable | Binding y canal propios del responsable; ninguna entrada del responsable entra al hilo del cliente ni viceversa; el modelo las ve como fuentes distintas con autoridad distinta |
| Evitar que una autorización desactualizada habilite una operación modificada | **Approval Horizon Hold** (R7-3, BLK-AP1): la decisión queda ligada al horizonte conversacional y a los argumentos vistos; si la operación o la conversación del cliente cambian, se retiene y se re-ratifica |
| Permitir que otras conversaciones sigan ejecutándose | La espera de la decisión suspende sólo esa task (`WAIT_FOR_HUMAN`); los workers siguen con las demás; sin bloqueo global |

### Interpretación del responsable

El modelo interpreta la respuesta en lenguaje natural del responsable (AD-01 de R7: la semántica es del modelo). Esa
interpretación **no** es autoridad comercial:
- Una excepción aprobada sólo habilita lo que el Policy Engine y los contratos del dominio (Quote, Checkout) acepten
  con esa evidencia.
- Una respuesta ambigua del responsable lleva a una repregunta, no a una ejecución.

## Dependencias

| Dependencia | Estado | Necesaria para |
|---|---|---|
| HumanRuntime (`TemporalRuntime`: `human_requests`, respuestas, vencimientos) | Existente | Consultas durables, vencimiento, idempotencia |
| Approval Horizon Hold (R7-3, BLK-AP1) | Diseñado, no implementado | Que una decisión desactualizada no habilite una operación modificada |
| Steering durable (R7-2) | Diseñado, no implementado | Mensajes del cliente durante la consulta: identificados, sin pérdida |
| Steering interactivo (J5-A) | Planificado | Opcional: incorporar la decisión durante un turno activo |
| Outbox (dueño de la entrega, ADR-038/041) | Existente | Mensajes al responsable con el mismo ciclo de vida, gate e idempotencia |
| Canal privado del responsable (adaptador WhatsApp, registro de responsables) | No existe | Autenticación y separación de conversaciones |

## Restricciones

- No implementar durante R7-1 (mandato §3 y §5).
- No es un supervisor ni un segundo modelo: el responsable es un humano.
- No sustituye a `REQUIRE_APPROVAL` (ADR-043): es un canal más para decisiones humanas excepcionales.

## Alternativas a evaluar en J5-B

1. Reutilizar `request_consultation` con destino "responsable" (ruteo de canal) frente a un tipo de `human_request`
   nuevo.
2. Aprobación estructurada (botones o plantilla) frente a lenguaje natural interpretado por el modelo y confirmado
   por la plataforma.
