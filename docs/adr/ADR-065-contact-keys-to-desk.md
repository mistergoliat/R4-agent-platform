# ADR-065 — Claves del contacto hacia la mesa de ventas

- **Identificador:** `R4-CONTACT-KEYS-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25.
  - Al ver de dónde entran las oportunidades del CRM pidió: «necesito que estén desde todos los canales».
  - Pidió el ADR: «sí, escribe el ADR de las claves del contacto».
  - En la revisión objetó que el vendedor confirme cada correo: «¿cómo lo hacemos si las cuentas en realidad tienen
    su "id" con el mail?».
  - Aprobó el modelo de este ADR: «sí, actualiza el ADR-065 con ese modelo». Un correo une como probable y se
    confirma con una prueba; el vendedor confirma solo como respaldo.
  - El número 064 está reservado para el ADR de postventa.
- **Autoridad superior:**
  - Constitución y AGENTS.md:
    - la salida del modelo no es confiable;
    - las escrituras pasan por ejecución gobernada;
    - Core no tiene conceptos de venta.
  - ADR-045: carril de conversación y clave de identidad.
  - ADR-053: contacto, persona y cliente; qué nunca vincula.
  - ADR-057: el chat web y la cotización por correo.
  - ADR-061: conectores y datos personales.
  - ADR-062: CRM en la mesa. Decisión 6: ganada solo con pedido pagado que calza. Decisión 10: claves y segmento con
    evidencia, camino A.

## Contexto

Hechos verificados:

- **La mesa no sabe quién es el cliente de una conversación.** El registro de R4 (`desk.opportunity.record`@1) lleva
  la conversación, el canal, la cotización y la clasificación. Del cliente lleva solo la referencia opaca de la
  conversación. Sin claves, la mesa no puede:
  - unir la oportunidad con la tienda ni con SAP;
  - marcarla ganada cuando el cliente paga;
  - mostrar el recorrido del cliente.
- **En la tienda la cuenta es el correo.** El diagnóstico de ADR-062 lo confirma: cerca del 99 % de las cuentas
  tiene correo, celular y RUT válidos.
- **Qué sabe R4 de cada contacto:**
  - **WhatsApp:** el número del remitente, que Meta entrega firmado. Está en la conversación (`recipientRef` del
    binding) porque R4 lo necesita para responder.
  - **Chat web:** una sesión anónima del navegador. El módulo de la tienda sabe si el visitante inició sesión en su
    cuenta, pero hoy no se lo dice al chat.
  - **Instagram y Facebook:** un identificador de Meta que no sirve fuera de Meta.
  - **En cualquier canal**, lo que el cliente escribe: un correo para recibir la cotización, un teléfono, un RUT.
- **El paquete de ventas ya lee la conversación verificada** con `bindingByTask`, como la capacidad de cliente
  (`customer-v2`).
- **ADR-053:**
  - Decisión 4: un teléfono o un correo escrito en un chat sin verificar **nunca** vincula a dos contactos dentro de
    R4.
  - Decisión 3: saber qué cuenta comercial corresponde a un contacto es autoridad de CIA, hoy no desplegada. ADR-062
    aceptó el camino A: la mesa guarda lo mínimo, como maestro transitorio y solo para el CRM.
- **El riesgo de unir con un correo escrito no es de privacidad hacia el cliente, porque unir es interno.** Es de
  **atribución**: alguien puede escribir el correo de otra persona. El vendedor vería entonces otro historial, y una
  compra ajena podría parecer una venta de esta oportunidad.

## Decisión 1 — Tres niveles de unión: probable, confirmada y verificada

| Nivel | Qué lo produce | Para qué sirve |
|---|---|---|
| **Verificada** | Una clave que el canal o la tienda garantizan: el celular de WhatsApp firmado por Meta, o la cuenta de la tienda con sesión iniciada en el chat web, firmada por la tienda | Todo el CRM |
| **Confirmada** | Una clave declarada que una prueba confirmó (Decisión 2) | Todo el CRM |
| **Probable** | Una clave que el cliente escribió (correo, teléfono o RUT) y que calza con una sola cuenta | Ficha y recorrido del cliente, marcados «probable». Nunca solos para comisión ni para cliente de cabecera |

- **Una unión probable no basta para marcar ganada una oportunidad.** Además, el pedido pagado debe calzar en
  productos y cotización, como exige ADR-062 D6.
- **Las reglas de ADR-062 D10 valen en los tres niveles:**
  - una clave genérica (el RUT de venta general) nunca une;
  - una clave compartida por más de 3 cuentas nunca une sola;
  - una clave que calza con varias cuentas no une: queda para revisar.

## Decisión 2 — Una unión probable se confirma con una prueba, sin vendedor

Cualquiera de estas pruebas la confirma sola:

1. **El cliente abre el enlace de su cotización.** El correo del PDF (ADR-057 C4) trae «Ver mi cotización», un enlace
   firmado de un solo uso para ese correo y esa cotización. Abrirlo prueba que el cliente controla el buzón. El
   servicio de cotizaciones registra la apertura y la mesa la lee por su conector.
2. **El cliente paga un pedido desde esa cuenta** con los productos de la oportunidad.
3. **El celular verificado de WhatsApp coincide** con el teléfono de esa cuenta en la tienda.
4. **El cliente inicia sesión en la tienda** durante la conversación del chat web (Decisión 3).

**El vendedor confirma solo cuando no hubo ninguna prueba**, desde la ficha del cliente. Es la excepción.

## Decisión 3 — Quién pone cada clave: la plataforma o la tienda, nunca el modelo

- **WhatsApp:** la capacidad de registro (`desk.opportunity.record`@2) agrega al cuerpo firmado el celular verificado
  de la conversación, normalizado.
- **Claves declaradas:** la misma capacidad agrega los correos, teléfonos y RUT que encuentran reglas deterministas en
  los mensajes **del cliente**, como máximo tres de cada tipo.
- **Chat web con sesión iniciada:** el módulo de la tienda le pasa al chat la referencia de la cuenta, firmada por la
  tienda. El adapter web de R4 la verifica y la deja en la conversación.
  - Si eso requiere un campo nuevo en la conversación, es un cambio genérico de Core con autorización propia: una
    «referencia verificada de una cuenta externa», que no menciona ventas.
- **El modelo no puede leer ni escribir ninguna clave.** No están en la entrada de la capacidad, no vuelven en su
  resultado y no entran a su contexto.

## Decisión 4 — Qué hace la mesa con ellas

- **Normaliza** con las reglas de ADR-062 D10 y guarda cada clave con su nivel y su prueba: fuente, fecha y, si hubo,
  la apertura o el pedido que la confirmó.
- **Une** según la Decisión 1. Pasa de probable a confirmada al llegar la prueba. Separar sigue siendo un evento.
- **Guarda solo los contactos que tienen oportunidades.** No copia la base de R4 ni la de la tienda.
- **Unir es interno.** Sirve al recorrido del cliente, a la ganada por pedido pagado y al cliente de cabecera.
  **Nunca** le da al cliente acceso a pedidos o datos de una cuenta: eso sigue gobernado por ADR-053, ADR-061 y CIA.

## Decisión 5 — Quién las ve

- **Consola:** siempre enmascaradas (`+56 9 •••• 4410`, `c•••@dominio`, `76.•••.•••-K`), con el nivel visible:
  verificada, confirmada o probable.
- **App de ventas:** el dueño de la oportunidad ve el celular completo, porque es quien llama. Los demás, incluido el
  pozo, lo ven enmascarado.
- **Nunca** quedan en registros, eventos, incidentes, el repositorio público ni el contexto del modelo.

## Decisión 6 — Cuánto tiempo se guardan

- Las claves de un contacto sin oportunidades abiertas ni ventas en los últimos 24 meses se **anonimizan**: se borra
  la clave y queda solo el evento.
- El plazo final lo decide el owner con la revisión legal (D-17).

## Fases (cada una requiere autorización del owner)

- **K0. Diseño:** este ADR.
- **K1. Celular verificado de WhatsApp y claves declaradas.**
  - Sale con `desk.opportunity.record`@2, en las versiones de cada canal que lo usen.
  - La mesa une como verificada (WhatsApp) o probable (lo declarado).
  - Se confirma por pedido pagado y por coincidencia con el celular de WhatsApp.
  - **Gate:** el recorrido de un cliente de prueba muestra su compra real de la tienda.
- **K2. Enlace «Ver mi cotización».** Necesita un cambio en el servicio de cotizaciones, con su propia autorización.
- **K3. Cuenta de la tienda con sesión iniciada en el chat web.** Necesita cambios en el módulo de la tienda y en el
  adapter web de R4, y quizás el campo genérico de la Decisión 3.
- **K4. Retención:** la tarea que anonimiza.

## Fuera de alcance

- Vincular contactos entre canales dentro de R4. Eso es ADR-053, con su propia prueba.
- Darle al cliente acceso a sus pedidos o datos. Eso es ADR-053, ADR-061 y CIA.
- Importar la base de la tienda o de SAP completa.

## Consecuencias

- **Se reconoce al cliente en todos los canales sin que nadie digite.** WhatsApp y la sesión de la tienda lo
  identifican de inmediato. Un correo escrito lo identifica como probable y se confirma con algo que el cliente hace de
  todas formas: abrir su cotización o pagar.
- **El vendedor solo interviene cuando no hay ninguna prueba.**
- **La mesa pasa a guardar teléfonos y correos de clientes de todos los canales.** Por eso hay enmascarado, retención,
  prohibición de registros y una base privada.

## Decisiones abiertas del owner

1. Si el dueño de la oportunidad ve el celular completo en la app (propuesta: sí, solo el dueño).
2. El plazo de retención (propuesta: 24 meses sin actividad, después anonimizar), con la revisión legal.
3. Si una unión probable basta para el cliente de cabecera (propuesta: no; solo verificada o confirmada).
