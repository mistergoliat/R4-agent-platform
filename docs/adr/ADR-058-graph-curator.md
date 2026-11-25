# ADR-058 — Curador del grafo de productos: el grafo vive en R4 como versión firmada y un agente propone sus cambios

- **Identificador:** `R4-GRAPH-CURATOR-01`
- **Estado:** **Aceptado** (G0, PR #125).
  - **G1 en producción** (PR #132): la versión 1 está firmada por el owner desde el 2026-11-23.
  - La consola lee el grafo (PR #133).
  - **G2 en producción** (PR #134). Primera corrida el 2026-11-23: 2.550 fichas, 588 hallazgos.
  - **G3 en producción** (PR #136): 589 propuestas abiertas el 2026-11-23.
  - **G2b-1 en producción** (PR #138): altas por analogía, reemplazos, grupos musculares y cierre automático de avisos.
  - **Decisión 9 en producción** (PR #141): la versión 2 se publicó sola el 2026-11-23, con 290 cambios automáticos.
  - **Decisión 10 en producción** (PR #143).
  - **G5 en producción** (PR #144): las herramientas del chat web leen el grafo firmado, versión 2, desde el
    2026-11-24.
  - **G5b en producción** (PR #146): Pesín lee los hechos de la Decisión 10 como parte de la ficha.
  - **G2b-2 en producción** (PR #150): calce físico y cuántas relaciones desbloquea cada dato faltante.
  - **Corrección de la reactivación en producción** (PR #152): un producto reactivado recupera sus relaciones.
  - **G4a en producción** (PR #153): el agente `graph-curator` clasifica lo que ninguna regla clasifica.
  - **G4b en producción** (PR #154): el agente revisa por lotes las relaciones sin revisar. La corrección de la evidencia
    «Categoría» y `graph:recheck` están en producción desde el 2026-11-25 (PR #158).
  - **Decisiones 11 y 12 aceptadas** (enmienda del 2026-11-25, PR #160; owner: «apruebo el ADR y parte con G7a»):
    conversar con el curador y una revisión que se entienda. G7a autorizada; G7b y G7c esperan su autorización.
  - Cada fase necesita autorización explícita del owner.
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
  - unas **10.400 relaciones publicadas son propuestas que el owner no revisó** (al importar en G1: 10.649 de 23.494);
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
4. **Ámbitos de operador:** `artifact.curate` para aprobar o rechazar y `artifact.sign` para firmar, como en ADR-052.
   - En G3 se llamaron así, y no `graph.*`, porque Core no puede nombrar el grafo: los ámbitos valen para cualquier
     artefacto.
   - Hoy los dos los tiene el owner. Si se suma un operador, quien aprueba y quien firma pueden ser personas
     distintas.
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

## Decisión 8 — Grupos musculares de cada producto

Decisión del owner del 2026-11-23: el grafo suma qué parte del cuerpo trabaja cada producto, junto con G2b.

1. **Es un atributo del producto, no una relación.** Cada producto tiene cero o más grupos de una lista cerrada:
   - piernas, glúteos, espalda, pecho, hombros, brazos y core;
   - cuerpo completo y cardio.

   Un accesorio o un producto de orden (collarines, racks de discos, pisos) no tiene grupo: lo hereda de lo que
   acompaña.
2. **Por qué:**
   - **Armar un gimnasio por objetivo.** Pesín puede responder «quiero entrenar piernas y espalda en casa» y revisar
     que un armado cubra el cuerpo completo.
   - **«Lo reemplaza» con sentido.** Un reemplazo de otro tipo que trabaja los mismos grupos es razonable: por
     ejemplo, un banco de hip thrust y una máquina de extensión de cadera. El curador deja de marcarlo como
     inconsistente y marca solo los reemplazos que no comparten ningún grupo.
3. **De dónde sale:** hoy no está en el catálogo. Ninguna ficha declara «músculos trabajados», y solo hay unas pocas
   categorías: «Bancos Abdominales», «Abdominales» y «Glute Bands».
   - **Primero las reglas**, por tipo de producto y nombre. Por ejemplo, «Bíceps / Tríceps» → brazos, «Hip Thrust» →
     glúteos y piernas, una cinta de correr → cardio.
   - **El modelo** clasifica lo que ninguna regla resuelve, desde G4 y siempre citando el dato de la ficha o el nombre.
   - Cada asignación es una **propuesta** que el owner aprueba y firma en la consola, como el resto del grafo
     (Decisión 4).
4. **Esquema:** `products[P].muscles`, opcional, con valores de la lista cerrada; el esquema valida la lista. Las
   versiones sin el campo siguen siendo válidas.

## Decisión 9 — Los cambios mecánicos se aplican solos (enmienda del 2026-11-23)

Decisión del owner del 2026-11-23: un product manager no va a revisar cientos de cambios mecánicos uno por uno. La
Decisión 4 cambia solo para estas reglas.

1. **Reglas automáticas:** `INACTIVE_WITH_RELATIONS`, `DISCONTINUED`, `RENAMED` y `REACTIVATED`.
   - Son mecánicas: el catálogo ya dice lo que pasó, y el cambio solo lo refleja.
   - Todas las demás, incluidas las nuevas, siguen esperando a una persona. Por ejemplo: reemplazos entre tipos
     distintos, altas de productos y grupos musculares.
2. **Se aprueban, se arman y se firman solas.** En cada corrida, el curador aprueba sus propuestas automáticas y arma
   una versión que solo las contiene. La firma como `graph-curator:auto`.
   - Decisión del owner: esa versión se publica sola, sin esperar su firma.
   - Lo que una persona aprobó y todavía no firmó no entra en esa versión.
3. **Resumen semanal y deshacer.**
   - La consola muestra lo que se aplicó solo.
   - **Deshacer** un cambio arma y firma una versión nueva que lo revierte. El producto vuelve a quedar como estaba en
     la versión anterior al cambio: su nombre, su estado y sus relaciones.
   - El cambio queda `undone` y el curador no lo vuelve a aplicar, aunque lo siga encontrando.
4. **Firmar no puede borrar lo publicado.**
   - Cada versión recuerda sobre qué versión se armó.
   - Una versión que nunca se firmó, y que se armó sobre una versión que ya no es la vigente, no se puede firmar: hay
     que volver a armarla.
   - Los cambios cuentan como aplicados recién al firmar. Así, una versión armada que nadie firma no se lleva sus
     cambios.
   - Volver a firmar una versión anterior, para ir atrás, sigue permitido.

## Decisión 10 — Los datos que faltan se responden una vez en R4 (enmienda del 2026-11-23)

Decisión del owner del 2026-11-23: el product manager no va a ir al administrador de la tienda a corregir la ficha y
volver a aprobar. Esto amplía «Fuera de alcance»: R4 guarda datos de producto que aprendió.

1. **Una pregunta, una respuesta.** El responsable responde el dato que falta una sola vez dentro de R4, por ejemplo
   «Perfiles: 50×50». La pregunta llega como aviso del curador o como consulta de Pesín (Decisión 7).
2. **R4 lo guarda como un hecho con evidencia:** producto, dato, valor, quién lo respondió, cuándo y de dónde vino.
   Es append-only: un valor nuevo reemplaza al anterior sin borrarlo.
3. **Se usa de inmediato.** El curador y Pesín leen el hecho como si fuera parte de la ficha. El aviso de dato
   faltante se cierra solo.
4. **La ficha se corrige después, en lote.** La consola exporta la lista de hechos que la tienda todavía no tiene,
   para quien carga productos. Cuando la ficha ya trae el dato, el hecho queda como respaldo.
5. **Implementación en una fase aparte**, después de la Decisión 9 (ver «Decisión 10 — implementación»).

## Decisión 11 — Conversar con el curador (enmienda del 2026-11-25)

Pedido del owner del 2026-11-25: «uno debería poder explicarle al curador también y que lo interprete, es un agente al
final». Hoy a cada propuesta solo se le contesta Aprobar o Rechazar. El curador no se entera de por qué y vuelve a
proponer lo mismo en casos parecidos.

1. **«Explicar» en cada propuesta.** Además de Aprobar y Rechazar, la persona escribe con sus palabras lo que sabe.
   Por ejemplo, ante «quitar: la Polea Alta/Remo reemplaza a la Polea de Muro»:
   > «No, sí la reemplaza: las dos trabajan espalda con cable. Lo que no la reemplaza es una máquina de piernas.»
2. **El curador lo interpreta como una tarea gobernada.** El tipo de tarea nuevo es `graph.interpret_explanation`. Recibe
   la explicación, la propuesta y las propuestas abiertas parecidas (misma regla, mismos tipos de producto). Devuelve un
   **plan** con tres partes, y todas esperan la confirmación de la persona:
   - **esta propuesta:** aprobarla o rechazarla, según lo que la persona quiso decir;
   - **casos parecidos:** qué otras propuestas abiertas resuelve igual, una por una y con el motivo. Ejemplo: «otras 6
     de máquinas de cable para espalda»;
   - **un criterio:** la regla general que la persona expresó, en una frase. Ejemplo: «Las máquinas de cable que
     trabajan el mismo grupo muscular se reemplazan entre sí».
3. **La persona confirma el plan con un clic, o lo corrige.** Puede confirmar todo, solo esta propuesta, o desmarcar
   casos parecidos. Si el plan no es lo que quiso decir, vuelve a explicar. La explicación nunca cambia el grafo por sí
   sola, y el plan tampoco. Se mantiene la Decisión 2: el agente solo propone.
4. **Los criterios son conocimiento curado (ADR-052, Decisión 4).**
   - Un criterio confirmado se guarda como una entrada de la base de conocimiento con el tema `grafo`. La fuente es
     `graph-curator:explanation` y la referencia es la propuesta. Lleva quién lo dijo y cuándo.
   - Pasa por los mismos estados (propuesto, verificado, firmado, retirado) y se retira desde la consola cuando deja de
     valer.
   - No hace falta una tabla nueva en Core: la base de conocimiento ya es genérica.
5. **El curador usa los criterios firmados.**
   - Las tareas de revisión y de clasificación reciben como entrada los criterios firmados del tema `grafo`.
   - Cada veredicto que se apoya en un criterio lo cita, igual que cita la ficha. `checkReview` acepta esa evidencia
     solo si el criterio existe y está firmado.
   - Así no vuelve a proponer lo que la persona ya explicó.
   - Estos criterios son del curador. Pesín no lee hoy la base de conocimiento; si algún día la lee, el tema `grafo`
     queda fuera. Lo que el criterio cambia le llega a Pesín por el grafo firmado.
6. **Qué se guarda y qué no.**
   - Se guardan la explicación (en la nota de la decisión de la propuesta), el plan validado y el criterio.
   - No se guarda el razonamiento del modelo (Constitución).
   - La explicación es de un operador identificado (ADR-050). La salida del modelo no es confiable: el plan se valida
     contra la lista de propuestas abiertas, y un caso parecido que no existe o no está abierto se descarta.
7. **Costo y evaluación.**
   - Interpretar es una llamada al modelo, de unos 10.000 tokens y menos de US$0,01. Lleva su propio tope diario,
     aparte del tope por corrida de la Decisión 5.
   - Las explicaciones confirmadas y corregidas forman el conjunto de regresión de la interpretación: un plan corregido
     es un caso fallido.

## Decisión 12 — Una revisión que se entienda (enmienda del 2026-11-25)

Hallazgo del owner del 2026-11-25, después de la primera revisión del agente (G4b): las propuestas «están difíciles de
interpretar, incluso para mí, que lo diseñé». Hay ~1.050 propuestas abiertas, con códigos de regla y áreas en vez de
preguntas. La Decisión 4 cambia así:

1. **Cada propuesta es una pregunta.** No se muestra «`AGENT_REMOVE_RELATION` · sub», sino:
   > «Si un cliente busca la **Polea de Muro** y está agotada, ¿le ofrecerías la **Polea Alta/Remo**?»

   Cada pregunta muestra la foto, el precio y el link de los dos productos, y tiene los botones **Sí**, **No** y
   **Explicar** (Decisión 11). La pregunta sale de una plantilla por tipo de relación, en código y sin modelo, con las
   etiquetas legibles del grafo.
2. **El efecto, en palabras, antes de decidir.** Por ejemplo: «Si dices No, Pesín deja de ofrecerla como reemplazo».
   También muestra la razón y la evidencia citada por el curador, con el dato de la ficha resaltado.
3. **Separadas por cuánto importan:**
   - **Cambian lo que hace Pesín:** quitar o agregar relaciones, reemplazos y tipos de producto. Van primero, de una en
     una.
   - **Trámite:** las confirmaciones (`mark_reviewed`), que no cambian lo que hace Pesín. Se muestran como bloque. La
     consola muestra una muestra al azar y ofrece «Aprobar todas», con la Decisión 4.2.
   - **Avisos sin cambio:** van a un resumen y no piden decisión.
4. **Orden dentro de cada grupo:** primero los productos que más le consultan a Pesín, como en G4b.
5. **Contadores que se entiendan:** «Te quedan 30 preguntas que cambian lo que hace Pesín» en vez de «1.051
   propuestas».
6. **La consola es de otra sesión.**
   - R4 entrega en la API la pregunta, el efecto y el grupo ya armados, para que la consola solo los muestre.
   - Así la plantilla vive en el paquete, con pruebas, y no se duplica.

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
| **G2b** | Pasar al paquete las reglas de compatibilidad de la revisión del grafo: propone las relaciones y los reemplazos de un producto nuevo, y cuenta cuántas relaciones desbloquea cada dato faltante. **Grupos musculares** (Decisión 8): el campo en el esquema, las reglas que los asignan y la regla de reemplazo que compara grupos | No |
| **G3** | Consola: propuestas, aprobación por lote y firma de versiones. Horario semanal | No |
| **G4** | Revisión por lotes de las propuestas sin firmar. El modelo clasifica lo que ninguna regla clasifica, siempre con evidencia | Sí, con tope |
| **G5** | Las herramientas del chat web leen la versión firmada (junto con su paso a `main`) | No |
| **G6** | Consulta al responsable (Decisión 7): las dudas que el grafo no responde van al vendedor o al product manager, y su respuesta vuelve como propuesta. Depende de ADR-056 y del alta de los operadores | No |
| **G7** | Conversar con el curador y revisión legible (Decisiones 11 y 12). **G7a**, R4: preguntas, efecto y grupos en la API, plantillas con pruebas, sin modelo. **G7b**, R4: «Explicar» → tarea `graph.interpret_explanation` → plan, y criterios en la base de conocimiento usados por las tareas. **G7c**, consola: la vista nueva, en la sesión de consola, con el contrato de G7a y G7b | G7b sí, con tope diario |

## G1 — implementación (2026-11-23)

- **Core, migración `0023_artifacts`:**
  - `artifact_versions`: versiones inmutables por tipo, con contenido JSON opaco y su hash (lo calcula la base);
  - `artifact_signatures`: registro append-only de firmas, con la versión que cada firma reemplaza.
  - La versión vigente de un tipo es la firmada al último. Volver atrás es firmar de nuevo una versión anterior.
  - `PostgresArtifacts` (`createVersion`, `sign`, `current`) no interpreta el contenido ni revisa ámbitos: eso lo
    hace quien llama (la consola, desde G3).
- **Paquete `agents/graph-curator`** (`@r4-graph/curator`), fuera de Core:
  - el esquema del grafo: el formato que ya leen las herramientas del chat web, más `unreviewed` (las relaciones
    publicadas sin revisar, como `[área, a, b]`);
  - el esquema valida que cada vecino sea un producto, que cada área tenga etiqueta y que cada marca sea una relación
    publicada en ambas direcciones;
  - `readSignedGraph`: lee y valida la versión firmada vigente;
  - `importSignedGraph`: guarda y firma; es idempotente.
- **Importar la línea base:** `R4_DATABASE_URL=… npm run graph:import -- --graph <grafo.json> --unreviewed
  <marcas.json> --signed-by <operador> --note <texto>`. Imprime conteos y hash, nunca el contenido.
  - Prueba sobre una base local con el grafo real: 1.093 productos, 23.494 relaciones, 10.649 sin revisar, 173 kB;
    la segunda corrida no crea ni firma nada.
  - En producción corre solo con un OK aparte del owner.
- **Sin cambios para Pesín:** las herramientas siguen leyendo `R4_EXP_GRAPH_FILE` hasta G5.

## G2 — implementación (2026-11-23)

- **Una corrida a pedido, sin modelo:** `npm run graph:curate -- --started-by <operador>`.
  1. Lee la versión firmada.
  2. Recorre las fichas de Catalog V2. Lee cada producto del grafo y sigue por las claves más altas hasta 150 seguidas
     que no son productos. Hace 2 lecturas a la vez.
  3. Aplica las reglas y guarda la corrida con lo que encontró.

  No cambia el grafo.
  - Una lectura que falla no concluye nada.
  - Si fallan más del 5 % de las lecturas, la corrida queda como fallida y sin hallazgos.
- **Esquema `graph` del paquete** (migración `0024_graph_curation`, que se aplica con `npm run graph:migrate`):
  - `curation_runs` guarda las corridas;
  - `curation_findings` guarda los hallazgos, inmutables, cada uno con una huella (tarea, regla, producto,
    relacionado) para reconocerlo en otra corrida.
- **Reglas:**

  | Tarea | Reglas |
  |---|---|
  | Productos nuevos o cambiados | `NOT_IN_GRAPH`: activo y fuera del grafo, nuevo o sin relaciones. `DISCONTINUED`: activo en el grafo, pero inactivo o fuera del catálogo. `REACTIVATED`. `RENAMED` |
  | Datos faltantes | `SPEC_MISSING`: la ficha no declara el dato que su tipo necesita; primero los vendibles. Discos y collarines: diámetro interno. Barras: diámetro de manga y largo de agarre. Racks y sus accesorios: perfiles. Bancos: peso máximo |
  | Inconsistencias | `INACTIVE_WITH_RELATIONS`, `SELLABLE_UNRELATED`, `NO_SELLABLE_SUBSTITUTE`, `SUBSTITUTE_KIND_MISMATCH` (reemplazo de otro tipo), `SUBSTITUTE_AND_COMPLEMENT` (un par que es reemplazo y complemento a la vez) |

- **Lo que G2 todavía no hace, y dónde queda:**
  - **Proponer las relaciones de un producto nuevo.** Exige pasar al paquete las reglas de compatibilidad de la
    revisión del grafo (`propose-relations` y `propose-substitutes`, unas 50 reglas). Queda como G2b.
  - **Cuántas relaciones desbloquearía cada dato faltante.** Depende de esas mismas reglas; también va en G2b.
  - **Agente con worker y definición propios** (Decisión 2). Hoy no hace falta, porque no hay modelo. Llega con G4,
    cuando entra el modelo. El horario semanal llega con G3.
- **Prueba en seco** con el grafo real y una copia local de fichas, que no sabe bien qué productos están activos:
  - salió `PLATE_MACHINE`, porque son máquinas que se cargan con discos, no discos;
  - la regla de producto nuevo pasó a `NOT_IN_GRAPH`, porque el grafo solo incluye productos con relaciones.
  - Los conteos reales salen de la primera corrida en producción.

## G3 — implementación (2026-11-23)

- **Core, migración `0025_artifact_proposals`:** propuestas de cambio a un artefacto, genéricas.
  - Cada una guarda su resumen, su evidencia y un cambio opaco que Core no interpreta. Un cambio nulo es informativo.
  - Estados: `proposed` → `approved` | `rejected`, por una persona → `applied`, cuando entra en una versión.
  - Puede haber una sola propuesta viva o rechazada por huella: un hallazgo se propone una vez, y uno rechazado no
    vuelve.
  - `artifact_proposal_events` guarda la historia, append-only.
- **API para la consola:**
  - Lecturas: `GET /v1/artifacts/:kind/versions` (incluye las no firmadas) y `GET /v1/artifacts/:kind/proposals?state=`.
  - Escrituras de operador firmado: `POST /v1/artifacts/:kind/proposals/decide` (`artifact.curate`, por lote de hasta
    1.000) y `POST /v1/artifacts/:kind/sign` (`artifact.sign`).
- **Paquete:**
  - `graph:curate` propone cada hallazgo con su cambio y su efecto:
    - descontinuado o inactivo con relaciones → desactivar y quitar sus relaciones;
    - reactivado → activar;
    - renombrado → nombre nuevo;
    - «Lo reemplaza» entre tipos distintos, o que también es complemento → quitar ese reemplazo;
    - el resto es informativo.
  - `graph:compose` arma la versión siguiente: la firmada más los cambios aprobados. La deja **sin firmar** y marca
    esos cambios como aplicados.
  - **Firmar en la consola publica.** Las herramientas de Pesín la leerán desde G5.
- **Corrida semanal:** domingo a las 22:00, hora de Santiago (decisión del owner).
  - pm2 lanza `ops/graph-curator/weekly-curate.sh` cada hora, y el script solo corre el curador en esa hora. Así el
    cambio de horario de Chile no exige editar nada.
  - Corre como `schedule:weekly` y solo propone.
  - Por ahora no es la primitiva Schedule de Core: no abre tareas, porque el curador todavía no es un agente (G4).
- **Consola** (repositorio de la consola):
  - lista de propuestas por tarea y regla, con aprobación o rechazo por lote;
  - botón «Armar versión», que corre `graph:compose` como trabajo del host;
  - versiones sin firmar, con botón de firma;
  - el operador necesita `artifact.curate` y `artifact.sign` en su registro.

## G3, corrección: los avisos siguen lo que el curador encuentra (2026-11-23)

Observación del owner: un aviso marcado «visto» no volvía nunca, aunque el problema siguiera. Por ejemplo, una ficha
sin perfiles quedaba olvidada.

- **Migración `0026_artifact_proposal_resolution`:** agrega el estado `resolved`.
- **Al guardar una corrida:**
  - lo nuevo queda propuesto;
  - lo que sigue propuesto se actualiza con los datos de la última corrida;
  - **un aviso marcado visto o rechazado se reabre** si se vuelve a encontrar;
  - un cambio ya decidido no cambia: el rechazo del owner se mantiene.
- **Lo que la corrida ya no encuentra se cierra solo (`resolved`):** lo propuesto, y los avisos vistos o rechazados.
  Si reaparece más adelante, se abre una propuesta nueva.
- Así un aviso no necesita «visto»: sigue abierto mientras el problema exista.

## G2b-1 — implementación (2026-11-23)

- **Altas por analogía, no copiando las reglas una a una.**
  - Casi todas las reglas de la revisión clasifican por el «species» PRG y por la ruta completa de categorías, y
    Catalog V2 no entrega ninguno de los dos para un producto nuevo. Copiarlas habría dejado sin clasificar justo a
    los productos nuevos.
  - **Tipo:** las reglas por nombre y categoría que no necesitan «species» (`classify.ts`). Si ninguna aplica, el tipo
    que tienen al menos 3 hermanos de su categoría en el grafo, con un 60 % o más.
  - **Relaciones de uso, complemento y orden** (`nu`, `ec`, `st`): las que ya tiene al menos la mitad de sus pares, es
    decir, los productos del mismo tipo y, si alcanzan, de la misma categoría. Cada relación cita «N de M productos
    parecidos ya lo tienen».
  - Así se reproduce lo que el owner ya aprobó, sin inventar reglas: rodilleras → racks de sentadilla, Bosu →
    colchonetas.
  - **El calce físico nunca se infiere por analogía** (barra–disco, racks, collarines, accesorios): queda para G2b-2.
  - **Reemplazos:** los grupos de `propose-substitutes`, que solo necesitan tipo y nombre. Hasta 3 vendibles, de
    precio más cercano.
  - Una propuesta `ADD_PRODUCT` agrega el producto con sus relaciones.
  - Servicios, vestuario y cámara hiperbárica, o un alta sin nada que agregar, siguen como aviso `NOT_IN_GRAPH`.
- **Grupos musculares** (Decisión 8):
  - por nombre en máquinas, con la tabla de músculos de `propose-substitutes`; un grupo específico reemplaza a
    «cuerpo completo»;
  - por tipo en el resto;
  - los accesorios no llevan grupo;
  - la propuesta `SET_MUSCLES` va por producto, para aprobarla por lote.
- **«Lo reemplaza» entre tipos distintos** se marca solo si no comparten un grupo **específico**. «Cuerpo completo»
  es demasiado amplio. En el grafo actual, de 139 pares: 112 comparten un grupo específico, por ejemplo jalón ↔ remo,
  ambos espalda, y ya no se marcan; 27 comparten solo «cuerpo completo» y siguen marcados.
- **Queda para G2b-2:** las reglas de calce físico y cuántas relaciones desbloquea cada dato faltante.

## Decisión 9 — implementación (2026-11-23)

- **Core, migración `0027_artifact_version_base`:**
  - `artifact_versions.base_version` es la versión sobre la que se armó cada versión, e `includes` son las propuestas
    aprobadas que contiene.
  - `sign` marca esas propuestas como `applied` al firmar, no al armar.
  - `sign` rechaza con `stale_base` una versión que nunca se firmó y se armó sobre otra versión que la vigente.
    Volver a firmar una versión ya firmada sigue permitido, para ir atrás.
  - `versions` marca `stale` las versiones en esa situación.
  - Estado nuevo `undone`: conserva la huella, así que el curador no vuelve a proponer ni a aplicar el cambio.
  - `markUndone` y `version(kind, n)`.
- **Paquete:**
  - `applyAutomatic` corre al final de cada corrida. Aprueba las propuestas de `AUTO_RULES` como `graph-curator:auto`,
    arma una versión **solo con lo que aprobó el curador** y la firma.
  - `composeNextVersion` registra la versión base y lo que incluye.
  - `undoChange` y `npm run graph:undo -- --proposal <id> --by <operador>`:
    - devuelven los productos que tocó el cambio a como estaban en la versión base, con su ficha, sus relaciones y sus
      marcas;
    - firman como la persona;
    - marcan el cambio `undone`.
- **Consola:**
  - el resumen semanal son las propuestas `applied` o `undone` decididas por `graph-curator:auto`;
  - «Deshacer» corre `graph:undo` como trabajo del host;
  - una versión `stale` muestra «volver a armar» en vez de «firmar».

## Decisión 10 — implementación (2026-11-24)

- **Core, migración `0028_artifact_facts`:** `artifact_facts` es genérico. Guarda tipo, sujeto, campo, valor, origen,
  nota, quién y cuándo, y Core no interpreta nada de eso.
  - Es append-only: el hecho vigente de un sujeto y campo es la última respuesta.
  - `PostgresArtifactFacts`: `record`, `current` (opcionalmente de un sujeto) y `history`.
- **API:**
  - `GET /v1/artifacts/:kind/facts?subject=` (lector de servicio);
  - `POST /v1/artifacts/:kind/facts` (operador firmado con `artifact.curate`) con `{ subject, field, value, source?,
    note? }`. Responde 201 con el hecho; `recordedBy` es el operador.
- **Curador:** cada corrida lee los hechos y los suma a las fichas (`withFacts`).
  - Un hecho completa un campo que la ficha no declara. Si la ficha ya lo declara, la ficha manda.
  - El aviso de dato faltante se cierra solo en esa misma corrida.
  - Cada hecho que la ficha todavía no tiene es un aviso `FACT_NOT_IN_SHEET` («está en R4, falta cargarlo en la
    tienda»). Esa es la lista para corregir la tienda en lote, y se cierra sola cuando la ficha trae el dato.
- **Consola:**
  - bandeja «Datos que faltan»: los `SPEC_MISSING` abiertos, con un campo por dato que hace `POST …/facts`, con
    sujeto = producto y campo = el dato que falta;
  - lista para exportar: los `FACT_NOT_IN_SHEET` abiertos.
- **Pesín** usará los hechos cuando lea el grafo firmado (G5). Las consultas de Pesín que terminan en un hecho son
  G6 (Decisión 7).

## G5 — implementación (2026-11-24)

- **Fuente del grafo:** `catalog.build_step`, `catalog.replacements` y `catalog.set_complements` leen el grafo a
  través de una fuente (`GraphSource`): un archivo, o una fuente viva. Cada llamada lee la versión que la fuente tiene
  en ese momento.
- **`SignedStoreGraph`, en el paquete de Ventas:**
  - al arrancar, el worker web carga la última versión firmada del tipo `product-graph`. Una versión mal formada
    detiene el arranque;
  - cada 10 minutos busca una versión más nueva, así que lo que el curador publica el domingo llega sin reiniciar;
  - una lectura fallida o mal formada conserva la versión en uso y queda en el log.
  - El código de Ventas no toca la persistencia: la lectura de Core la arma el CLI del worker (`cli/production.ts`),
    como exige el contrato de límites de Ventas.
- **Respaldo:** si no hay ninguna versión firmada, se usa el archivo `R4_EXP_GRAPH_FILE`, como antes.
- **Efecto con la versión 2:** Pesín deja de proponer productos inactivos o descontinuados (unas 8.350 relaciones
  menos) y usa los nombres corregidos.
- **Queda pendiente:** que Pesín use también los hechos de la Decisión 10. Leen la ficha en vivo desde Catalog, y
  sumar los hechos a esa lectura es un cambio del adaptador de catálogo de Ventas. Queda como G5b.

## G5b — implementación (2026-11-24)

- **`catalogWithFacts`**, en el paquete de Ventas, envuelve el puerto de catálogo que lee Pesín.
  - Cada ficha de producto (`getProductContext`) recibe, como especificaciones, los hechos que una persona respondió en
    R4 para campos que la tienda no declara.
  - Si la tienda ya declara el campo con valor, manda la tienda. Es la misma regla del curador.
  - La búsqueda y las variantes pasan sin cambios.
- **`ProductFactsSource`:**
  - el worker carga los hechos vigentes al arrancar y los relee cada 10 minutos;
  - una lectura fallida conserva los hechos en uso;
  - si la primera lectura falla, Pesín arranca solo con las fichas, como antes.
  - La lectura de Core la arma el CLI del worker, por el contrato de límites de Ventas.
- **Alcance:** todos los workers con catálogo real, es decir, WhatsApp y chat web. Lo que se responde en R4 es un dato
  de producto, igual para los dos canales (Decisión 10).
- **Efecto:** ninguno hasta que alguien responda un dato. Desde ese momento, Pesín lo usa a más tardar 10 minutos
  después.

## G2b-2 — implementación (2026-11-24)

- **Reglas de calce físico** (`fit.ts`). Vienen de la revisión del grafo: `review-bar-plate`, `review-collar-rackbar` y
  la capa de entrenador de `final-decisions`, con criterio delegado del 2026-11-17. Solo usan datos declarados.
  - **Barra ↔ disco** (`bpc`; a es la barra): calza con 0 a 3 mm de holgura entre el orificio y la manga, según la
    propuesta PRG-D5. Una barra de técnica o junior va solo con discos de caucho, y un par de discos no puede superar
    la carga máxima declarada de la barra. Los packs y los soportes se saltan.
  - **Barra ↔ collarín** (`col`; a es la barra): calza si el collarín mide hasta 1 mm más que la manga. Entre 1 y 5 mm
    también entra, porque los collarines de palanca, aluminio o magnéticos aprietan esa diferencia. Si es más chico
    que la manga, o más de 5 mm más grande, no calza.
  - **Rack ↔ barra** (`rb`; a es el rack): no se aceptan las barras que declaran «no apta para racks» ni las
    infantiles. Calza si el agarre es mayor o igual a la medida mayor del rack, o si es una barra estándar de 128 cm
    o más.
- **Lo que propone** (ninguna regla automática; todo espera a una persona):
  - `FIT_MISSING_PLATES`, `_COLLARS` y `_BARS`: por barra o por rack, los calces declarados que el grafo no tiene. El
    cambio es `add_relations`, con hasta 60 por propuesta, y deshacerlo quita solo lo que la base no tenía.
  - `FIT_CONTRADICTED`: una relación publicada que los datos declarados contradicen, con `remove_relation`.
- **Cuánto desbloquea cada dato faltante:** cada par que queda sin decidir por un dato suma a ese producto y a ese
  campo. `SPEC_MISSING` lo muestra («desbloquea N relaciones») y se ordena primero por vendible y después por esa
  cifra. Las barras preolímpicas entran a los datos requeridos (diámetro de manga).
- **Core:** una propuesta abierta que se vuelve a encontrar se refresca también con su cambio más reciente, por
  ejemplo cuando llegan más discos que calzan.
- **Prueba en seco** con el grafo real y una copia local de fichas: barra–disco y barra–collarín ya están completos,
  sin contradicciones. Al rack «Squat Rack Lite Series» le faltan 16 barras. Completar el largo de agarre de la «Barra
  Olímpica Power Bar 20kg» desbloquea 18 relaciones. Desde aquí, las corridas semanales vigilan los productos nuevos
  y los datos que cambien.

## Decisión 9, corrección: un producto reactivado recupera sus relaciones (2026-11-24)

- **Qué es «inactivo»:** el producto está desactivado en la tienda, según el indicador `status.active` de Catalog, o
  ya no está en el catálogo. **No** es falta de stock. El stock (`sellability`) no vive en el grafo: las herramientas
  lo leen en vivo.
- **El vacío:** al desactivarse, el producto pierde sus relaciones automáticamente. Al reactivarse, `REACTIVATED` solo
  volvía a marcarlo activo, y quedaba sin relaciones.
- **La corrección** (pregunta del owner, 2026-11-24):
  - el curador busca en el historial, hasta 20 versiones, la última versión en que el producto estaba activo y con
    relaciones;
  - el cambio `activate` lleva esas relaciones (`restore`), salvo las que son con productos que hoy no están activos;
  - sigue siendo automático. «Deshacer» lo revierte entero: el producto vuelve a como estaba en la versión base.
- **Forzar una lectura:** correr el curador a pedido (unos 15 segundos). El chat web toma la versión nueva en menos
  de 10 minutos.
- **El cruce entre Catalog y el grafo** es por la clave del producto (el ID de PrestaShop, `P…`).
- **Lo que el grafo no limita:** que el grafo diga «inactivo» solo afecta lo que Pesín sugiere a partir de otro
  producto (armar, complementos, «Lo reemplaza»). La búsqueda, Discover y la ficha se leen en vivo.

## G4a — el agente clasifica lo que ninguna regla clasifica (2026-11-24)

Decisiones del owner del 2026-11-24:
- los lotes se ordenan por lo más consultado a Pesín, no por ventas, porque R4 no tiene datos de ventas;
- el modelo primero clasifica productos y después revisa relaciones (G4b);
- corre como un agente R4, con runs gobernados.

- **Agente `graph-curator` v1:**
  - es un archivo candidato `candidates/graph-curator.v1.candidate.json`, así que la API no lo registra sola; lo
    registra `npm run graph:agent-bootstrap`;
  - tipo de tarea `graph.classify_product` y ámbito `graph.read`;
  - presupuesto de 30.000 tokens y 4 llamadas al modelo por tarea, sin escrituras ni delegación.
- **Capacidades de solo lectura:**
  - `graph.product_sheet`: la ficha de Catalog V2, con los hechos de la Decisión 10 para los campos que la tienda no
    declara;
  - `graph.kinds`: la lista cerrada de tipos que ya usa el grafo, con ejemplos.
- **Worker propio** (`npm run graph:agent-worker`): atiende solo tareas de `graph-curator` (`servedAgents`), así que
  nunca toma tareas de Pesín y Pesín no toma las suyas. Tiene su propia cuota del límite por minuto del modelo.
- **El modelo nunca escribe:** termina con su clasificación en `result.data`. El curador (`npm run graph:classify`) la
  verifica con `checkClassification` antes de proponer:
  - el tipo debe estar en la lista cerrada;
  - toda clasificación necesita evidencia;
  - cada evidencia (campo y valor) tiene que aparecer en la ficha.

  Lo que pasa la verificación se propone como `AGENT_KIND` (`set_kind`) y `AGENT_MUSCLES` (`set_muscles`), con la
  evidencia citada, la confianza y la tarea, para que una persona lo apruebe. Lo que no pasa se rechaza con su motivo
  y nunca se propone.
- **Tope de US$1 por corrida** (decisión 3): la plataforma registra tokens, no dinero.
  - El tope se convierte en número de tareas con el precio por millón de tokens del modelo
    (`R4_GRAPH_MODEL_PRICE_PER_M_USD`, el mayor entre entrada y salida). Con GPT-6 Luna (US$0,10 / 0,50) caben 66
    productos por corrida.
  - Cada tarea recibe su presupuesto completo; no se acorta. Una tarea que igual se queda sin presupuesto queda
    bloqueada y el lote la cuenta como rechazada.
  - El mismo producto sobre la misma versión firmada es una sola tarea (clave de idempotencia): un lote repetido no
    duplica tareas.
- **Orden:** lo más consultado a Pesín en los últimos 90 días (lecturas de `catalog.get_product_context`), después lo
  más relacionado.
- **Evaluación:** `checkClassification` es la evaluación determinista de cada resultado, y sus casos son el conjunto de
  regresión (`tests/unit/graph-curator/agent.test.ts`). La tasa de rechazo por regla se ve en la consola, por
  decisión del owner.
- **Puesta en producción** (con OK del owner):
  1. desplegar;
  2. `graph:agent-bootstrap`;
  3. un proceso pm2 `r4-graph-curator-worker` con las variables del modelo y de Catalog V2, `R4_WORKER_ID` propio,
     `R4_MODEL_MAX_REQUESTS_PER_MINUTE=2` y sin escrituras;
  4. un primer `graph:classify`.
- **Queda para G4b:** revisar por lotes las 10.150 relaciones sin revisar.
- **Primer lote en producción (2026-11-25):** solo 2 de los 839 productos activos no tenían tipo; las reglas ya
  clasificaban el resto. Salieron 3 propuestas y ningún rechazo.

## G4b — el agente revisa las relaciones sin revisar (2026-11-25)

- **Agente `graph-curator` v2** (la v1 queda registrada: las definiciones no cambian). Agrega el tipo de tarea
  `graph.review_relations`, sube el presupuesto a 60.000 tokens y la ventana de contexto a 24.000. La clasificación
  sigue con 30.000 tokens por tarea.
- **Una tarea = hasta 10 relaciones de un mismo producto.** Ese producto es, de los dos extremos, el que más le
  consultan a Pesín; los grupos van en ese orden y después por cuántas relaciones tienen. La entrada trae cada relación
  con su significado legible («Barra → Discos para cargarla → Disco»).
- **Capacidad `graph.product_sheets`:** hasta 12 fichas en una lectura, así que revisar diez relaciones cuesta una
  llamada al modelo y no once.
- **Veredicto por relación:** `keep`, `remove` o `unsure`, con una razón y evidencia literal de la ficha del producto
  que cita (a o b). `checkReview` verifica cada veredicto por separado:
  - que sea de una relación de la tarea, y una sola vez;
  - que `keep` y `remove` traigan evidencia;
  - que cada evidencia sea de a o de b y aparezca en su ficha.

  Un veredicto que no pasa se rechaza solo, con su motivo. Una forma inválida rechaza el resultado completo.
- **Propuestas, todas para una persona:**
  - `AGENT_REMOVE_RELATION`, una por relación (`remove_relation`);
  - `AGENT_CONFIRM_RELATIONS`, una por tarea, con las relaciones confirmadas: el cambio nuevo `mark_reviewed` les
    quita la marca «sin revisar» sin tocar las relaciones. Deshacerlo devuelve la marca.
  - `unsure` no propone nada: la relación sigue marcada para una persona.
- **No se paga dos veces:** las relaciones de una tarea de revisión terminada no vuelven al modelo, en ninguna
  versión. La clave de idempotencia es el conjunto de relaciones, así que una corrida que dejó de esperar retoma sus
  tareas sin duplicarlas.
- **Tope de US$1 medido con lo gastado de verdad:** las tareas salen en olas (4 por defecto). Después de cada ola, la
  corrida suma los tokens de entrada y de salida que la plataforma registró para sus tareas, con los precios del modelo
  (`R4_GRAPH_MODEL_PRICE_IN_PER_M_USD`, `R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD`). La ola siguiente sale solo si el tope
  cubre la ola completa en el peor caso: cada tarea con todo su presupuesto, al precio mayor. Así el tope nunca se pasa.
  En G4a, una clasificación real costó US$0,002, cerca de 4,5 veces menos que la estimación fija.
- **A pedido:** `npm run graph:review -- [--wave 4] [--per-task 10] [--wait-min 60]` (hasta 180 minutos). Con un tope
  de 2 llamadas por minuto, el worker hace cerca de una tarea por minuto, así que conviene subirlo para esta tarea.
- **Evaluación:** los casos de `checkReview` son el conjunto de regresión (`tests/unit/graph-curator/review.test.ts`).
  La integración `graph-curator-agent` prueba el ciclo con un modelo guionado: quita la relación citada, confirma la
  otra, rechaza la evidencia inventada, no repite relaciones ya juzgadas y no parte si el tope no cubre una tarea.

## Fuera de alcance

- Escribir en Catalog o en PrestaShop, o corregir fichas. R4 sí guarda los datos que el responsable le responde
  (Decisión 10), y la ficha se corrige fuera de R4.
- Publicar una versión sin firma de una persona, salvo la de los cambios automáticos (Decisión 9), firmada por el
  curador.
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
6. **Corrida semanal:** domingo a las 22:00, hora de Santiago (G3).
7. **Grupos musculares:** se suman al grafo junto con G2b (Decisión 8).

## Decisiones abiertas (owner)

1. **Cómo le llega la consulta al product manager**, que trabaja en ClickUp.
   - Se propone que la pregunta y la respuesta vivan en R4: R4 crea una tarea en ClickUp como aviso, con un link para
     responder en la mesa.
   - La alternativa es que el PM responda en ClickUp y R4 lea la respuesta con un webhook. Esto exige una integración
     de ida y vuelta.
2. **Quiénes son el vendedor y el product manager** que se dan de alta como operadores.
3. ~~Día y hora de la corrida semanal~~: cerrada, domingo 22:00 (decisión 6).
4. **Tope diario para interpretar explicaciones** (Decisión 11). Se propone US$0,25 por día, unas 25 explicaciones.
5. **Quién firma un criterio.** Se propone que confirmar el plan ya lo deje firmado si quien explica tiene
   `knowledge.sign` (hoy, el owner). Si no, el criterio queda verificado y espera la firma.
6. ~~Orden de G7a y G7b~~: cerrada, G7a primero (owner, 2026-11-25).
