# ADR-053 — Omnicanalidad: un agente por canal, contactos, personas y clientes

- **Identificador:** `R4-OMNI-01`
- **Estado:** **Propuesto** (owner, 2026-11-19: «sí porfa»). Implementar cada fase necesita autorización explícita del
  owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-19. Pensar la omnicanalidad (WhatsApp, Facebook, Instagram, web): dónde se guarda la
  información, cómo se separa por canal y cómo se vinculan los canales. En la consola, Don Pesín va separado por canal,
  porque los clientes se comportan distinto en cada uno; los workers ya están separados así.
- **Autoridad superior:** Constitución («el estado durable sobrevive al reinicio»; «la salida del modelo no es
  confiable»; «no agregar infraestructura sin necesidad demostrada»); AGENTS.md (Customer fuera de Core); ADR-039
  (identidad de cliente: D1 bloqueado); ADR-045 (carril de conversación); ADR-046 (canal web); ADR-049 (consola).

## Contexto

Hechos verificados:
- **R4 conoce solo identidades de canal.** Cada conversación es un binding con `channel`, `accountRef` y
  `recipientRef`, abierto por la ingress a partir de la firma del proveedor (ADR-039, Contexto).
- **Cada canal ya es un agente aparte.** WhatsApp es `sales`, en el carril `sales-production@N` (ADR-045). La web es
  `sales-web`, en `sales-web@N` (ADR-046). Cada uno tiene su gateway, su worker, su perfil de capacidades y sus
  versiones. El paquete de Ventas es el mismo.
- **El chat web de QA guarda sus conversaciones en otra base.** La decisión 3 del ADR-046 lo aísla de producción, así
  que la consola, que lee la base de producción, no las ve. El edge del chat guarda solo una copia para mostrar.
- **La identidad de cliente está bloqueada.** Saber qué cliente comercial corresponde a un contacto depende de CIA, y
  esa decisión (D1 del ADR-039) sigue pendiente. El traspaso entre canales con link firmado quedó estacionado el
  2026-11-12 por esa razón.

## Decisión 1 — Un solo depósito: la base de producción de R4

Todas las conversaciones de todos los canales se guardan en la base de producción de R4, con las mismas tablas: tareas,
runs, pasos, entradas, salidas y pedidos humanos. El canal y la cuenta van en cada binding. El edge de un canal nunca es
el registro: solo muestra.

Una cuenta de QA conectada a producción, como el chat de la tienda de QA, usa su propio `accountRef`. Así se puede
filtrar en las métricas y apagar sin tocar las demás cuentas. Esto reemplaza la decisión 3 del ADR-046 («base propia en
QA») **cuando el owner autorice conectar el chat web**. Mientras tanto, esa decisión sigue vigente.

## Decisión 2 — Un agente por canal

Cada canal tiene su propia identidad de agente, `sales-<canal>`:

| Canal | Agente | Estado |
|---|---|---|
| WhatsApp | `sales` (`sales-production@N`) | En producción |
| Web | `sales-web` (`sales-web@N`) | En QA, con base propia |
| Instagram | `sales-instagram` | No construido |
| Facebook (Messenger) | `sales-facebook` | No construido |

Cada uno tiene:
- su worker y su gateway (o una ruta propia en un gateway multicanal, ADR-046 punto 7);
- su perfil de capacidades: la web solo lee, WhatsApp cotiza;
- sus versiones, su despliegue gradual, sus topes y su presupuesto de modelo;
- sus métricas, su calidad y sus incidentes.

**Por qué:** el visitante web mira y compara, en WhatsApp se cotiza y se paga, y en Instagram llegan preguntas sueltas
desde una publicación. Un cambio pensado para un canal no debe mover a otro, y cada canal se mide contra sí mismo.

**En la consola:** cada agente aparece como «Don Pesín · WhatsApp», «Don Pesín · Web», etc. Un canal que R4 no ejecuta
aparece como planificado, nunca como activo. Ventas, calidad y lanzamientos se leen por agente.

## Decisión 3 — Tres capas: contacto, persona y cliente

| Capa | Qué es | Autoridad |
|---|---|---|
| **Contacto** | Quién escribe en un canal (número de WhatsApp, ID de Instagram o de Messenger, sesión web) | R4, con la firma del proveedor (vigente) |
| **Persona** | Varios contactos que una prueba une como el mismo ser humano | R4 (esta ADR) |
| **Cliente** | La cuenta comercial: pedidos, datos, historial de compra | Autoridad de identidad externa, CIA (ADR-039, D1 bloqueado) |

La persona **no** es el cliente. Unir dos contactos no abre pedidos ni datos de ninguna cuenta. Por eso la persona se
puede construir sin CIA.

Contacto y persona son primitivas genéricas de canal (`live-ops`), sin conceptos de Ventas. Cliente sigue fuera de Core.

## Decisión 4 — Cómo se vinculan los contactos

Un vínculo une dos contactos en una persona. Guarda el método, la evidencia, quién lo creó, cuándo y cuándo se revocó.
Nunca se borra: se revoca.

| Método | Prueba | Quién lo inicia |
|---|---|---|
| **Código puente** | En un canal, el cliente aprieta «Seguir por WhatsApp» (o por la web). El otro canal recibe un código de un solo uso, válido 10 minutos, en un mensaje ya escrito o en un link firmado. Cuando el código llega desde un contacto, queda probado que la misma persona controla los dos | El cliente |
| **Código de verificación (OTP)** | R4 envía un código por un canal y el cliente lo repite en el otro (diseño R4-J4-SEC-OTP) | El agente o el cliente |
| **Operador** | Una persona del equipo une dos contactos, con motivo. Queda marcado como «vinculado por operador» | El operador, desde la consola |

**Nunca vinculan:** la coincidencia de nombre, un teléfono o un correo escrito en un chat sin verificar, ni una inferencia
del modelo. Un dato declarado sirve solo como pista para ofrecer la verificación.

**Qué habilita cada vínculo:**
- **Cualquier vínculo:** la ficha de la persona en la consola, con sus conversaciones de todos los canales en una línea
  de tiempo.
- **Código puente u OTP:** además, continuidad para el agente. Por ejemplo, «ayer en la web viste esta barra», o «tu
  cotización de WhatsApp sigue vigente». Usarlo es un cambio de comportamiento: necesita una versión nueva de cada
  agente, con su evaluación.
- **Cliente verificado (CIA):** pedidos, despachos y datos de la cuenta. Sigue bloqueado por ADR-039.

**Revocar:** desde la consola, con motivo. El agente deja de usar la continuidad desde la siguiente vuelta.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Consola separada por canal (Decisión 2) | Hecha en la consola, sin desplegar |
| F1 | Chat web sobre la base de producción, con cuenta de QA (Decisión 1) | Espera que QA vuelva a estar encendido y la autorización del owner |
| F2 | Vínculos (tabla, código puente web → WhatsApp, operador) y ficha de persona en la consola | Propuesta |
| F3 | Continuidad para el agente (versiones nuevas de `sales` y `sales-web`) | Propuesta |
| F4 | Adaptadores de Instagram y Facebook (API de mensajería de Meta), con su agente y su worker | Propuesta |
| F5 | Persona → cliente con CIA | Bloqueada por ADR-039 D1 |

## Decisiones abiertas del owner

1. Si el código puente puede ir visible en el mensaje ya escrito de WhatsApp («Hola, sigo desde la web: código 4F7K»).
2. Si el operador puede vincular a mano o solo sugerir el vínculo, para que el cliente lo confirme.
3. Cuánto tiempo se guarda cada canal y qué se borra a pedido del cliente.
4. Qué va primero, Instagram o Facebook.

## Fuera de alcance

- Identidad de cliente, autorización individual y datos de Customer Profile (ADR-039).
- Inicio de sesión automático desde un link (decisión del owner del 2026-11-12: el link lleva al login o al carrito).
- Unir conversaciones en una sola: cada canal sigue con su conversación, con sus reglas de ventana.

## Consecuencias

- Cada canal nuevo cuesta un adaptador, una identidad de agente, un worker y su evaluación. A cambio, ningún canal
  cambia el comportamiento de otro.
- La consola muestra una bandeja con filtro por canal. La ficha de persona llega en F2.
- Las métricas de QA y de producción conviven en la base desde F1. Se separan por `accountRef`.
