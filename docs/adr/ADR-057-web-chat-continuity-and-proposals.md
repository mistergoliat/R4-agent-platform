# ADR-057 — Chat web: la conversación no se pierde, y la propuesta va al carrito

- **Identificador:** `R4-WEB-CONT-01`
- **Estado:** **Propuesto. No implementado.** Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-23
- **Mandato:** owner, 2026-11-23. Al probar la mesa, vio que al cerrar la ventana del chat web el cliente pierde la
  conversación, aunque la mesa la sigue mostrando. Pidió ver cómo se resolvería («dibújalo en el lienzo») y definió:
  - la cotización en la web es una propuesta que el cliente agrega al carrito con un botón;
  - el PDF de la cotización puede enviarse por correo a cualquier cliente que lo pida.
- **Pantallas:** lienzo de la consola, versión 49:
  - «Cliente · vuelve al chat (mismo navegador)»;
  - «Cliente · aviso por correo»;
  - «Ventas · cliente fuera, sin aviso»;
  - «Ventas · Conversación por webchat».
- **Autoridad superior:** Constitución (salida del modelo no confiable; escrituras gobernadas); ADR-046 (canal web: R4
  no tiene autoridad de carrito); ADR-048 (mesa de ventas, Decisiones 5 y 8); ADR-053 (contactos y personas); ADR-055
  (reglas de contacto).

## Contexto

Hechos verificados:
- **El chat guarda la llave solo mientras la pestaña está abierta.** El token de la sesión vive en `sessionStorage` del
  origen del chat y vence a las 2 h. Al cerrar la ventana, la llave se pierde. Si el cliente vuelve, parte una
  conversación nueva.
- **El servidor del chat guarda las sesiones en memoria.** Si se reinicia, se pierden todas (deuda D-2 del canal web).
- **R4 guarda la conversación completa.** La mesa y la consola la siguen mostrando, pero si una persona responde
  después de que el cliente se fue, el mensaje queda en un chat que nadie va a abrir.
- **ADR-048 Decisión 5 ya prevé preguntar dónde avisar** (correo o WhatsApp) cuando se pide una persona. Ni el aviso ni el
  envío de correos existen todavía.
- **El chat ya muestra fichas** con «Agregar al carrito» y «Agregar los N al carrito», y deja editar el carrito. El chat
  solo pide, la tienda decide, y nada entra al carrito sin un clic del cliente.
- **En WhatsApp, la cotización formal ya existe.** Pesín la emite con el servicio de Cotizaciones, R4 envía su PDF con la
  vigencia y Checkout da el link de pago. Por el chat web no viajan documentos ni links de pago.
- **El servicio de Cotizaciones ya sabe enviar la cotización por correo** (V2, R1.6B):
  - **Operación:** `POST /v2/quotes/{quoteId}/deliveries/email`, con el permiso `quotes:delivery:email`.
  - **Contenido:** el PDF verificado de la cotización, en un correo con la marca.
  - **Garantías:** salida durable y como máximo un envío aceptado por pedido, sin duplicados ante la duda. No envía una
    cotización vencida ni anulada.
  - **Proveedor:** Gmail (`QUOTE_EMAIL_PROVIDER=gmail`). En el despliegue actual está apagado (`disabled`).
- **Política comercial (owner, 2026-11-20):** sin descuentos. Precio del catálogo con sus promociones vigentes.

## Decisión 1 — La conversación vuelve en el mismo navegador

- **El chat recuerda la conversación 7 días** desde la última actividad, en almacenamiento persistente de su origen. Si
  el cliente cierra la ventana o el navegador y vuelve, el chat se abre donde quedó. Una marca «Mientras no estabas»
  señala lo nuevo.
- **El servidor del chat guarda las sesiones en una base**, no en memoria. Se cierra la deuda D-2.
- **«Terminar conversación»** borra la llave de ese navegador y cierra la sesión en el servidor, para computadores
  compartidos. Después, el chat parte de cero.
- **No cambia la privacidad.** R4 sigue recibiendo solo la referencia opaca de la sesión, nunca el token. Recordar la
  conversación no inicia sesión en ninguna cuenta ni une contactos (ADR-053).

## Decisión 2 — Si el cliente no está, se le avisa por el canal que eligió

- Amplía ADR-048 Decisión 5. **Si el cliente está fuera** cuando una persona le responde, y dejó un correo para eso, sale
  **un aviso** por cada vez que se va, no uno por mensaje. El aviso dice «{nombre} te respondió», sin el contenido de la
  conversación.
- **El aviso lleva un link que abre solo esa conversación,** en cualquier dispositivo, y vence con la conversación (7
  días). El link es opaco y firmado. No inicia sesión, no da acceso a una cuenta y no une contactos. Abrirlo deja la
  conversación recordada en ese navegador (Decisión 1).
- **El correo se usa solo para el aviso** y para la cotización que el cliente pida (Decisión 5), según ADR-055 regla 7.
  El consentimiento queda registrado con el contacto.
- **WhatsApp como canal del aviso queda para después.** Un número escrito en un chat web no tiene una ventana abierta,
  así que el primer mensaje exige una plantilla aprobada por Meta. Queda como decisión abierta.

## Decisión 3 — La mesa sabe si el cliente está en el chat

- El servidor del chat informa a R4 cuándo el cliente abre o cierra el chat, y cuándo deja de responder la conexión.
  R4 lo guarda como **estado del contacto en el canal**: en el chat, o fuera desde tal hora. Es una primitiva genérica
  de canal (`live-ops`), sin conceptos de Ventas.
- La mesa y la consola muestran **«en el chat» o «fuera · hace N min»** y, si está fuera, qué pasará con el mensaje:
  - «le avisamos por correo, como pidió»;
  - o «no dejó contacto: lo espera en su navegador hasta el {fecha}».

## Decisión 4 — En la web, la propuesta es un set que el cliente agrega al carrito

- **La propuesta, de Pesín o de una persona, es una tarjeta de productos** con el total y **«Agregar los N al
  carrito»**. Usa los bloques de fichas que el canal ya tiene. La nota dice «precio del catálogo con las promociones
  vigentes; el carrito lo confirma».
- **Nada entra al carrito sin el clic del cliente.** El clic es su consentimiento, y la tienda hace la escritura, como
  hoy (ADR-046). Ni el agente ni el vendedor escriben en el carrito.
- **«Proponer productos» en la mesa.** El vendedor busca en el catálogo (lectura) y elige productos y cantidades. R4
  envía el mismo bloque de fichas como mensaje del operador. El bloque lleva claves de catálogo y cantidades, nunca
  precios ni URLs, y R4 lo valida contra el catálogo antes de enviarlo.
- **Atribución:** las líneas agregadas desde la tarjeta son evidencia **directa** (ADR-048 Decisión 8). Si la tarjeta
  vino de una persona, la línea lleva también la referencia de esa propuesta.
- **Reemplaza en el chat web** la frase de ADR-048 Decisión 8 «el vendedor cierra con cotización y link de pago». En la
  web cierra con la propuesta al carrito y, si el cliente la pide, la cotización en PDF. WhatsApp no cambia.

## Decisión 5 — La cotización en PDF, por correo, a quien la pida

- La tarjeta ofrece **«Enviarme la cotización en PDF por correo»**. Si el cliente no ha dejado un correo, se le pide en ese
  momento, con su consentimiento.
- **La cotización la emite la plataforma a pedido del cliente,** con la misma capacidad gobernada que hoy usa Pesín en
  WhatsApp y con los productos y cantidades de la tarjeta. Ni el modelo ni el vendedor deciden el precio: el número, el
  precio del catálogo y la vigencia salen del servicio de Cotizaciones.
- **El correo lo envía el servicio de Cotizaciones,** con su operación de envío existente: el PDF verificado, con la
  vigencia. R4 no arma ese correo ni toca el PDF. Solo pide el envío con la dirección que dio el cliente y una clave de
  idempotencia por pedido. El modelo nunca escribe la dirección, el link ni el monto.
- **Requisitos en el servicio de Cotizaciones:**
  - el principal de R4 recibe el permiso `quotes:delivery:email`;
  - el envío se enciende en ese despliegue (`QUOTE_EMAIL_PROVIDER=gmail`, con la cuenta remitente);
  - si el correo debe llevar un botón de vuelta al chat, es un cambio de su plantilla. Se pide como cambio de ese
    servicio, no se arma en R4.
- **Si el envío queda en estado `unknown`,** R4 no lo reintenta solo: lo informa en la mesa y en la consola, igual que
  hace el servicio.
- **El perfil web necesita una versión nueva** que pueda pedir esta emisión, con su evaluación antes del lanzamiento.
- **Si la cotización vence,** el botón ofrece una nueva. No hay descuentos.

## Decisión 6 — El aviso «te respondió» necesita su propio envío de correo

- **La cotización no necesita nada nuevo en R4:** la envía el servicio de Cotizaciones (Decisión 5).
- **El aviso de la Decisión 2 no es una cotización,** así que no le corresponde a ese servicio. Necesita un adaptador de
  salida de correo en R4:
  - genérico, con la misma salida durable e idempotente que los demás canales;
  - con registro de entregas y rebotes;
  - sin envíos de marketing.
- **Usa el mismo proveedor y la misma cuenta remitente que el servicio de Cotizaciones** (Gmail), para que el cliente
  reciba los dos correos del mismo remitente y no haya una segunda configuración de dominio. Si el volumen lo exige más
  adelante, el owner decide un proveedor transaccional.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido | Dónde |
|---|---|---|
| C1 | «En el chat / fuera» (Decisión 3) | Servidor del chat, R4 (`live-ops`), mesa y consola |
| C2 | Conversación recordada 7 días, sesiones durables y «Terminar conversación» (Decisión 1) | Chat de la tienda y su servidor |
| C3 | «Proponer productos» en la mesa (Decisión 4) | Mesa y R4 (mensaje del operador con fichas) |
| C4 | Cotización en PDF por correo (Decisión 5) | R4 (emisión y pedido de envío), servicio de Cotizaciones (permiso y envío encendido), versión nueva del perfil web con evaluación |
| C5 | Aviso «{nombre} te respondió» con link (Decisiones 2 y 6) | R4 (adaptador de correo), mesa |

C1 y C2 no necesitan infraestructura nueva. C4 usa el envío que ya trae el servicio de Cotizaciones. C5 es el único que
suma un envío de correo en R4.

## Decisiones abiertas del owner

1. Cuánto se recuerda la conversación: 7 días propuestos, alineados con la ventana de venta asistida de ADR-048.
2. La cuenta remitente de los correos (la del servicio de Cotizaciones) y si se enciende su envío.
3. Si el aviso también puede ir por WhatsApp a un número dejado en el chat web, con plantilla de Meta.
4. Si «Terminar conversación» se muestra siempre o solo cuando una persona se unió al chat.

## Fuera de alcance

- Iniciar sesión, cuentas y datos de pedidos (CIA, ADR-039).
- Unir contactos por correo (ADR-053 F2).
- Links de pago en el chat web: se paga en el checkout de la tienda.
- Descuentos y cualquier cambio de precio.

## Consecuencias

- El cliente que cierra la ventana sin querer vuelve a su conversación. El que se fue recibe un aviso si lo pidió. La
  persona de la mesa sabe si le escribe a alguien que está o a una ventana vacía.
- La venta en la web sigue la lógica de la tienda: propuesta, carrito y checkout. El PDF queda para quien lo pida.
- R4 suma dos primitivas genéricas: el estado del contacto en el canal y, para el aviso, la salida por correo. Cada una
  lleva sus pruebas de contrato. El PDF por correo reutiliza el servicio de Cotizaciones.
- La emisión de cotizaciones desde la web es una escritura gobernada nueva. Se evalúa antes de lanzarla (C5).
