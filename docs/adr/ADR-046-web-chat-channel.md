# ADR-046 — Canal de chat web: el mismo paquete de Ventas, con su propio perfil, gateway y worker

- **Identificador:** `R4-WEB-CHANNEL-01`
- **Estado:** **Propuesto.** Implementado en la rama `feat/r4-web-w1` (W1). Pendiente de revisión y merge. Desplegado
  solo en QA para la validación W1, nunca en producción.
- **Fecha:** 2026-11-10
- **Mandato:** «R4 WEB — W0 Architecture and W1 QA Vertical Slice» (owner, 2026-11-10). Es una parte de R4-L
  («additional channels»), autorizada como desarrollo paralelo que no bloquea R4-J. Este documento es el ADR W0.
- **Autoridad superior:** Constitución; PRD §19 (canales); ADR-029 (modo productivo y entrega gobernada);
  ADR-040 (inspección del inbound); ADR-041 (avisos de plataforma); ADR-045 (carril); EV-2 (`servedAgents`).

## Contexto

La tienda tiene un chat web: un módulo del CMS abre, en un iframe con sandbox, una página servida desde **otro
origen**, el *edge*. El edge maneja la sesión del visitante, el consentimiento y la interfaz. Hasta ahora respondía
con un agente simulado. Queremos que responda el agente de Ventas de R4, con Catalog V2, sin tocar el canary de
WhatsApp, que tiene su propio perfil, carril y despliegue (F1).

Hechos verificados en el código (`main` `714b0fe`):

1. **Un perfil, un canal.** `productionProfileSchema.channel` es un solo canal. `createGatewayPlatform` exige un adapter
   de entrada y uno de salida para ese canal, y el carril de ADR-045 debe servir el mismo canal.
2. **El gateway es genérico.** El canal se elige por `adapter.channel`. Un gateway web es la misma aplicación con
   otros adapters y otro perfil, sin cambios en Core.
3. **El worker no conoce canales.** La composición del worker se niega a recibir configuración del gateway. Toma
   solo tareas fijadas a las definiciones de `servedAgents` (EV-2), y su compatibilidad es la cabecera Core más el
   perfil.
4. **`ingest()` no persiste `metadata`.** El modelo solo ve el texto del inbound. No hay campo estructurado para el
   contexto de la página.
5. **Catalog V2 usa los ids de PrestaShop.** `productKey = P{id_product}`, `itemKey = P{id}-V{id_product_attribute}`
   (`adapters/domains/catalog/http/src/discover.ts`).
6. **La salida es solo texto.** `OutboundSubmission.text`. "R4 Media & Communications" sigue diferido.

## Decisión

1. **Mismo agente, configuración propia.** Es el paquete de Ventas, con sus capacidades, runtime y políticas, con una
   identidad de definición propia, **`sales-web`**, cuya primera versión es `sales-web@1`. La web no consume números
   de la línea `sales@vN`, que usan F1 y J5. La identidad aparte existe para que cada canal versione por su cuenta;
   no es un agente nuevo.
2. **Perfil `sales-web@1`, solo lectura.** Es `sales-production@13` en el canal `web`: Catalog V2 con Discover y
   disponibilidad por variante, y Shipping. **Ninguna escritura**: sin workspace, Quote, Checkout, Customer ni pago.
   El visitante compra en el carrito y el checkout de la tienda. **R4 no tiene autoridad de carrito.**
3. **Procesos propios.** Un gateway web (`production:sales:gateway --web-gateway` → `composeSalesWebGateway`) y un
   worker con `R4_PROD_POLICY_PROFILE=sales-web@1`, con su propia configuración. Nunca son los procesos de WhatsApp.
   En QA usan además una base propia. Ni el gateway de WhatsApp ni el bootstrap con `--lane` pueden seleccionar
   un perfil web: hay pruebas de contrato que lo verifican.
4. **El edge es el proveedor.** `@r4-adapters/web` es transporte puro y depende solo de `@r4/live-ops`, igual que el
   de WhatsApp:
   - **Entrada:** `POST /v1/channels/web/webhook` con `x-r4-web-timestamp` y
     `x-r4-web-signature: sha256=HMAC(secreto, "{ts}.{cuerpo}")`. La firma falla cerrada si falta, tiene mal
     formato, tiene más de 5 minutos o no coincide. Hay una conversación por sesión del edge, y conversaciones
     1 a 1 atestiguadas. La deduplicación es por `eventId`.
   - **Salida:** `submit` → `POST {edge}/r4/v1/outbound`, firmado y con la clave de idempotencia de R4. El edge
     deduplica por esa clave. La clasificación es honesta, como en WhatsApp.
   - **Señal de "escribiendo"** opcional: `POST {edge}/r4/v1/working`.
5. **Contexto de la página sin tocar Core.** El edge envía `context: {page, productId}`. El adapter **reconstruye**
   una nota fija desde un enum y un entero, nunca desde texto del navegador, y la agrega al texto del visitante:
   *«[Contexto informado por el navegador, no verificado: … producto P647.]»*. La definición la trata como pista y
   obliga a verificar el producto con Catalog V2. Llevar el contexto en un campo estructurado del inbound canónico
   queda para un ADR propio.
6. **Identidad.** El canal web es anónimo. EXT-07 sigue detenido. Nada del canal web llega a CIA ni a Customer Profile.
7. **Compatibilidad con un gateway multicanal futuro.** Los adapters, el perfil y el worker no dependen de que el
   gateway web sea un proceso aparte. Cuando un gateway sirva varios canales, el worker no cambia.

## W2–W3: fichas de producto y carrito (`sales-web@2`)

1. **El agente cita claves, no URLs.** La definición `sales-web@2` termina la respuesta con la clave del producto
   verificado: `[[P1651]]`, o el `itemKey` de la variante elegida, `[[P1675-V463]]`. Son como máximo 3 y nunca lleva
   URLs. El perfil `sales-web@2` es `sales-web@1` con esa definición: mismas lecturas y ninguna escritura.
2. **La ficha la arma la tienda.** El edge saca las claves del texto y las entrega como referencias. El módulo de la
   tienda calcula, para ese visitante, todo lo que muestra la ficha:
   - nombre, variante, precio con impuestos y descuento, stock e imagen;
   - la URL canónica, con `Link::getProductLink`.

   No es ni el texto del modelo ni el `publicUrl` de Catalog, porque ese URL usa un prefijo fijo que la tienda corrige
   con una redirección, y esa redirección no existe en entornos con modo debug. Una clave inventada no produce
   ficha. Las fichas no requieren cambiar `OutboundSubmission`: las claves viajan en el texto.
3. **Carrito.** La ficha muestra "Agregar" solo con la variante elegida, stock vendible y un mínimo de compra de 1.
   - El alta la hace el navegador del visitante contra el carrito de la tienda, con su sesión y su token.
   - La tienda valida, y el alta ocurre solo cuando el visitante hace clic.
   - Cambiar cantidades, quitar productos y pagar se hace en el carrito y el checkout de la tienda.
   - R4 sigue sin autoridad de carrito y sin escrituras.

## Armado guiado, contexto y salida honesta (`sales-web@3` a `@6`)

Cada versión es un perfil más, con su propia definición, sobre las mismas lecturas y sin escrituras.

1. **Persona y botones (`@3`).** El asistente se presenta con nombre propio y como IA, sin hacerse pasar por una persona.
   - Pregunta con `[[opciones: A | B | C]]`, que el edge convierte en botones; desde `@5` acepta hasta 5.
   - En un set cita cantidades: `[[P123-V45 x2]]`.
   - La tienda calcula el total del set y lo agrega completo, en el navegador del visitante.
2. **Una verificación por producto (`@4`).** La validez de las respuestas de catálogo es corta, y la evidencia vencida
   no se usa como actual. Por eso, al armar un set, el agente no repite los precios en el texto (los muestran las fichas
   de la tienda) y verifica cada producto una sola vez por respuesta.

   Esto no basta si la ventana de validez es más corta que unas pocas llamadas al modelo. La ventana la decide el dueño
   del catálogo.
3. **Rangos de presupuesto fijos (`@5`)** para el armado guiado.
4. **Sin derivaciones en la web (`@6`).** El chat web todavía no tiene personas conectadas, y una derivación deja la
   tarea esperando a alguien que no llega.
   - El agente no usa `request_handoff` ni `request_consultation`. Ofrece `[[contacto]]`, que el edge reemplaza por el
     contacto real de ventas desde su propia configuración.
   - Los avisos fijos del gateway web (falla del run y pedido humano) dicen eso mismo. Terminan en
     `[[nueva-conversacion]]`, con lo que el edge abre otra conversación para el siguiente mensaje del visitante.
5. **Contexto del visitante (`@6`).** La nota no verificada que arma el adapter suma tres datos:
   - la opción elegida en la ficha;
   - el carrito de la tienda;
   - el set que el visitante armó en el chat.

   Todos se reconstruyen como claves de catálogo y cantidades enteras, con un máximo de 10 líneas cada uno. Nunca
   incluyen texto del navegador.

## Avance mientras trabaja

El worker de un perfil web informa al edge qué está leyendo: una búsqueda (con las palabras buscadas), Discover, el
producto que revisa (con el nombre que entrega Catalog) o la comuna del despacho. Viaja por el mismo
`/r4/v1/working` firmado, con `step` y `detail` (texto para mostrar, máximo 80 caracteres), y el chat lo muestra en vez
de solo "escribiendo".

Se hace en el mejor esfuerzo:
- la lectura no lo espera;
- sus errores se ignoran;
- nunca cambia ni hace fallar la lectura;
- R4 no vuelve a leer lo que envía.

Va solo en el paquete de Ventas y solo para perfiles web. No cambia Core, `live-ops` ni WhatsApp.

## Fuera de alcance

- **Excluido:** Quote V2, Checkout, CIA, Customer Profile, escrituras, el botón «Continuar por WhatsApp» y cambios en
  el gateway de WhatsApp o en sus perfiles.
- **El agente no lee el carrito por su cuenta (`cart.get`):** solo recibe la nota no verificada del navegador.

## Consecuencias

- **Código:** solo aditivo. Hay un paquete nuevo y un perfil y una definición nuevos. En archivos compartidos hay
  condiciones nuevas:
  - la selección del perfil;
  - Discover y la disponibilidad por variante;
  - `salesCatalogSourceOf`;
  - `servedAgents` y el `agentId` de la `taskFactory`;
  - el bootstrap web.

  No hay migraciones, ni cambios en Core, en `live-ops` ni en el gateway de WhatsApp.
- **Operación:** tres procesos más (gateway, worker y scheduler) por despliegue web, con sus límites. El kill
  switch es el de su propia base.
- **Riesgo aceptado:** la nota de contexto es texto del visitante. Una página falsa solo puede apuntar a otro
  producto, que el agente verifica igual.
