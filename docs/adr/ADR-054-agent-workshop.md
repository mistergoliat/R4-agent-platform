# ADR-054 — Taller de agentes: borrador, probador y lanzamiento

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

## Decisión 2 — Qué puede cambiar un borrador

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
misma aserción de operador de ADR-050, con un scope nuevo, `agent.workshop`, y la consola le habla a través de su BFF
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

## Decisión 6 — Agentes que necesitan capacidades nuevas

El curador del grafo y otros agentes internos necesitan capacidades que R4 no tiene, y en general otro disparador: por
horario o por lote, no por conversación. Primero va su ADR y el contrato con el servicio dueño de los datos (Catalog,
para el grafo). Cuando esas capacidades existan en un paquete, el taller suma una plantilla para ellos, con su propio
probador por lote.

## Core

Borrador, revisión, prueba y manifiesto son primitivas genéricas sobre `Agent`. Las plantillas, el corpus y los
bindings shadow de Ventas viven en el paquete de Ventas. Core no gana conceptos de Ventas.

## Fases

| Fase | Contenido |
|---|---|
| W1 | Borradores (tabla, revisiones, validación contra la base) y pantalla «Nuevo agente» con la plantilla «Don Pesín en un canal nuevo» |
| W2 | Probador: `r4-trial` con su base, chat shadow en la consola, tope de gasto |
| W3 | Evaluación con el corpus y paquete de lanzamiento (PR) |
| W4 | Plantillas para agentes internos, cuando existan sus capacidades (curador del grafo) |

Primer caso propuesto: **«Don Pesín · Instagram»**, sin adaptador, para afinar el tono y las respuestas antes de
construir el canal.

## Decisiones abiertas del owner

1. El tope diario de gasto del probador. Propuesta: US$2 por día.
2. Si el probador usa la misma cuenta de modelo que producción o una aparte.
3. Si un borrador puede guardar conversaciones de prueba como casos del corpus sin revisión.

## Fuera de alcance

- Registrar o activar definiciones desde la consola.
- Generar instrucciones con el modelo.
- Crear capacidades o canales desde la consola.

## Consecuencias

- Probar una idea de agente deja de requerir una sesión de desarrollo. Lanzarla sigue requiriendo revisión,
  evaluación y firma.
- Se agrega un proceso (`r4-trial`) y una base (`r4_trial`). Ambos se justifican porque las pruebas no pueden mezclarse
  con las métricas de producción.
- El gasto de modelo crece con las pruebas, con un tope propio.
