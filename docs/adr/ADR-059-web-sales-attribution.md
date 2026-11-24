# ADR-059 — Chat web: qué ventas se atribuyen a Pesín y a las personas

- **Identificador:** `R4-WEB-ATTR-01`
- **Estado:** **Propuesto.** No autoriza código ni despliegues. Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-24
- **Mandato:** owner, 2026-11-24.
  - Al revisar qué compara la consola, pidió ver las ventas atribuidas a Pesín. Para WhatsApp la venta queda ligada a la
    cotización y al pago de Checkout, pero en la web es difícil atribuirla. Dijo: «dale, redacta el ADR de atribución
    web».
  - Al revisar la propuesta, definió la regla: «veamos si podemos rescatar el carrito y si el cliente lo paga y los
    productos calzan, se le atribuye».
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

- **ADR-048 Decisión 8 definió tres niveles de evidencia en la web:**
  - **directa:** el visitante agregó el producto desde la ficha del chat y lo compró;
  - **asistida:** el chat mostró el producto y el visitante lo compró después desde la página;
  - **sin relación:** hubo chat, pero el pedido no tiene productos mostrados en él.

  Dejó abiertas la ventana de la asistida y el grupo de control (decisión abierta 8).
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
     desde el chat de las demás. Los eventos no llevan una clave de visitante, así que los agregados no se pueden unir
     después con el pedido.
  2. **No tiene ventana.** La marca dura lo que dure la sesión de la tienda, hasta el pedido siguiente.
  3. **No conoce la conversación de R4.** No separa a Pesín de una persona, ni una versión de Pesín de otra.
  4. **Solo la ve el back office de la tienda.** La consola no la ve.
  5. **Cuenta pedidos creados, no pagados.** Un pedido anulado o devuelto no se revierte.
- **La tienda no conoce la referencia de la conversación.** El chat vive en un iframe de otro origen. Hoy el mensaje
  «agregar al carrito» lleva solo el producto, la variante y la cantidad.
- **El módulo está fuera de este repositorio.** Sus cambios necesitan autorización propia. El chat corre hoy en la
  tienda de QA, no en la tienda de producción.
- **El chat web emite cotizaciones formales por correo (ADR-057 C4).** Si el cliente paga una de ellas en la tienda,
  hoy no hay cómo ligar el pago con la cotización. Queda fuera de este ADR: llega con Checkout.

## Decisión 1 — Solo se atribuye lo que se agregó desde el chat, se pagó y calza

- **Una línea del pedido se atribuye solo si se cumplen las tres condiciones:**
  1. el producto y la variante se agregaron al carrito desde una tarjeta del chat;
  2. el pedido está pagado (Decisión 3);
  3. la línea pagada calza en producto y variante con lo agregado, y cuenta hasta la cantidad agregada desde el chat.
- **El resto del pedido no se atribuye.** Esto incluye:
  - lo que el visitante agregó por su cuenta;
  - lo que el chat mostró pero el visitante agregó desde la página.
- **Modifica ADR-048 Decisión 8 para el chat web.** El nivel «asistida» no se atribuye: no se puede demostrar que el
  chat causó esa compra (owner, 2026-11-24). Tampoco se registra qué productos mostró el chat.

## Decisión 2 — El carrito se rescata durante 7 días en el mismo navegador

- **El módulo guarda cada agregado desde el chat** en su propia tabla:
  - producto y variante, y cantidad;
  - origen: `agente`, si la tarjeta es de Pesín, o `persona`, si viene de una propuesta de la mesa (ADR-057 Decisión 4),
    con la referencia de esa propuesta;
  - referencia de la conversación y hora.

  No modifica el carrito de PrestaShop ni usa overrides.
- **La clave es el visitante de la tienda** (el invitado de PrestaShop de ese navegador), no el carrito. Si el carrito
  se pierde y el visitante lo vuelve a armar, o vuelve otro día, lo agregado desde el chat sigue contando.
- **El plazo es de 7 días desde el agregado**, el mismo que la conversación recordada (ADR-057 Decisión 1). Pasado ese
  plazo, el agregado ya no cuenta. Cierra la ventana de la decisión abierta 8 de ADR-048.
- **El chat entrega a la tienda la referencia opaca de la conversación,** la misma que ya recibe R4, en el mensaje de
  agregar. Nunca entrega el token de la sesión (ADR-057 Decisión 1).
- **Límite conocido (ADR-048 Decisión 8):** si el visitante agrega en un dispositivo y compra en otro sin iniciar
  sesión, el pedido no se une a la conversación. No se une por suposición.

## Decisión 3 — Solo cuenta lo pagado, y se revierte

- **Una venta cuenta cuando el pedido llega a un estado pagado:** los estados de pago aceptado de la tienda,
  configurables en el back office del módulo. Un pedido creado y sin pagar no se atribuye.
- **Una anulación o devolución** genera un asiento de reversa, nunca una edición (ADR-048 Decisión 4).
- **El módulo clasifica las líneas con los datos del pedido de la propia tienda,** en su servidor, nunca con datos del
  navegador. Los montos salen del pedido: precio pagado con IVA, sin despacho.
  - Se cuenta la suma de las líneas atribuidas, no el pedido completo. El total del pedido se muestra como contexto.
  - Así se cumple el «los montos se leen del sistema de pedidos» de ADR-048 Decisión 8.
- **El módulo escucha los cambios de estado del pedido** con un tercer hook, `actionOrderStatusPostUpdate`, sin
  overrides.
- **Sin datos personales.** La evidencia lleva ids de producto y de pedido, la referencia opaca de la conversación y
  montos. No lleva nombre, correo, teléfono ni dirección.
- **Medir nunca impide un pedido.** Si algo falla, el pedido sigue y el error queda en el registro de la tienda, como
  ya hace el módulo.

## Decisión 4 — Cada línea tiene un solo dueño, y atribuir no es pagar

- **Dueño de cada línea:**
  - si se agregó desde una tarjeta de Pesín, es de Pesín;
  - si se agregó desde la propuesta de una persona, es de esa persona.

  Un mismo pedido puede tener líneas de los dos.
- **Atribuir no es pagar.**
  - Lo atribuido a Pesín se registra como de Pesín para medir. No se le acredita a ninguna persona.
  - Si alimenta un fondo del equipo de ventas es la decisión abierta 1 de ADR-048. El owner aún no la decide.
  - La comisión de un vendedor sale solo de sus líneas, según las reglas versionadas de ADR-048 Decisión 4.

## Decisión 5 — Se ve en el libro de la mesa y en la consola

- **La tienda envía cada evidencia al libro de atribución de la mesa** (ADR-048 Decisión 4): pedido pagado, anulado o
  devuelto.
  - Es un solo libro, append-only, para personas y para Pesín.
  - El envío va firmado con un secreto propio de la tienda y es idempotente por pedido y estado.
- **Si el envío falla,** la evidencia queda pendiente en la tabla del módulo y se reintenta en el envío siguiente.
  Nunca bloquea el pedido.
- **La mesa resuelve la referencia de la conversación** con la lectura de R4 que ya usa: conversación y versión del
  agente. Cada asiento guarda la versión de Pesín.
- **La consola agrega la columna «Ventas» en Lanzamientos, pestaña web.** Por cada versión de Pesín muestra:
  - pedidos pagados con líneas atribuidas;
  - monto atribuido;
  - qué parte de lo agregado desde el chat terminó pagada.

  Incluye la marca «Muestra chica». La consola lee esos datos de la mesa, con un acceso de solo lectura.
- **Lo que ve el vendedor no cambia** (ADR-048 Decisión 4): sus ventas atribuidas, sin métricas del agente.
- **R4 Core y el paquete de Ventas no cambian.** Pedido, producto y comisión son conceptos de dominio. Viven en la
  tienda y en la mesa.

**Alternativa descartada:** que la tienda envíe la evidencia a R4. Pondría pedidos y montos en la plataforma y
duplicaría el libro que ADR-048 ya asignó a la mesa.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido | Dónde |
|---|---|---|
| A1 | Agregados desde el chat por visitante y por 7 días, líneas pagadas que calzan, reversa. El panel del back office muestra lo atribuido | Módulo de la tienda y chat (referencia de la conversación en el mensaje de agregar) |
| A2 | Envío firmado al libro, versión de Pesín en cada asiento y columna «Ventas» en Lanzamientos web | Módulo, mesa y consola |

- **A1 puede ir sola:** no sale de la tienda y ya responde cuánto de lo que el chat puso en el carrito se pagó.
- **Antes de la tienda de producción:** revisión legal de la marca de sesión (deuda D-17 del canal web).

## Decisiones del owner (2026-11-24)

1. **Plazo de 7 días** para rescatar lo agregado desde el chat.
2. **Se cuenta la suma de las líneas atribuidas,** no el pedido completo.
3. **Solo cuenta lo pagado.** Lo anulado o devuelto se revierte.
4. **Lo asistido no se atribuye** y por lo tanto no paga comisión. El uso de un fondo del equipo con lo de Pesín sigue
   abierto (ADR-048, decisión abierta 1).
5. **Sin grupo de control.** La regla es demostrable por sí sola: lo que el chat puso en el carrito, pagado y calzando.

## Fuera de alcance

- **WhatsApp:** su evidencia es el pago de Checkout ligado a la cotización (ADR-048 Decisión 4). Entra cuando Checkout
  exista.
- **Una cotización de la web pagada:** también se liga con Checkout.
- **La venta asistida y el grupo de control** (Decisiones 1 y 5 del owner). Si algún día se quiere medir el efecto
  total del chat, se decide en otro ADR.
- **Unir dispositivos o cuentas por suposición** (ADR-048 Decisión 5; ADR-053).
- **Cualquier dato personal en la evidencia.**

## Consecuencias

- **A favor:**
  - las ventas de Pesín en la web quedan visibles por versión, con una regla que se puede demostrar;
  - personas y Pesín se atribuyen en el mismo libro y con las mismas reglas.
- **En contra:**
  - el módulo suma una tabla, un hook y un envío saliente hacia la mesa;
  - la regla subestima el aporte del chat: no cuenta al visitante que recibió una recomendación y compró desde la
    página. Es deliberado: solo cuenta lo demostrable.
