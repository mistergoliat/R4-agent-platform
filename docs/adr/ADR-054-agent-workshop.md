# ADR-054 — Nuevo agente: borrador, probador y lanzamiento

- **Identificador:** `R4-WORKSHOP-01`
- **Estado:** **Propuesto** (owner, 2026-11-19: «dale, escribe el ADR-054»). Implementar cada fase necesita
  autorización explícita del owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-19. Un botón en la consola para crear agentes y probarlos, por ejemplo Don Pesín en
  Instagram, antes de que atiendan clientes.
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «las escrituras requieren ejecución
  gobernada»; «la evaluación se entrega con la implementación»; «no agregar infraestructura sin necesidad
  demostrada»); ADR-027 (ejecución shadow); ADR-049 (consola); ADR-050 (identidad de operador); ADR-052
  (lanzamientos); ADR-053 (un agente por canal).

## Contexto

Hechos verificados:
- **Una definición de agente es un archivo revisado.** Vive en el repositorio (`agents/sales/candidates/*.json`), y
  una vez registrada en `agent_definitions` es inmutable por versión. Lo que puede hacer un agente lo fija su perfil,
  en código: capacidades, bindings y políticas.
- **R4 ya sabe ejecutar sin efectos reales.** El modo shadow (ADR-027) usa el modelo real y lecturas reales
  (`live-read`), y simula las escrituras (`SHADOW_WRITE`). Las respuestas van a un sumidero y nunca a un cliente.
  Además deja un manifiesto que comprueba que no hubo efectos de producción. Hoy se usa solo desde la línea de
  comandos (`shadow:sales`), con un corpus fijo.
- **Probar una versión exige hoy una sesión de desarrollo.** Hay que editar el JSON, correr el corpus y abrir un PR.
  El owner no puede conversar con una versión antes de lanzarla.
- **Los casos que motivan esto son distintos.** «Don Pesín · Instagram» reutiliza el paquete de Ventas y sus
  capacidades: solo cambian las instrucciones y el canal. El curador del grafo, en cambio, necesita capacidades que
  R4 no tiene.

## Decisión 1 — El botón crea un borrador, nunca un agente que atiende

«Nuevo agente» crea un **borrador**: una definición propuesta que no se registra en `agent_definitions` y no atiende a
nadie. Se arma desde una plantilla:
- **«Don Pesín en un canal nuevo»** copia la definición vigente de un agente de Ventas. Se editan el nombre, el canal
  de destino (`sales-<canal>`, ADR-053), las instrucciones y los topes.
- Las demás plantillas llegan cuando existan sus capacidades (ver Decisión 6).

Un borrador tiene: la base (`agentId@version`), la identidad destino, la definición propuesta, el autor, las
revisiones y un estado: `draft`, `ready`, `launched` o `discarded`. Cada guardado crea una revisión nueva; nada se
sobrescribe.

**En la consola** (decisión del owner, 2026-11-19), la entrada es el botón «Nuevo agente», al pie del menú. No hay una
sección aparte. Un borrador en curso aparece en la lista de Agentes marcado «(borrador)», con un punto distinto al de
un agente activo. Desde su página se prueba y se lanza.

## Decisión 2 — Qué puede cambiar un borrador

Con la plantilla «Don Pesín en un canal nuevo», el borrador parte de una base y solo puede reducirla. La plantilla
«Agente en blanco» (Decisión 7) no tiene base y elige del catálogo de capacidades.

| Se puede | No se puede |
|---|---|
| Nombre visible, descripción e instrucciones | Crear capacidades, adaptadores de canal o políticas |
| Quitar capacidades de la base | Agregar capacidades que la base no tiene |
| Bajar topes (llamadas, duración, escrituras) | Subir topes sobre los de la base |
| Elegir el canal de destino | Activar el canal |

Todo esto se valida en R4 contra el esquema de definición y contra la base, no en la consola. Las instrucciones son
texto del operador y nunca se generan con el modelo en esta fase.

## Decisión 3 — El probador: conversar con el borrador en modo shadow

En la consola, el operador hace de cliente y conversa con el borrador, turno a turno:
- **Modelo real** y **lecturas reales** de catálogo, stock y despacho (`live-read`).
- **Escrituras simuladas** (`SHADOW_WRITE`): una cotización o un link de pago se muestran como «lo que habría
  emitido», sin emitirse.
- **Ninguna respuesta sale a un canal:** van al sumidero de ADR-027.
- Cada turno muestra la respuesta, los pasos (qué leyó, qué intentó escribir y qué decidió la política), el tiempo y
  el costo. Se cierra con el manifiesto shadow (`production_effects_zero`, `real_outbound_deliveries_zero`).

**Dónde corre:** en un proceso aparte, `r4-trial`, con su propia base (`r4_trial`) en el mismo Postgres. Así las
pruebas no aparecen en incidentes, calidad ni métricas de producción. El proceso escucha solo en `127.0.0.1`. Acepta la
misma aserción de operador de ADR-050, con un scope nuevo, `agent.draft`, y la consola le habla a través de su BFF
con lista permitida, como a `r4-api`.

**Gasto:** las pruebas usan modelo real. Tienen un tope diario propio (`R4_TRIAL_MAX_USD_PER_DAY`) y un límite de
turnos por minuto. Al llegar al tope, el probador se detiene y lo dice.

## Decisión 4 — Evaluación antes de lanzar

Un borrador pasa a `ready` solo si corre el corpus de regresión de su paquete (R4-G) en shadow, sin fallas críticas.
El resultado queda adjunto al borrador. Las conversaciones del probador se pueden guardar como casos nuevos del corpus.

## Decisión 5 — Lanzar es una versión revisada, no un clic que registra

«Lanzar» **no** registra la definición en producción. Arma el paquete de lanzamiento:
- el archivo candidato (`<agente>.v<N>.candidate.json`);
- la evaluación;
- el diff contra la base;
- las conversaciones de prueba.

Con ese paquete se abre el pedido de cambio (PR). Después siguen el flujo de Lanzamientos (ADR-052), la firma del owner
y el despliegue.

Un canal nuevo necesita además su adaptador y su worker (ADR-053, F4). Mientras no existan, el borrador lanzado queda
como «listo, sin canal».

## Decisión 6 — Catálogo de capacidades

R4 ya registra cada capacidad con sus esquemas de entrada y salida (`CapabilityRegistration`,
`packages/capability-runtime`). La consola muestra ese registro como un catálogo. Cada capacidad trae:
- qué hace y quién es su dueño: el paquete o el servicio;
- si lee o escribe, y su clase de riesgo;
- qué implementaciones tiene: producción, solo lectura o shadow;
- qué agentes la usan.

El catálogo es la única lista de la que un borrador puede elegir. Una capacidad que no está en el catálogo no existe
para el botón.

## Decisión 7 — «Agente en blanco»: el perfil se compone desde la definición

Hoy cada agente tiene un perfil de composición escrito a mano: qué implementación va detrás de cada capacidad, sus
políticas y su canal. Para crear un agente desde cero, R4 arma el perfil a partir de la definición:
- cada capacidad elegida trae su implementación desde el catálogo;
- las políticas parten **conservadoras**: toda escritura pide firma hasta que la autonomía suba (ADR-052);
- el disparador se elige entre tres: **conversación** (un canal), **horario** o **lote** (una lista de entradas, por
  ejemplo productos de Catalog).

**Horario necesita una primitiva nueva.** Hoy los horarios de R4 solo despiertan tareas que ya existen (`wake`,
`reconciliation`, `human_expiry`, `action_retry`). Abrir una tarea nueva por horario es una extensión genérica de
`Schedule`.

La plantilla «Agente en blanco» usa el mismo flujo: borrador, probador y lanzamiento. El probador por horario o por
lote corre una pasada sobre unas pocas entradas y muestra qué habría hecho con cada una.

## Decisión 8 — Cómo entra una capacidad nueva

Una capacidad tiene cinco piezas: contrato, adaptador al servicio dueño, política, garantías (en escrituras) y
evaluación. El camino depende del efecto:

| Efecto | Camino | Desde la consola |
|---|---|---|
| **Escribe** en un sistema real | Código: ADR, contrato con el servicio dueño, adaptador con idempotencia, recibo y reconciliación (ADR-018, ADR-019), política, evaluación y PR | Nunca. Aparece en el catálogo cuando se despliega |
| **Lee** de un servicio interno | **Conector de lectura declarativo** (propuesta, ver abajo) | Sí, con revisión y prueba |
| **Herramienta externa** (MCP u otra) | Envuelta como capacidad. Si lee, es un conector de lectura; si escribe, sigue el camino de las escrituras | Solo las de lectura |

**Conector de lectura declarativo (propuesta, decisión aparte del owner).** Desde la consola se registra una lectura:
- un host de una lista permitida;
- solo `GET`, con una ruta con parámetros tipados;
- el esquema de la respuesta;
- timeout, tamaño máximo y una credencial guardada en el servidor, nunca en la consola.

R4 la ejecuta con un adaptador genérico de solo lectura, fuera de Core:
- valida cada respuesta contra el esquema;
- rechaza lo que no calce y nunca escribe;
- la trata como dato no confiable, igual que la salida del modelo.

Un conector nuevo pasa por el probador antes de que un agente lanzado lo use, y queda en el catálogo con su autor y su
historial. Abre una puerta nueva hacia otros servicios, por eso necesita una autorización aparte del owner.

## Decisión 9 — El curador del grafo como primer «agente en blanco»

Con las decisiones 6 a 8, el curador necesita menos de lo previsto:
- **Lectura del grafo de Catalog:** un conector de lectura, si Catalog expone el grafo por `GET`. Si no lo expone, es
  un pedido a Catalog.
- **Sus propuestas quedan en R4 como artefactos**, no escritas en Catalog. `Artifact` es una primitiva permitida en Core
  que todavía no está implementada; esta sería su primera versión, mínima. Las propuestas se revisan y se aprueban en
  la consola.
- **Disparador:** por lote (productos de una categoría) o por horario (Decisión 7).

Que el curador escriba directo en Catalog sigue el camino de las escrituras (Decisión 8), más adelante.

## Core

Borrador, revisión, prueba, manifiesto, catálogo de capacidades, horario que abre tareas y artefacto son primitivas
genéricas. Las plantillas, el corpus y los bindings shadow de Ventas viven en el paquete de Ventas. El adaptador de
lectura declarativo vive en `adapters/`. Core no gana conceptos de Ventas ni de Catalog.

## Fases

| Fase | Contenido |
|---|---|
| W1 | Borradores (tabla, revisiones, validación contra la base) y pantalla «Nuevo agente» con la plantilla «Don Pesín en un canal nuevo» |
| W2 | Probador: `r4-trial` con su base, chat shadow en la consola, tope de gasto |
| W3 | Evaluación con el corpus y paquete de lanzamiento (PR) |
| W4 | Catálogo de capacidades en la consola (lectura del registro) |
| W5 | «Agente en blanco»: perfil compuesto desde la definición, políticas conservadoras, disparador por lote y por horario |
| W6 | Conectores de lectura declarativos (solo con autorización aparte) y `Artifact` mínimo |
| W7 | Curador del grafo como primer agente en blanco |

Primer caso propuesto: **«Don Pesín · Instagram»**, sin adaptador, para afinar el tono y las respuestas antes de
construir el canal.

## Decisiones abiertas del owner

1. El tope diario de gasto del probador. Propuesta: US$2 por día.
2. Si el probador usa la misma cuenta de modelo que producción o una aparte.
3. Si un borrador puede guardar conversaciones de prueba como casos del corpus sin revisión.
4. Si se habilitan los conectores de lectura declarativos, y qué hosts entran a la lista permitida.
5. Si el curador del grafo lee el grafo por un conector (Catalog expone `GET`) o por una capacidad en código.

## Fuera de alcance

- Registrar o activar definiciones desde la consola.
- Generar instrucciones con el modelo.
- Crear capacidades que escriben, o canales, desde la consola.
- Que un agente en blanco escriba sin firma: sus escrituras parten pidiendo firma.

## Consecuencias

- Probar una idea de agente deja de requerir una sesión de desarrollo. Lanzarla sigue requiriendo revisión,
  evaluación y firma.
- Se agrega un proceso (`r4-trial`) y una base (`r4_trial`). Ambos se justifican porque las pruebas no pueden mezclarse
  con las métricas de producción.
- El gasto de modelo crece con las pruebas, con un tope propio.
- Componer el perfil desde la definición reemplaza, con el tiempo, a los perfiles escritos a mano. Los perfiles
  vigentes (`sales`, `sales-web`) siguen igual hasta que una versión los migre, con su evaluación.
- Los conectores de lectura amplían lo que R4 puede leer sin código. El riesgo queda acotado: solo lectura, lista
  permitida, esquema validado y autorización aparte.
