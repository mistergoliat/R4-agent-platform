# ADR-060 — Messenger e Instagram: Pesín en los mensajes directos de Meta

- **Identificador:** `R4-META-CHANNEL-01`
- **Estado:** **Propuesto.** M1 (mensajes directos) implementado en la rama `feat/r4-meta-channels`, sin desplegar.
  M2 (comentarios en publicaciones) es solo una propuesta y espera decisiones del dueño.
- **Fecha:** 2026-11-25
- **Mandato:** el dueño, 2026-11-25: crear los agentes y conectores de Instagram y Facebook, de modo que conectarlos
  sea agregar 2 o 3 parámetros. Alcance pedido: «una mezcla; que responda publicaciones y converse por chat,
  principalmente. En Instagram la gente no tiende a comprar, así que sería más como un *gymbro*». La página de Facebook
  y la cuenta de Instagram están vinculadas y bajo la misma app de Meta que WhatsApp.
- **Autoridad superior:** Constitución; PRD §19 (canales); ADR-029 (modo productivo y entrega gobernada); ADR-045
  (carril); ADR-046 (canal web: el mismo paquete de Ventas con su propio perfil, gateway y worker); ADR-056 (consultas
  sin pausa).

## Contexto

Hechos verificados en el código (`main` `2ce4faa`) y en la documentación de Meta (developers.facebook.com, leída el
2026-11-25):

1. **Un perfil, un canal.** El gateway exige un adapter de entrada y otro de salida para el canal del perfil
   (`createGatewayPlatform`). El worker no conoce canales (ADR-046).
2. **Messenger e Instagram Direct usan la misma forma.** El webhook trae `object: "page"` o `object: "instagram"`,
   con `entry[].messaging[]` = `{sender, recipient, timestamp, message{mid, text, is_echo, attachments, reply_to}}`.
   La firma `X-Hub-Signature-256` es la misma de WhatsApp (HMAC-SHA256 del cuerpo con el secreto de la app), igual que
   el handshake `hub.*`.
3. **Con Facebook Login, ambos se responden por la página.** `POST /{page-id}/messages` con el token de la página y
   `recipient.id` = el PSID (Messenger) o el IGSID (Instagram). La respuesta trae `message_id`.
   - Instagram acepta hasta 1000 bytes por mensaje; Messenger, 2000 caracteres.
   - `sender_action: typing_on` muestra «escribiendo…».
4. **Ventana de 24 horas** desde el último mensaje del contacto. La etiqueta `HUMAN_AGENT` abre 7 días, pero solo para
   respuestas de una persona.
5. **App Review.** Con acceso estándar, solo las personas con rol en la app reciben respuesta. Para el público hace
   falta acceso avanzado (App Review) a `pages_messaging` e `instagram_manage_messages`, y la app debe estar publicada.
6. **Política de bots en Messenger:** responder en 30 s. Pesín tarda 30 a 100 s por turno (98 % es tiempo de modelo),
   por eso importa mostrar «escribiendo…».
7. **Comentarios (para M2).**
   - Llegan por otros webhooks: `comments` (Instagram) y `feed` (página).
   - Una respuesta pública va a `POST /{comment-id}/replies` (Instagram) o `/{comment-id}/comments` (Facebook).
   - Una *respuesta privada* es **un** mensaje directo a quien comentó (`recipient: {comment_id}`), dentro de 7 días.
     Desde ahí, la conversación sigue por DM si la persona contesta.
   - Permisos: `instagram_manage_comments`, `pages_manage_engagement`, `pages_read_user_content`.

## Decisión (M1: mensajes directos)

1. **Un canal `meta` para Messenger e Instagram Direct, un adapter, un gateway y un worker.**
   - `@r4-adapters/meta` es transporte puro y depende solo de `@r4/live-ops`, como los de WhatsApp y web.
   - `accountRef` es el id de la página (Messenger) o el de la cuenta de Instagram. `conversationRef` es el PSID o
     IGSID de quien escribe; las conversaciones son 1 a 1 y atestiguadas.
   - Un solo par gateway + worker, no dos, porque el EC2 tiene 3,8 GB sin swap.
   - El perfil es uno; el tono cambia por superficie (punto 3).
2. **Conectar = 3 parámetros.**

   | Variable | Qué es |
   |---|---|
   | `R4_META_PAGE_ID` | id numérico de la página de Facebook |
   | `R4_META_PAGE_ACCESS_TOKEN` | token de la página (permanente, de un usuario de sistema) con `pages_messaging` (+ `instagram_manage_messages`) |
   | `R4_META_INSTAGRAM_ACCOUNT_ID` | id de la cuenta profesional de Instagram vinculada; sin él, solo Messenger |

   El secreto de la app y el token de verificación se toman de `R4_WHATSAPP_APP_SECRET` y `R4_WHATSAPP_VERIFY_TOKEN`
   (misma app). `R4_META_APP_SECRET` y `R4_META_VERIFY_TOKEN` los reemplazan si algún día hay una app propia.

   `npm run production:sales:meta-check` dice qué falta y prueba la conexión, sin escribir nada:
   - el token lee la página;
   - la cuenta de Instagram es la vinculada a la página;
   - la app está suscrita a los mensajes de la página.

   Con `-- --subscribe`, además suscribe la página. Es una escritura en Meta y se hace con el OK del dueño.
3. **Perfil `sales-social@1`, solo lectura, con su propia línea de definición `sales-social`.**
   - **Lecturas:** las del chat web (Catalog V2 con Discover y disponibilidad por variante, y Shipping), más consultas
     al equipo sin pausa (ADR-056).
   - **Sin escrituras:** ni workspace, Quote, Checkout, Customer ni pago. La persona compra en la tienda con el link
     del producto. Para una cotización formal se le da el WhatsApp de la tienda, donde Pesín cotiza.
   - **Contenido no soportado:** imágenes, stickers e historias se le informan al agente (`inform_agent`), que pide
     que se lo cuenten en palabras. No se retienen para una persona.
   - **Superficie:** el adapter agrega una nota fija que arma desde la cuenta donde llegó el mensaje, nunca desde el
     texto: *«[Canal informado por la plataforma: Instagram, mensaje directo, respondiendo a una historia de la
     cuenta.]»*. Con esa nota, la definición ajusta el tono:
     - **en Instagram**, Pesín es primero un compañero de entrenamiento (técnica, rutinas, progresión). Menciona un
       producto solo si se lo piden o si ayuda claramente, como máximo uno o dos, y nunca insiste;
     - **en Messenger**, es el asesor de ventas.
   - **Salida:** texto plano, sin markdown. Cada producto va con su link: el `publicUrl` de una lectura de
     `catalog.get_product_context` de la conversación. Nunca se arma un URL.
   - **Personas:** sin `request_handoff`. Las respuestas de una persona pasan por la consulta sin pausa: el equipo
     responde desde el escritorio (ADR-048) y el mensaje sale por este mismo canal, dentro de la ventana de 24 h.
4. **Escribiendo…** El contrato neutro de la señal de trabajo suma `conversationRef`, opcional, porque Messenger e
   Instagram la dirigen al contacto. El gateway la refresca cada 20 s mientras el turno trabaja, igual que en WhatsApp.
5. **Salida honesta.** La clasificación es la de WhatsApp, más los códigos de Meta:
   - `4` y `613` = límite de uso (`not_sent`);
   - `10/2018278` = ventana cerrada (`rejected`).

   Una respuesta más larga que lo que acepta la superficie sale en partes. La primera parte decide el resultado. Si
   falla una parte posterior, queda `accepted` con `partial_delivery` y no se reintenta, porque reintentar repetiría la
   primera.
6. **Ecos y borrados.** `is_echo` es lo que la cuenta envió: R4, o una persona desde la bandeja de Meta. Se ignora, y lo
   mismo los mensajes borrados. Por eso, si alguien del equipo responde desde Meta Business Suite, Pesín no se entera y
   puede seguir respondiendo. El equipo responde desde el escritorio de R4, no desde la bandeja de Meta (límite
   conocido de M1).

## M2 (propuesta, no implementada): comentarios en publicaciones

El dueño pidió que Pesín «responda publicaciones». La propuesta:

1. **El agente nunca escribe en público.** Un comentario que es una pregunta (precio, stock, «info», «link») recibe:
   - **una respuesta pública de texto fijo**, elegida de una lista que aprueba el dueño (por ejemplo «¡Te escribimos
     por DM! 💪»), nunca generada por el modelo;
   - **una respuesta privada (DM)**, que es la que escribe Pesín. Si la persona contesta, sigue la conversación normal
     de M1.
2. **Qué comentarios responde:** una clasificación decide si un comentario es una pregunta o no, y la decisión queda
   registrada. Los elogios, las menciones a amigos y los emojis no se responden. Cada publicación tiene un tope de
   respuestas por hora (el límite de Meta es 750 por hora por página).
3. **Permisos y App Review:** `instagram_manage_comments`, `pages_manage_engagement` y `pages_read_user_content`, y las
   suscripciones `comments` (Instagram) y `feed` (página).
4. **Diseño pendiente:** el contrato canónico no tiene un mensaje de «comentario». La respuesta privada va dirigida a
   un `comment_id`, no a un PSID o IGSID. Hay que decidir cómo se vuelve una conversación cuando la persona contesta.
   Va en un ADR propio cuando el dueño apruebe M2.

**Decisiones del dueño para M2:**
- respuesta pública fija o ninguna;
- qué publicaciones (todas, o solo las de productos y anuncios);
- si las menciones (`@pesaschile`) también se responden.

## Puesta en marcha (cuando el dueño lo autorice)

1. **Meta.**
   - En la app de WhatsApp, agregar el producto Messenger y la API de Instagram.
   - Crear un token de página permanente con un usuario de sistema del Business Manager.
   - Configurar el webhook de los objetos `page` e `instagram` (campo `messages`) hacia
     `https://<host del gateway Meta>/v1/channels/meta/webhook`, con el mismo token de verificación de WhatsApp.
2. **Servidor.**
   - El dueño escribe los 3 parámetros en un archivo de configuración del servidor que no va al repositorio. Nunca
     se pegan en el chat.
   - Correr `production:sales:meta-check` y, con OK, `-- --subscribe`.
3. **Procesos.**
   - Registrar la definición con `production:sales:bootstrap` y `R4_PROD_POLICY_PROFILE=sales-social@1`.
   - Levantar dos procesos pm2: el gateway (`production:sales:meta-gateway`, con su puerto y la ruta del proxy) y su
     worker (`R4_PROD_POLICY_PROFILE=sales-social@1`).
   - Antes, medir la memoria libre: cada proceso ocupa unos 100–150 MB.
4. **QA antes de App Review.** Con acceso estándar, solo responde a quienes tienen rol en la app. Ese es el QA real con
   la página real: el dueño y los testers prueban sin exponer nada al público.
5. **App Review** de `pages_messaging` e `instagram_manage_messages`. Después, abrir al público.

## Evaluación

- **Unit** (`tests/unit/live-ops/meta-adapter.test.ts`, 21 pruebas):
  - configuración: qué falta y reutilización de los secretos de WhatsApp;
  - firma y handshake;
  - entrada: Messenger, Instagram, respuesta a una historia, contenido no soportado, ecos, cuentas ajenas;
  - salida: cuerpo y token, partes de hasta 1000 bytes, entrega parcial, cada clase de error, «escribiendo…»;
  - verificación de la conexión.
- **Contrato** (`tests/contract/sales-social-profile.test.ts`):
  - solo lecturas; el worker compone exactamente cuatro, con Discover obligatorio;
  - aislamiento de los gateways de WhatsApp y web;
  - la definición: texto plano con links, tono por superficie, sin handoff y sin escrituras.
- **Integración** (`tests/integration/sales-meta-channel.test.ts`), sobre una base desechable:
  - DM firmado de Instagram y de Messenger → tarea `sales-social@1` con la nota de canal → «escribiendo…» → respuesta
    por la página;
  - duplicados y firma falsa;
  - el gateway Meta no conoce los canales `whatsapp` ni `web`.
- **Antes de abrir al público**, falta un L3 con el modelo real y testers con rol en la app:
  - en Instagram: el tono de compañero de entrenamiento, sin presionar la venta;
  - en Messenger: la asesoría;
  - links solo de lecturas;
  - texto plano.
