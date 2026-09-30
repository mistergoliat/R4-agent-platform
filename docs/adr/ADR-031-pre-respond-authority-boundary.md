# ADR-031 — Frontera de autoridad previa a `respond` (enmienda acotada de ADR-025)

- **Estado:** Aceptado (R4-J1E, autorizado explícitamente por el dueño del producto)
- **Fecha:** 2026-09-30
- **Autoridad superior:** Constitución ("model output is untrusted"; la verdad durable pertenece a su owner); PRD §7; ADR-002, ADR-005, ADR-008, ADR-009, ADR-030
- **Enmienda:** ADR-025 §1, sólo en lo que aquí se define
- **Relacionado:** `docs/architecture/R4-J1D_PRODUCTION_CATALOG_CLOSURE.md` (primer E2E de WhatsApp)

## Contexto

El primer E2E real de WhatsApp (R4-J1, 2026-09-30) mostró respuestas comerciales incompatibles con la
evidencia del owner: el modelo presentó como disponible una kettlebell que Catalog informaba
`not_sellable/out_of_stock`, y varios precios salieron después del `validUntil` de su evidencia
(+8 s … +110 s), porque la ventana del owner (15 s) es menor que la latencia de un turno del modelo.
ADR-025 §1 prohíbe guards en el loop del agente; una evaluación post-hoc detecta el error, pero no
impide que llegue al cliente. Subir la ventana de Catalog está descartado: Catalog es dueño de
`validUntil` (ADR-030).

## Decisión

1. **Una sola frontera determinista, inmediatamente antes de que un `respond` sea durable.** Como
   el outbound materializa un mensaje por cada step `respond` `recorded` (ADR-029), el último punto
   donde todavía se puede refrescar evidencia o pedir una corrección al modelo es el kernel, al recibir
   la decisión. No se mueve al dispatcher de outbound: ahí ya no hay modelo ni evidencia.
2. **Seam genérico en Core** (`@r4/contracts`: `ResponseAuthorityValidator`; kernel: aplicación de
   veredictos). El kernel no conoce Catalog, precios ni stock. Veredictos:
   - `allow` → se registra el borrador tal cual.
   - `revalidation_required` → el kernel emite los READ pedidos como steps durables de
     `origin = 'platform'` (sin llamada al modelo, sin tokens; migración `0009_run_step_origin`) y
     valida **el mismo borrador** otra vez: si la verdad no cambió, se conserva y se envía.
   - `reject` → el borrador se registra `refused` (no terminal, código `response_authority_*`), nunca
     se envía y el modelo recibe el feedback estructurado (episodio `response.not_sent` en el contexto).
3. **Límites (sin loops).** Hasta 6 READ de revalidación por borrador, dentro del budget de READ.
   Un ciclo de corrección del modelo por candidato de outbound; si el borrador corregido tampoco es
   válido, se registra la degradación segura del pack (sin afirmaciones comerciales). Evidencia que no
   se pudo revalidar ⇒ `reject` (`response_authority_unverifiable`).
4. **El pack es dueño de la semántica** (Sales: `SalesCommercialEvidenceValidator`): reconstrucción
   determinista de claims anclados (montos `$`, nombres de producto observados), vinculación a la
   última observation de Catalog de la task, sellability/disponibilidad, variante ("desde"),
   frescura hasta el envío (+3 s) y clasificación de totales derivados (suma de precios de Catalog
   del mismo borrador, rotulada referencial/aproximada; nunca impuestos, descuentos, despacho ni
   reglas de negocio). Catalog sigue siendo dueño de producto, precio, promoción, sellability,
   disponibilidad y `validUntil`.
5. **Contabilidad honesta.** Los steps `platform` no cuentan como llamadas al modelo (budgets, métrica
   `model_calls`); los borradores rechazados no aparecen como respuestas dichas.

## Qué sigue prohibiendo ADR-025

Guards genéricos de calidad, reintentos arbitrarios, workflows ocultos y cualquier juez LLM dentro
del loop. Esta frontera no evalúa calidad ni estilo: sólo impide afirmar como verdad actual lo que
contradice o no puede respaldar la evidencia del owner.

## Límites conocidos

- No es un parser de lenguaje natural: afirmaciones comerciales sin ancla (sin monto ni nombre de
  producto observado) no se validan; el agente sigue siendo responsable de ellas y la evaluación
  post-hoc (ADR-025) las mide.
- La ambigüedad (mismo monto en varios productos) se resuelve con tolerancia: basta un producto
  coincidente consistente.
- Los claims permitidos se registran en telemetría (`response.authority.*`); los rechazados, en el
  step `refused`. El validador es determinista sobre estado durable, por lo que el veredicto es
  reproducible post-hoc.

## Consecuencias

- Una respuesta comercial ya no puede contradecir la sellability/variante/precio vigentes ni salir
  con evidencia vencida sin revalidar; el costo es un READ por producto vencido (≈ decenas de ms) y,
  sólo ante una contradicción real, una llamada adicional al modelo.
- Sin validador configurado (profile v1, tests, otros packs) el comportamiento es el anterior.
