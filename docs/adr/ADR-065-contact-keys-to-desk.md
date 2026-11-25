# ADR-065 — Claves del contacto hacia la mesa de ventas

- **Identificador:** `R4-CONTACT-KEYS-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25.
  - Al ver de dónde entran las oportunidades del CRM pidió: «necesito que estén desde todos los canales».
  - Después de que se le explicó qué son las claves del contacto, dijo: «sí, escribe el ADR de las claves del
    contacto».
  - El número 064 está reservado para el ADR de postventa.
- **Autoridad superior:**
  - Constitución y AGENTS.md:
    - la salida del modelo no es confiable;
    - las escrituras pasan por ejecución gobernada;
    - Core no tiene conceptos de venta.
  - ADR-045: carril de conversación y clave de identidad.
  - ADR-053: contacto, persona y cliente; qué nunca vincula.
  - ADR-061: conectores y datos personales.
  - ADR-062: CRM en la mesa. Decisión 10: claves normalizadas y segmento con evidencia, camino A.

## Contexto

Hechos verificados:

- **La mesa no sabe quién es el cliente de una conversación.** El registro de oportunidades de R4 (ADR-062,
  `desk.opportunity.record`@1) lleva la conversación, el canal, la cotización y la clasificación de Pesín. Del
  cliente lleva solo la referencia opaca de la conversación. Sin claves, la mesa no puede:
  - unir esa oportunidad con las cuentas de la tienda ni con SAP;
  - marcarla ganada cuando el cliente paga;
  - mostrar el recorrido del cliente.
- **Qué sabe R4 de cada contacto:**
  - **WhatsApp:** el número del remitente, que Meta entrega firmado. Está en la conversación (`recipientRef` del
    binding), porque R4 lo necesita para responder.
  - **Chat web:** nada verificado. Es una sesión anónima del navegador.
  - **Instagram y Facebook:** un identificador de Meta que no sirve fuera de Meta. No trae teléfono ni correo.
  - **En cualquier canal**, lo que el cliente escribe: un correo para recibir la cotización, un teléfono, un RUT.
    Nadie lo verificó.
- **El paquete de ventas ya lee la conversación verificada** con `bindingByTask`, como hace la capacidad de cliente
  (`customer-v2`). Ese es el camino de la plataforma, no del modelo.
- **ADR-053 Decisión 4:** un teléfono o un correo escrito en un chat sin verificar **nunca** vincula a dos contactos.
- **ADR-053 Decisión 3:** saber qué cuenta comercial corresponde a un contacto es autoridad de CIA, que hoy no está
  desplegada. ADR-062 aceptó el camino A: la mesa guarda lo mínimo como maestro transitorio.
- **La mesa ya guarda claves:** las que escribe el vendedor en «Cliente en tienda».
- **El diagnóstico (ADR-062):** cerca del 99 % de las cuentas de la tienda tiene celular, correo y RUT válidos. Unir
  por celular encuentra a casi todos.

## Decisión 1 — Qué claves viajan y con qué nivel de confianza

| Clave | De dónde sale | Nivel | ¿Une sola? |
|---|---|---|---|
| Celular de WhatsApp | La conversación verificada, el número que Meta firma | **verificada por el canal** | Sí, con las reglas de ADR-062 D10: nunca una clave genérica o compartida |
| Correo, teléfono o RUT que el cliente escribió | Los mensajes **del cliente** de esa conversación, con reglas fijas | **declarada** | **No.** Queda como candidata; la confirma una persona |
| Identificadores de Instagram, Facebook o sesión web | — | — | No viajan: no identifican a nadie fuera de su canal |

- **Una clave declarada se vuelve «confirmada por una persona»** solo cuando el vendedor la valida con el cliente. Por
  ejemplo, le pregunta «¿este es tu correo de compras?» o el cliente lo confirma al pagar. Recién ahí une.
- **Un correo que recibió la cotización no prueba que sea del cliente.** Sigue siendo declarado.

## Decisión 2 — Las pone la plataforma, nunca el modelo

- **La capacidad de registro agrega las claves.** `desk.opportunity.record` sube a la versión 2 y agrega al cuerpo
  firmado un bloque `contact`:
  - el celular verificado de la conversación, si el canal es WhatsApp;
  - las claves declaradas que encuentran reglas deterministas en los mensajes **del cliente**, como máximo tres de
    cada tipo;
  - todo normalizado.
- **El modelo no puede leerlas ni escribirlas.** No están en la entrada de la capacidad, no vuelven en su resultado y
  no entran al contexto del modelo.
- **No cambia R4 Core.** El binding verificado ya está disponible para las capacidades del paquete de ventas.

## Decisión 3 — Qué hace la mesa con ellas

- **Normaliza con las reglas de ADR-062 D10** y guarda cada clave con su nivel: `verificada_canal`, `declarada` o
  `confirmada`.
- **Une solo con claves verificadas o confirmadas**, y nunca con claves genéricas o compartidas. Las declaradas
  quedan en «Datos de clientes · revisar» como candidatas.
- **Guarda solo los contactos que tienen oportunidades.** No copia la base de R4 ni la de la tienda.
- **Unir es interno.** Sirve al CRM: recorrido del cliente, ganada por pedido pagado, cliente de cabecera. **Nunca**
  le da al cliente acceso a pedidos o datos de una cuenta: eso sigue gobernado por ADR-053 y ADR-061.

## Decisión 4 — Quién las ve

- **Consola:** siempre enmascaradas (`+56 9 •••• 4410`, `c•••@dominio`, `76.•••.•••-K`).
- **App de ventas:**
  - el dueño de la oportunidad ve el celular completo, porque es quien llama;
  - los demás, incluido el pozo, lo ven enmascarado;
  - las claves declaradas se muestran marcadas «sin confirmar».
- **Nunca** quedan en registros, eventos, incidentes, el repositorio público ni el contexto del modelo.

## Decisión 5 — Cuánto tiempo se guardan

- Las claves de un contacto sin oportunidades abiertas ni ventas en los últimos 24 meses se **anonimizan**: se borra
  la clave y queda solo el evento.
- El plazo final lo decide el owner con la revisión legal (D-17).

## Fases (cada una requiere autorización del owner)

- **K0. Diseño:** este ADR.
- **K1. Celular verificado de WhatsApp.** `desk.opportunity.record`@2 y la versión de WhatsApp que lo use; la mesa lo
  une con la tienda y SAP.
  - **Gate:** en la consola, el recorrido de un cliente de prueba muestra su compra real de la tienda.
- **K2. Claves declaradas** desde los mensajes del cliente, con confirmación del vendedor en la app.
- **K3. Retención:** la tarea que anonimiza.

## Fuera de alcance

- Vincular contactos entre canales dentro de R4. Eso es ADR-053, con prueba.
- Darle al cliente acceso a sus pedidos o datos. Eso es ADR-053, ADR-061 y CIA.
- Importar la base de la tienda o de SAP completa.

## Consecuencias

- **Se puede reconocer al cliente de WhatsApp** en la tienda y en SAP, y cerrar sus oportunidades con el pedido
  pagado.
- **La mesa pasa a guardar teléfonos de clientes de WhatsApp.** Es un dato personal más en un repositorio y una base
  privados. Por eso hay enmascarado, retención y prohibición de registros.
- **El chat web, Instagram y Facebook** solo se identifican con lo que el cliente declara y una persona confirma.

## Decisiones abiertas del owner

1. Si el dueño de la oportunidad ve el celular completo en la app (propuesta: sí, solo el dueño).
2. El plazo de retención (propuesta: 24 meses sin actividad, después anonimizar), con la revisión legal.
3. Si una clave declarada puede confirmarse sola en algún caso (propuesta: no; siempre una persona).
