# ADR-061 — Conectores: cómo R4 y sus agentes se conectan con otras aplicaciones

- **Identificador:** `R4-CONNECTORS-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25: «explícame sobre los conectores, qué herramientas deberíamos incluir para que la
  plataforma y los agentes se puedan conectar a otras aplicaciones», y después: «arma el ADR de conectores».
- **Autoridad superior:**
  - Constitución: la salida del modelo no es confiable; las escrituras requieren ejecución gobernada; el estado
    durable sobrevive al reinicio;
  - PRD;
  - ADR-018 (idempotencia y reconciliación de escrituras) y ADR-019 (recuperación de efectos externos);
  - ADR-050 (identidad de operador de la consola);
  - ADR-053 (un agente por canal; contactos y personas);
  - ADR-054 (variantes de agentes; su revisión 1, Decisión 8, propuso los conectores de lectura que este ADR retoma);
  - ADR-055 (contacto con clientes);
  - ADR-058 (`Artifact` con versiones firmadas);
  - ADR-060 (Instagram y Facebook conectados desde la consola).

## Contexto

Hoy R4 se conecta con otras aplicaciones de tres maneras, y las tres son código escrito a mano:

1. **Canales**, por donde habla la gente: WhatsApp, chat web, Instagram y Facebook. Cada uno tiene un adapter, un
   gateway y su agente.
2. **Servicios dueños**, que los agentes leen o en los que escriben: Catalog, Despacho, Quote, Checkout, Customer.
   Cada uno tiene un contrato tipado, un adapter y una capacidad registrada en el perfil del agente. Sus escrituras
   llevan política, límites, kill switch, idempotencia y recibo.
3. **Avisos hacia afuera**: alertas ntfy al teléfono del dueño y avisos de la consola. Están escritos uno por uno.

Lo que ya funciona y conviene generalizar:
- **La pantalla «Canales» (ADR-060).** El dueño escribe unos pocos parámetros en la consola. Se guardan en un archivo
  600 del servidor, el secreto nunca se vuelve a mostrar, y una operación fija prueba y enciende. Es el patrón de la
  bóveda.
- **`Artifact` con versiones firmadas (ADR-058).** Sirve para guardar la definición de un conector, con su historial y
  quién la firmó.
- **La capacidad como única puerta** de un agente hacia afuera. Todo pasa por el `CapabilityInvoker`, con presupuesto,
  registro y política.

Lo que falta, por valor para el negocio:
- **Estado del pedido y seguimiento del despacho.** Son las preguntas más frecuentes de postventa en WhatsApp. Hoy
  Pesín no las puede contestar y las deriva.
- **Email (Gmail) como canal.** La mesa de ventas (ADR-048, C4) lo espera.
- **Documentos y planillas del equipo** (políticas, listas, stock de bodega), para responder sin consultar a una
  persona.
- **Avisos a otras apps** (Slack, correo del equipo, una planilla) y **disparadores desde otras apps**, por ejemplo
  «pedido pagado» → un agente actúa.

Riesgos que el diseño tiene que cerrar:
- **Respuestas no confiables:** lo que devuelve otra aplicación puede traer instrucciones escondidas.
- **Datos personales:** un pedido trae nombre, dirección y teléfono.
- **Secretos:** tokens y claves de terceros.
- **Costo y disponibilidad:** límites de uso y caídas de terceros.
- **Escrituras sin garantías:** un POST a otra app que se repite o se pierde.

## Decisión 1 — Tres familias, una sola puerta por familia

| Familia | Qué es | Cómo entra | Desde la consola |
|---|---|---|---|
| **Canal** | Por donde llegan y salen conversaciones | Código: adapter + gateway + perfil + agente (ADR-046, ADR-060) | Conectar la cuenta y encender o apagar (pantalla «Canales») |
| **Capacidad** | Lo que un agente lee o hace en otra app | Lectura: conector declarativo o herramienta MCP de solo lectura. Escritura: siempre código | Registrar, probar y firmar conectores de **lectura** |
| **Evento** | Lo que otra app le cuenta a R4, o R4 a otra app | Disparador entrante (abre una tarea) o aviso saliente (suscripción a eventos de R4) | Registrar, probar y firmar |

Un agente solo toca otra aplicación a través de una capacidad de su perfil. Nunca por texto del modelo, una URL que
escriba el modelo o un fetch libre.

## Decisión 2 — Bóveda de credenciales en la consola

Generaliza «Canales»:
- **Dónde se guarda:** cada conector tiene su archivo de secretos en el servidor,
  `~/.config/r4/secrets/connectors/<id>.env` (600). Lo escribe la consola, con operador firmado (ADR-050), y nunca lo
  vuelve a mostrar: solo «guardado» y la fecha. Rotar es escribir uno nuevo; el anterior queda respaldado.
- **Qué nunca pasa:** los secretos no se pegan en el chat, no van al repositorio, no aparecen en logs ni en eventos, y
  la salida del modelo no los ve.
- **Qué lee cada proceso:** el adapter genérico recibe solo el archivo de su conector. Ningún proceso lee la bóveda
  completa.
- **Qué guarda cada conector, además del secreto:**
  - sus hosts permitidos;
  - su límite de uso por minuto;
  - su presupuesto mensual de llamadas;
  - su dueño (quién lo firmó).

## Decisión 3 — Conector de lectura declarativo

Retoma la propuesta del ADR-054 (rev. 1, D8). Desde la consola se describe una lectura HTTP sin escribir código. El
manifiesto tiene:
- **`id`** y la **descripción para el modelo**. La escribe el operador; nunca se toma del servicio remoto.
- **Host** de una lista permitida, **solo `GET`**, y una **plantilla de ruta** con parámetros tipados (entero, texto
  con patrón, enum). El modelo llena solo esos parámetros; nunca la URL.
- **Credencial:** una referencia a la bóveda (encabezado o query), nunca el valor.
- **Esquema de la respuesta**, y la **proyección**: los campos que verá el modelo. Lo demás se descarta antes de entrar
  al contexto.
- **Límites:** timeout, tamaño máximo, caché (TTL), límite de uso y presupuesto.
- **Clase de dato:** `público`, `interno` o `personal` (Decisión 4).

R4 lo ejecuta con un adapter genérico **fuera de Core** (`adapters/connectors/http-read`) que:
- valida cada respuesta contra el esquema y rechaza lo que no calce;
- no sigue redirecciones fuera del host;
- nunca hace otra cosa que `GET`;
- trata lo que recibe como dato no confiable, igual que la salida del modelo: el modelo lo ve marcado como
  observación de esa capacidad, nunca como instrucción.

El manifiesto se guarda como **`Artifact` de tipo `connector`**, con versiones firmadas (ADR-058). Su ciclo es
**borrador → probador → firmado → disponible**:
- **probador:** llamadas de prueba con entradas de ejemplo, que muestran la respuesta proyectada y lo rechazado;
- **firmado:** solo el owner firma.

Se registra como capacidad `connector.<id>` con efecto `read`. Un agente lo usa solo si su perfil y su definición lo
incluyen. Eso es una versión nueva del agente, que entra como variante y experimento (ADR-054). Firmar un conector no
se lo da a ningún agente por sí solo.

## Decisión 4 — Datos personales: el sujeto lo pone la plataforma

Un conector de clase `personal` (pedidos, despachos de un cliente):
- **Declara cuál de sus parámetros identifica al sujeto** (por ejemplo, el correo o el teléfono del comprador). Ese
  parámetro lo llena **la plataforma** con la identidad verificada del contacto de la conversación, nunca el modelo.
  Sin identidad verificada (ADR-053: vínculo o verificación) la capacidad responde «no disponible» y el agente ofrece
  el camino humano.
- **Proyecta lo mínimo** que responde la pregunta, por ejemplo estado, courier, número de seguimiento y fecha
  estimada; nunca dirección completa, RUT ni montos de pago.
- **Nunca entra a logs, eventos ni incidentes.** El registro guarda que hubo una lectura, su resultado (ok, vacío o
  error) y el conector, sin el contenido.

Esta regla se aplica antes del primer conector personal, no después.

## Decisión 5 — Herramientas MCP: R4 como cliente, solo lectura y con permiso por herramienta

R4 suma un cliente MCP **fuera de Core** (`adapters/connectors/mcp`):
- **Servidores permitidos:** se registran en la consola, de una lista permitida: un comando local de una lista fija,
  o una URL remota con su credencial en la bóveda.
- **Herramientas, una por una:** nunca se importa el servidor completo. Cada herramienta se habilita aparte y se vuelve
  una capacidad `mcp.<servidor>.<herramienta>` con:
  - la descripción que escribe el operador (la del servidor es dato no confiable y puede traer instrucciones);
  - un esquema de entrada fijado al habilitarla;
  - el mismo validador de respuesta, proyección, límites y clase de dato del conector declarativo.
- **Solo lectura:** se habilitan herramientas que leen. Una herramienta que escribe, borra o envía no se habilita desde
  la consola, aunque el servidor la marque como segura. Si hace falta, entra por la Decisión 6.

Con esto, Google Drive y Sheets, Calendar o Notion quedan al alcance con poco código propio.

## Decisión 6 — Escribir en otra aplicación es siempre código

Crear, modificar, enviar o pagar en otra aplicación sigue el camino de Quote y Checkout:
- ADR del caso;
- contrato con el dueño;
- adapter con idempotencia, recibo y reconciliación (ADR-018, ADR-019);
- política (`ALLOW`, `REQUIRE_APPROVAL` o `DENY`), límites y kill switch;
- evaluación y PR.

No hay escrituras declarativas ni herramientas MCP de escritura habilitadas desde la consola. La consola muestra la
capacidad cuando está desplegada, y el owner decide en qué agente y con qué límites.

## Decisión 7 — Eventos: disparadores entrantes y avisos salientes

- **Disparador entrante.** Otra app avisa algo a R4 (por ejemplo, un pedido pagado):
  - entra por `POST /v1/connectors/<id>/events`, con firma HMAC cuyo secreto está en la bóveda;
  - se valida contra un esquema;
  - se deduplica por el id del evento;
  - abre una tarea para un agente, con el evento como dato no confiable. Es una extensión genérica de `Schedule`: una
    tarea abierta por evento en vez de por horario.

  Si el agente le escribe a un cliente por su cuenta, aplica el ADR-055: ventanas, plantillas y reglas de contacto.
- **Aviso saliente.** Una suscripción a eventos de R4 (una conversación espera a una persona, una consulta sin
  respuesta, una cotización emitida, un incidente):
  - hace un `POST` firmado a una URL de la lista permitida;
  - reintenta con espera creciente;
  - lleva ids y un link a la consola, y no lleva contenido de conversaciones salvo que el owner lo habilite para ese
    destino.

  Reemplaza los avisos escritos uno por uno; ntfy pasa a ser un destino más.

## Decisión 8 — Gobierno, costo y salud

- **Por conector:**
  - límite de uso;
  - presupuesto mensual de llamadas;
  - un corte automático tras errores seguidos: el conector queda «no disponible», el agente lo dice con honestidad y
    nunca inventa un dato.
- **Apagar un conector es inmediato:** sus capacidades responden «no disponible» y la consola lo muestra.
- **Desconectar borra la credencial** y apaga cada herramienta y disparador que la usaba. Nada queda conectado a
  medias.
- **Errores con códigos estables** que el agente y la consola entienden igual: `no_autorizado`, `sin_permiso`,
  `no_encontrado`, `limite_de_uso`, `no_disponible`, `respuesta_invalida`.
- **Auditoría:** cada firma, cambio de secreto, encendido y apagado queda con el operador firmado.

## Decisión 9 — La pestaña «Conectores» de la consola

El owner pidió una pestaña de conectores como la de productos del rubro. Se revisó la documentación pública de Nexor
(docs.getnexor.ai, 2026-11-25). Se adoptan sus buenas prácticas, con dos diferencias a favor de la seguridad, que se
marcan abajo.

**Organización:**
- **Una pestaña «Conectores»** en Plataforma, junto a «Canales», con tarjetas agrupadas por para qué sirven:
  - Canales: los de ADR-046 y ADR-060, que enlazan a «Canales»;
  - Tienda y pedidos: PrestaShop;
  - Despacho: couriers;
  - Documentos: Drive y Sheets;
  - Avisos: Slack, correo, ntfy;
  - Personalizados: HTTP, MCP y webhooks.
- **Cada tarjeta dice en una línea qué cubre**, por ejemplo «Estado de pedidos por número». Cada herramienta lleva una
  etiqueta: **«Lee»** o **«Puede cambiar datos»**. Un logo nunca promete un conector que no existe: los que no están
  construidos dicen «Disponible más adelante».
- **Estados de la tarjeta:**
  - «Disponible»;
  - «Conectado»;
  - «Conectado, apagado»: se enciende ahí mismo, no se vuelve a conectar;
  - **«Necesita atención»**: credencial vencida o rechazada, o el corte automático por errores;
  - «Desconectado».

**Credenciales:**
- **Una credencial por conector,** que se muestra una sola vez al guardarla y después solo como «guardada» y su fecha.
- **Para rotar,** se guarda la nueva, se prueba y recién entonces se revoca la anterior.
- **Con OAuth,** cuando el proveedor lo ofrece (Google), el owner inicia sesión en la página del proveedor y R4 nunca
  ve la contraseña.

**Herramientas por agente:**
- **Una herramienta agregada a un agente entra apagada.** Encenderla es explícito, y para un agente en producción es
  una variante nueva (ADR-054).
- **Mínimo privilegio por defecto. Diferencia con Nexor:** su autorización OAuth viene con todos los permisos marcados,
  incluso los de borrar. En R4 vienen marcados **solo los de lectura**, y las escrituras no se pueden habilitar desde
  la consola (Decisión 6).

**Probar antes de usar:**
- **«Probar conexión»** valida la credencial y los permisos.
- **«Probar herramienta»** corre una llamada y muestra:
  - la llamada hecha, sin el secreto;
  - la respuesta;
  - **lo que el agente leería después de la proyección**;
  - lo que se descartó.
- **Disparador entrante:** se crea con una prueba en seco y después se importa un lote pequeño antes del tráfico real.
  Antes de encenderlo, la consola advierte que lo que llegue se atiende de inmediato.

**Salud y actividad:**
- **Por herramienta, agente y canal:** llamadas, correctas, fallidas, vacías y bloqueadas, la tasa de fallas y los
  errores más frecuentes. Las problemáticas se ordenan primero.
- **«Actividad reciente»** por conector: herramienta, agente, resultado y duración.
- **Diferencia con Nexor:** las muestras de llamadas **nunca guardan datos personales**. Nexor guarda argumentos y
  resultados recortados; R4 guarda solo la forma del resultado (campos y tamaños), nunca valores de clase `personal`
  (Decisión 4).
- **Avisos salientes:** cada destino tiene una salud con umbrales y un registro de entregas (intento, código,
  duración), sin contenido:
  - sano;
  - degradado tras 5 fallas seguidas;
  - fallando tras 20;
  - deshabilitado tras 100.
- La salud entra a «Salud de R4» y las fallas a «Incidentes» (ADR-051).

**Límites de la plataforma:**
- solo `https`;
- un máximo de conectores conectados (20 al inicio);
- quién puede abrir la pestaña: solo el owner, el operador de la consola (ADR-050).

## Primer conector: pedidos de PrestaShop

Revisión de la tienda real el 2026-11-25, con el usuario de solo lectura de la base y solo estructura y conteos, sin
datos de clientes.

**Lo que hay:**
- **Webservice activo.** El webservice de PrestaShop está habilitado y ya tiene cuentas de acceso. Es la puerta
  correcta: R4 no lee bases de otros sistemas (instrucciones del repositorio) y el webservice permite una clave
  propia, limitada a `GET` y a los recursos que se elijan.
- **El estado del pedido y su historial** (estado actual, fecha de cada cambio y transportista) están completos en
  todos los pedidos.
- **Estados del flujo real:**
  - estándar: «Pago aceptado», «Enviado», «Entregado», «Cancelado»;
  - de bodega: «Embalando», «Embalando BE», «Etiquetando»;
  - de la flota propia: «Consolidando Ruta», «En Reparto»;
  - de transportista: «Entregado a BlueExpress»;
  - de retiro: «Listo para retiro», «Transacción Lista para retiro en tienda»;
  - de pago: «Transacción Rechazada», «Transacción Reembolsada», «Transacción Terminada».

  Las marcas de PrestaShop (pagado, enviado, entregado) no son confiables para el cliente; por ejemplo, «Entregado a
  BlueExpress» no está marcado como enviado. Por eso el conector usa **una tabla explícita de estado → frase para el
  cliente**, que aprueba el owner.
- **Transportistas:** flota propia (Pesas Chile), Blue Express, Starken, retiro en tienda y retiro en el centro de
  distribución de Maipú.
- **Seguimiento:** PrestaShop **no guarda número de seguimiento**: el campo está vacío en todos los pedidos. Un módulo
  de logística (`ps_logistics`, desde 2026-10-22) envía los despachos a un servicio externo. El seguimiento del
  courier, si existe, vive ahí o en el courier.
- **Identidad:** casi todos los pedidos tienen un celular chileno en la dirección de despacho, y la referencia del
  pedido es de 9 letras. No hay compras como invitado: todo pedido tiene cuenta y correo.

**Decisión propuesta:**
- **Va en código, no como manifiesto declarativo:** es el adapter `@r4-adapters/prestashop-orders`, fuera de Core,
  porque lleva la regla del sujeto y la tabla de estados. Sirve de referencia para el conector declarativo de la
  Decisión 3.
- **Clave de webservice propia** creada por el owner: solo `GET` sobre `orders`, `order_histories`, `order_states`,
  `order_carriers`, `carriers` y `addresses`. Va en la bóveda; si se rota, el conector sigue funcionando.
- **Qué se muestra depende de cuánto se validó** (owner, 2026-11-25: «con el número de pedido, lo mismo que hace
  Starken», y para la página, la sesión del cliente):

  | Nivel | Validación | Canales | Qué se muestra |
  |---|---|---|---|
  | **1** | Solo la referencia del pedido, como el número de una orden de transporte | Todos | Estado traducido por la tabla, fecha de ese estado, y transportista o retiro. Nada más |
  | **2** (más adelante) | Referencia + correo del comprador, como el seguimiento de pedidos de PrestaShop para quien no inicia sesión | Todos | El nivel 1, más los productos del pedido |
  | **3** | Cliente con sesión iniciada en la tienda | Web | «Mis pedidos»: sus pedidos con estado, sin pedir la referencia |

- **Nivel 1: capacidad `orders.status`.**
  - **Por qué basta la referencia:** se genera al azar con 9 letras, así que no se puede adivinar ni recorrer como un
    correlativo. Quien la tiene es porque se la dieron.
  - **Proyección:** solo lo de la tabla de niveles. Nunca nombre, dirección, montos, productos ni teléfono.
  - **Tope de intentos:** 5 por conversación por hora. Una referencia inexistente y una mal escrita reciben la misma
    respuesta.
  - Las consultas van al registro sin la referencia completa.
- **Nivel 3: «mis pedidos» del cliente con sesión, armado por la tienda** (el mismo patrón que las fichas de producto
  del ADR-046):
  - el agente responde con la marca `[[mis-pedidos]]`;
  - el módulo de la tienda (`pc_r4chat`) arma la tarjeta con la sesión del visitante, en su navegador. **R4 no ve
    esos datos**;
  - sin sesión, la tarjeta dice «Inicia sesión para ver tus pedidos», con el botón para hacerlo.
- **WhatsApp, más adelante:** «mis pedidos» por coincidencia del celular del pedido con el número de la conversación.
  Necesita un endpoint de solo lectura firmado en `pc_r4chat`, porque el webservice filtra por valor exacto y los
  teléfonos están escritos de muchas formas.
- **El agente no promete fechas de entrega** con este conector: dice el estado y su fecha. Una fecha estimada necesita
  una regla del owner por transportista y región.
- **Lectura interna «pedidos pagados desde T»** (acordada con el ADR-062 D6, que cierra oportunidades como ganadas):
  - **Qué es:** una segunda lectura del mismo adapter, para la plataforma y no para el agente. No es una capacidad y
    nunca llega al contexto de un modelo.
  - **Qué entrega:** referencia, fecha de pago, total e id de cliente de cada pedido que pasó a un estado pagado
    desde T. Se reconoce por el historial de estados, no por el estado actual.
  - **Proyección y permisos propios:**
    - la misma clave de solo lectura (`orders`, `order_histories`, `order_states`), sin otros recursos;
    - la proyección de esta lectura, distinta de la del nivel 1;
    - su propio tope de uso.
  - **Dónde queda lo leído:** se guarda solo donde lo decide el ADR-062. Nunca entra a logs, eventos ni incidentes
    con el total ni el id de cliente: el registro guarda cuántos pedidos leyó y si terminó bien.
  - **Qué pasa si falla:** reintenta en la siguiente pasada desde el último T confirmado. Nunca salta un tramo.

## Core

Lo genérico vive en Core y no gana conceptos de dominio:
- una **capacidad respaldada por un conector**: misma interfaz, efecto `read`, presupuesto y registro;
- el **`Artifact` de tipo `connector`**: un manifiesto con versiones firmadas;
- el **disparador por evento**, como extensión de `Schedule`;
- la **suscripción a eventos salientes**.

Los adapters genéricos (`http-read`, `mcp`) y cada conector concreto viven fuera de Core. Nada de «pedido» o
«despacho» entra a Core: son manifiestos.

## Fases

| Fase | Qué | Valor |
|---|---|---|
| C0 | Este ADR | Decisión |
| C1 | Bóveda y pestaña «Conectores» (Decisión 9), generalizando «Canales» | Secretos de terceros sin tocar el servidor |
| C2 | Conector de PrestaShop (niveles 1 y 3), y luego el conector de lectura declarativo con su probador y firma | La pregunta más común de postventa, sin derivar |
| C3 | Avisos salientes (webhooks firmados; ntfy como destino) | El equipo se entera donde trabaja |
| C4 | Herramientas MCP de lectura (primero Google Drive / Sheets) | Documentos del equipo como fuente |
| C5 | Disparadores entrantes | R4 reacciona a lo que pasa en otras apps |

Email (Gmail) es un **canal**, no un conector: va en su propio ADR, como el ADR-060.

## Decisiones abiertas del owner

1. **Pedidos de PrestaShop** (sección «Primer conector»). Ya decidido (2026-11-25): los niveles 1 y 3, y que la
   pestaña «Conectores» sigue la Decisión 9. Queda abierto:
   - la clave de webservice de solo lectura, que crea el owner;
   - la tabla estado → frase para el cliente;
   - dónde vive el seguimiento del courier: el servicio externo del módulo `ps_logistics`, o la API de Blue Express y
     Starken.
2. **Identidad para datos personales:** para el futuro «mis pedidos» por WhatsApp, si basta que el celular del pedido
   coincida con el número de WhatsApp, o se exige la verificación del ADR-053.
3. **Hosts y servidores MCP permitidos** al inicio.
4. **Presupuestos por conector**, y si el gasto en llamadas de terceros se suma al tope mensual de modelo o va aparte.
5. **Destinos de los avisos salientes** (Slack, correo, planilla) y si alguno puede llevar contenido de conversaciones.

## Evaluación

- **Adapter genérico:** pruebas de contrato que verifican:
  - solo `GET`, solo hosts permitidos, sin redirecciones fuera del host;
  - rechazo por esquema, tamaño y timeout;
  - la proyección: el modelo nunca ve un campo fuera de ella;
  - el sujeto personal lo llena la plataforma: si el modelo intenta pasarlo, la llamada se rechaza.
- **Inyección:** una respuesta o una descripción MCP con instrucciones escondidas no cambia el comportamiento del
  agente. Es un caso del set adversarial.
- **Cada conector** pasa el probador con entradas de ejemplo antes de firmarse, y cada agente que lo usa pasa por su
  experimento (ADR-054).

## Fuera de alcance

- Escrituras declarativas o herramientas MCP de escritura habilitadas desde la consola.
- Código arbitrario definido en la consola, scraping de sitios y lectura directa de bases de otros sistemas (CRM
  incluido).
- Conectores que un agente se habilite a sí mismo.

## Consecuencias

- **Lo que se gana:** R4 puede leer de muchas aplicaciones sin un PR por cada una. El riesgo queda acotado porque solo
  se lee, por hosts y herramientas permitidos, con esquema y proyección, con el sujeto puesto por la plataforma y con
  firma del owner.
- **Lo que no cambia:** las escrituras siguen siendo lentas de agregar, a propósito. Es donde está el daño posible.
- **Lo que hay que mantener:** cada conector firmado se monitorea (salud, gasto, errores) y tiene un dueño. Un conector
  sin dueño se apaga.
