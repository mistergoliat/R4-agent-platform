# ADR-069 — Transcripción completa de las llamadas, visible en la consola

- **Identificador:** `R4-VOICE-TRANSCRIPTS-01`
- **Estado:** **Propuesto.**
  - Pedido del owner, 2026-11-27: «si alguien llama debería aparecer en la consola el audio para poder escuchar la
    conversación y poder evaluarla».
  - Forma elegida por el owner el mismo día: «parte con el ADR de la transcripción». El texto va primero y el audio
    queda para después.
  - La implementación necesita su OK explícito. Los despliegues necesitan su OK por SHA.
- **Fecha:** 2026-11-27
- **Modifica:** ADR-068 D6 («no se guarda transcripción completa»). Solo para la lista de permitidos mientras no se
  resuelvan las decisiones abiertas 1 a 3.
- **Relacionados:**
  - ADR-068: la llamada es una modalidad del canal WhatsApp.
  - ADR-067: las calificaciones del contacto son una señal, nunca una entrada. Es el patrón que se repite aquí.
  - ADR-049: consola.
  - ADR-036: proveniencia.
  - Discovery G0, O-8: grabación y transcripciones.

## Contexto

Hoy, de una llamada queda en R4 solo lo que la voz delegó, como entradas `[r4:llamada]` de la conversación de WhatsApp.
Lo que GPT-Live conversa solo nunca llega a R4: saludo, fuera de tema, aclaraciones y despedida. Tampoco queda en
ningún log.

El caso que motivó esto, el 2026-11-27:
- El owner preguntó «¿conoces a mi amigo?» y la voz respondió «cuéntame más».
- Se supo solo porque el owner lo contó.
- Para evaluar las llamadas hay que poder leer la llamada entera.

GPT-Live ya entrega las dos transcripciones durante la llamada, sin costo adicional:
- Lo que oyó del cliente: `session.input_transcript.delta`.
- Lo que dijo Don Pesín: `session.output_transcript.delta`.

`r4-voice` hoy las usa en memoria (delegación y auditoría de cifras) y las descarta.

## Decisión 1 — Al cortar, `r4-voice` envía la transcripción completa a R4

**Cuándo:** al terminar una llamada que Don Pesín contestó, `r4-voice` arma la transcripción por turnos y la envía
por la misma ruta firmada de ADR-068 D2 (`/v1/channels/whatsapp-call/webhook`, HMAC sobre timestamp y cuerpo).

**El cuerpo:**

```json
{ "callId": "…", "event": "transcript", "from": "<número firmado por Meta en la llamada>",
  "startedAt": "…", "endedAt": "…",
  "lines": [ { "speaker": "contact" | "agent", "at": "…", "text": "…" } ] }
```

- **Identidad:** el evento es `call:<hash del id de llamada>:transcript`. Repetir el envío no duplica.
- **Orden:** va antes del evento `ended`, para que la conversación ya tenga la transcripción cuando el agente
  pregunte «¿te pude ayudar?».
- **Topes:**
  - 600 líneas, 2.000 caracteres por línea y 128 KB por cuerpo.
  - Con el tope de llamada de 10 minutos de `r4-voice`, nunca se alcanzan. Si se pasan, se trunca por el final y la
    transcripción queda marcada como truncada.
- **Logs:** la transcripción no se escribe en los logs de `r4-voice` ni de R4. ADR-068 D6 sigue igual en ese punto:
  la voz del cliente nunca va a un log.
- **Fallos:** el envío es de mejor esfuerzo. Si falla, se registra y no se reintenta en bucle; la llamada ya terminó.

## Decisión 2 — En R4 es un registro de la conversación, nunca una entrada

Es el mismo patrón de las calificaciones (ADR-067):
- El adaptador de transcripciones de llamada devuelve la transcripción en una lista lateral del resultado, como
  `feedback` y `presence`.
- `ChannelIngress` la guarda con un método del store.
- **No crea `task_input`, no despierta al agente y no entra a su contexto.**

**Por qué:**
- Lo comercial ya entró como entradas `[r4:llamada]`, una por delegación, con las palabras del cliente.
- Meter la llamada entera repetiría esas entradas y le daría al agente texto que nunca debe juzgar como pedido. La
  salida del modelo de voz no es confiable (ADR-068 D2).

**Tabla nueva**, aditiva y genérica:

- **Nombre y alcance:** `session_transcripts`, sin conceptos de Ventas.
  - La modalidad, `call`, es un texto que define el adaptador, igual que `channel`.
  - Las líneas son `speaker` (`contact` / `agent`), `at` y `text`.
- **Datos que no son confiables:**
  - El texto del cliente se guarda como el contenido de un mensaje entrante: personal y no confiable.
  - El texto de Don Pesín es salida de un modelo.
  - Ninguno de los dos se muestra en incidentes, avisos ni notificaciones.
- **Borrable, a diferencia del resto del registro:** no lleva el trigger de inmutabilidad, para que la retención (D4)
  y una solicitud de supresión del titular puedan borrar filas. Es la única tabla de conversación que se borra; lo
  delegado a R4 sigue en las entradas, como hoy.
- **Idempotencia:** por `(channel, event_id)`.
- **Tarea:** `task_id` se resuelve con la conversación del número, como las calificaciones. Si la conversación no se
  puede resolver, queda nulo.

## Decisión 3 — La consola muestra la llamada dentro de la conversación

**En el hilo:** `GET /v1/tasks/:id/thread` agrega una entrada `event` por llamada, en el momento en que empezó:
- `{ type: 'session.transcript', transcriptId, modality, durationS, lines }`, sin texto.
- Igual que los avisos, el hilo muestra una referencia y nunca el cuerpo.
- `r4-voice` lee el hilo, pero solo mira las entradas `agent`. Los turnos anteriores de una conversación
  (`earlierConversationTurns`) no incluyen eventos. Ninguno de los dos cambia.

**Lectura del cuerpo:** `GET /v1/session-transcripts/:id`, con rol lector. Devuelve las líneas con su hablante y su
hora.

**En la consola**, en Conversaciones → la conversación:
- El hilo muestra «Llamada de WhatsApp · 3:12 · ver transcripción».
- Al abrirla, se ve la llamada por turnos: «Cliente» y «Pesín».
- Las delegaciones aparecen marcadas: el turno en que la voz consultó a R4 y la respuesta de R4 que dijo.
- La auditoría de cifras de esa llamada (coincide / cifras sin respaldo) se muestra arriba.
- Nada se edita.

**La mesa de ventas no la muestra en T1** (decisión abierta 2).

## Decisión 4 — Retención y aviso

- **Retención:** una purga diaria borra las transcripciones con más de **30 días**. Es la cifra propuesta (decisión
  abierta 1). La auditoría de cifras y los metadatos de la llamada (duración, delegaciones, espera) no son
  transcripción y quedan.
- **Aviso al llamante:**
  - En T1 solo llama la lista de permitidos (el owner), que sabe que se transcribe.
  - Antes de abrir la voz a clientes (ADR-068 V2), el saludo agrega un aviso corto, por ejemplo «esta llamada queda
    transcrita para mejorar la atención». El aviso de privacidad del sitio se actualiza.
  - Esto sigue pendiente de revisión legal (G0 O-8, Ley 21.719).

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| T1 | Envío desde `r4-voice`, tabla `session_transcripts`, entrada de hilo, endpoint lector, vista en la consola, purga diaria; solo lista de permitidos | Propuesta |
| T2 | Aviso en el saludo y en la política de privacidad; transcripción para llamantes reales (con ADR-068 V2) | Propuesta, tras revisión legal |
| T3 | Audio de la llamada (dos pistas Opus por llamada en S3, con retención y acceso solo de administradores) | Fuera de este ADR; se decide si el texto no basta |

## Evaluación (va con la implementación)

- **Adaptador:**
  - Una firma mala, vieja o ausente da 401.
  - El mismo evento guarda una sola transcripción.
  - Un cuerpo sobre los topes se trunca y queda marcado, nunca da error.
- **Nunca es entrada:**
  - Una transcripción no crea `task_input` ni una corrida del agente.
  - Una transcripción que trae `[r4:` o el texto «sí, emítela» no emite nada.
- **Hilo:**
  - El evento aparece una vez, en orden, sin el cuerpo.
  - `earlierConversationTurns` no cambia.
- **Lector:** sin rol lector da 401/403.
- **Purga:** borra lo vencido y no toca otras tablas.
- **`r4-voice`:**
  - Arma los turnos en orden con su hablante.
  - Envía la transcripción antes del `ended`.
  - No escribe la transcripción en sus logs.
- **L3:** una llamada del owner con una pregunta fuera de tema y una cotización. La consola muestra la llamada
  completa, con la delegación y la auditoría de cifras.

## Decisiones abiertas del owner

1. Retención: 30 días propuestos.
2. Si la mesa de ventas (ADR-048) también ve la transcripción, o solo la consola.
3. El texto del aviso en el saludo (T2).

## Fuera de alcance

- **Audio (T3):** se reevalúa con la experiencia de T1.
- **Evaluación automática de llamadas:** por ejemplo, un auditor con modelo. Primero se lee a mano.
- **Contexto del agente:** la transcripción no entra al contexto del agente de WhatsApp.

## Consecuencias

- **Positivas:**
  - Se puede leer y evaluar la llamada completa, incluido lo que la voz respondió sola.
  - No toca el comportamiento del agente.
  - La tabla es aditiva y sin migración de datos.
- **Negativas:**
  - Por primera vez R4 guarda la conversación hablada completa del cliente. Eso obliga a la retención, el aviso y la
    revisión legal antes de abrir a clientes.
  - Lo que oyó GPT-Live puede tener errores de transcripción: la consola muestra lo que el motor entendió, no el audio.
