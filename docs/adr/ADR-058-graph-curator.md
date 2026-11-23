# ADR-058 — Curador del grafo de productos: el grafo vive en R4 como versión firmada y un agente propone sus cambios

- **Identificador:** `R4-GRAPH-CURATOR-01`
- **Estado:** **Propuesto.** Sin implementación. Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-23
- **Mandato:** decisiones del owner del 2026-11-23:
  - «empecemos con el agente curador del grafo»;
  - el grafo vive **en R4 por ahora**;
  - la primera versión hace **las cuatro tareas**: productos nuevos o cambiados, datos faltantes en fichas, revisar
    propuestas sin firmar y detectar inconsistencias;
  - orden acordado: este ADR primero, luego llevar a `main` las herramientas del chat web que usan el grafo, luego
    pasar el chat web a la base de producción.
- **Autoridad superior:**
  - Constitución y PRD;
  - ADR-049 (consola) y ADR-050 (identidad de operador);
  - ADR-048 (mesa de ventas) y ADR-056 (consultas al equipo sin pausar la conversación), para la Decisión 7;
  - ADR-052 (aprendizaje: base de conocimiento con propuesta, verificación y firma);
  - ADR-054 (taller de agentes; Decisión 9 de su revisión 1: el curador como primer «agente en blanco»).

## Contexto

La tienda tiene un **grafo de productos**: qué barra apoya en qué rack, qué discos sirven para qué barra, qué
accesorio se monta en qué equipo, qué producto «lo reemplaza» cuando otro está agotado, entre otras relaciones.

Hechos verificados al 2026-11-23:
- **Tamaño:** se armó con una revisión completa sobre la extracción del catálogo (unos 876 productos en Catalog V2,
  602 vendibles). La versión exportada tiene **1.093 productos y 46.988 relaciones publicadas**, en áreas como «Barras
  que apoyan en este rack», «Discos sugeridos», «Se monta en», «Collarines», «Guarda» y «Lo reemplaza».
- **Dónde vive:** fuera de los repositorios, en scripts y archivos JSON de trabajo:
  - un proceso de refresco recalcula todo sin llamar a un modelo;
  - exporta un archivo que las herramientas experimentales del chat web leen por la variable `R4_EXP_GRAPH_FILE`
    (`catalog.build_step`, `catalog.replacements`).
- **Sin dueño ni versión:**
  - nadie firma una versión;
  - actualizarlo es correr el proceso a mano y copiar el archivo a los servidores;
  - no queda registro de qué cambió ni quién lo aprobó.
- **Pendientes medidos:**
  - unas **10.400 relaciones publicadas son propuestas que el owner no revisó**;
  - unos **4.531 pares están bloqueados por datos que faltan en las fichas** (perforaciones de rack, diámetros,
    composición de packs);
  - unos 130 productos sin vender no tienen un reemplazo vendible;
  - el catálogo cambia (productos nuevos, discontinuados, cambios de precio) y el grafo no se entera.
- **Catalog no tiene un grafo propio verificado.** Moverlo a Catalog es posible más adelante. Hoy el owner decidió que
  viva en R4.

## Decisión 1 — El grafo vive en R4 como una versión firmada

1. **El grafo publicado es una versión inmutable y firmada.** Se guarda en Postgres de R4 con:
   - número de versión, hash del contenido y fecha;
   - quién la firmó y la versión anterior.

   Las herramientas que lo usan leen siempre **la última versión firmada**, ya no un archivo copiado a mano.
2. **`Artifact` mínimo en Core.** Es una primitiva genérica permitida que todavía no existe (ADR-054 la anticipa).
   - Core guarda un artefacto **opaco**: tipo, versión, contenido JSON, hash, estado, autor y firmante. Tiene un
     registro de eventos append-only, igual que los libros de ADR-051 y ADR-052.
   - **Core no sabe qué es un producto ni una relación.**
3. **El esquema del grafo vive fuera de Core**, en un paquete de dominio nuevo: `agents/graph-curator`. Ahí se definen
   los productos, las áreas de relación y las reglas, y también la lectura de la versión firmada que usan las
   herramientas de Ventas.
4. **Volver atrás es volver a firmar la versión anterior.** No se borra nada.

## Decisión 2 — El curador es un agente propio que solo propone

1. **Agente `graph-curator`**, con su propio worker, definición y versión. No atiende clientes ni tiene canal.
2. **Herramientas:**
   - **leer el catálogo:** productos, fichas, estado y precio, de Catalog V2, solo lectura;
   - **leer el grafo:** la versión firmada vigente y las propuestas abiertas;
   - **proponer:** escribe propuestas dentro de R4. Es una escritura interna, sin efecto fuera de R4.
3. **Reglas primero, modelo después.**
   - Las reglas deterministas de hoy (compatibilidad, «lo reemplaza», tipos de producto) pasan al paquete como código
     con pruebas, y producen la mayoría de las propuestas sin modelo.
   - El modelo solo clasifica lo que ninguna regla clasifica y resume las inconsistencias.
   - Cada propuesta del modelo debe citar el dato de la ficha en que se apoya. Una propuesta sin evidencia se descarta.
4. **Nunca escribe en Catalog ni en PrestaShop.** Lo que falta en una ficha se informa para que el equipo lo complete
   en la tienda.

## Decisión 3 — Qué hace la primera versión

| Tarea | Qué produce |
|---|---|
| **Productos nuevos o cambiados** | Compara el catálogo con la última versión firmada: productos nuevos, discontinuados o que cambiaron de tipo. Propone sus relaciones y sus reemplazos. |
| **Datos faltantes en fichas** | Lista, por producto, el dato que falta y cuántas relaciones desbloquearía. Ordena primero los productos vendibles. |
| **Revisar propuestas sin firmar** | Presenta por lotes las ~10.400 relaciones sin revisión, empezando por las de productos más vendidos o más consultados, con la regla y el dato que las respaldan. |
| **Detectar inconsistencias** | Pares contradictorios, relaciones con productos discontinuados, productos vendibles sin ninguna relación, reemplazos de otro tipo o de otra carga sin aviso. |

## Decisión 4 — Revisión y firma en la consola

1. **Las propuestas llegan a la consola agrupadas** por tarea y por producto. Cada una muestra:
   - qué cambia;
   - la regla o el dato que la respalda;
   - el efecto: qué relaciones agrega o quita.
2. **Se aprueban o rechazan una por una o por lote.** Aprobar no publica: junta cambios para la próxima versión.
3. **Firmar publica.** Firmar crea la versión nueva del grafo, y las herramientas la usan desde ese momento.
4. **Ámbitos de operador:** `graph.curate` para aprobar o rechazar y `graph.sign` para firmar, como en ADR-052. Hoy los
   dos los tiene el owner; si se suma un operador, quien aprueba y quien firma pueden ser personas distintas.
5. **El curador también se evalúa.**
   - Sus propuestas se comparan con lo que el owner aprueba y rechaza, y la tasa de rechazo por regla se muestra en la
     consola.
   - Las decisiones ya revisadas forman su conjunto de regresión.
   - Una versión nueva de las reglas no se activa si empeora contra ese conjunto.

## Decisión 5 — Cuándo corre

- **Una vez por semana, a una hora fija** (decisión del owner, 2026-11-23), para detectar cambios del catálogo y
  revisar las relaciones. Necesita un horario que abra tareas: es una primitiva genérica (Schedule) que ADR-054 ya
  anticipa.
- **A pedido desde la consola,** por categoría o por lote de productos.
- **Tope de gasto de modelo: US$1 por corrida.** Sin presupuesto, corre solo con reglas.

## Decisión 6 — Las herramientas del chat web leen la versión firmada

- `catalog.build_step` y `catalog.replacements` dejan de leer el archivo de `R4_EXP_GRAPH_FILE`. Leen la versión
  firmada mediante el puerto del paquete `graph-curator`.
- Este es el puente con el segundo paso del orden acordado: llevar esas herramientas a `main` con su propio PR.

## Decisión 7 — Lo que el grafo no responde se pregunta al responsable

Decisión del owner del 2026-11-23: cuando Pesín tiene una duda que el grafo no logra responder, en cualquier canal, le
pregunta al responsable. Por ejemplo: si una barra calza en un rack, cuando falta un dato de la ficha.

1. **Usa la consulta sin pausa de ADR-056.**
   - Pesín le dice al cliente que lo confirma con el equipo y sigue conversando.
   - Retoma con la respuesta cuando llega.
   - Si nadie responde a tiempo, la consulta vence según ADR-056.
2. **A quién va:**
   - **una duda comercial**, a un **vendedor**, en la mesa de ventas (ADR-048), con su aviso al celular;
   - **una duda técnica** del producto, al **product manager**.
3. **La respuesta vuelve al grafo.**
   - Lo que responde la persona llega al curador como una propuesta, con la respuesta como evidencia y su autor.
   - Se firma como cualquier otra propuesta (Decisión 4).
   - Así la misma duda no se pregunta dos veces.
   - Lo que falta en la ficha también queda en la lista de datos faltantes (Decisión 3), para completarlo en la
     tienda.
4. **Requisitos:**
   - el vendedor y el product manager dados de alta como operadores en la consola;
   - un área técnica o de producto, con el product manager como responsable.

## Privacidad y repositorio público

- El grafo no tiene datos personales: son productos, fichas y relaciones públicas de la tienda.
- El contenido del grafo vive en la base de datos, no en el repositorio. El repositorio tiene las reglas y sus
  pruebas, con datos de ejemplo.

## Fases (cada una con autorización explícita)

| Fase | Contenido | Modelo |
|---|---|---|
| **G0** | Este ADR | No |
| **G1** | `Artifact` mínimo en Core. Paquete `graph-curator` con el esquema y la lectura de la versión firmada. Importar el grafo actual como **versión 1, firmada por el owner como línea base** y marcando las relaciones aún sin revisar | No |
| **G2** | El curador con reglas: productos nuevos o cambiados, datos faltantes e inconsistencias. Corre a pedido | No |
| **G3** | Consola: propuestas, aprobación por lote y firma de versiones. Horario semanal | No |
| **G4** | Revisión por lotes de las propuestas sin firmar. El modelo clasifica lo que ninguna regla clasifica, siempre con evidencia | Sí, con tope |
| **G5** | Las herramientas del chat web leen la versión firmada (junto con su paso a `main`) | No |
| **G6** | Consulta al responsable (Decisión 7): las dudas que el grafo no responde van al vendedor o al product manager, y su respuesta vuelve como propuesta. Depende de ADR-056 y del alta de los operadores | No |

## Fuera de alcance

- Escribir en Catalog o en PrestaShop, o corregir fichas.
- Publicar una versión sin firma.
- Que otros agentes consuman propuestas no firmadas.
- Mover el grafo a Catalog. Queda para después; el esquema del paquete facilita esa migración.

## Consecuencias

- **Positivas:**
  - el grafo tiene dueño, versiones, firma y registro de cambios, y se mantiene al día con el catálogo;
  - las herramientas leen lo firmado;
  - el trabajo pendiente (sin revisar, datos faltantes) queda a la vista y ordenado.
- **Costos:**
  - dos primitivas genéricas nuevas en Core (`Artifact` mínimo y horario que abre tareas);
  - un paquete y un worker nuevos;
  - el tiempo del owner para revisar y firmar.
- **Riesgos:**
  - **Firmar por lotes sin mirar.** Se mitiga mostrando el efecto de cada lote y empezando por lo que más se vende.
  - **Reglas que se quedan atrás.** Se mitiga con las inconsistencias y la tasa de rechazo por regla.

## Decisiones del owner (2026-11-23)

1. **Línea base:** se firma el grafo actual completo como versión 1. Las ~10.400 relaciones sin revisar quedan
   marcadas «sin revisar» y siguen en uso.
2. **Lectura del catálogo:** una capacidad en código recorre las fichas de Catalog V2. No se le pide una lectura en lote
   a Catalog. Esto cierra, para este agente, la decisión abierta 5 de ADR-054.
3. **Frecuencia y tope:**
   - una vez por semana, más las corridas a pedido;
   - tope de US$1 de modelo por corrida, desde G4.
   - El día y la hora quedan para G3.
4. **Datos faltantes y dudas:** Pesín pregunta al responsable cuando el grafo no responde (Decisión 7). Una duda
   comercial va a un vendedor y una técnica al product manager.
5. **Orden de revisión de lo sin firmar:** por ventas, primero los productos más vendidos.

## Decisiones abiertas (owner)

1. **Cómo le llega la consulta al product manager**, que trabaja en ClickUp.
   - Se propone que la pregunta y la respuesta vivan en R4: R4 crea una tarea en ClickUp como aviso, con un link para
     responder en la mesa.
   - La alternativa es que el PM responda en ClickUp y R4 lea la respuesta con un webhook. Esto exige una integración
     de ida y vuelta.
2. **Quiénes son el vendedor y el product manager** que se dan de alta como operadores.
3. **Día y hora de la corrida semanal.**
