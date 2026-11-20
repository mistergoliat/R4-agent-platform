# ADR-055 — Contacto con clientes: reglas para los mensajes por iniciativa propia

- **Identificador:** `R4-CONTACT-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-20
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

## Decisiones abiertas del owner

1. El horario: propuesta, lunes a sábado de 9:00 a 20:00.
2. El tope: propuesta, 1 cada 3 días y 4 al mes.
3. Las palabras de baja y el texto con que se confirma.
4. De dónde sale el permiso de marketing por canal. Por ejemplo, la casilla de la tienda para correo, y un permiso
   explícito en WhatsApp.
5. Quién puede liberar un mensaje detenido: el supervisor, el owner o ambos.

## Fuera de alcance

- Contenido y segmentación de campañas.
- Plantillas de WhatsApp: se crean y aprueban en Meta.
- Unir contactos entre canales (ADR-053, F2).

## Consecuencias

- Ningún mensaje por iniciativa propia sale sin pasar por la compuerta, sea de un agente o de una persona.
- La compuerta empieza en sombra. Cuando llegue el primer propósito real, ya hay un registro de cómo habría decidido.
- La mesa de ventas aporta pausas sin que R4 aprenda conceptos de ventas.
