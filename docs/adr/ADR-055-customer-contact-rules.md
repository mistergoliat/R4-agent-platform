# ADR-055 — Contacto con clientes: reglas para los mensajes por iniciativa propia

- **Identificador:** `R4-CONTACT-01`
- **Estado:** **Propuesto, revisión 1.**
  - El owner autorizó implementar el seguimiento automático el 2026-11-25 («dale, partamos con el seguimiento
    automático»). Esto cubre las fases C1 y C2, con el diseño de la sección «Revisión 1».
  - Desplegar, y pasar de sombra a activo, necesitan cada uno autorización explícita del owner.
- **Fecha:** 2026-11-20; revisión 1, 2026-11-25.
- **Mandato:** owner, 2026-11-20: «vamos con el ADR-048, la mesa de ventas y el contacto con clientes». El diseño de
  la pantalla «Contacto con clientes» del lienzo de la consola (2026-11-18) pasa a decisión escrita.
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «las escrituras requieren ejecución
  gobernada»); ADR-029 (entrega gobernada por canal); ADR-041 (avisos de plataforma); ADR-047 (cierre por
  inactividad); ADR-048 (mesa de ventas); ADR-053 (un agente por canal).

## Contexto

- **Hoy R4 solo responde.** Cada mensaje que sale contesta algo que escribió el cliente: respuestas del agente,
  respuestas de una persona (ADR-050) y avisos de plataforma ligados a un turno (ADR-041). Fuera de la ventana de 24 h
  de WhatsApp, la entrega cancela lo que no puede salir (`window_closed`).
- **Vienen mensajes que nadie pidió en ese momento:** el seguimiento de una cotización sin pagar, el aviso de que
  volvió el stock, la encuesta al cerrar un caso (ADR-048) y, más adelante, campañas.
- **Sin una regla común, cada fuente decide sola.** Un cliente con un reclamo abierto podría recibir una campaña, el
  seguimiento de una cotización ajena podría salir sin su dueño (ADR-048, Decisión 4), o tres agentes podrían
  escribirle el mismo día.
- **R4 ya tiene las piezas de entrega:** salida durable, idempotencia, resultado incierto sin reenvío, ventana de 24 h
  y kill switch. Falta la decisión previa: si un mensaje por iniciativa propia puede salir, cuándo y cuál.

## Decisión 1 — Responder nunca se bloquea

Las reglas de este ADR aplican **solo a los mensajes por iniciativa propia**: los que no contestan a un mensaje del
cliente en curso. Responder lo que el cliente pregunta nunca pasa por estas reglas, con una única excepción: la ventana
de 24 h de WhatsApp, que ya aplica la entrega.

Todo mensaje por iniciativa propia declara su **propósito**, de una lista cerrada que declara el paquete:

| Propósito | Ejemplo | Prioridad |
|---|---|---|
| `postventa` | El repuesto de un reclamo ya salió | 1 (la más alta) |
| `promesa` | El cliente pidió que le avisaran cuando volviera el stock | 2 |
| `seguimiento` | La cotización sigue sin pagar | 3 |
| `aviso` | Un cambio que afecta al cliente (despacho, precio de su cotización) | 4 |
| `campana` | Campaña comercial | 5 |
| `encuesta` | Satisfacción al cerrar un caso | 6 |

Un propósito desconocido se rechaza. Core no interpreta los propósitos: solo aplica su orden y las reglas.

## Decisión 2 — Las reglas, en orden

La primera regla que aplica decide. Cada mensaje guarda la regla que lo dejó salir o lo detuvo.

1. **Pidió no recibir mensajes.** Solo se le responde. Nadie le escribe primero, nunca.
2. **Tiene un reclamo o una garantía abierta.** Solo sale `postventa`. Lo demás queda en pausa hasta que se cierre.
3. **Está conversando con una persona.** Solo esa persona le escribe. El agente y las campañas esperan a que el caso
   se cierre.
4. **Tiene una cotización vigente.** El `seguimiento` es del dueño de la cotización (ADR-048, Decisión 4). Si lo
   genera el agente y la cotización es de un vendedor, queda como borrador en la bandeja de ese vendedor
   («Preparado para ti»). Las campañas esperan a que pague o venza.
5. **Tope de frecuencia.** Como máximo 1 mensaje cada 3 días y 4 al mes, sumando todas las fuentes (agentes y
   personas). `postventa` y `promesa` no cuentan contra el tope; sí cuentan para el siguiente.
6. **Horario.** Lo que se genera fuera del horario espera al siguiente tramo.
7. **Consentimiento y canal.** Una `campana` necesita permiso de marketing en ese canal. En WhatsApp, pasadas 24 h,
   solo sale con una plantilla aprobada por Meta. Un correo dado solo para un aviso (por ejemplo, el del chat web,
   ADR-048, Decisión 5) sirve solo para ese aviso.

**Si dos mensajes quieren salir el mismo día,** sale el de mayor prioridad. El resto espera su turno, o se junta en un
solo mensaje cuando el paquete lo declara posible (por ejemplo, el aviso de stock y una campaña de la misma
categoría). Esperar tiene un vencimiento: un mensaje que deja de tener sentido (una campaña terminada) se descarta.

## Decisión 3 — Nadie se salta una regla sola

- **Ningún agente** puede cambiar ni saltarse estas reglas. Las reglas son configuración versionada, firmada por el
  owner.
- **Un supervisor** puede liberar un mensaje puntual detenido, con motivo. Queda registrado en la Auditoría.
- **Las reglas 1 y 7 no se saltan nunca:** son el permiso del cliente.
- **Pedir la baja es inmediato.** Una palabra declarada por el paquete («BAJA», «no me escriban») o la acción de una
  persona marca al contacto en la regla 1 desde ese momento. La baja se puede revertir solo si el cliente lo pide.

## Decisión 4 — Dónde vive cada cosa

| Pieza | Dueño | Por qué |
|---|---|---|
| La compuerta: propósito, orden, tope, horario, espera, registro de cada decisión | **R4 Core**, genérico | Todo mensaje que sale pasa por la entrega de R4. La compuerta va justo antes, para las mismas fuentes |
| Baja y consentimiento por canal | R4, por contacto (ADR-053, capa contacto) | Es permiso del cliente sobre su canal |
| «Está conversando con una persona» | R4 (traspaso activo) | Ya lo sabe |
| «Reclamo abierto», «dueño de la cotización» | La mesa de ventas (ADR-048) y Quote | Son conceptos de dominio. Llegan a R4 como **pausas opacas**: `pausa(motivo, hasta, propósitos permitidos)` |
| Qué propósitos existen y su prioridad, qué se puede juntar | El paquete | Core no sabe qué es una campaña |
| Campañas | Un agente o servicio de marketing, futuro | Fuera de este ADR |

Core gana una primitiva genérica: **compuerta de contacto** (propósito, prioridad, pausas, tope, horario,
consentimiento, decisión registrada). No gana reclamos, cotizaciones ni campañas.

## Decisión 5 — La pantalla «Contacto con clientes»

En la consola, sección «Operar el día»:
- **Los números del día:** mensajes por iniciativa propia (de agentes y de personas), detenidos por una regla,
  clientes en pausa y bajas del mes.
- **Las reglas en orden,** con su versión y quién la firmó, y cuántos clientes caen hoy en cada una.
- **Los mensajes de hoy:** cliente (enmascarado), qué quería salir y de quién, el resultado (enviado, detenido,
  desviado, juntado, en espera, descartado) y la regla que lo decidió.
- **Un cliente, todos sus contactos:** su estado (en pausa, cartera, caso abierto, permisos por canal) y la línea de
  tiempo de lo que se le envió y lo que se detuvo.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido |
|---|---|
| C0 | Este ADR |
| C1 | Baja y consentimiento por contacto, y la compuerta en modo **sombra**: decide y registra, pero no detiene nada, porque todavía no hay mensajes por iniciativa propia. La pantalla, en solo lectura |
| C2 | Primer propósito real: `seguimiento` de cotizaciones del agente, con la compuerta activa |
| C3 | Pausas de la mesa de ventas (reclamo abierto, dueño de la cotización) y desvío a «Preparado para ti» (ADR-048) |
| C4 | Encuestas y campañas, cuando existan sus fuentes |

## Decisiones del owner

**Tomadas el 2026-11-25:**
1. **Horario:** lunes a sábado, de 9:00 a 20:00, hora de Chile.
2. **Tope:** como máximo 1 mensaje cada 3 días y 4 cada 30 días.
3. **Baja:**
   - Las palabras son «BAJA», «no me escriban» y «no quiero más mensajes».
   - La confirmación dice: «Listo, no te escribiremos por iniciativa propia. Si nos escribes, te respondemos como
     siempre.»
4. **Seguimiento:** uno con texto normal dentro de las 24 horas y otro después con la única plantilla de Meta,
   `seguimiento_cotizacion`.
5. **Encendido:** primero en sombra y después activo.

**Siguen abiertas:**
1. De dónde sale el permiso de marketing en cada canal. Solo hace falta para `campana` (C4).
2. Quién puede liberar un mensaje detenido: el supervisor, el owner o ambos. Hace falta cuando exista la pantalla.
3. Si el mensaje de la cotización agrega la línea «Si no quieres que te escribamos, responde BAJA».
   - Meta pide que el cliente haya aceptado recibir mensajes que la empresa inicia.
   - La Ley 21.719 pide transparencia.
   - El cliente inició la conversación y pidió la cotización, pero esta línea deja explícito su permiso y le muestra
     cómo darse de baja.
4. Quién crea la plantilla `seguimiento_cotizacion` en WhatsApp Manager. Meta la aprueba y le asigna la categoría.
5. Los feriados: hoy no están modelados, y el horario los trata como días hábiles.

## Revisión 1 — Diseño de C1 y C2: seguimiento de cotizaciones por WhatsApp

### Secuencia

Aplica a una cotización emitida por el agente en WhatsApp, cuando el cliente no volvió a escribir.

| Paso | Cuándo | Cómo sale |
|---|---|---|
| **S1** | En el primer momento dentro del horario entre las 18 h y las 23 h 30 desde el último mensaje del cliente | Texto fijo, con la ventana de 24 h todavía abierta, como aviso de plataforma sobre la tarea abierta (clave `sales.followup-1:<quoteId>`) |
| **S2** | 3 días después de S1, o 4 días después de la cotización si S1 no salió. Siempre en el primer momento dentro del horario | La plantilla `seguimiento_cotizacion` de Meta, la única que se necesita |

**Reglas de la secuencia:**
- S2 queda a 3 días de S1 para respetar el tope de 1 cada 3 días.
- Si el horario no deja un momento antes de las 23 h 30, S1 no sale y queda registrado como `fuera_de_horario`. Nunca
  se corre fuera de la ventana.
- El cierre por inactividad (ADR-047) no cambia: el caso se cierra a las 24 h del último mensaje del cliente.

**La secuencia termina** cuando pasa cualquiera de estas cosas:
- el cliente escribe: su mensaje abre un caso nuevo, que recuerda la cotización (lectura de cotizaciones de 30 días);
- el cliente pide la baja;
- la cotización vence antes del paso;
- una persona toma la conversación;
- salió S2. No hay un tercer intento.

### Texto fijo, del paquete

El modelo no redacta estos mensajes en esta versión. Así no puede prometer nada y la sombra muestra exactamente qué
habría salido. El PRD (§16) deja que el agente decida si contactar; eso queda para una versión siguiente, y la
compuerta lo seguirá gobernando igual.

- **S1:**
  > Hola, ¿pudiste revisar la cotización {número}? Si te queda alguna duda sobre los productos o el despacho,
  > escríbeme y lo vemos. La cotización vale hasta el {fecha}.
- **S2:** la plantilla dice:
  > Hola, te escribe Pesín de Pesas Chile. Tu cotización {{1}} sigue disponible hasta el {{2}}. ¿Te ayudo a terminar tu
  > compra o a resolver alguna duda?

  Tiene tres botones de respuesta rápida: «Sí, ayúdame», «Ya compré» y «No me escriban». Un botón llega como un
  mensaje con su texto:
  - «No me escriban» es una palabra de baja;
  - «Sí, ayúdame» y «Ya compré» abren un caso normal.
- **Confirmación de baja:** responde a un mensaje del cliente, así que no necesita plantilla.

### Baja (regla 1)

- Se decide en la entrada del mensaje, sin el modelo. El texto se normaliza (minúsculas, sin tildes, sin puntuación)
  y tiene que ser **igual** a una de las palabras declaradas. «No me escriban más tarde» no es una baja.
- Cuando el texto es una baja:
  - el mensaje se registra;
  - no despierta al agente;
  - sale la confirmación fija.
- La baja se guarda por contacto: canal más la clave estable de la conversación (`conversation_key`). Vale para
  todos los casos de ese contacto.
- Volver atrás una baja: solo si el cliente lo pide, con una acción registrada de una persona. En C1 es un
  procedimiento del runbook; la pantalla llega después.

### La compuerta (R4 Core)

**Entrada:** canal, contacto, propósito, origen (`sales.quote-followup:<quoteId>:<paso>`), momento debido y
vencimiento.

**Reglas, en el orden de la Decisión 2, con lo que existe hoy:**
1. **Baja.**
2. **Reclamo abierto.** Llega como pausa opaca en C3. Hasta entonces no hay ninguna, así que la regla pasa.
3. **Conversando con una persona:** la tarea está tomada por una persona.
4. **Dueño de la cotización.** Hoy todas son del agente; los vendedores entran con C3.
5. **Tope:** 1 cada 3 días y 4 cada 30 días, contando los mensajes por iniciativa propia que salieron.
6. **Horario.**
7. **Canal:** pasadas 24 h, WhatsApp solo acepta una plantilla.

**Registro:** cada decisión guarda contacto, propósito, origen, regla, resultado (`enviar`, `detenido`, `en_espera`
o `descartado`), modo (`sombra` o `activo`) y el mensaje que salió, si salió.

### Dónde corre

**El barrido:**
- Corre en el channel gateway cada 60 s, como el cierre por inactividad.
- Lo controla `R4_PROD_CONTACT_MODE=off|shadow|active`. Por defecto está en `off`.
- En `shadow` decide y registra, sin encolar nada.

**Qué pone cada parte:**
- **Sales** aporta la fuente: las cotizaciones emitidas, unidas a su conversación, y el texto.
- **Core** aporta la compuerta, la baja, el registro y la plantilla.

**Plantillas (Core):**
- La salida gana un origen `contact` con plantilla (nombre, idioma, parámetros). Va sobre la última tarea del
  contacto, aunque esté cerrada.
- La entrega le aplica el kill switch, la lista de bloqueo, el rollout y la vigencia de 10 minutos.
- No le exige ventana abierta, tarea viva ni enlace abierto, porque la plantilla es justamente lo que permite
  escribir fuera de la ventana.
- Si la ventana está cerrada y el mensaje no trae plantilla, se cancela.

### Fases dentro de C1 y C2

| Paso | Qué | Gate |
|---|---|---|
| C1 | Compuerta, baja y registro; barrido con S1 y S2 en sombra; informe de la sombra por script de solo lectura | Despliegue autorizado |
| C2a | S1 activo | Owner revisa la sombra y autoriza |
| C2b | S2 activo | Plantilla aprobada por Meta, y autorización del owner |

La pantalla «Contacto con clientes» (Decisión 5) sigue la regla de la consola: primero se aprueba en el lienzo.

### Evaluación

Se entrega junto con el código:
- pruebas de cada regla de la compuerta y de su orden;
- pruebas de la elección de S1 y S2: horario, vigencia, cliente que volvió a escribir, persona a cargo;
- pruebas de la normalización de las bajas, incluidos los casos que no son baja;
- prueba del cuerpo de la plantilla en el adaptador de WhatsApp;
- prueba de que en `shadow` no se encola nada.

## Fuera de alcance

- Contenido y segmentación de campañas.
- Plantillas de WhatsApp: se crean y aprueban en Meta.
- Unir contactos entre canales (ADR-053, F2).

## Consecuencias

- Ningún mensaje por iniciativa propia sale sin pasar por la compuerta, sea de un agente o de una persona.
- La compuerta empieza en sombra. Cuando llegue el primer propósito real, ya hay un registro de cómo habría decidido.
- La mesa de ventas aporta pausas sin que R4 aprenda conceptos de ventas.
