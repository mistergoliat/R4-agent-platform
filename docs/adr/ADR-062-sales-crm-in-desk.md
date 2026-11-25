# ADR-062 — CRM en la mesa de ventas: oportunidades con dueño, estado, próxima acción y resultado

- **Identificador:** `R4-SALES-CRM-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25.
  - Revisó el plan comercial omnicanal (documento interno). Ese plan pide un CRM propio que centralice las
    conversaciones, clasifique, derive a pools, haga seguimiento y mida.
  - Preguntó: «¿dónde integrarías un CRM y qué necesitaríamos? Con integrar me refiero a crear uno para gestionar
    leads, cosa que Pesín probablemente ya lo hará, pero que sea útil y no quede como una página bonita
    únicamente».
  - Pidió escribir este ADR. El número 061 ya lo usa la propuesta de conectores (PR #157), por eso este es el 062.
- **Autoridad superior:**
  - Constitución y AGENTS.md:
    - conceptos de dominio como «oportunidad» viven fuera de Core;
    - la salida del modelo no es confiable;
    - toda escritura pasa por ejecución gobernada.
  - ADR-047: cierre del caso por inactividad.
  - ADR-048: la mesa de ventas es un servicio de dominio. Esta propuesta usa:
    - Decisión 2: contrato con R4;
    - Decisión 3: reglas de asignación;
    - Decisión 4: libro append-only con reversa;
    - cambios genéricos C-3 y C-4.
  - ADR-053: contactos y personas entre canales.
  - ADR-055: reglas de contacto para mensajes proactivos.
  - ADR-056: consultas al equipo sin pausar la conversación.
  - ADR-059: qué venta web se atribuye.
  - ADR-061 (propuesto): conectores y lectura de pedidos de PrestaShop.

## Contexto

Hechos verificados:

- **El plan comercial pide:**
  - centralizar conversaciones y clientes;
  - clasificar por intención, monto, segmento y complejidad;
  - derivar a cinco pools: ventas general, mayoristas, institucionales, postventa y servicio técnico;
  - que cada oportunidad tenga un solo responsable, con toma trazable;
  - seguimiento con estados, recordatorios y próxima acción;
  - medir origen, tiempos, conversión, no conversión y su motivo, satisfacción, pool y responsable.

  También define los límites: el CRM no cotiza ni ejecuta postventa, y la IA no cierra un caso por silencio. Las
  metas se definen después de medir la línea base.
- **La mesa de ventas ya está en producción (ADR-048).** En su base guarda:
  - vendedores con rol (`seller`, `supervisor`, `admin`);
  - áreas y la relación vendedor ↔ área;
  - disponibilidad;
  - un registro append-only de asignaciones (`offered`, `accepted`, `declined`, `replied`, `released`,
    `withdrawn`, `answered`).

  La app Ventas muestra «Pesín te consulta» y los casos del vendedor. Permite tomar, responder y soltar, y muestra si
  el visitante web sigue en el chat.
- **Lo que R4 ya ofrece:**
  - conversaciones en cuatro canales: WhatsApp, web, Instagram y Facebook;
  - traspasos y consultas;
  - lecturas permitidas para la mesa: atención, conversaciones e hilo;
  - acciones de operador firmadas por persona;
  - cotizaciones reales de Quote, con referencia, en WhatsApp y en web.
- **Lo que R4 todavía no ofrece:**
  - `/v1/events` lista eventos hacia atrás. No hay un feed con cursor hacia adelante (ADR-048 C-4).
  - El traspaso no lleva un motivo estructurado (C-3).
- **No existe una unidad que sobreviva a la conversación.** Un caso es un traspaso, y al soltarlo nada registra:
  - si el cliente compró;
  - quién es dueño del siguiente paso;
  - por qué se perdió la venta.

  Tampoco se guarda el segmento: el código no conoce «mayorista» ni «institucional».
- **Diagnóstico de los datos de clientes (2026-11-25).** Se hizo de solo lectura, sobre la copia de la tienda y la
  copia sincronizada de documentos de venta de SAP. Solo se obtuvieron conteos; ningún dato personal salió de la
  base.
  - **Las claves de la tienda están casi completas:**
    - prácticamente todas las cuentas tienen correo válido;
    - cerca del 99 % de las direcciones tiene celular chileno válido;
    - cerca del 99 % tiene RUT con dígito verificador correcto, en el campo de documento de la dirección.

    En cerca del 99 % de los clientes están las tres claves a la vez. Los campos de empresa del cliente están
    vacíos.
  - **Duplicados:** al unir cuentas por correo, celular o RUT, cerca del 10 % de las cuentas cae en grupos
    de 2 a 5 cuentas. Esos grupos son probablemente la misma persona. Unos pocos valores se repiten en decenas de
    cuentas, y uno de esos grupos encadena más de cien. Son claves compartidas (un teléfono de tienda, un RUT de
    relleno) y no deben unir cuentas solas.
  - **No hay segmento en la tienda.** Solo existen los grupos de cliente por defecto, sin grupo mayorista.
  - **La evidencia de empresa existe:**
    - un módulo de facturación guarda RUT, razón social y giro de factura;
    - cerca del 11 % de los pedidos va a una dirección de factura;
    - la gran mayoría de esos RUT son de persona jurídica.
  - **SAP cubre todos los canales**, incluida la tienda física:
    - el código de cliente es un RUT válido en el 99,6 % de los casos;
    - tres códigos genéricos (consumidor final) concentran cerca del 85 % de los documentos;
    - el resto son clientes con nombre, casi todos empresas;
    - de esos clientes con nombre, la mayoría también aparece en la tienda con el mismo RUT;
    - unos cientos tienen cinco o más documentos en 24 meses;
    - la mayoría tiene un solo vendedor en SAP.

    El RUT también da un indicio de institución: entidades del Estado, municipalidades y organizaciones sin fines
    de lucro tienen rangos propios.
  - **Postventa ya tiene un flujo de casos** en una automatización existente, fuera de R4: casos por departamento,
    estado y contacto posterior a la compra.
- **Cómo fracasa un CRM:** se convierte en una página bonita cuando:
  - depende de que alguien digite;
  - sus campos son opcionales;
  - no empuja a nadie;
  - el resultado se escribe a mano.

  Entonces los vendedores siguen en el sistema actual. Este ADR está diseñado para evitar cada una de esas causas.

## Decisión 1 — El CRM es la mesa, y su unidad es la oportunidad

- **La oportunidad vive en la base de la mesa** (repositorio privado). R4 Core no la conoce. El paquete Sales la
  referencia con una clave opaca.
- **Una oportunidad es un contacto con una intención de compra.** Tiene:
  - **origen:** canal, referencia de entrada (link o QR del vendedor, anuncio) y fuente (Decisión 2);
  - **segmento** y **área (pool)**;
  - **un solo dueño a la vez:** una persona, o Pesín mientras atiende solo;
  - **estado** (Decisión 5);
  - **próxima acción:** qué y cuándo;
  - **monto:** viene de la cotización o del pedido, nunca del modelo;
  - **referencias:** conversaciones, cotizaciones y pedidos;
  - **resultado y motivo.**
- **Una sola oportunidad abierta por contacto y área.** Si el mismo contacto vuelve por la misma área, se suma a la
  oportunidad abierta, por cualquier canal. Cada conversación se reconoce por la clave opaca de R4 (ADR-053). La
  mesa une esas claves con las de la tienda y las de SAP en un contacto (Decisión 10).
- **Historia append-only** (`opportunity_events`), igual que el registro de asignaciones. Cada cambio queda con su
  autor (persona, Pesín o sistema) y su fuente. Una corrección es un evento nuevo.

## Decisión 2 — Nadie digita: las oportunidades nacen de evidencia

Cada fuente crea o actualiza la oportunidad. Es idempotente: la clave es la referencia de la fuente.

1. **Conversación con intención de compra.** Se registra en estos momentos:
   - cuando Pesín consulta al equipo o pide un traspaso;
   - cuando emite una cotización;
   - cuando la conversación se cierra por inactividad (ADR-047), si la clasificación (Decisión 3) dice que hubo
     intención.
2. **Cotización emitida**, por Pesín o por una persona. La oportunidad pasa a «cotizada» y toma el monto de Quote.
3. **Carro web con líneas agregadas desde el chat:** la evidencia de ADR-059 fase A1. Llega en una fase posterior.
4. **Leads de anuncios de Meta** (formularios). Entran como disparador entrante (ADR-061 Decisión 7), en una fase
   posterior.
5. **Cliente en tienda.** Es la **única captura manual**: un formulario de tres campos en la app Ventas (contacto,
   qué busca y próxima acción).

Las conversaciones sin intención de compra no crean oportunidades. Por ejemplo, una pregunta frecuente o una
política de despacho.

## Decisión 3 — Pesín propone la clasificación y la plataforma la valida

- **Pesín clasifica dentro de su turno**, como entrada de la capacidad que registra la oportunidad (cambios en R4).
  No es una llamada extra al modelo. Los campos son listas cerradas que declara la mesa:
  - **intención:** compra, cotización, postventa, servicio técnico u otra;
  - **segmento:** persona, mayorista o institucional;
  - **complejidad:** estándar o proyecto;
  - **productos o categorías:** referencias de Catalog;
  - **resumen:** hasta 500 caracteres.
- **Un valor fuera de la lista se rechaza.** El resumen es texto de apoyo para el vendedor, no evidencia.
- **El monto nunca lo dice el modelo.** Sale de Quote o de la tienda. Sin cotización ni carro, la oportunidad queda
  «sin monto».
- **Lo que dice Pesín es evidencia de nivel conversación.** La evidencia de los sistemas y la confirmación de una
  persona le ganan (Decisión 10).
- **Una persona puede corregir** el segmento o el área. La corrección queda como evento con su autor. Las
  correcciones son la señal para medir la calidad de la clasificación.
- **Las reglas de derivación son configuración versionada de la mesa**, no texto del prompt. Ejemplos: «sobre un
  monto o si es proyecto, va a una persona» o «mayorista va al pool Mayoristas». El monto que Pesín puede cotizar
  solo sigue siendo un límite de R4 (`R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP`).

## Decisión 4 — Dueño y pool: se aplican las reglas de ADR-048

- **La asignación sigue el orden de ADR-048 Decisión 3:**
  1. entrada directa por el link o QR de un vendedor;
  2. cliente de cabecera (90 días);
  3. el cliente pide a alguien por nombre;
  4. el motivo determina el área. **Dentro del área, la oportunidad queda en un pozo común y la toma quien quiera
     del pool (autoasignación).** Así lo pide el plan comercial y lo decidió el owner el 2026-11-25. Esto cambia la
     oferta rotativa de la regla 4 de ADR-048 solo para las oportunidades del CRM. Si nadie la toma dentro del plazo
     (10 minutos, como el plazo de aceptación de ADR-048), la mesa avisa al dueño del pool y luego al supervisor;
  5. si nadie está disponible, nunca hay silencio.

  Los pools son las áreas de la mesa. Las áreas iniciales y sus integrantes son decisión del owner.
- **Toma única.** Al tomar una oportunidad queda un evento con persona, fecha y hora. Otro vendedor puede verla,
  pero no puede tomarla sin que el dueño la suelte o la reasigne un supervisor.
- **Pesín es dueño mientras atiende solo.** Lo deja de ser cuando una persona toma la oportunidad o cuando esta se
  cierra. Sus ventas se miden, pero no se acreditan a ninguna persona (ADR-059 Decisión 4; el fondo del equipo es
  la decisión abierta 1 de ADR-048).

## Decisión 5 — Estados y próxima acción obligatoria

- **Cinco estados:** `nueva` → `en_gestion` → `cotizada` → `ganada` | `perdida`. Cambiar los nombres o agregar
  estados es un cambio de configuración versionada, acordado con Ventas.
- **Invariante: toda oportunidad abierta tiene dueño y próxima acción con fecha.** La API de la mesa rechaza guardar
  una oportunidad abierta sin próxima acción. Cuando se pueda, también lo impide una restricción de la base, no solo
  la pantalla. Para salir de una oportunidad el vendedor tiene dos caminos:
  - fijar la próxima acción;
  - marcarla `perdida` con un motivo.
- **Motivos de pérdida:** lista cerrada, definida por el owner. Propuesta:
  - precio;
  - sin stock;
  - plazo de entrega;
  - compró en otro lado;
  - el cliente no respondió;
  - no califica;
  - otro, con nota.
- **El silencio no cierra.** Si una cotización vence sin compra, el sistema le pregunta al dueño qué pasó. La
  oportunidad no pasa sola a `perdida`.
- **Escalamiento:**
  - una próxima acción vencida aparece primero en «Hoy»;
  - pasado el plazo de escalamiento, le llega un aviso al dueño;
  - después, al supervisor (mecanismo de SLA de ADR-048);
  - una oportunidad `nueva` sin dueño dentro del SLA se ofrece al siguiente y se avisa al supervisor.

## Decisión 6 — El resultado llega de la tienda, no se digita

- **`ganada` se marca cuando un pedido pagado calza con la oportunidad.** Puede calzar de tres formas:
  - una cotización pagada por Checkout, cuando exista;
  - en la web, la evidencia de ADR-059: líneas agregadas desde el chat, pagadas y que calzan;
  - un pedido de PrestaShop del mismo contacto (por sus claves, Decisión 10), con los productos cotizados, dentro
    de la vigencia.
  - **Cómo se lee:** con una lectura interna de la plataforma sobre el mismo adapter de pedidos de ADR-061 (clave
    propia y de solo lectura). Trae los pedidos pagados desde una fecha: referencia, fecha de pago, total y cliente.
    Tiene su propia proyección y sus permisos. **Nunca se expone al modelo:** no es una capacidad de ningún agente.
    «Pagado» sale del historial de estados y de una tabla explícita de estados pagados. Nunca sale de las marcas del
    estado actual, porque en los estados propios de la tienda están mal configuradas (auditoría de estados,
    2026-11-25).
    Es distinta de la consulta de estado por referencia que ADR-061 ofrece a los clientes.

  La comparación es determinista. Si es ambigua, el dueño la confirma.
- **`ganada` manual exige la referencia del pedido.** Sirve para ventas en tienda. La referencia se verifica cuando
  el pedido existe; si no aparece, la oportunidad queda marcada para revisión.
- **El monto ganado sale de las líneas del pedido**, no de la cotización.
- **Una anulación o devolución** agrega un evento de reversa (ADR-048 Decisión 4).
- **El CRM no calcula comisiones.** Sus eventos alimentan el libro de atribución de ADR-048, que sigue siendo dueño
  de esa regla.

## Decisión 7 — Pesín trabaja para el vendedor

- **«Hoy» muestra, por cada oportunidad:**
  - el resumen de Pesín;
  - la próxima acción;
  - un mensaje sugerido.

  El vendedor lo envía con un toque o lo edita. El envío es una acción de operador firmada por el vendedor, que ya
  existe. Generar el borrador no envía nada.
- **Fuera de la ventana de 24 horas de WhatsApp** se usa una plantilla aprobada por Meta (paridad de ADR-048).
- **Que Pesín haga seguimientos por su cuenta** es el motor de seguimiento. Queda fuera de este ADR, porque necesita
  las reglas de contacto de ADR-055. El owner lo dejó fuera del primer MVP (2026-11-24).

## Decisión 8 — Postventa y servicio técnico: casos, no oportunidades

- **Lo que entra en este ADR:**
  - Pesín deriva estos casos al pool que corresponde, con el historial completo.
  - El caso queda registrado con un tipo propio (`postventa` o `servicio_tecnico`) y tres estados: `abierto`,
    `resuelto` (lo confirma el cliente o lo marca una persona con motivo) y `en_revision`.
  - **El silencio nunca resuelve un caso.**
- **Lo que necesita un ADR propio:** el plan pide que la IA lea los chats de casos gestionados fuera del CRM y los
  siga hasta su resolución. Eso requiere acceso al sistema donde viven esos chats y reglas de contacto. Ese ADR parte
  del flujo de casos de postventa que ya existe fuera de R4 (Contexto) y no lo duplica.

## Decisión 10 — Identidad del contacto y segmento con evidencia (camino A)

- **Tres claves, normalizadas con reglas fijas y sin modelo:**
  - **celular:** formato chileno `+569XXXXXXXX`;
  - **correo:** en minúsculas y sin espacios;
  - **RUT:** sin puntos, con guion y con el dígito verificador comprobado.

  Un valor que no pasa la regla no es clave: se guarda como dato, pero no une a nadie.
- **El contacto de la mesa es un conjunto de claves.** Con ellas se une:
  - las conversaciones de R4, por su clave opaca;
  - las cuentas y pedidos de la tienda;
  - los documentos de SAP, cuyo código de cliente lleva el RUT.
- **Cuándo se unen dos registros solos:**
  - comparten una clave;
  - y esa clave no es compartida, es decir, no aparece en más de N cuentas. N es configuración; el valor inicial
    propuesto es 3.

  Las claves compartidas, como el teléfono de la tienda o un RUT de relleno, nunca unen. Se listan para que una
  persona las revise.
- **Los RUT y códigos genéricos de «venta general» no son claves.** Son el RUT que se usa cuando el cliente no da
  el suyo y los códigos de consumidor final de SAP. Se declaran en una lista explícita en la configuración de la
  mesa, no en este repositorio. Nunca unen ni dan segmento.
  - Un pedido o documento con ese RUT se une solo por correo o celular.
  - Si no los tiene, se une por la referencia del pedido.
  - El umbral de clave compartida queda como red de seguridad para los genéricos que falten en la lista.
- **Unir es reversible.** Cada unión es un evento append-only con su clave y su regla. Separar es otro evento. Nunca
  se borran ni se editan los registros de origen en la tienda o en SAP.
- **El segmento se guarda con su evidencia:** valor, fuente, fecha y nivel. Gana el nivel más alto. A igual nivel,
  gana el más reciente:
  1. **Una persona lo confirmó.**
  2. **Evidencia de los sistemas:**
     - factura de la tienda a un RUT de persona jurídica;
     - documento de SAP a un RUT de persona jurídica;
     - un RUT en el rango de entidades del Estado o municipalidades (indicio institucional);
     - volumen: varios documentos o líneas de muchas unidades (indicio mayorista).
  3. **Lo dicho en la conversación**, leído por Pesín.
  4. **Sin segmento.** Se completa en el próximo contacto.

  Los indicios mayorista e institucional dejan al contacto como **candidato** hasta que una persona confirme o el
  owner fije la regla (decisión abierta 4). Una persona jurídica sin más indicios es «empresa».
- **Camino A: la mesa guarda lo mínimo y es transitoria como maestro.**
  - La mesa guarda solo los contactos que tienen oportunidades: claves, uniones, segmento con evidencia y vínculo
    con un vendedor.
  - La historia se carga una vez, de solo lectura, desde la tienda y SAP. Solo trae la evidencia que necesitan las
    oportunidades.
  - El maestro de clientes sigue siendo el diseño de identidad (CIA) y perfil de cliente (CP). Hoy no están
    desplegados. Cuando lo estén, la mesa les entrega claves y uniones y pasa a leerlos.
  - La tabla de contactos de la mesa queda documentada como deuda acotada hasta ese momento.
- **El historial de vendedores en SAP puede sembrar el cliente de cabecera** de ADR-048. Si se usa, aplica la misma
  regla de 90 días desde la última venta. Decidirlo le corresponde al owner (decisión abierta 9).

## Decisión 9 — Medición

- **La mesa ofrece una lectura agregada para la consola**, que ya lee R4. Mide por origen, canal, segmento, pool y
  dueño:
  - oportunidades abiertas y cerradas;
  - tiempo hasta la primera respuesta humana;
  - porcentaje con próxima acción vencida;
  - conversión;
  - monto ganado;
  - motivos de pérdida;
  - correcciones de la clasificación.
- **Satisfacción:** una encuesta al cerrar. La mesa es su dueña (ADR-048 Decisión 1). Llega en una fase posterior.
- **Pesín y las personas se miden por separado.** El vendedor no ve métricas del tipo «Pesín atendió X» (ADR-048
  Decisión 4).
- **Primero se mide la línea base.** Las metas se fijan después, como pide el plan.
- **Medida de adopción:** porcentaje de oportunidades con próxima acción vigente y uso diario de «Hoy». La meta
  final es retirar el sistema actual. Si los vendedores siguen en él, el CRM no está cumpliendo.

## Cambios en R4

- **R4 Core:**
  - **No hay primitivas nuevas.** Se usan dos cambios genéricos ya propuestos en ADR-048:
    - C-3: motivo de traspaso estructurado;
    - C-4: feed de eventos con cursor hacia adelante y `eventId` estable.
  - **Sin C-4, la mesa no puede reconciliar** de forma confiable lo que perdió durante una caída. En la fase O1
    puede funcionar porque la capacidad escribe directo, pero C-4 es requisito antes de O2.
- **Paquete Sales:**
  - **Una capacidad `desk.opportunity.record`**, escritura gobernada hacia la API de la mesa:
    - lleva el origen, la clasificación de la Decisión 3 y las referencias;
    - su clave de idempotencia es la conversación más la fuente;
    - deja un recibo;
    - la política de acciones la permite en autónomo, porque registra y no mueve dinero.
  - **Se declara en una versión nueva de cada perfil** que la use, como variante (ADR-054) y con su evaluación. La
    evaluación mide intención y segmento contra un set etiquetado, y se entrega junto con la implementación.
- **Los conceptos «oportunidad», «pool» y «motivo de pérdida» viven en la mesa y en el paquete Sales**, nunca en
  Core.

## Seguridad y datos personales

- **La mesa guarda datos personales:** contactos de tienda, leads de anuncios y las tres claves de la Decisión 10.
  Por eso vive en su repositorio privado. Guarda solo los contactos con oportunidades, no copia la base completa.
  La carga inicial usa una credencial de solo lectura. Este repositorio es público: aquí no van datos personales, montos reales ni nombres de vendedores.
- **La mesa usa un usuario de base de datos con permisos mínimos**, no el superusuario (lección de la brecha S-1).
- **La lectura de pedidos usa la clave de solo lectura de ADR-061.** La brecha S-2 (llave de pedidos) se cierra
  antes de la fase O2.
- **La salida del modelo se valida contra listas cerradas.** El resumen se muestra como sugerencia de Pesín.
- **Retención:** cuánto tiempo se guardan los datos de una oportunidad perdida es decisión del owner, con la
  revisión legal (D-17).

## Fases (cada una requiere autorización del owner)

- **O0. Diseño:** este ADR y el contrato de la API de la mesa. Sin código.
- **O1. MVP útil.**
  - **Qué incluye:**
    - oportunidades e historia en la mesa;
    - el contacto con sus claves normalizadas, uniones y segmento con evidencia (Decisión 10);
    - la carga inicial de evidencia de solo lectura desde la tienda y SAP;
    - creación desde consultas, traspasos y cotizaciones emitidas;
    - dueño, estado y próxima acción obligatoria;
    - «Hoy» y los motivos de pérdida;
    - `ganada` manual con referencia;
    - conteos simples en la consola;
    - la capacidad `desk.opportunity.record` con su evaluación.
  - **Gate:**
    - primero en QA, con conversaciones de prueba del owner;
    - la precisión de la clasificación debe alcanzar el umbral que fije el owner;
    - cero oportunidades abiertas sin próxima acción.
- **O2. Resultado automático:**
  - `ganada` desde los pedidos pagados, con reversa;
  - la evidencia web de ADR-059 A1.

  Requiere el conector de ADR-061, S-2 cerrada y C-4.
- **O3. Equipo real:**
  - pools con vendedores reales;
  - avisos y escalamiento (fase 2 de ADR-048);
  - captura en tienda;
  - criterios de mayorista e institucional.
- **O4. Apoyo de Pesín:**
  - mensajes sugeridos;
  - leads de anuncios de Meta;
  - encuesta de satisfacción;
  - casos de postventa y servicio técnico (Decisión 8).
- **Fuera de estas fases, cada uno con su propio ADR:**
  - el seguimiento autónomo de Pesín;
  - el monitoreo de chats externos de postventa.

## Fuera de alcance

- Tableros para arrastrar tarjetas, campos personalizados, campañas de correo y fichas de contacto editables a mano.
- Importar el historial del sistema actual. Se decide en la migración del número (ADR-048 fase 3).
- Cotizar (lo hace Quote), ejecutar postventa y calcular comisiones.
- El POS y el Gym Planner del plan comercial.

## Consecuencias

- **Un solo lugar** para ver cada oportunidad, quién es su dueño y qué sigue. El resultado sale de la evidencia, no
  de lo que alguien escribió.
- **La línea base para las metas** sale del sistema y no de una planilla.
- **Costo:** algunas tablas más en la mesa y una escritura más por oportunidad. No hay llamadas extra al modelo, pero
  cada perfil que registre oportunidades necesita una versión nueva con su evaluación.
- **Riesgo de adopción:** se vigila con la medida de adopción de la Decisión 9. Si «Hoy» no se usa, se corrige antes
  de sumar fases.

## Decisiones del owner (2026-11-25)

- **Estados:** los cinco propuestos. Nueva, en gestión, cotizada, ganada o perdida.
- **Reparto dentro de un pool:** autoasignación desde un pozo común, como dice el plan comercial. Las reglas 1 a 3 de
  ADR-048 van antes, y hay aviso al supervisor si nadie la toma en el plazo (Decisión 4).
- **Mayorista e institucional:** los indicios de los sistemas dejan al cliente como candidato y una persona lo
  confirma. Nada cambia de pool solo (Decisión 10).
- **Umbral:**
  - Pesín cotiza solo hasta $1.000.000; sobre ese monto la oportunidad pasa al pool;
  - el armador de home gym del chat web sigue proponiendo sets de cualquier monto, pero sobre $1.000.000 ofrece
    pasar a un vendedor;
  - el límite de cotización autónoma de R4 (`R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP`) se ajusta a ese monto, con
    autorización propia.
- **Motivos de pérdida:** se parte en QA con la lista propuesta (Decisión 5) y se ajusta con el equipo de ventas
  antes de producción.
- **Plazos:**
  - una próxima acción no puede quedar a más de 3 días;
  - cuando vence, se avisa al dueño;
  - si sigue vencida 4 horas, se avisa al supervisor.
- **Cliente de cabecera:** se siembra con el vendedor de las ventas SAP de los últimos 90 días, con la misma regla
  de ADR-048. Lo más antiguo no crea vínculo.
- **Clave compartida:** una clave que aparece en más de 3 cuentas no une sola; la revisa una persona.

## Decisiones abiertas del owner

1. Los pools iniciales, quién está en cada uno y quién supervisa (coincide con las decisiones abiertas 2 y 5 de
   ADR-048).
2. La lista de RUT y códigos genéricos de «venta general». Va en la configuración de la mesa, no en este
   repositorio.
3. La lista final de motivos de pérdida, acordada con Ventas.
4. La retención de los datos personales de oportunidades perdidas.
