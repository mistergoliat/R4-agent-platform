# ADR-034 — Emisión autónoma de cotizaciones (sales-production@5)

- **Estado:** **Aceptado solo para experimentación y canary** (decisión del owner, 2026-10-13). Implementado en `cc1e6c3`. Validado localmente y en un canary aislado en EC2 (R4-J3E §13). No desplegado y no seleccionado por ningún worker productivo.
- **Decisión registrada:**
  - `AUTONOMOUS_QUOTE_CANARY_APPROVED`
  - `AUTONOMOUS_QUOTE_CUSTOMER_ROLLOUT_NOT_APPROVED`
- **Bloqueo de producción vigente:** `CUSTOMER_INTENT_INDEPENDENT_EVIDENCE_REQUIRED`. La propuesta de solución está en "Evidencia independiente de intención (propuesta)".
- **Fecha:** 2026-10-13
- **Autoridad superior:** Constitución ("model output is untrusted"; "writes require governed execution"); PRD; ADR-016, ADR-017, ADR-018, ADR-029, ADR-033
- **Sustituye parcialmente:** ADR-029, en un solo punto. ADR-029 establece que `quote.create` es `REQUIRE_APPROVAL`; esa regla deja de aplicarse **solo en el perfil `sales-production@5`** y **solo para `quote.create@3`**. Para `@1–@4`, para `quote.create@2` y para cualquier otra escritura, ADR-029 sigue vigente sin cambios.
- **Evidencia:** `docs/architecture/R4-J3E_AUTONOMOUS_QUOTE_ISSUANCE_REPORT.md`

## Contexto

En `sales-production@4`, toda cotización formal (`quote.create@2`) exige que un humano apruebe los argumentos exactos (ADR-029, ADR-033). La aprobación humana valida datos comerciales (precios, despacho y totales) que el **modelo** escribió en la propuesta, y que la ejecución vuelve a verificar contra los owners.

El objetivo de J3E es emitir sin humano las cotizaciones que cumplan una política comercial verificable. El principio es **"decisión autónoma, ejecución comercial determinista"**, y debe cumplirse sin modificar el harness.

## Auditoría de compatibilidad (resumen)

| Pregunta | Hallazgo |
|---|---|
| ¿El Policy Engine permite autonomía sin cambios? | **Sí.** Las reglas se resuelven por `capabilityId`, pero el motor exige además el `approvalPolicy` de la propia capacidad (regla `capability.approval_policy`). Por eso una versión nueva con `approvalPolicy: none`, bajo una política propia del perfil, puede ser `allow` sin que `quote.create@2` (`approvalPolicy: required`) deje de exigir aprobación bajo **cualquier** política. |
| ¿La política es por perfil? | Sí. `WorkerBindings.actionPolicy` es un seam público, y la composición de Sales elige la política según el perfil. |
| ¿El versionado lo soporta? | Sí: capability `quote.create@3`, workspace `sales.workspace.update@2`, definición Sales v5 (archivo nuevo, inmutabilidad del registro) y perfil `sales-production@5` (fingerprint propio). Las huellas de `@1–@4` y de `SALES_PRODUCTION_ACTION_POLICY` no cambian; un test las fija a sus valores de `main`. |
| ¿La capacidad ve la propuesta y sus evidencias? | **No.** `WriteHandlerContext` expone el input, la clave de ejecución y el contexto confiable, pero no los `evidenceRefs`. El vínculo entre preview y emisión pasa por el input (`previewId`) y por el estado propio de Sales. |
| ¿La capacidad puede leer el texto literal del cliente? | **No.** Los inbound viven en `task_inputs`/`memory_entries` del Core. Ningún seam público (`ContextSource`, `ConversationTaskFactory`, `WorkerBindings`) los expone al pack, y leer tablas del Core desde el pack viola el límite. Ver "Límites". |

Conclusión: la autonomía cabe en extensiones existentes. **No hubo bloqueo.**

## Decisión

1. **Perfil `sales-production@5`.** Es `@4` con:
   - `quote.create` como `ALLOW`;
   - `quote.preview` como READ, en el dominio `quote`;
   - la definición Sales v5.

   Se compone solo cuando se selecciona explícitamente. Sin los límites configurados, la composición falla.
2. **Política `sales-production-autonomous-policy@1`.** Es idéntica a `SALES_PRODUCTION_ACTION_POLICY` salvo en una regla: `quote.create: allow` (con identidad `provisional` y evidencia citada obligatorias). Todas las clases de riesgo conservan el default de la plataforma, así que ninguna otra escritura se vuelve autónoma: cancelar, entregar, cobrar, comunicar o una escritura irreversible futura.
3. **`quote.preview@1` (READ, Sales).** No recibe argumentos. Construye un `CommercialSnapshot` versionado (`r4-sales-commercial-snapshot-v1`) solo desde el workspace y los owners:
   - el precio de Catalog para el tramo de cantidad, el impuesto, la vendibilidad, el stock y la frescura;
   - la oferta de Shipping elegida, recotizada;
   - la aritmética normativa de Quote V2 (`quoteV2ChargeAmounts`, `quoteV2Totals`).

   El `previewId` es el SHA-256 de la forma canónica del contenido comercial; los timestamps de los owners quedan fuera del hash. El snapshot persiste como Observation inmutable del harness, con la validez más temprana de sus evidencias. **Un `previewId` nombra un contenido; no autoriza nada.**
4. **`sales.workspace.update@2`.** Agrega tres operaciones:
   - `select_shipping_offer`: la oferta que el cliente eligió. Se recotiza contra el owner antes de escribir y se aplica solo si el workspace no cambió entretanto.
   - `exclude_shipping`.
   - `record_quote_request`: el `previewId` que el cliente pidió y sus palabras.

   Cualquier cambio de ítems, cantidades o destino borra la elección de despacho y la solicitud. Esto resuelve la debilidad documentada en J3B §432. La versión 1 no cambia.
5. **`quote.create@3`.** Su único argumento es `{ previewId }`. Usa la misma integración Quote V2 que `@2`: el mismo cuerpo (Model B), el congelamiento por clave de ejecución, `expectedTotals`, 201/202, `unknown`, la reconciliación por idempotency lookup y la verificación del PDF por SHA-256. Las funciones son compartidas, no duplicadas. En el primer intento toma una **decisión comercial determinista** y la registra:
   1. existe una solicitud del cliente para exactamente ese `previewId`;
   2. el snapshot recalculado **ahora** no tiene bloqueos y produce el mismo `previewId`; si no, `preview_stale`;
   3. respeta los límites de monto, líneas y unidades;
   4. bajo un lock: no existe una autorización previa del mismo snapshot en la conversación (además, índice único en la base) y se respetan los límites por conversación y por hora.

   La autorización se escribe en la **misma transacción** que congela el cuerpo de Quote V2 (`sales.quote_autonomous_decisions`, migración Sales `0008`, append-only). Si una condición no se cumple, la emisión se rechaza (`rejected`, sin efecto) con el motivo; **no hay fallback a una aprobación humana**.
6. **Límites como configuración.** Las variables son `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP`, `_MAX_LINES`, `_MAX_UNITS_PER_LINE`, `_MAX_PER_CONVERSATION` y `_MAX_PER_HOUR`. Todas son obligatorias y no tienen valores por defecto en el código. Los valores de producción los decide y aprueba el owner del negocio antes de cualquier rollout.
7. **Cliente.** Customer sigue UNAVAILABLE. La cotización autónoma es `guest` y no lleva datos personales: el modelo no puede aportar datos del cliente, así que no puede fabricarlos.
8. **Emisión ≠ entrega.** Nada en `@5` envía la cotización por email ni comparte el PDF. El principal de R4 conserva exactamente `quotes:create`, `quotes:read` y `quotes:document:read`.

## Límites (honestos)

- **Intención del cliente.** La solicitud (`record_quote_request`) la registra el agente con las palabras del cliente, así que está **atestiguada por el modelo**. R4 la verifica estructuralmente: debe existir, nombrar ese snapshot y quedar invalidada por cualquier cambio comercial. **No la verifica contra el texto literal del inbound**, porque ningún seam lo expone al pack. Las palabras quedan registradas para la auditoría y la evaluación post-hoc. Verificarla en runtime exigiría un seam nuevo de la plataforma (decisión del owner, fuera de J3E). Es un gate de despliegue de `@5`.
- **Concurrencia de la frecuencia.** El límite por hora y el de la conversación se cuentan en la base de datos del despliegue, bajo un advisory lock. Valen por base de datos, no globalmente entre despliegues.
- **Un snapshot autorizado no se reemite.** Si el owner rechaza definitivamente una emisión autorizada (por ejemplo un 422, que indica un defecto de R4), el mismo contenido no se reemite en esa conversación. Se prefiere la seguridad sobre la reintentabilidad.

## Evidencia independiente de intención (propuesta, no implementada)

**Hallazgo.** La auditoría de J3E concluyó que ningún seam entrega el texto del cliente al pack. Eso vale para `ContextSource`, `WriteHandlerContext` y `ConversationTaskFactory`. Pero hay un contrato existente que sí lo hace: el puerto **`ProductionStore.thread(taskId)`** de `@r4/live-ops`, implementado por `PostgresProductionStore`. Devuelve el hilo de la conversación:
- mensajes del cliente (`kind: 'contact'`, con `text`, `refs.inputId` y `at`), que el canal ya autenticó (el ingress verifica antes de parsear);
- respuestas del agente (`kind: 'agent'`, con `text` y estado de entrega).

`composeSalesProductionWorker` **ya recibe** ese `store`. Por lo tanto la evidencia de origen se resuelve con componentes Sales-owned y contratos existentes, **sin modificar el harness**.

**Propuesta (protocolo de confirmación determinista).**

1. `quote.preview` expone un `confirmationCode` derivado del `previewId`, por ejemplo `Q-` y los primeros 6 caracteres en mayúsculas. Las instrucciones v6 obligan al agente a mostrarlo junto con los totales y a pedir que el cliente lo repita para confirmar.
2. `quote.create@4` (versión nueva; `@3` queda como está) recibe un lector `Pick<ProductionStore, 'thread'>` desde la composición. En la decisión exige, además de lo que exige `@3`:
   - a. una entrada `agent` posterior al preview, con entrega no fallida, cuyo texto contenga el `confirmationCode` y el total bruto del snapshot (el cliente vio esa cotización);
   - b. una entrada `contact` **posterior** a esa respuesta que contenga el `confirmationCode` (el cliente confirmó **esa** cotización, con su propio mensaje autenticado).
3. La decisión (`0008`, o una columna en una migración `0009` nueva) registra el `inputId`, la hora de recepción y el SHA-256 del mensaje que confirmó. El texto queda en el Core y no se copia.
4. Fallas posibles: no hay código en el hilo (`customer_confirmation_missing`); el código pertenece a otro preview, o la confirmación llegó antes de la presentación (`customer_confirmation_stale`). En ambos casos la emisión se rechaza.

**Variante mínima.** Exigir que `customerWords` aparezcan textualmente, normalizadas, en una entrada `contact` posterior al preview. Esto prueba el **origen** de las palabras, pero su **significado** lo sigue interpretando el modelo. Se recomienda el protocolo con código.

**Dependencias:**
- la composición inyecta `options.store`; el canary ya compone un `PostgresProductionStore`;
- una versión nueva de la definición Sales con instrucciones para presentar y pedir el código;
- una capacidad versionada nueva (`quote.create@4`) y su perfil (`@6`), o una enmienda explícita de `@5`;
- una decisión de UX del owner: el cliente debe escribir un código;
- el canal sintético del canary pasa por el mismo `ChannelIngress`, así que el hilo es equivalente.

**Pruebas necesarias:**
- Sin código, código ajeno, código anterior a la presentación, código de otro preview, y código presente solo en la respuesta del agente: todos se rechazan.
- Una respuesta del agente con entrega fallida no cuenta.
- Mensajes duplicados y reintentos de ingress no duplican la evidencia.
- El código no se acepta si lo "dice" el modelo en `customerWords`, sino solo si aparece en el hilo.
- Concurrencia con dos previews.
- Canary EC2 con el modelo real.
- Contract: el pack solo usa `ProductionStore.thread`, sin SQL a tablas del Core.

**Fuera de alcance de esta propuesta:** la verificación semántica de la intención sin código, que exigiría NLP o un humano, y la identidad del cliente (Customer UNAVAILABLE).

## Consecuencias

- Una cotización elegible se emite sin humano, por el camino gobernado completo: propuesta → Policy Engine (`allow`, `autonomous`, política hasheada) → ActionExecutor → decisión comercial → Quote V2 → recibo.
- El harness no se modifica.
- `@1–@4` y `quote.create@2` siguen idénticos.
- Gates de despliegue de `@5` (`SALES_PRODUCTION_PROFILE_V5_GATE`):
  - aceptar este ADR;
  - aprobar los límites;
  - aplicar la migración `0008`;
  - registrar la definición v5;
  - un canary autónomo real;
  - una decisión sobre la evidencia de intención;
  - autorización explícita.
