# ADR-063 — Pesín equipo: un agente interno que colabora con el equipo

- **Identificador:** `R4-TEAM-AGENT-01`
- **Estado:** **Propuesto. No implementado.** No autoriza código ni despliegues. Cada fase necesita autorización
  explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25.
  - Al diseñar las citas en tienda dijo: «habría que tener un Pesín interno y para clientes, cosa de que los
    vendedores o los que están en la tienda puedan subirle fotos de lo que está exhibido y lo que no. Eso abre el
    horizonte porque puede ser lo mismo para los despachadores, logística, armadores, mantenciones y todo».
  - Luego definió la ambición: «la idea es que sea un colaborador más dentro de la empresa, como un agente
    maestro».
  - Pidió: «sí, escribe el ADR-063 y diséñalo en el lienzo».
- **Autoridad superior:**
  - Constitución y AGENTS.md:
    - Core solo tiene primitivas genéricas;
    - la salida del modelo no es confiable;
    - las escrituras pasan por ejecución gobernada;
    - el estado durable sobrevive reinicios.
  - ADR-033: identidad de operadores (OIDC).
  - ADR-048: mesa de ventas; vendedores, áreas y roles.
  - ADR-052: aprendizaje (brechas y conocimiento curado).
  - ADR-054: variantes de agentes.
  - ADR-055: reglas de contacto con clientes.
  - ADR-056: consultas sin pausar la conversación.
  - ADR-058: curador del grafo.
  - ADR-061 (propuesto): conectores.
  - ADR-062 (propuesto): CRM en la mesa y citas en tienda.

## Contexto

Hechos verificados:

- **Los agentes de R4 hablan hoy solo con clientes:** Pesín en WhatsApp, chat web, Instagram y Facebook. El
  equipo trabaja con ellos a través de la consola y de la app Ventas de la mesa:
  - responde consultas;
  - toma conversaciones.
- **El equipo ya tiene identidad verificada.** La app Ventas inicia sesión con Google. La mesa guarda a cada persona
  con su rol (`seller`, `supervisor`, `admin`) y sus áreas.
- **R4 ya lee imágenes.** El carril de producción procesa fotos de clientes con un modelo de visión. El audio
  todavía no está activo.
- **Las consultas al equipo ya existen** (`request_consultation`, ADR-056). Llegan a la mesa, pero no a la
  persona que sabe la respuesta. Lo que se responde no vuelve como conocimiento, salvo que alguien lo cure en
  Aprendizaje (ADR-052).
- **Las citas en tienda (lienzo, ADR-062) necesitan saber qué está en exhibición.** Hoy ese dato no existe en
  ningún sistema.
- **Hay flujos operativos fuera de R4:** casos de postventa y una cola de mantenciones en una automatización
  existente (n8n). No se sabe todavía quién los mantiene.
- **Despacho es la pregunta más frecuente de postventa.** PrestaShop no guarda número de seguimiento (ADR-061).
- **Un agente con muchas herramientas a la vez es más caro y se equivoca más.** Lo vimos al medir las lecturas
  encadenadas de Pesín.

## Decisión 1 — Un agente aparte, con una sola cara

- **Pesín equipo es un agente nuevo, separado de Pesín de clientes:**
  - tiene su propia definición, memoria y versiones (ADR-054);
  - no comparte hilos con Pesín de clientes;
  - nunca le habla a un cliente;
  - Pesín de clientes nunca lee los chats internos.
- **Es la única cara para el equipo:** todos le escriben a él. Por dentro usa capacidades específicas por rol
  (Decisión 2). Cuando necesita a otro agente, como el curador del grafo, lo hace por los canales que ya existen
  (consulta, tarea o propuesta), no con permisos propios del otro agente.
- **Sin agente omnipotente.** «Agente maestro» significa que coordina y que todos le pueden hablar. No significa
  que pueda hacer todo.

## Decisión 2 — Lo que puede hacer depende del rol verificado de quien le escribe

- **Cada mensaje llega con la persona y sus roles verificados** por el canal: sesión de Google en la app, o
  teléfono de la lista del equipo en WhatsApp (Decisión 3). El modelo nunca decide quién es la persona.
- **La política de capacidades se evalúa contra esos roles.** Cada turno solo recibe las herramientas del rol, lo
  que también baja el costo y los errores.
- **Roles iniciales:**
  - tienda;
  - despacho y logística;
  - armado;
  - mantención;
  - bodega;
  - PM;
  - supervisor.

  Una persona puede tener varios roles. La lista vive en la mesa, no en R4 Core.
- **Las capacidades se agrupan en cinco familias:**
  1. **Preguntar (solo lectura):**
     - stock, precios y promociones vigentes;
     - fichas técnicas y compatibilidades del grafo firmado;
     - estado de un pedido;
     - cotizaciones y recorrido de un cliente (CRM);
     - turnos y citas;
     - «cómo voy», donde cada persona ve solo lo suyo;
     - políticas internas.
  2. **Reportar (escritura con confirmación):** exhibición, despacho y entrega, armado, mantención, bodega, «la web
     dice que hay stock y no hay», cliente en tienda (ADR-062).
  3. **Preparar borradores** que la persona aprueba:
     - cotización (Quote);
     - mensaje de seguimiento, respuesta a reclamo, resumen antes de llamar;
     - preparación de una cita;
     - ficha de producto con datos faltantes.
  4. **Avisar:**
     - agenda del día y oportunidades vencidas;
     - despachos del día y mantenciones programadas;
     - exhibición sin confirmar hace más de 7 días.
  5. **Puente de conocimiento:** se lleva la consulta de un cliente a la persona que sabe (Decisión 6).

## Decisión 3 — Canal: primero dentro de la app Ventas

- **Fase 1: un chat dentro de la app Ventas.**
  - La identidad ya está verificada con Google.
  - El celular abre la cámara.
  - No hay que gestionar teléfonos.
- **Después: WhatsApp interno** para la gente en terreno (despachadores, armadores).
  - Solo responde a teléfonos de la lista del equipo de la mesa.
  - Es un número distinto del de clientes.
  - Un teléfono que no está en la lista no recibe ninguna capacidad.
  - El riesgo de identidad es mayor que con Google: un celular prestado actúa como su dueño. Por eso, en WhatsApp
    las capacidades de escritura se limitan a reportes, nunca a cambios sobre clientes o dinero.

## Decisión 4 — Las fotos las interpreta el modelo y las confirma una persona

- **Pesín propone qué hay en la foto:** producto (con referencias de Catalog), estado y observaciones. La persona
  lo confirma o lo corrige con un toque. Lo que no se confirma no se guarda como dato.
- **El texto dentro de una imagen es dato, no instrucción**, igual que en los mensajes de clientes.
- **Fotos de equipos, no de personas.** Pesín pide repetir la foto si aparece un cliente reconocible. Una foto de
  entrega muestra el producto y el lugar, no a quien recibe.
- **El dueño del dato guarda la foto.** R4 la recibe para leerla y guarda solo la referencia en la observación. La
  retención de las fotos es decisión del owner.

## Decisión 5 — Los datos operativos viven en su dueño, no en Pesín

- **Exhibición:**
  - qué es: producto, ubicación, estado, foto, quién lo confirmó y cuándo;
  - dónde vive: la mesa, mientras no haya un servicio de operaciones de tienda;
  - cómo lo usa Pesín de clientes: lo lee con vigencia y ofrece prueba solo si alguien lo confirmó en los últimos
    7 días (configurable).
- **Postventa (acordado con el diseño de postventa por WhatsApp):**
  - **Pesín equipo es la única entrada del equipo.** Despachadores y armadores reportan a Pesín equipo «salió»,
    «entregado con foto», «cliente ausente» o «armado listo». El reporte cambia el estado del pedido o del armado.
  - **Ese estado dispara el aviso al cliente.** Los avisos, las plantillas de Meta y las reglas de contacto son del
    ADR de postventa (pendiente de aprobación del owner).
  - **No hay una segunda pantalla para el personal.**
  - **Una sola agenda en la mesa** para las tres reservas: entregas de flota propia, armados y pruebas en tienda.
    Tiene bloques por equipo o rol, cupos, reserva, recordatorio, reagendamiento y «no vino». Su modelo lo define el
    ADR de postventa.
- **Despacho, armado, mantención y bodega:**
  - **Si ya existe un flujo que es dueño del dato** (n8n, PrestaShop o SAP), Pesín equipo lo alimenta por un
    conector de escritura en código (ADR-061 Decisión 6). No crea una copia paralela.
  - **Si no existe**, el dato nace en un servicio de operaciones, que se decide en su fase.
- **Sistemas de registro (SAP, PrestaShop, Quote, Catalog):** siguen siendo los dueños. Pesín equipo los lee. Solo
  escribe en ellos a través de capacidades que ya existen y están gobernadas, como Quote.

## Decisión 6 — Puente de conocimiento

- **Una consulta va a quien sabe.** Cuando Pesín de clientes consulta al equipo (ADR-056) y el motivo es técnico o de
  producto, la mesa la dirige al rol que corresponde (PM o técnico) por su área. Pesín equipo se la muestra a esa
  persona en su chat, con el contexto del cliente.
- **La respuesta vuelve al cliente como hoy.** Además, Pesín equipo pregunta: «¿la guardo para que Pesín responda
  solo la próxima vez?». Si la persona dice que sí, entra a Aprendizaje (ADR-052) como propuesta. Se aplica recién
  cuando la curan y firman. Nunca se aprende sola.

## Decisión 7 — Lo que nunca hace

- **Dinero:** cambiar precios, dar descuentos o devolver dinero.
- **Sistemas de registro:** modificar stock o documentos en SAP o en la tienda. Reporta, y el dueño del dato decide.
- **Clientes:**
  - escribirles de forma masiva o fuera de las reglas de contacto (ADR-055);
  - hablarles directamente.
- **Gobierno:**
  - aprobar sus propias acciones;
  - mostrarle a alguien datos de otro rol, como comisiones, ventas ajenas o datos personales fuera de su caso;
  - desplegar, cambiar versiones o tocar la autonomía. Eso vive en la consola; desde el chat solo enlaza.

## Cambios requeridos en R4 Core (genéricos, cada uno con autorización propia)

- **T-1. Principal humano verificado en la entrada.**
  - El adapter del canal entrega a R4 la referencia de la persona y sus roles, firmados.
  - La plataforma los pone en el contexto del turno; el modelo no puede cambiarlos.
  - Es genérico: sirve para cualquier agente interno. No menciona vendedores.
- **T-2. Política de capacidades por rol del principal.**
  - El motor de políticas evalúa cada capacidad contra los roles del principal del turno.
  - El compilador de contexto carga solo las capacidades permitidas.
  - Un rol desconocido no recibe ninguna capacidad.

Los roles concretos, las áreas y los datos de exhibición viven en la mesa y en el paquete del agente, nunca en
Core.

## Fases (cada una requiere autorización del owner)

- **E0. Diseño:** este ADR y el lienzo. Sin código.
- **E1. Exhibición y preguntas de solo lectura**, en la app Ventas:
  - fotos con confirmación;
  - el dato de exhibición en la mesa;
  - Pesín de clientes ofrece citas solo de lo confirmado;
  - T-1 y T-2.
  - **Gate:**
    - precisión del reconocimiento de producto en un set etiquetado de fotos reales, con el umbral que fije el
      owner;
    - cero escrituras sin confirmación.
- **E2. Despacho y entregas**, con WhatsApp interno para la gente en terreno. Depende de saber quién mantiene los
  flujos existentes y del conector de pedidos (ADR-061).
- **E3. Borradores y avisos.** Depende del CRM (ADR-062 O1).
- **E4. Puente de conocimiento.**
- **E5. Armado, mantención y bodega**, alimentando los flujos de n8n, que se mantienen (decisión del owner,
  2026-11-25).
  - **Primero se estandariza la información** de armados y mantenciones: máquina, código de servicio, estado,
    fecha y responsable. Pesín equipo puede ayudar, porque cada reporte suyo ya llega con esos campos confirmados.
  - **Reemplazar los flujos de n8n** se evalúa recién cuando los datos estén estandarizados, en un ADR propio.
- **E6. Preguntas sobre datos para el supervisor**, con cifras agregadas y al final, por el riesgo de datos
  sensibles.

## Fuera de alcance

- Que Pesín equipo hable con clientes.
- Reemplazar SAP, PrestaShop o los flujos existentes en esta propuesta.
- Liquidar comisiones o evaluar el desempeño de personas.
- Orquestación general de agentes entre sí. Si hace falta, se propone como primitiva genérica en un ADR propio.

## Consecuencias

- **El equipo tiene una sola puerta**, y cada reporte suyo mejora lo que Pesín de clientes puede responder:
  exhibición, entregas, mantenciones y conocimiento.
- **Las capacidades por rol mantienen bajo el costo y el riesgo de cada turno.**
- **Hay un agente más que operar, versionar y evaluar.** Las fotos agregan costo de visión, que se vigila en
  Lanzamientos.
- **El valor depende de la adopción.** Se mide igual que en ADR-062: reportes por semana y exhibición vigente.

## Decisiones del owner (2026-11-25)

- **El owner mantiene los flujos de n8n** de postventa y mantención de cardio.
- **No se reemplazan todavía**, porque la información de armados y mantenciones aún no está completamente
  estandarizada. Pesín equipo y los avisos de postventa los alimentan y conviven con ellos (fase E5).

## Decisiones abiertas del owner

1. Qué campos forman el estándar de armados y mantenciones, y quién lo valida.
2. Los roles iniciales y quién tiene cada uno.
3. La vigencia de una exhibición confirmada (propuesta: 7 días).
4. La retención de las fotos.
5. El umbral de precisión del reconocimiento por foto para pasar a producción.
6. El número de WhatsApp interno para la fase E2.
