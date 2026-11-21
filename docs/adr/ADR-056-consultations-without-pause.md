# ADR-056 — Consultas al equipo sin pausar la conversación

- **Identificador:** `R4-CONSULT-01`
- **Estado:** **Propuesto. No implementado.** Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-20
- **Mandato:** owner, 2026-11-20: «ese diseño del lienzo es el que debemos lograr» (pantallas «Ventas · Pesín te
  consulta» y «Cliente · Pesín consulta al equipo» de la consola). El cliente no cambia de persona: Pesín dice «lo
  confirmo con el equipo», sigue resolviendo lo demás y, cuando el equipo responde, continúa con esa respuesta.
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «la evaluación se entrega con la
  implementación»); ADR-008 (protocolo de decisión); ADR-021 (runtime temporal y humano); ADR-041 y su extensión F-ADV-2
  (avisos de plataforma); ADR-048 (mesa de ventas); ADR-051 (incidentes).

## Contexto

Hechos verificados en `main`:
- **Una consulta pausa la conversación.** `request_consultation` abre un pedido humano y una espera `WAIT_FOR_HUMAN`.
  Un mensaje del cliente durante esa espera se guarda, pero **no despierta al agente**: solo `WAIT_FOR_INPUT` y
  `WAIT_UNTIL` se despiertan con un mensaje (`TemporalRuntime.#submitInputWithin`). El cliente que pregunta otra cosa
  queda sin respuesta hasta que alguien conteste la consulta.
- **El aviso al cliente ya existe en WhatsApp.** F-ADV-2 envía un aviso fijo cuando el agente abre una consulta o un
  traspaso sin haber respondido en ese turno, para los perfiles `sales-production@17` a `@22`: «Lo estoy consultando con
  un asesor de nuestro equipo de PesasChile; la respuesta llegará por este mismo chat…» (con su variante fuera de
  horario).
- **En la web el aviso dice que nadie atiende.** El texto de los perfiles web termina en `[[contacto]]` y
  `[[nueva-conversacion]]` (ADR-046), porque hasta ahora nadie atendía la web.
- **La consulta solo lleva la pregunta.** `consultationDecisionSchema` tiene `question`, `contextRefs` y `expiresAt`. No
  hay respuestas sugeridas.
- **La mesa ya responde consultas** (ADR-048, fase 1): sección «Pesín te consulta», responder, «Lo tomo yo», aporte en el
  libro y marca de vencida a los 10 minutos.
- **Política comercial (owner, 2026-11-20):** no se ofrecen descuentos. El precio es el del catálogo, con sus
  promociones vigentes.

## Decisión 1 — Consulta sin pausa

`request_consultation` gana un modo **sin pausa** (`blocking: false`). El modo actual, con pausa, sigue igual.

1. **El agente responde en el mismo turno.** Una consulta sin pausa se registra y el agente debe responder antes de
   terminar el turno, por ejemplo «Lo confirmo con el equipo y te respondo aquí mismo. Mientras tanto, ¿a qué comuna va
   el despacho?». Después la tarea espera al cliente (`WAIT_FOR_INPUT`), como siempre.
2. **La conversación sigue.** Si el cliente escribe, el agente responde normalmente. Su contexto muestra la consulta
   pendiente con su pregunta, para que no la conteste por su cuenta ni prometa un dato que no tiene.
3. **La respuesta despierta al agente.** Cuando una persona responde, R4 la registra como una entrada de la tarea, de
   origen humano y confiable. Esa entrada despierta al agente si está esperando al cliente, o queda en cola si está en
   un turno. El agente continúa con la respuesta: «Confirmado por Camila, del equipo de ventas: …».
4. **Si nadie responde a tiempo,** la consulta vence (`expiresAt`, o el SLA que fije el paquete) y el agente despierta
   con el vencimiento. Le dice al cliente que no pudo confirmarlo y le ofrece una persona (traspaso) o el contacto.
5. **«Lo tomo yo» no cambia:** tomar la conversación sigue cerrando la consulta (ADR-048, fase 1).

Con la consulta sin pausa el agente mismo avisa al cliente en su respuesta, así que el aviso fijo de F-ADV-2 sigue solo
para las consultas con pausa y los traspasos.

**Core:** la consulta sin pausa y la entrada de origen humano son genéricas (ADR-021). No hay conceptos de Ventas.

## Decisión 2 — Respuestas sugeridas

La consulta puede llevar hasta 4 respuestas sugeridas (`options`, cada una de hasta 60 caracteres), por ejemplo «Sí, con
RUT y giro» y «Solo pago contado».
- **La mesa las muestra como botones.** Elegir una envía ese texto como respuesta, con la nota opcional del vendedor.
  La respuesta libre sigue disponible.
- **Son salida del modelo y no autorizan nada:** son texto que una persona elige. La respuesta llega al agente como
  información, igual que hoy.
- El paquete de Ventas pide sugerencias solo cuando la pregunta tiene respuestas cerradas.

## Decisión 3 — Una respuesta nunca cambia un precio

El agente usa la respuesta como información para el cliente. Los precios, el stock y el despacho se siguen leyendo de
sus servicios, y una cotización usa siempre el precio vigente del catálogo. Con la política actual (sin descuentos), una
respuesta que hable de precio se usa solo para explicarle al cliente esa política. Lo verifica la evaluación de cada
versión que use consultas.

## Decisión 4 — Aviso al consultar en la web

Cuando la mesa atienda la web, el perfil web que consulta o deriva usa el aviso de WhatsApp: el equipo responde aquí
mismo. Se deja el de «nadie puede atenderte aquí», y el traspaso deja de abrir una conversación nueva. Llega con una
versión nueva del perfil web, con su evaluación. Hasta entonces la web sigue sin consultar ni derivar (ADR-046).

## Decisión 5 — Alerta cuando una consulta espera de más

Un detector nuevo de incidentes (ADR-051), `consultation_waiting`, marca toda consulta sin respuesta pasado el SLA
(ADR-048: 10 minutos). Aparece en la consola, y el aviso al celular que ya corre cada 10 minutos lo incluye. La mesa ya la
marca como vencida en la bandeja. Quién la recibe como supervisor sigue siendo una decisión abierta del ADR-048.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido |
|---|---|
| K1 | Respuestas sugeridas (contrato y botones en la mesa) y el detector `consultation_waiting` |
| K2 | Consulta sin pausa en R4 Core (entrada de origen humano que despierta al agente; contexto con la consulta pendiente; vencimiento) |
| K3 | Versión de Pesín (WhatsApp) que consulta sin pausa y propone sugerencias, probada como variante (ADR-054) y lanzada como experimento |
| K4 | Versión del perfil web que consulta y deriva hacia la mesa, con el aviso de la Decisión 4 |

## Fuera de alcance

- Descuentos y cualquier cambio de precio.
- Asignar consultas por área (llega con el ruteo de la fase 2 de ADR-048).

## Consecuencias

- El cliente nunca queda en silencio por una consulta: o Pesín sigue conversando, o hay un aviso y una alerta si nadie
  responde.
- R4 Core gana un modo de consulta y una entrada de origen humano. Ambos son genéricos y llevan sus pruebas de
  contrato. El modo con pausa no cambia.
- El agente tiene una regla más que cumplir (no contestar la consulta por su cuenta). La evaluación de K3 lo verifica
  antes de lanzar.
