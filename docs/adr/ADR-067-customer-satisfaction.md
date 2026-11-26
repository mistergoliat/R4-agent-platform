# ADR-067 — Satisfacción del cliente: «¿Cómo te atendimos?» y «¿Te sirvió?»

- **Identificador:** `R4-CSAT-01`
- **Estado:** **Propuesto.** No autoriza código ni despliegues; cada fase necesita autorización del owner.
- **Fecha:** 2026-11-26
- **Mandato:** owner, 2026-11-26.
  - El plan comercial omnicanal (documento interno) pide medir la satisfacción del cliente junto con las conversiones y los tiempos.
  - El owner revisó el diseño en el lienzo de la consola: tableros «Satisfacción de clientes», «Cliente · valora la atención (WhatsApp)» y «Cliente · valora la atención (chat web)».
- **Autoridad superior:**
  - AGENTS.md: la salida del modelo no es confiable; toda escritura es gobernada; no se guarda razonamiento.
  - ADR-046 y ADR-057: el canal web, el edge y sus eventos.
  - ADR-051: los incidentes.
  - ADR-055: las reglas de contacto con clientes.

## Contexto

- El chat web ya tiene un «¿Te sirvió?» con pulgar arriba o abajo bajo cada respuesta de Pesín. El edge lo cuenta en su propia memoria con cuatro motivos fijos y nada llega a R4: no se puede ver en la consola ni cruzar con la conversación.
- No existe una pregunta al cliente sobre la atención completa.
- La consola mide tiempos y conversión, pero no satisfacción.

## Decisiones del owner (2026-11-26)

1. **Escala de tres:** Bien, Más o menos, Mal. Es lo más simple de responder y calza con los tres botones de WhatsApp.
2. **En el chat web,** una tarjeta «¿Cómo te atendimos?» cuando el cliente **se despide**. No hay pregunta por tiempo: el cliente no se queda con el chat abierto esperando.
3. **«¿Te sirvió?» se mantiene** bajo cada respuesta. Ahora llega a R4.
4. **Con «Más o menos», «Mal» o «no me sirvió»** se le pide al cliente que explique un poquito qué pasó. Responder es opcional.
5. **Un «Mal» abre un incidente bajo,** para que alguien lo mire.
6. **En WhatsApp,** una plantilla de Meta («valoracion_atencion», categoría utilidad, español, tres respuestas rápidas). Va 30 minutos después de la última respuesta, si el cliente no volvió a escribir, una vez por caso. Cuenta para el tope de contacto (ADR-055) y un seguimiento de cotización tiene prioridad. Esta fase espera que la plantilla esté aprobada.

## Decisión técnica

### D1 — La valoración es un evento del canal, no un mensaje

- **El evento:** el edge envía a R4 un evento nuevo `feedback`, firmado como los demás. Lleva:
  - `conversationRef`;
  - `scope`: `conversation` (la tarjeta) o `message` (un «¿Te sirvió?» sobre una respuesta concreta, con su `outboundId`);
  - `value`: `bien`, `mas_o_menos` o `mal` para la tarjeta; `up` o `down` para el «¿Te sirvió?»;
  - `comment` opcional;
  - `occurredAt`.
- **No entra a la conversación:** el adaptador web lo valida con una lista cerrada y lo entrega aparte, igual que la presencia (ADR-057 D3). Pesín no lo ve como un mensaje.
- **El comentario es texto del cliente:**
  - es dato no confiable y puede traer datos personales;
  - se guarda con el mismo tratamiento que un mensaje entrante, con un máximo de 500 caracteres;
  - nunca aparece en un incidente ni en un aviso;
  - la consola lo muestra solo a operadores, igual que una conversación.

### D2 — Dónde se guarda

- **Tabla en R4 Core:** `customer_feedback`, con `task_id`, `channel`, `scope`, `value`, `comment`, `outbound_id` opcional, `at` e idempotencia por `eventId`.
- **Por qué en Core:** «Evaluación» y «Observación» son primitivas de Core según AGENTS.md. La valoración de una conversación es genérica: no hay concepto de ventas en ella.
- **Una valoración por conversación y alcance:** una nueva reemplaza a la anterior, así que cuenta la última; el historial se conserva.
- **Quién atendió:** se lee de la conversación (Pesín solo o una persona), no del evento.

### D3 — Incidente y lectura

- **Incidente:** un detector `customer_rating_bad`, de severidad baja, agrupa las valoraciones «Mal» por agente y versión. Sigue la regla de ADR-051: solo códigos, conteos, horas y ids de tarea, nunca el comentario.
- **Lectura para la consola:** `GET /v1/feedback?days=N`, de solo lectura.
  - **Totales:** por canal y por quién atendió.
  - **Lista para revisar:** «Mal», «Más o menos» y «No», con la tarea.
  - **El comentario:** viene solo en el detalle de esa lista.

### D4 — WhatsApp (fase posterior)

- **El envío:** la plantilla se manda con las reglas de contacto (ADR-055: tope de frecuencia, prioridad del seguimiento de cotización, nunca a un contacto de prueba, con un traspaso en curso ni a quien pidió no recibir mensajes).
- **La respuesta:** el botón que el cliente toca llega como `feedback` desde el adaptador de WhatsApp, no como un mensaje para Pesín.
- **La explicación:** se le pide en un segundo mensaje, y lo que conteste es un comentario.

## Fases (cada una requiere autorización del owner)

- **S1. Chat web:**
  - el evento `feedback` en el adaptador web;
  - la tabla y su migración;
  - el detector del incidente;
  - la lectura `/v1/feedback`;
  - en el edge, la tarjeta de despedida, la explicación y el envío del «¿Te sirvió?» a R4.
- **S2. Consola:** la pantalla «Satisfacción», diseñada en el lienzo.
- **S3. WhatsApp:** la plantilla aprobada por Meta, el envío y la lectura de la respuesta.

## Fuera de alcance

- Encuestas largas o de varias preguntas.
- NPS.
- Valorar a un vendedor por su nombre ante el cliente.
- Usar las valoraciones para cambiar a Pesín de forma automática. Las revisa una persona.

## Consecuencias

- La medición de satisfacción que pide el plan comercial queda en el mismo lugar que los tiempos y la conversión.
- El «¿Te sirvió?» del chat web deja de quedar solo en el edge.
- Una tabla nueva en Core y un detector de incidentes más.
- El edge cambia su contrato con R4, con un tipo de evento nuevo, así que sus despliegues se coordinan con los de R4.

## Decisiones abiertas del owner

1. ¿Cuenta una conversación sin respuesta a la tarjeta como «no respondió»? Hoy solo se cuentan las respuestas.
2. ¿Cuánto tiempo se guardan los comentarios? Se propone lo mismo que los mensajes de la conversación.
