# ADR-034 — Emisión autónoma de cotizaciones (sales-production@5)

- **Estado:** Propuesto (R4-J3E). Implementado y validado **localmente**. No desplegado y no seleccionado por ningún worker productivo.
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
