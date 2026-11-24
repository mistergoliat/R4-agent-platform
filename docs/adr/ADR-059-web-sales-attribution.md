# ADR-059 — Chat web: qué ventas se atribuyen a Pesín y a las personas

- **Identificador:** `R4-WEB-ATTR-01`
- **Estado:** **Propuesto.** No autoriza código ni despliegues. Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-24
- **Mandato:** owner, 2026-11-24. Al revisar qué compara la consola, pidió ver las ventas atribuidas a Pesín. Para
  WhatsApp la venta queda ligada a la cotización y al pago de Checkout, pero en la web es difícil atribuirla. Dijo:
  «dale, redacta el ADR de atribución web».
- **Autoridad superior:**
  - Constitución: la salida del modelo no es confiable.
  - ADR-046: R4 no tiene autoridad de carrito.
  - ADR-048:
    - Decisión 4: libro de atribución append-only, con reversa.
    - Decisión 8: evidencia de venta en el chat web.
    - Decisión abierta 8: ventana de la venta asistida y grupo de control.
  - ADR-057:
    - Decisión 1: la conversación se recuerda 7 días.
    - Decisión 4: una línea agregada desde la tarjeta es evidencia directa.

## Contexto

Hechos verificados:

- **ADR-048 ya definió los niveles de evidencia en la web:**
  - **directa:** el visitante agregó el producto desde la ficha del chat y lo compró;
  - **asistida:** el chat mostró el producto y el visitante lo compró después desde la página;
  - **sin relación:** hubo chat, pero el pedido no tiene productos mostrados en él.

  Dejó abiertas dos cosas: la ventana de la asistida y el grupo de control. Este ADR cierra la ventana, define cómo
  se produce la evidencia y dónde se ve. El grupo de control queda para una fase posterior.
- **El módulo de la tienda ya mide algo, sin datos personales:**
  - **Eventos registrados** en su propia tabla: el primer mensaje, cada «agregar al carrito» desde el chat (con el id
    del producto) y cada pedido.
  - **Marca de la sesión:** al primer mensaje o al primer agregado, marca la sesión de la tienda con
    `pc_r4chat_assisted`.
  - **Pedido:** al validarse, si la sesión estaba marcada, registra un evento `order` y borra la marca.
  - **Panel:** el back office muestra 30 días de visitantes que usaron el chat, agregados desde el chat, pedidos,
    conversión y ventas.
- **Lo que esa medición no distingue:**
  1. **Todo el pedido cuenta como «con chat»** si la sesión usó el chat alguna vez. No separa las líneas agregadas
     desde el chat de las demás, ni los productos que el chat mostró. Los eventos no llevan una clave de visitante, así
     que los agregados no se pueden unir después con el pedido.
  2. **No tiene ventana.** La marca dura lo que dure la sesión de la tienda, hasta el pedido siguiente.
  3. **No conoce la conversación de R4.** No separa a Pesín de una persona, ni una versión de Pesín de otra.
  4. **Solo la ve el back office de la tienda.** La consola no la ve.
  5. **Cuenta pedidos creados, no pagados.** Un pedido anulado o devuelto no se revierte.
- **El módulo ya tiene pruebas A/B de cuatro funciones del chat:** la mitad de los visitantes ve una función apagada,
  y el grupo queda guardado en el navegador. No existe la opción de ocultar el chat completo.
- **La tienda no conoce la referencia de la conversación.** El chat vive en un iframe de otro origen. Hoy el mensaje
  «agregar al carrito» lleva solo el producto, la variante y la cantidad.
- **El módulo está fuera de este repositorio.** Sus cambios necesitan autorización propia. El chat corre hoy en la
  tienda de QA, no en la tienda de producción.
- **El chat web emite cotizaciones formales por correo (ADR-057 C4).** Si el cliente paga una de ellas en la tienda,
  hoy no hay cómo ligar el pago con la cotización. Queda fuera de este ADR: llega con Checkout.

## Decisión 1 — La evidencia es por línea y la produce la tienda en su servidor

- **Línea agregada desde el chat.** Cuando el visitante agrega un producto desde una tarjeta, el módulo registra la
  línea en su propia tabla:
  - carrito, producto y variante, y cantidad;
  - origen: `agente`, si la tarjeta es de Pesín, o `persona`, si viene de una propuesta de la mesa (ADR-057
    Decisión 4), con la referencia de esa propuesta;
  - referencia de la conversación y hora.

  No modifica el carrito de PrestaShop ni usa overrides.
- **Productos mostrados.** Cuando el chat pide a la tienda los datos de una tarjeta, el módulo anota en la sesión qué
  productos se mostraron, con su origen y su hora. Guarda como máximo los 60 más recientes. Con esto, la tienda puede
  reconocer una venta asistida sin preguntarle a R4.
- **Al validarse el pedido,** el módulo clasifica cada línea con los datos del pedido de la propia tienda, nunca con
  datos del navegador:
  - **directa:** la línea coincide en producto y variante con una línea agregada desde el chat en ese carrito, hasta la
    cantidad agregada desde el chat;
  - **asistida:** el resto de las líneas cuyo producto se mostró dentro de la ventana (Decisión 2);
  - **sin relación:** todo lo demás.

  Los montos salen del pedido: precio pagado con IVA, sin despacho. Así se cumple el «los montos se leen del sistema de
  pedidos» de ADR-048 Decisión 8. El módulo corre en el servidor de la tienda, no en el navegador.
- **El chat entrega a la tienda la referencia opaca de la conversación,** la misma que ya recibe R4, en los mensajes de
  agregar y de tarjetas. Nunca entrega el token de la sesión (ADR-057 Decisión 1).
- **Sin datos personales.** La evidencia lleva ids de producto y de pedido, la referencia opaca de la conversación y
  montos. No lleva nombre, correo, teléfono ni dirección.
- **Medir nunca impide un pedido.** Si algo falla, el pedido sigue y el error queda en el registro de la tienda, como
  ya hace el módulo.

## Decisión 2 — La ventana es de 7 días

- **Asistida:** el producto se mostró en los 7 días anteriores al pedido.
- **Directa:** la línea se agregó desde el chat en los 7 días anteriores al pedido, en el mismo carrito.
- **Mismo plazo que la conversación recordada** (ADR-057 Decisión 1). Un visitante que vuelve al chat dentro de esos
  7 días sigue en la misma conversación.
- **La marca de sesión pasa a guardar una hora** en vez de un 1, en la misma cookie de la tienda. Pasados 7 días ya no
  cuenta.
- **Límite conocido (ADR-048 Decisión 8):** si el visitante conversa en un dispositivo y compra en otro sin iniciar
  sesión, el pedido no se une a la conversación. No se une por suposición.

Cierra la primera mitad de la decisión abierta 8 de ADR-048.

## Decisión 3 — Solo cuenta lo pagado, y se revierte

- **Una venta cuenta cuando el pedido llega a un estado pagado:** los estados de pago aceptado de la tienda,
  configurables en el back office del módulo. Un pedido creado y sin pagar figura como «pedido pendiente», no como
  venta.
- **Una anulación o devolución** genera un asiento de reversa, nunca una edición (ADR-048 Decisión 4).
- **El módulo escucha los cambios de estado del pedido** con un tercer hook, `actionOrderStatusPostUpdate`, sin
  overrides.

## Decisión 4 — Cada línea tiene un solo dueño

- **Directa:**
  - si la tarjeta era de Pesín, la línea se atribuye a Pesín. Como toda venta que cierra solo el agente, va al fondo
    del equipo (ADR-048 Decisión 4);
  - si venía de la propuesta de una persona, se atribuye a esa persona.
- **Asistida:** se atribuye a quien mostró el producto por última vez dentro de la ventana, Pesín o una persona.
- **Un mismo pedido puede tener líneas de los dos.** Cada línea tiene un solo dueño.
- **Atribuir no es pagar.**
  - Lo que se atribuye a Pesín no paga comisión a nadie: va al fondo del equipo (ADR-048 Decisión 4).
  - Lo asistido no paga comisión a nadie: se mide, pero no se paga (owner, 2026-11-24).
  - La comisión de un vendedor sale solo de sus líneas directas, según las reglas versionadas de ADR-048 Decisión 4.

## Decisión 5 — Se ve en el libro de la mesa y en la consola

- **La tienda envía cada evidencia al libro de atribución de la mesa** (ADR-048 Decisión 4): pedido validado, pagado,
  anulado o devuelto.
  - Es un solo libro, append-only, para personas y para Pesín.
  - El envío va firmado con un secreto propio de la tienda y es idempotente por pedido y estado.
- **Si el envío falla,** la evidencia queda pendiente en la tabla del módulo y se reintenta en el envío siguiente.
  Nunca bloquea el pedido.
- **La mesa resuelve la referencia de la conversación** con la lectura de R4 que ya usa: conversación y versión del
  agente. Cada asiento guarda la versión de Pesín.
- **La consola agrega la columna «Ventas» en Lanzamientos, pestaña web.** Por cada versión de Pesín muestra:
  - ventas directas: pedidos y monto;
  - ventas asistidas: pedidos y monto;
  - cuántos visitantes que conversaron compraron dentro de 7 días.

  Incluye la marca «Muestra chica» y la nota «atribuir no es causar». La consola lee esos datos de la mesa, con un
  acceso de solo lectura.
- **Lo que ve el vendedor no cambia** (ADR-048 Decisión 4): sus ventas atribuidas, sin métricas del agente.
- **R4 Core y el paquete de Ventas no cambian.** Pedido, producto y comisión son conceptos de dominio. Viven en la
  tienda y en la mesa.

**Alternativa descartada:** que la tienda envíe la evidencia a R4. Pondría pedidos y montos en la plataforma y
duplicaría el libro que ADR-048 ya asignó a la mesa.

## Decisión 6 — El efecto real se mide después, con un grupo de control

- **Una prueba A/B nueva en el módulo, `chat`:** a un grupo de visitantes no se le muestran ni el botón del chat ni la
  invitación. Se compara la conversión y el ticket de los dos grupos con los pedidos de la propia tienda.
- **Es la única forma de saber si Pesín causó ventas.** Las Decisiones 1 a 5 dicen dónde participó, no qué habría
  pasado sin él.
- **No se activa hasta que haya tráfico real.** El owner decide la fracción y la duración. Ese visitante pierde el
  chat, así que la fracción debe ser chica y el plazo, acotado.

Cierra la segunda mitad de la decisión abierta 8 de ADR-048 cuando se active.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido | Dónde |
|---|---|---|
| A1 | Evidencia por línea, productos mostrados, ventana de 7 días, estados pagado y revertido. El panel del back office se divide en directa y asistida | Módulo de la tienda y chat (referencia de la conversación en los mensajes) |
| A2 | Envío firmado al libro, versión de Pesín en cada asiento y columna «Ventas» en Lanzamientos web | Módulo, mesa y consola |
| A3 | Grupo de control `chat` | Módulo de la tienda |

- **A1 puede ir sola:** no sale de la tienda y ya responde cuánto vende el chat, separado en directa y asistida.
- **Antes de la tienda de producción:** revisión legal de la marca de sesión (deuda D-17 del canal web).

## Decisiones del owner

Recomendaciones para cerrar el ADR:

1. **Ventana:** 7 días, igual que la conversación recordada.
2. **Monto:** la suma de las líneas atribuidas, no el pedido completo. El total del pedido se muestra como contexto.
3. **Estados que cuentan como pagado:** los de pago aceptado de la tienda, configurables en el back office.
4. **Lo asistido no paga comisión** (decidido por el owner el 2026-11-24). Lo de Pesín tampoco: va al fondo del equipo.
5. **Grupo de control:** 20 % de los visitantes sin chat, durante 4 semanas, cuando haya tráfico real.

## Fuera de alcance

- **WhatsApp:** su evidencia es el pago de Checkout ligado a la cotización (ADR-048 Decisión 4). Entra cuando Checkout
  exista.
- **Una cotización de la web pagada:** también se liga con Checkout.
- **Unir dispositivos o cuentas por suposición** (ADR-048 Decisión 5; ADR-053).
- **Concluir causalidad sin el grupo de control.**
- **Cualquier dato personal en la evidencia.**

## Consecuencias

- **A favor:**
  - las ventas de Pesín en la web quedan visibles por versión;
  - personas y Pesín se atribuyen en el mismo libro y con las mismas reglas.
- **En contra:**
  - el módulo suma dos tablas, un hook y un envío saliente hacia la mesa;
  - la asistida sobreestima el aporte del chat: el visitante quizás habría comprado igual. Por eso se muestra separada
    de la directa, y por eso existe A3.
