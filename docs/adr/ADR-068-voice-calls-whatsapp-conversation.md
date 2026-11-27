# ADR-068 — Llamadas de WhatsApp: la voz conversa y R4 atiende lo comercial en la misma conversación

- **Identificador:** `R4-VOICE-CALLS-01`
- **Estado:** **Aceptado** (merge del PR #192, 2026-11-26).
  - Decisión de forma del owner, 2026-11-26: «sí, vamos con esa forma, parte con el ADR». Se refiere a la llamada y
    el WhatsApp escrito como una sola conversación.
  - V1 autorizada por el owner el 2026-11-26: «sí, haz merge del #192 y parte con V1». Los despliegues en producción
    siguen necesitando su OK explícito por SHA.
  - **Revisión 1, mismo día:** decisión del owner sobre D4: «que acepte cotizaciones, para poder mandarlas por mail y
    el whatsapp altiro».
- **Fecha:** 2026-11-26
- **Contexto previo:**
  - Discovery G0: `docs/architecture/R4_VOICE_G0_DISCOVERY.md`, PR #120.
  - Gateway de voz `r4-voice`, repo privado. G1: llamada real con audio en ambos sentidos. G2: conversación con
    GPT-Live por WebRTC, probada en llamadas reales el 2026-11-26.
- **Relacionados:**
  - ADR-035: verificación de intención.
  - ADR-036: proveniencia de las entradas.
  - ADR-046: canal web firmado.
  - ADR-053: un agente por canal; contacto, persona y cliente.
  - Inbound multimodal v1: marcas de nota de voz.

## Contexto

`r4-voice` ya contesta las llamadas al número de WhatsApp de R4:
- Recibe una copia del webhook (`mirror` de nginx) y negocia WebRTC con Meta.
- Puentea el audio Opus con GPT-Live, que conversa en tiempo real.
- Hoy no tiene acceso a nada comercial: dice que no puede confirmar precios ni stock.

El owner quiere que la llamada **cotice y responda lo comercial**. El discovery G0 (§7) proponía un canal `voice` aparte,
con un agente `sales-voice` de solo lectura. No cotiza, y suma un gateway y un worker en un host con poca memoria.

**El dato que cambia la propuesta:** quien llama al número de WhatsApp lo hace desde su WhatsApp. Meta firma el mismo
número de cliente en la llamada y en los mensajes. Ya existe un contacto de WhatsApp, y casi siempre una conversación
con Don Pesín, el agente que hoy cotiza con todas sus reglas.

**Restricción conocida:** un turno de R4 tarda decenas de segundos, casi todo en tiempo de modelo. R4 no puede estar
en cada frase de una llamada.

## Decisión 1 — La llamada es una modalidad del canal WhatsApp, no un canal nuevo

Lo comercial que se pide por voz entra a **la misma conversación de WhatsApp** del número que llama: mismo contacto,
misma tarea, mismo agente, mismo carril (lane), mismos topes y mismo kill switch.

No se crea `sales-voice` ni un canal `voice`. Esto precisa ADR-053 D2, «un agente por canal»: una llamada de WhatsApp
es el canal WhatsApp.

**Por qué:**
- Cotiza desde el primer día.
- La cotización y el PDF llegan donde sirven, al chat.
- La conversación aparece en la consola y en la mesa como cualquier otra.
- No se duplica ninguna regla comercial.

Una llamada abre o renueva la ventana de 24 h de WhatsApp (documentación de Meta Calling, «pricing»), así que R4 puede
responder por escrito aunque el cliente nunca haya escrito.

## Decisión 2 — Entrada: lo que dijo el cliente, por una ruta propia y firmada

Cuando el motor de voz delega un pedido comercial, `r4-voice` envía a R4 **la transcripción final de lo que dijo el
cliente** en ese turno. Nunca envía el resumen del modelo de voz, porque la salida de un modelo no es confiable.

- **Ruta:** una ruta propia del gateway de canal, separada del webhook de Meta.
  - La firma con HMAC sobre timestamp y cuerpo, con un secreto propio de `r4-voice`, como el canal web (ADR-046).
  - El adaptador produce una entrada canónica **del canal WhatsApp**, con el número firmado por Meta que llegó en la
    llamada.
  - La identidad del evento es `voice:<id de llamada>:<turno>`, para la idempotencia.
- **Marca:** el texto llega con una cabecera de plataforma, `[r4:llamada]`, del mismo tipo que `[r4:nota-de-voz]`, y
  la proveniencia queda registrada.
- **Descartado:** firmar un webhook con formato de Meta usando el app secret. Suplantaría al proveedor, R4 no podría
  distinguir un texto escrito de una transcripción, y rompe ADR-036.
- **Core:** el adaptador es transporte puro en `adapters/channels`. Si `live-ops` necesita aceptar un segundo
  adaptador de entrada para un mismo canal, ese cambio es genérico y no lleva conceptos de Ventas ni de voz.

## Decisión 3 — Salida: R4 responde por WhatsApp como siempre; la voz lo dice

R4 responde por la salida normal de WhatsApp: texto, oferta, PDF, guardas de turno y avisos.

`r4-voice` obtiene esa respuesta con el lector de servicio existente (`GET /v1/tasks/:id/outbound`, sin escrituras).
El motor de voz la recibe como resultado de la delegación y la dice.

- **Cifras textuales:** las cifras se dicen tal cual vienen de R4. El motor está instruido para decir precios,
  cantidades y plazos textuales y para ofrecer «te lo dejé en el WhatsApp».
- **Auditoría de lo dicho:** al cortar, `r4-voice` compara las cifras de la transcripción de salida del motor con las
  de los textos que entregó R4 en esa llamada. Guarda solo el resultado (coincide / cifras sin respaldo), nunca la
  transcripción.
- **Espera:** mientras R4 trabaja, la voz sostiene la espera con la delegación de GPT-Live y sus acuses hablados.
  Tope: 90 s. Si R4 no respondió para entonces, la voz dice que la respuesta llegará por WhatsApp. La respuesta llega
  igual, porque la tarea sigue.
- **Interrupciones:** si el cliente interrumpe, se cancela el **audio**, nunca la tarea de R4.

## Decisión 4 — Lo dicho en la llamada acepta como un texto escrito (revisión 1)

**Decisión del owner, 2026-11-26:** la llamada acepta cotizaciones, para que el PDF salga al WhatsApp en el acto. La
revisión original (aceptación solo por chat) queda reemplazada.

- **Regla:** lo que el cliente dice en la llamada pasa por la **misma guardia de intención** que un «sí» escrito
  (ADR-035, `guardIntentReply`). Nunca acepta si hay pregunta, negación, duda o pedido de cambio. `quote.create`
  aplica todos sus controles de siempre: la oferta presentada, los topes F1 y la idempotencia.
- **Errores de transcripción:** la transcripción puede equivocarse.
  - La marca `[r4:llamada]` le dice al agente que, si la aceptación no es clara o la transcripción parece equivocada
    (otro producto, otra cantidad), pregunte antes de emitir.
  - La oferta presentada queda escrita en el chat.
  - Una cotización no compromete dinero: el pago sigue su propio flujo.
- **Lo que no cambia:** la marca sin las palabras del cliente nunca acepta. Las palabras del cliente nunca pueden
  traer una cabecera de plataforma propia.
- **Voz:** delega también la aceptación, con las palabras del cliente, y nunca dice que una cotización quedó emitida
  si R4 no lo confirmó.
- **Correo:** enviar la cotización por correo (`quote.email@1`) hoy está solo en el perfil web. Llevarlo a WhatsApp es
  una versión nueva del perfil del carril, evaluada, y queda fuera de esta revisión.

## Decisión 5 — Activación y alcance

- **V1:**
  - Solo para la lista de permitidos de `r4-voice`. Hoy es el owner; sus conversaciones van por el carril.
  - Las reglas para el agente (respuestas cortas, aceptación con la misma guardia) viajan en la marca
    `[r4:llamada]`, igual que las de las notas de voz.
  - Si el L3 muestra que hacen falta en la definición, se hace una versión nueva del carril, evaluada.
  - El resto de los llamantes sigue igual que hoy: su llamada suena sin contestar.
- **Apagado:**
  - El archivo kill de `r4-voice` ignora llamadas nuevas y corta las activas.
  - El kill switch de R4 detiene la autonomía como siempre: la voz dice que un vendedor le escribirá.
- **Handoff:** si la conversación pasa a una persona (handoff, ADR-048), la voz lo dice y deja de delegar. No hay
  transferencia de audio a la mesa en V1.

## Decisión 6 — Datos

- **Lo que queda:** lo que se delega a R4 queda como entrada durable de la conversación, igual que un mensaje de
  WhatsApp, con su marca.
- **Lo que no se guarda:** el resto de la llamada. No hay audio, transcripción completa ni voz del cliente en logs.
  `r4-voice` registra solo lo que dijo Don Pesín y los metadatos de la llamada.
- **Pendiente legal:** retención, aviso de privacidad y la Ley 21.719 siguen pendientes antes de abrir a clientes
  (discovery G0, O-8).

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| V1 | Adaptador firmado de transcripciones en R4, lectura de la respuesta, delegación en `r4-voice`, auditoría de cifras, marca `[r4:llamada]`, aceptación hablada (D4 rev. 1); solo la lista de permitidos | Autorizada; despliegue con OK por SHA |
| V2 | Llamantes reales con despliegue gradual, aviso de privacidad, métricas por llamada (espera, delegaciones, auditoría) | Propuesta |
| V3 | Cotización por correo desde WhatsApp (`quote.email` en el perfil del carril) | Propuesta |

## Evaluación (va con la implementación)

- **Adaptador:**
  - Una firma mala, vieja o ausente da 401.
  - La misma identidad de evento produce una sola entrada.
  - La marca siempre está presente.
  - Nunca se aceptan números fuera del canal firmado.
- **Guardia de intención:**
  - Una entrada `[r4:llamada]` se juzga igual que el mismo texto escrito: lo que se rechaza por escrito se rechaza
    en la llamada.
  - La marca sin las palabras del cliente nunca acepta.
- **`r4-voice`:**
  - Delega solo transcripciones finales.
  - Se mantiene dentro del tope de espera.
  - La auditoría detecta una cifra sin respaldo.
- **L3:** una llamada real del owner.
  - La oferta llega al WhatsApp y la voz dice las mismas cifras.
  - Un «sí» dicho en la llamada emite la cotización, y el PDF llega al WhatsApp.
  - La auditoría queda limpia.

## Decisiones abiertas del owner

1. ~~Si una frase dicha en la llamada podrá aceptar.~~ Resuelta el 2026-11-26: sí (D4, revisión 1).
2. El tope de espera en línea (propuesto 90 s).
3. Qué dice la voz cuando R4 pasa la conversación a una persona: «un vendedor te escribirá», o en el futuro
   transferir el audio a la mesa (G5 del discovery).

## Fuera de alcance

- Transferencia de audio a un operador (G5).
- Llamadas salientes (G6).
- Grabación.
- Un endpoint de lecturas rápidas de Catalog para la voz (se reevalúa si la espera medida en V1 no se sostiene).

## Consecuencias

- **Positivas:**
  - Por voz se cotiza con las mismas reglas que por escrito.
  - No hay agente, worker ni proceso nuevo en R4.
  - La continuidad entre voz y chat es la de la propia conversación.
- **Negativas:**
  - El cliente espera en línea lo que dura un turno de R4.
  - La conversación escrita recibe entradas que el cliente no escribió (marcadas).
  - Un error de transcripción podría llegar a una aceptación. Lo frenan la guardia, la pregunta del agente cuando hay
    duda y la oferta escrita en el chat.
