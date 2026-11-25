# ADR-048 — Mesa de ventas: servicio de dominio para derivar, asignar y atribuir conversaciones a vendedores

- **Identificador:** `R4-SALES-DESK-01`
- **Estado:** **En producción por partes.** La fase 1 está hecha y partes de la fase 2 están en producción, cada una
  con autorización del owner. Los cambios en Core C-1 a C-4 no están implementados. La revisión 2 registra el estado
  real. Lo pendiente sigue necesitando autorización explícita del owner, fase por fase y cambio por cambio.
- **Fecha:** 2026-11-18
- **Revisión 1 (2026-11-18):** cobertura cuando el vendedor dueño no está en turno (Decisión 3), protección por
  cotización y catálogo de casos de conflicto (Decisión 4), aviso no bloqueante en el chat web (Decisión 5) y
  evidencia de venta en el chat web (Decisión 8).
- **Revisión 2 (2026-11-25):** qué está hecho y qué falta, qué decisiones cambiaron otros ADR (049, 050, 053, 055,
  056, 057, 059, 060 y 062), qué significan las secciones apagadas de la consola y las brechas de seguridad que siguen
  abiertas. También alinea el reparto con el plan comercial omnicanal del owner («Don Pesin · Plan Comercial
  Omnicanal», 2026-11-24, fuera del repositorio): pools con autoasignación, sin comisiones por ahora, y metas por
  vendedor medidas desde su onboarding. Pedido del owner del 2026-11-25. Ver la sección «Revisión 2».
- **Mandato:** owner, 2026-11-18: diseñar una plataforma robusta que reemplace al proveedor de atención actual
  (menú de áreas y bandeja de agentes humanos) para WhatsApp y el chat web.
- **Autoridad superior:** Constitución; PRD §17 (operador humano) y §19 (canales); ADR-029 (entrega gobernada);
  ADR-033 (identidad de operadores, OIDC); ADR-041 (avisos de plataforma ante fallas); ADR-042 (colaboración
  con el owner); ADR-045 (carril de conversación); ADR-046 (canal web); ADR-047 (cierre por inactividad);
  auditoría R4-I CRM/WhatsApp (D-1: número productivo).

## Revisión 2 — estado al 2026-11-25

El resto del documento se conserva como se decidió. Esta sección dice qué rige hoy. Si una decisión de abajo choca con
un ADR posterior, rige el posterior, como indica la tabla de cambios.

### Lo que está en producción

- **La mesa de ventas** es un servicio propio, fuera de R4 Core y con base de datos propia (Decisión 1), en
  producción desde el 2026-11-23. Su base guarda:
  - vendedores con rol (`seller`, `supervisor` o `admin`);
  - áreas y la relación vendedor ↔ área;
  - disponibilidad;
  - un registro append-only de asignaciones (`offered`, `accepted`, `declined`, `replied`, `released`, `withdrawn` y
    `answered`). Es la base del libro de la Decisión 4, todavía sin atribución.
- **La app Ventas** (Decisión 7) muestra la bandeja y los casos del vendedor, y «Pesín te consulta» (ADR-056). Permite
  tomar, responder y soltar, y muestra si el visitante web sigue en el chat.
- **Cada acción va a nombre de una persona.** Se firma con la identidad del operador (ADR-050), nunca con una cuenta
  compartida (Decisión 2). El nombre de la persona llega al cliente desde el registro de operadores (Decisión 5,
  implementada el 2026-11-20).
- **CRM en la mesa** (ADR-062, en producción desde el 2026-11-25):
  - oportunidades con dueño, estado, próxima acción y resultado;
  - la pantalla «Oportunidades» de la consola;
  - Pesín las registra en la mesa desde el chat web (`sales-web@21`) y desde WhatsApp (carril `@27`, en despliegue el
    2026-11-25).
- **Operadores:** desde el 2026-11-25, la consola invita y da de alta personas con sus ámbitos (sección «Operadores»).
  Hoy el único operador que responde es el owner.

### Lo que cambiaron otros ADR

| Esta decisión | Lo que rige hoy |
|---|---|
| D3, regla 5 («nadie disponible»: el agente promete un plazo), y D6 (modelo lento → cola humana) | **ADR-056:** consultas al equipo sin pausar la conversación. El vencimiento es de 30 minutos en horario; fuera de él, la próxima apertura más 30 minutos, con tope en la ventana de WhatsApp. Si nadie responde, el cliente recibe un aviso |
| D5: el chat web ofrece avisar por correo o WhatsApp, y la decisión abierta 3 | **ADR-057:** la conversación del chat web no se pierde al cerrar la ventana. El aviso por correo es su fase C5, que espera autorización |
| D5: no se unen contactos entre canales hasta que exista CIA | **ADR-053:** un agente por canal. Los vínculos entre contactos y personas no necesitan CIA, y no hay inicio de sesión automático |
| D5: los canales son WhatsApp y el chat web | Hay además **Instagram y Facebook** (ADR-060), cada uno con su agente y con la ventana de 24 horas de Meta |
| D5: mensajes por iniciativa propia, fuera de 24 horas | **ADR-055** (propuesto): ventanas, plantillas y reglas de contacto |
| D8 y la decisión abierta 8 (venta asistida y grupo de control) | **ADR-059** (aceptado el 2026-11-24): la venta de Pesín es una línea de la ficha del chat, pagada y que coincide, con un rescate de 7 días. La venta asistida se mide aparte y no da comisión. **No hay grupo de control** |
| D7: roles OIDC `admin`, `supervisor` y `vendedor` | En R4, ámbitos por operador (ADR-050). En la mesa, los roles `seller`, `supervisor` y `admin` |
| D3, regla 4 (oferta rotativa dentro del área, con SLA) | **ADR-062 y el plan comercial** (owner, 2026-11-25): cada pool tiene un **pozo común con autoasignación**. Quien toma la oportunidad queda como responsable único, con un tope de 15 abiertas por vendedor. Si nadie la toma en 10 minutos, la mesa avisa al dueño del pool y luego al supervisor |
| Los pools | **Plan comercial:** cinco pools, que son las áreas de la mesa: ventas general, mayoristas, institucionales, postventa y servicio técnico. Pesín clasifica por intención, monto, segmento y complejidad. Lo que no resuelve dentro de su alcance va como solicitud al pool que corresponde |
| D4: atribución y comisión | **Comisiones fuera de alcance por ahora:** el plan comercial no las define. Las **metas por vendedor** del plan se medirán desde el onboarding de los vendedores en la app Ventas (owner, 2026-11-25). Para eso basta el libro de quién tomó, quién cotizó y qué se pagó, sin reglas de comisión |

### Los cambios en Core: ninguno está hecho

| Cambio | Estado | ¿Lo pide el plan comercial? |
|---|---|---|
| **C-1.** Puerto de ruteo antes del agente | No existe | **No.** En el plan, Pesín atiende primero y clasifica cada conversación |
| **C-2.** Referencia de entrada persistida | No existe | **No.** El plan no usa link ni QR personal por vendedor (regla 1) |
| **C-3.** Motivo estructurado del traspaso | No existe; el traspaso lleva solo texto (ADR-062 lo confirma) | **Sí.** Es lo que manda cada solicitud al pool correcto. Por ejemplo, «≥ $1M o proyecto» va a ventas general y un distribuidor va a mayoristas |
| **C-4.** Feed de eventos con cursor | Parcial: `/v1/events` lista hacia atrás, sin cursor hacia adelante | **Para medir las metas.** La mesa necesita el libro sin perder eventos desde el onboarding de los vendedores |

**El reparto que rige es el del plan comercial:** pools por intención, pozo común y autoasignación.
- Las reglas 1 a 3 de la Decisión 3 (link o QR, cliente de cabecera, «quiero hablar con fulano») quedan escritas
  en ADR-062, pero el plan no las pide.
- El **cliente de cabecera** sí sirve para la continuidad: si vuelve un cliente con una oportunidad abierta, la ve su
  mismo responsable. Esto se resuelve en la mesa, sin C-1.
- C-1 y C-2 quedan solo para cuando el owner quiera links personales.

### Las secciones apagadas de la consola

La consola muestra cuatro secciones desactivadas con la marca «ADR-048». Están diseñadas en el lienzo de la consola y
no construidas, porque dependen de lo que falta.

| Sección | Qué será | Qué le falta |
|---|---|---|
| **En vivo** (Mesa de ventas) | El pozo de cada pool, lo que nadie ha tomado y su tiempo, y quién está disponible | C-3 para mandar al pool, y vendedores reales dados de alta |
| **Reglas y equipo** (Mesa de ventas) | Vendedores, pools, turnos, tope por vendedor y plazo | Decisiones abiertas 2 y 5: quiénes son, en qué pools y quién supervisa |
| **Atribución** (Mesa de ventas) | Quién tomó, quién cotizó y qué se pagó, por vendedor, para las metas del plan. Sin comisiones por ahora | El onboarding de los vendedores en la app Ventas, C-4 y ADR-059 para el chat web |
| **Contacto con clientes** | Mensajes por iniciativa propia: avisos, seguimientos y plantillas | ADR-055, propuesto y no implementado |

### Decisiones abiertas, al día

- **Cerradas por otros ADR:**
  - la 3, por ADR-057: correo, con su fase C5 pendiente;
  - la 8, por ADR-059.
- **Siguen abiertas:**
  - la 1, comisiones y fondo de equipo: fuera de alcance por ahora, porque el plan comercial no las define;
  - la 2, vendedores, pools y turnos, con el onboarding de los vendedores en la app Ventas;
  - la 4, el repositorio de la mesa: la mesa está en un repositorio propio y en el mismo host. Falta confirmar que el
    repositorio sea privado;
  - la 5, quién supervisa el SLA;
  - la 6 y la 7, los casos K-3 y K-9.
- **La fase 3:** el proveedor actual es **Zenvia** y sigue en uso. El plan comercial lo retira en su fase 6
  («omnicanalidad»), cuando se valide la continuidad. Mientras tanto aplica el bloqueante D-1, y la fecha del corte es
  decisión del owner.
- **Decisiones nuevas que trae el plan comercial (owner):**
  - **Cupón de 10 % en la primera compra**, para quien muestra interés y no cierra. Choca con la decisión vigente de
    no ofrecer descuentos. Pesín no lo ofrece hasta que el owner lo active y defina su vigencia y exclusiones.
  - **Pesín vende hasta $1M por cotización.** Hay que alinear este tope con los límites de cotización que Pesín tiene
    hoy.

### Brechas de seguridad abiertas

Las brechas **S-1 a S-3** del ADR-049 («Brechas de seguridad previas al despliegue productivo») siguen abiertas, y el
owner las pospuso:
- `r4-api`, y también gateway, workers y scheduler, usan el rol superusuario de la base de producción;
- las llaves del webservice de PrestaShop no se limitan por orden.

La mesa y la consola ya están en producción sobre esa base, así que estas brechas son un pendiente vigente, no un
requisito futuro. Cerrarlas necesita la decisión del owner (ADR-049, decisión abierta 5).

### Próximo paso recomendado

1. **El onboarding de los vendedores en la app Ventas,** con sus pools. Desde ahí se miden las metas del plan.
2. **C-3, el motivo estructurado del traspaso:** cada solicitud llega al pool correcto. Es un cambio genérico de Core,
   con su propia autorización.
3. **C-4, el feed con cursor,** para que el libro de atribución no pierda eventos.

C-1 y C-2 no son necesarios para el plan comercial.

## Contexto

Hoy la atención humana pasa por un proveedor externo que funciona como un bot determinista: el cliente elige un
área en un menú y la conversación cae en la bandeja de esa área. Si nadie la toma, nadie responde. La
satisfacción declarada por los clientes es muy baja (dato del owner, fuera de este repositorio). Las comisiones
siguen a quien recibe la conversación, así que la derivación decide quién cobra.

R4 debe reemplazarlo con dos condiciones. El cliente nunca queda sin respuesta. La derivación a un vendedor debe
ser justa, explicable y auditable, porque reparte comisiones.

Hechos verificados en el código (`main` `278cc6b`):

1. **El traspaso a humanos ya existe y es genérico.** El agente puede pedirlo (`request_handoff`, con `summary`
   y `contextRefs`). Un operador puede tomar la conversación sin que el agente lo pida
   (`POST /v1/tasks/:id/handoff`). El pedido tiene un ciclo durable: `requested → active → released`, además de
   `cancelled` y `expired`.
2. **El operador ya puede responder.** `POST /v1/tasks/:id/operator-messages` toma la conversación si hace
   falta, reemplaza los envíos pendientes del agente y encola el texto con `responseKey` idempotente. Los envíos
   tienen seguimiento y resolución de resultado desconocido (`/v1/outbound/:id`, `resolve`, `cancel`).
3. **Hay vistas de atención.** `GET /v1/attention`, `/v1/production/attention` y
   `/v1/production/conversations`, más controles de producción (`/v1/production/controls`).
4. **Las fallas ya terminan en un humano.** Un run fallido se entrega a un humano con el aviso del paquete
   (ADR-041), y un caso inactivo se cierra a las 24 h (ADR-047).
5. **Faltan tres piezas, y las tres son genéricas.**
   - No hay forma de decidir *antes* de correr el agente que una conversación va directo a una persona.
   - `ingest()` no persiste metadatos del inbound, así que no sobrevive la referencia de un link o código QR
     (ADR-046, hecho 4).
   - El pedido de traspaso no lleva un motivo estructurado, solo texto libre.
6. **Core no puede contener conceptos de venta** (AGENTS.md). Vendedor, área, cartera y comisión son dominio.

## Decisión 1 — La mesa de ventas es un servicio de dominio, fuera de R4 Core

Se crea un servicio nuevo, la **mesa de ventas**, con base de datos propia, al lado de Catalog, Quote y Checkout.
R4 no aprende qué es un vendedor ni una comisión. Solo ve principals humanos, pedidos de traspaso y motivos
declarados por el paquete.

| La mesa de ventas es dueña de | R4 sigue siendo dueño de |
|---|---|
| Vendedores, roles, áreas, turnos, disponibilidad | Conversación, carril, tareas y runs |
| Reglas de asignación, colas, SLA y reasignación | Ciclo del traspaso (`requested/active/released`) |
| Cartera: vínculo cliente ↔ vendedor y su vigencia | Entrega por canal, idempotencia y seguimiento |
| Catálogo de motivos de derivación → área | Avisos de plataforma (ADR-041) y cierre (ADR-047) |
| Libro de atribución y reglas de comisión (versionadas) | Identidad de operadores (OIDC, ADR-033) |
| Encuesta de satisfacción y sus resultados | Evidencia: steps, observaciones y transiciones |

**Ubicación recomendada:** un repositorio **privado** propio. Este repositorio es público, y la mesa guarda datos
personales de vendedores y reglas de comisión. Aquí solo quedan este ADR y los contratos genéricos del lado R4.

## Decisión 2 — Contrato entre R4 y la mesa

La comunicación es determinista y sin modelo. La mesa nunca escribe en tablas de R4, y R4 nunca lee las de la
mesa.

**R4 → mesa (eventos).** R4 publica un feed de eventos de conversación con cursor, entrega al menos una vez y un
`eventId` estable para deduplicar. Eventos mínimos:

- conversación abierta, con canal, clave opaca del contacto y referencia de entrada (cambio C-2);
- traspaso pedido, con `reasonCode` (cambio C-3) y resumen;
- traspaso activo (quién lo tomó), liberado, cancelado o expirado;
- mensaje enviado por un humano;
- cotización emitida y link de pago enviado, como observaciones de capabilities con su referencia de dominio.
  Los montos no viajan en el evento: la mesa los lee de Quote o Checkout;
- caso cerrado.

**Mesa → R4 (acciones).** La mesa usa la API de operador que ya existe. Las acciones llevan la identidad del
vendedor (token OIDC del vendedor desde la app, ADR-033), nunca una cuenta compartida. Así, cada acción queda a
nombre de una persona:

- tomar (`handoff`), responder (`operator-messages`), devolver al agente (liberar el traspaso);
- la asignación automática no toma la conversación: la ofrece al vendedor. La conversación pasa a `active`
  solo cuando él la acepta en la app.

**R4 → mesa (ruteo de entrada, cambio C-1).** Antes de correr el agente, el gateway pregunta a un puerto de ruteo
genérico: «¿esta conversación va al agente o a un humano?». La respuesta es `agent` o `human(principalRef)`. El
plazo es corto (≤ 1 s). Si no hay respuesta o hay error, gana `agent`, con una marca para que la mesa reconcilie.
El cliente nunca queda sin respuesta por una caída de la mesa.

## Decisión 3 — Reglas de asignación, en orden

La primera regla que aplica decide. Toda decisión queda en el libro de la mesa con la regla que la produjo.

1. **Entrada directa a un vendedor.** El cliente llegó por el link o QR personal de un vendedor (referencia de
   entrada, C-2). La conversación va a ese vendedor sin pasar por el agente. Si el vendedor no está en turno, el
   agente atiende con un aviso: «{nombre} te responde al volver, {hora}». La conversación sigue reservada para
   ese vendedor.
2. **Cliente de cabecera.** El contacto tiene un vínculo vigente con un vendedor (90 días desde la última venta o
   atención; decisión del owner, 2026-11-19). Mismo trato que la regla 1. **El vínculo nunca se reasigna
   solo.** Se libera solo si el vendedor lo suelta, si un supervisor lo mueve con motivo, o si vence el periodo.
   Una cotización vigente emitida por un vendedor crea o renueva este vínculo.
3. **El cliente pide a alguien por nombre.** La mesa compara el texto con el directorio de nombres visibles de los
   vendedores, de forma exacta y sin modelo. Si hay una coincidencia única, aplica la regla 1. Si no, el caso
   sigue a la regla 4.
4. **Motivo → área.** El `reasonCode` del traspaso se mapea a un área: cotización por volumen, empresa o
   factura, instalación o técnico, postventa o garantía, reclamo, «quiero hablar con una persona», el agente no
   pudo resolver, o falla de plataforma. Dentro del área se ofrece por turno rotativo entre los disponibles.
   Si nadie acepta dentro del SLA (10 min, decisión del owner), se ofrece al siguiente y se avisa al supervisor.
5. **Nadie disponible.** El agente sigue atendiendo lo que puede, promete un plazo concreto y deja el caso en la
   cola del próximo turno. **Nunca hay silencio.**

El agente no elige vendedor ni área. Solo pide el traspaso con un motivo del catálogo. El modelo es cognición no
confiable, y la asignación reparte dinero.

**Precedencia entre las reglas 1 y 2.** Decidida por el owner (2026-11-19): **gana el vínculo vigente**. Un
cliente con vínculo con un vendedor puede llegar por el link de otro, y sigue con el vendedor del vínculo. El link
solo decide para contactos sin vínculo. Así nadie gana clientes ajenos repartiendo su link.

### Cobertura: ser dueño del cliente no es lo mismo que atenderlo ahora

Las reglas 1 y 2 reservan el cliente para un vendedor. Si ese vendedor no está en turno, esperar al próximo turno
puede costar la venta. Caso tipo: el vendedor cotiza y envía el link de pago, y el cliente responde al día
siguiente, cuando el vendedor no trabaja. La mesa separa dos cosas: **el vínculo** (de quién es el cliente y la
venta) y **la atención** (quién responde ahora).

1. **El agente responde de inmediato.** Si lo que pide el cliente no necesita una persona (pagar con el link ya
   enviado, reenviarlo, un plazo de despacho), el agente lo resuelve. El vínculo no cambia.
2. **Si hace falta una persona, el cliente elige.** El agente ofrece dos opciones con un texto fijo: esperar a su
   vendedor, con la hora de regreso, o que lo atienda otra persona ahora. La elección queda en el libro.
3. **Si elige a otra persona, el caso se ofrece por la regla 4 «en cobertura».** Quien lo toma ve la cotización
   vigente y a quién pertenece la venta antes de responder. El vínculo sigue siendo del vendedor original.
4. **Ausencias planificadas** (vacaciones, licencias): el supervisor designa la cobertura por adelantado y el
   agente no ofrece esperar.
5. **El SLA no mueve el vínculo.** Si el dueño está en turno y no responde dentro del SLA, la mesa ofrece
   cobertura y avisa al supervisor. No reasigna el cliente.

La atribución de una venta atendida en cobertura se define en la Decisión 4.

## Decisión 4 — Atribución y comisión

- **Libro de atribución append-only** en la mesa. Se construye con los eventos de R4 (quién tomó, quién cotizó,
  quién envió el link de pago) y con el pago confirmado por Checkout. Nunca se edita. Las correcciones son
  asientos nuevos con autor y motivo.
- **Regla base recomendada: protección por cotización.** Mientras una cotización emitida por un humano esté
  vigente, la venta que la paga se atribuye a quien la emitió, aunque otra persona envíe el link de pago o
  atienda en cobertura. La protección termina cuando vence la cotización. Las ventas que cierra solo el agente
  van a un fondo de equipo, no a una persona.
- **Cobertura.** Quien atiende en cobertura sin cambiar la cotización queda registrado como cobertura, y la
  venta sigue siendo del dueño. Si tiene que emitir una cotización nueva con cambios de fondo, se aplica un
  reparto definido en la regla versionada (decisión abierta 6). La app pide el motivo antes de cotizar de
  nuevo.
- **Aporte mínimo.** Tomar un caso no atribuye por sí solo: hace falta una cotización o un link de pago emitidos
  por esa persona.
- **Aviso antes del conflicto.** Antes de cotizar, la app muestra si el contacto tiene una cotización vigente de
  otro vendedor.
- **Reversa.** Una devolución o anulación revierte la atribución con un asiento nuevo.
- **Las reglas son configuración versionada**, decidida por el owner. Los porcentajes no viven en este
  repositorio. Cada asiento guarda la versión de la regla con que se calculó.
- **Libro en sombra primero.** En la fase 2 se calcula sin pagar y se compara con el cálculo manual. Recién
  después se usa para liquidar (fase 4).
- **En las disputas decide el owner o quien él designe.** El sistema muestra la evidencia, pero no juzga.
- **Lo que ve el vendedor:** sus casos, sus ventas atribuidas y su posición en el equipo. No ve métricas del
  agente del tipo «el agente atendió X conversaciones».

### Casos de conflicto (catálogo de prueba de las reglas)

Cada versión de las reglas de asignación y atribución se ejecuta contra este catálogo antes de activarse. Un
caso nuevo que aparezca en una disputa se agrega aquí. Las filas marcadas «abierta» esperan decisión del owner.

| # | Caso | Resultado esperado |
|---|---|---|
| K-1 | El vendedor cotiza y envía el link. El cliente vuelve cuando el vendedor no está en turno y paga ese link | Venta del vendedor que cotizó. El agente atiende; nadie más interviene |
| K-2 | Igual que K-1, pero el cliente necesita una persona y elige no esperar | Otra persona atiende en cobertura. Si paga la cotización original, la venta es de quien cotizó |
| K-3 | En cobertura hace falta una cotización nueva con cambios de fondo | Reparto según la regla versionada (abierta, decisión 6) |
| K-4 | Dos vendedores cotizan al mismo contacto | El segundo ve el aviso de cotización vigente. Si igual cotiza, la venta es de la primera cotización vigente que se pague |
| K-5 | Un vendedor cotiza y otro envía el link de pago de esa cotización | Venta de quien cotizó |
| K-6 | El vendedor cotiza y el cliente compra en la tienda sin usar el link | Venta del vendedor si el pedido coincide de forma exacta en contacto (teléfono o correo) y en productos, dentro de la vigencia. Sin coincidencia exacta no se atribuye |
| K-7 | Un contacto con vínculo vigente llega por el link de otro vendedor | Gana el vínculo vigente (decisión del owner, 2026-11-19) |
| K-8 | El vendedor toma el caso, no responde y el cliente compra con el agente | Sin atribución a la persona (aporte mínimo) |
| K-9 | El agente hizo todo el trabajo y el cliente pide una persona solo para pagar | Queda para después (owner, 2026-11-19; decisión abierta 7) |
| K-10 | Devolución o anulación de un pedido atribuido | Asiento de reversa |
| K-11 | El cliente pide cambiar de vendedor | Se respeta al cliente. El supervisor mueve el vínculo con ese motivo |
| K-12 | El vendedor deja la empresa con clientes vinculados | Los vínculos pasan al supervisor hasta que el owner decida. No se reparten solos |

## Decisión 5 — Multicanal: la conversación se queda en su canal

- **El humano entra a la misma conversación**, en el mismo canal. No se redirige al cliente a otro número ni a
  otra app. El cliente ve un aviso del tipo «{nombre}, del equipo de ventas, se unió».
  - **De dónde sale el nombre** (implementado el 2026-11-20). Del registro de operadores de R4 (ADR-050,
    `displayName`) para el operador que firmó la acción, nunca de un texto del pedido. R4 lo guarda con el mensaje
    (`outbound_messages.author_name`) y el canal que puede mostrar un autor lo recibe; el chat web lo muestra.
  - **WhatsApp no puede mostrar un autor:** todo sale desde el número de la empresa. El primer mensaje de cada persona
    en una conversación viene con «Hola, soy {nombre}, del equipo de ventas.» ya escrito, y la persona puede editarlo.
- **Chat web.** Un visitante anónimo que cierra la pestaña no se puede volver a ubicar. Por eso, al pedir el
  traspaso, el agente ofrece avisarle por correo o WhatsApp si se va antes de la respuesta. La pregunta es
  opcional y no detiene el traspaso. No se hace si el cliente tiene sesión iniciada en la tienda o si hay una
  persona disponible en ese momento. El aviso dice solo «tienes una respuesta» y lleva de vuelta al chat. Se
  guarda el consentimiento.
- **WhatsApp.** Pasadas 24 h desde el último mensaje del cliente, solo se puede escribir con una plantilla
  aprobada por Meta, por ejemplo una para retomar la conversación. La app lo indica y no deja enviar texto
  libre fuera de esa ventana.
- **Identidad entre canales.** No se unen contactos de forma automática hasta que exista CIA en producción. La
  mesa puede *sugerir* una unión (por ejemplo, el mismo correo en dos canales), y un humano la confirma o la
  descarta.

## Decisión 6 — Robustez: cada falla tiene un comportamiento definido

| Falla | Comportamiento |
|---|---|
| Modelo lento (> 25 s sin respuesta) | Mensaje fijo de espera, un reintento y después cola humana con aviso (familia de ADR-041) |
| Proveedor de modelo caído | **Modo humano:** control de producción que manda cada inbound a la cola, con aviso fijo al cliente |
| Mesa de ventas caída | R4 sigue con el agente. Los traspasos quedan `requested` en R4 (durable) y la mesa los toma al volver. Asignar es idempotente |
| Meta o el webhook fallan | Dedupe por id de mensaje, salida durable y resolución de resultado desconocido (ya existe). Nunca se reenvía a ciegas |
| Reinicio de procesos | Todo el estado vive en Postgres. No hay colas en memoria |
| El vendedor no responde | El SLA reasigna y avisa al supervisor. En las reglas 1 y 2 ofrece cobertura sin mover el vínculo |
| Host único (EC2) | Respaldo de base de datos verificado, chequeo de salud externo y alertas. Más infraestructura solo con necesidad demostrada |
| Errores recurrentes | Se registran como incidentes en la consola para que el owner decida si abrir una revisión. Nada se corrige solo en producción |

## Decisión 7 — Una aplicación web con dos caras

- **Consola** (administración): mapa de agentes, conversaciones con traza, incidentes, colas, reglas,
  vendedores, reportes y libro de atribución.
- **Ventas** (vendedores, pensada para el celular, instalable con notificaciones push): bandeja, conversación,
  cotizar, link de pago, devolver al agente, disponibilidad y mis ventas.
- Usa la API de R4 y la API de la mesa. No usa ni importa nada del CRM.
- **Roles OIDC:** `admin`, `supervisor`, `vendedor`. Un vendedor ve solo sus casos y la cola de sus áreas. Los
  datos de contacto aparecen enmascarados fuera de sus propios casos.
- Subdominio genérico mientras no haya dominio propio.

## Decisión 8 — Evidencia de venta en el chat web

En WhatsApp la evidencia de una venta es el link de pago que envía el agente o el vendedor. En el chat web el
visitante agrega productos al carrito de la tienda desde la ficha del chat y paga en el checkout de la tienda
(ADR-046: R4 no tiene autoridad de carrito). No hay link, así que la evidencia sale del origen (la tienda):

| Nivel | Qué pasó | Cómo se sabe | Se atribuye |
|---|---|---|---|
| **Directa** | El visitante agregó el producto con el botón de la ficha del chat y lo compró | El origen marca esa línea del carrito con la referencia opaca de la sesión de chat. Al confirmarse el pedido, informa a la mesa: referencia del pedido, sesión, y cuántas líneas vinieron del chat | Sí, al canal chat web |
| **Asistida** | El agente mostró el producto y el visitante lo agregó después desde la página | Misma sesión o misma cuenta de la tienda, y el producto aparece en la evidencia de la conversación antes de la compra, dentro de una ventana (decisión abierta 8) | Sí, como asistida, separada de la directa |
| **Sin relación** | Hubo chat, pero el pedido no contiene productos mostrados en él | — | No |

- **Sin modelo y sin datos de contacto.** El informe del origen es determinista y lleva referencias opacas y
  claves de producto. Los montos se leen del sistema de pedidos, no del informe.
- **Ventas de una persona en el chat web.** El vendedor que entra a un chat web cierra con cotización y link de
  pago, igual que en WhatsApp. Su atribución usa la misma evidencia en los dos canales.
- **Límite conocido.** Si el visitante conversa en un dispositivo y compra en otro sin iniciar sesión, la compra
  no se puede unir a la conversación. No se une por suposición (Decisión 5, identidad entre canales).
- **Atribuir no es causar.** Los tres niveles dicen que el chat participó, no que la venta ocurrió gracias a él.
  Para medir el efecto se recomienda un grupo de control: el origen oculta el chat a una fracción aleatoria de
  visitantes y se compara conversión y ticket entre los dos grupos (decisión abierta 8).
- **Dónde vive el cambio.** En el módulo de la tienda y en la mesa. No requiere cambios en R4 Core. El módulo de
  la tienda está fuera de este repositorio y su cambio necesita autorización propia.

## Cambios requeridos en R4 Core (genéricos, cada uno con autorización propia)

- **C-1. Puerto de ruteo de entrada.** Consulta previa al agente que responde `agent` o `human(principalRef)`.
  Tiene plazo y, ante cualquier error, gana `agent`. Si la respuesta es humana, la tarea nace con un traspaso
  activo para ese principal y sin run del agente.
- **C-2. Referencia de entrada persistida.** El inbound conserva una referencia opaca y acotada (el código de un
  link o QR, o el parámetro de entrada del chat web). Core no la interpreta.
- **C-3. Motivo de traspaso estructurado.** `request_handoff` acepta un `reasonCode` de una lista que declara el
  paquete. Los motivos se validan contra esa lista, y un código desconocido se rechaza.
- **C-4. Feed de eventos de conversación.** Lectura con cursor y `eventId` estable para consumidores externos.

Ninguno menciona vendedores, áreas ni comisiones.

## Paridad con el sistema actual

| Función del sistema actual | Dónde queda |
|---|---|
| Menú de áreas | Motivo estructurado (C-3) → área en la mesa. El cliente no navega menús |
| Colas por área, estado del agente humano | Mesa (turnos y disponibilidad), app Ventas |
| Transferir entre agentes humanos | Mesa: reasignar con motivo, registrado en el libro |
| Respuestas rápidas | App Ventas (plantillas internas) |
| Plantillas de WhatsApp fuera de 24 h | Plantillas de Meta enviadas por R4 |
| Historial del contacto | R4 (hilo) más la mesa (cartera) |
| Notas internas | Mesa, no visibles para el cliente |
| Horario de atención | Mesa (turnos) y avisos de horario de R4 (ya existen) |
| Encuesta de satisfacción | Mesa, al cerrar el caso |
| Reportes | Consola: tiempos de respuesta, abandono, satisfacción, ventas por persona y por canal |

**Antes de apagar el sistema actual** hay que exportar su historial, sus contactos y sus plantillas, y decidir qué
se importa.

## Fases (cada una requiere autorización del owner)

0. **Diseño:** este ADR y los contratos C-1 a C-4. Sin código en runtime.
1. **Esqueleto en QA:** la mesa, la app Ventas con asignación manual y solo chat web. Usa datos sintéticos y
   vendedores de prueba.
2. **Chat web en producción con vendedores reales:** asignación automática, SLA, cartera y libro en sombra.
   Gate: tiempos de respuesta y cero conversaciones sin respuesta durante el periodo que fije el owner.
3. **Número productivo de WhatsApp:** se migra desde el sistema actual (bloqueante D-1 de la auditoría R4-I:
   paridad de interfaz de operador). Antes del corte, ambos sistemas corren en paralelo con un plan de vuelta
   atrás.
4. **Liquidación de comisiones desde el libro**, tras validar la sombra.

## Fuera de alcance

- Los porcentajes de comisión y la nómina.
- La identidad unificada entre canales (CIA).
- Campañas de marketing salientes.
- Cualquier cambio en Catalog, Quote o Checkout.

## Consecuencias

- R4 Core gana cuatro primitivas genéricas y nada de dominio de ventas. La mesa puede cambiar sus reglas sin
  tocar R4.
- La derivación deja de depender del modelo. El agente pide ayuda con un motivo y la mesa decide con reglas
  auditables.
- Hay un servicio más que operar. Su caída no deja clientes sin respuesta, pero sí retrasa asignaciones, que
  hay que vigilar.
- El libro de atribución se vuelve evidencia para las comisiones. Por eso debe ser append-only desde el primer
  día.

## Decisiones del owner (2026-11-19)

- **Cliente de cabecera:** 90 días.
- **SLA de aceptación:** 10 minutos. Falta definir quién supervisa.
- **Caso K-7:** gana el vínculo vigente sobre el link de otro vendedor.
- **Caso K-9:** queda para después.
- **Prioridad:** que una persona pueda responder el chat web desde la consola. Ese trabajo va antes que la mesa con
  vendedores.

## Decisiones abiertas del owner

1. El porcentaje y la base de la comisión, y el uso del fondo de equipo.
2. Los vendedores, las áreas y los turnos iniciales.
3. El canal de aviso del chat web (correo, WhatsApp o ambos) y sus plantillas.
4. El repositorio y el host de la mesa (recomendación: repositorio privado, mismo host en la fase 1).
5. Quién supervisa el SLA de aceptación.
6. El reparto cuando quien atiende en cobertura debe emitir una cotización nueva (caso K-3).
7. La atribución cuando el agente hizo todo el trabajo y el cliente pide una persona solo para pagar (caso K-9).
8. En el chat web: la ventana de la venta asistida y el tamaño del grupo de control.
