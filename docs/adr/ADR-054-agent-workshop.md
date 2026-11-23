# ADR-054 — Variantes de agentes: borrador, prueba y experimento

- **Identificador:** `R4-WORKSHOP-01`
- **Estado:** **Propuesto, revisión 2** (owner, 2026-11-20: «dale, reescríbelo»). W1 (borradores) está en producción
  desde el 2026-11-19. Implementar cada fase siguiente necesita autorización explícita del owner.
- **Fecha:** 2026-11-19; revisión 2, 2026-11-20.
- **Mandato:**
  - owner, 2026-11-19: un botón en la consola para crear agentes y probarlos antes de que atiendan clientes;
  - owner, 2026-11-20: el alcance actual son **variantes de los agentes que ya existen**, por ejemplo «iterar el
    prompt para ver cuál rinde mejor». Las capacidades y los canales nuevos (Instagram) siguen el camino de siempre:
    PRD, ADR, código y evaluación.
- **Autoridad superior:** Constitución («la salida del modelo no es confiable»; «las escrituras requieren ejecución
  gobernada»; «la evaluación se entrega con la implementación»; «no agregar infraestructura sin necesidad
  demostrada»); ADR-027 (ejecución shadow); ADR-045 (carril de conversación); ADR-049 (consola); ADR-050 (identidad
  de operador); ADR-052 (lanzamientos y calidad); ADR-053 (un agente por canal).

## Qué cambió en la revisión 2

- La plantilla principal es **«Variante de un agente»**, no «canal nuevo».
- **Probar** suma la repetición de conversaciones reales, lado a lado con la versión actual.
- **Lanzar** deja de ser un PR: es un **experimento** con porcentaje de conversaciones nuevas, comparación por versión
  y decisión firmada.
- Las plantillas «Don Pesín en un canal nuevo» y «Agente en blanco», el catálogo de capacidades y los conectores de
  lectura pasan a «Más adelante». No se descartan: esperan su código.

## Contexto

Hechos verificados:
- **Una definición de agente es un archivo revisado.** Vive en el repositorio (`agents/sales/candidates/*.json`), y
  una vez registrada en `agent_definitions` es inmutable por versión. Lo que puede hacer un agente lo fija su perfil,
  **en código**: capacidades, bindings y políticas (`agents/sales/src/production/profile-v*.ts`).
- **Los borradores ya existen (W1).** Migración `0019_agent_drafts`, API `/v1/agent-drafts` y la pantalla «Nuevo
  agente» de la consola. Un borrador parte de una definición registrada y solo puede reducirla
  (`draftDefinition`, `packages/agent-registry`). Nunca se registra ni corre en producción.
- **El carril ya reparte conversaciones nuevas en dos brazos** (ADR-045, enmienda 1):
  - con carril compuesto, una conversación **nueva** abre en el perfil del carril si está en la lista permitida o si
    cae en la cohorte del porcentaje (`R4_PROD_ROLLOUT_PERCENT`). Si no, abre en el perfil principal (`laneRoute`);
  - el bucket es determinista y la asignación se guarda en la conversación (`profile`, `eligibility_reason`,
    `rollout_fingerprint`). **Una conversación abierta nunca cambia de versión**;
  - los perfiles admitidos en la cohorte son una lista fija en código (`SALES_COHORT_LANE_PROFILES`): admitir uno es
    un cambio revisado.
- **Calidad y Lanzamientos ya miden por versión** (ADR-052): embudo, traspasos, fallas, tiempos y costo por
  `agentId@version`.
- **El modo shadow existe, pero las implementaciones shadow de Ventas son de ejemplo.** ADR-027 distingue lecturas
  reales (`live-read`) de escrituras simuladas, y deja un manifiesto de cero efectos. Las implementaciones shadow del
  paquete de Ventas, en cambio, leen datos de ejemplo, no Catalog real. La composición de producción exige
  implementaciones reales (`bindingKind: 'http'`) para Quote y Checkout.
- **La repetición existe, solo con datos sintéticos.** `workloadFromReplay` (`packages/shadow`) toma solo los mensajes
  del cliente, los anonimiza y deja que el agente responda de nuevo. Nunca se ha usado con conversaciones reales: no
  había una decisión del owner al respecto.

## Decisión 1 — «Nuevo agente» crea una variante

El botón «Nuevo agente», al pie del menú, crea un **borrador**. La plantilla principal es **«Variante de un agente»**:
- copia la definición vigente de un agente que ya atiende, por ejemplo Don Pesín · WhatsApp @22;
- se editan el **nombre de la variante** («más breve», «pregunta el uso primero»), las instrucciones y los topes;
- conserva la identidad del agente (`sales`). La variante es una **versión candidata del mismo agente**, para que
  Calidad y Lanzamientos la comparen con la versión actual;
- puede haber **varias variantes abiertas** del mismo agente a la vez (A, B, C). W1 permite una sola por identidad;
  W2 lo cambia con una migración aditiva (etiqueta de variante, índice único por etiqueta).

Las reglas de W1 siguen:
- **Solo puede reducir:** quita capacidades o baja topes, nunca suma.
- **Revisiones inmutables:** cada guardado es una revisión nueva.
- **La valida R4**, no la consola.

En la consola, una variante abierta aparece en Agentes, bajo su agente, como «Don Pesín · WhatsApp · variante B
(borrador)».

## Decisión 2 — Probar: chat de prueba y repetición de conversaciones reales

Dos maneras de probar, ambas sin efectos reales:

**1. Chat de prueba.** El operador hace de cliente y conversa con la variante:
- modelo real;
- **lecturas reales** de Catalog, Discover y Despacho;
- **escrituras simuladas**: una cotización o un link de pago se muestran como «lo que habría emitido»;
- respuestas a un sumidero, nunca a un canal.

Cada turno muestra la respuesta, los pasos, el tiempo y el costo.

**2. Repetición de conversaciones reales.** La variante responde, en modo prueba, los mensajes de clientes de las
últimas N conversaciones reales del agente. Se ven **lado a lado**: lo que respondió la versión actual y lo que habría
respondido la variante.
- Solo se repiten los mensajes del cliente, **anonimizados antes de usarse** (`workloadFromReplay`). La identidad del
  cliente nunca pasa a la prueba.
- **Límite honesto:** desde el segundo turno, el cliente respondía a lo que dijo la versión actual, no a la variante.
  La comparación es más confiable en los primeros turnos. La pantalla marca cuándo la conversación ya divergió.
- Usar conversaciones reales para pruebas necesita una decisión del owner (abierta 1).

**Dónde corre:** en un proceso aparte, `r4-trial`, con su propia base (`r4_trial`) en el mismo Postgres, para que las
pruebas no aparezcan en incidentes, calidad ni métricas.
- La composición de prueba es **nueva y separada de la de producción**: usa el perfil de la base, las lecturas reales
  y escrituras simuladas para Quote y Checkout, y el sumidero de ADR-027. No modifica la composición de producción.
- El proceso escucha solo en `127.0.0.1`. Acepta la aserción de operador de ADR-050 con el scope `agent.draft`, y la
  consola le habla a través de su BFF con lista permitida.

**Gasto:** tope diario propio (`R4_TRIAL_MAX_USD_PER_DAY`) y un límite de turnos por minuto. Al llegar al tope, la
prueba se detiene y lo dice.

## Decisión 3 — Lanzar es un experimento, no un despliegue

«Lanzar» una variante abre un **experimento** sobre las conversaciones nuevas:
1. **Antes de empezar:** la variante pasa el corpus de regresión de su paquete, en modo prueba, sin fallas críticas.
   El resultado queda adjunto.
2. **Firma del owner:** elige el porcentaje (por ejemplo 20 %) y firma. Queda en la Auditoría.
3. **R4 registra la variante** como versión nueva del agente (`sales@23`) y corre **el perfil de la base con la
   definición de la variante**.
   - Es la única pieza nueva de producción: un perfil derivado.
   - Hereda capacidades, implementaciones y políticas del perfil base, que ya está admitido.
   - Como la variante solo reduce respecto de la base, queda admitida en la cohorte **por regla**: no hace falta otro
     cambio de código por cada variante.
4. **Reparto:** el carril reparte las conversaciones **nuevas** entre la base y la variante según el porcentaje, con el
   bucket determinista de hoy. Una conversación empezada termina con la versión con que abrió.
5. **Comparación:** la consola muestra, por versión:
   - cuántas conversaciones lleva cada una;
   - el embudo y cuántas llegan a cotización;
   - traspasos y fallas;
   - tiempo de respuesta y costo por conversación;
   - si **ya hay muestra suficiente** para decidir.

   Con el volumen actual, un experimento puede tardar días.
6. **Decisión firmada:**
   - **promover:** la variante pasa al 100 % y queda como versión vigente;
   - **seguir:** sigue con el mismo porcentaje;
   - **descartar:** el porcentaje vuelve a 0, sin conversaciones nuevas para la variante, y las abiertas terminan
     con su versión.

**Vuelta atrás automática:** si la variante supera un umbral de fallas o traspasos de la plataforma, el experimento
baja a 0 % solo y avisa por ntfy.

**Un experimento a la vez por agente** en esta fase. Dos variantes contra la base es una extensión posterior.

## Decisión 4 — Lo que no hace el botón

- No crea capacidades ni canales. Instagram necesita su gateway, la app de Meta y el token de la cuenta: es código y
  configuración del servidor (ADR-053, F4). Cuando el gateway exista, la consola podrá tener un paso «Conectar cuenta»
  que guarde el token en el servidor, después del código y no en su lugar.
- No suma capacidades a un agente ni sube sus topes.
- No genera instrucciones con el modelo: las escribe el operador.

## Más adelante (sin cambio de decisión)

Quedan como propuesta, para cuando exista su código. Se detallan en la revisión 1 de este ADR (PR #111):
- plantilla «Don Pesín en un canal nuevo», cuando exista el gateway del canal;
- catálogo de capacidades en la consola;
- «Agente en blanco», con perfil compuesto desde la definición y disparador por lote u horario;
- conectores de lectura declarativos, con autorización aparte;
- el curador del grafo como primer agente en blanco.

Una capacidad nueva entra siempre por el camino de siempre (PRD, ADR, contrato con el servicio dueño, adaptador,
evaluación y PR). La consola la muestra cuando está desplegada.

## Core

Borrador, revisión, prueba, manifiesto y experimento son primitivas genéricas sobre `Agent`. El perfil derivado, las
implementaciones de prueba de Ventas y el corpus viven en el paquete de Ventas. Core no gana conceptos de Ventas.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| W1 | Borradores con revisiones, validación contra la base, «Nuevo agente» en la consola | **En producción** (R4 `85ab6dd`, consola `6c4ea76`) |
| W2 | Plantilla «Variante de un agente» (varias por agente); `r4-trial` con su base y composición de prueba; chat de prueba; repetición de conversaciones reales lado a lado; tope de gasto | Propuesta |
| W3 | Evaluación con el corpus; perfil derivado; experimento con porcentaje, comparación por versión, decisión firmada y vuelta atrás automática | Propuesta |

## Decisiones del owner (2026-11-20)

1. **Repetición con conversaciones reales:** sí, anonimizadas, las últimas 20 del agente.
2. **Tope diario de las pruebas:** US$2.
3. **Cuenta de modelo:** la misma de producción (OpenRouter), con el tope diario propio de las pruebas. No había
   propuesta; se toma la opción más simple y el owner puede cambiarla.

## Decisiones abiertas del owner

1. El umbral de la vuelta atrás automática del experimento.
2. Qué cuenta como «mejor» al comparar. Propuesta: más conversaciones que llegan a cotización, sin más traspasos ni
   fallas, y el costo como desempate.

## Implementación de W2a (2026-11-20)

- Migración `0020_agent_draft_variants` (aditiva): columna `label` y un borrador abierto por agente **y etiqueta**.
- Plantilla `variant`: mismo `agentId` que la base y etiqueta obligatoria (`variant_identity` si no).
- La consola crea variantes desde «Nuevo agente». «En un canal nuevo» y «Agente en blanco» se ven deshabilitadas, con
  su razón.

## Fuera de alcance

- Registrar una definición fuera de un experimento firmado.
- Capacidades, canales o agentes en blanco desde la consola (ver «Más adelante»).
- Cambiar la versión de una conversación ya abierta.

## Consecuencias

- Iterar un prompt deja de requerir una sesión de desarrollo. Pasa por prueba, evaluación, experimento y firma.
- Las versiones nuevas de un agente pueden nacer en R4, no solo en el repositorio. Quedan registradas, firmadas y en
  la Auditoría. El repositorio sigue siendo la fuente de las capacidades, los perfiles base y las políticas.
- Se agrega un proceso (`r4-trial`) y una base (`r4_trial`). Se justifican porque las pruebas no pueden mezclarse con
  las métricas de producción.
- El perfil derivado es la única pieza nueva en el camino de los clientes. Lleva sus propias pruebas de contrato: una
  variante no puede componer nada que su base no tenga.
