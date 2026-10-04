# ADR-032 — Adapter de producción de Shipping sobre pc-carrier

- **Estado:** Aceptado (R4-J2B/J2C). Compuesto por `sales-production@3` (R4-J2D, despliegue pendiente; ver `docs/architecture/R4-J2_SHIPPING_ROLLOUT.md`); `sales-production@1/@2` siguen con Shipping UNAVAILABLE.
- **Fecha:** 2026-10-02
- **Autoridad superior:** Constitución ("model output is untrusted"; la verdad durable pertenece a su owner); PRD; ADR-002, ADR-005, ADR-030
- **Evidencia:** `docs/architecture/R4-J2A_SHIPPING_OWNER_AUDIT.md`

## Contexto

El owner de Shipping es el microservicio productivo pc-carrier, que R4 no puede modificar. El
puerto de Shipping anterior era una forma de fixture (niveles `standard/express`, ítems enviados al
owner, ETA en días hábiles obligatoria, peso devuelto por el owner) sin correspondencia con
producción.

## Decisión

1. **pc-carrier no cambia.** R4 lo consume como owner externo, sólo por `GET /location` y
   `GET /carrier/v1/all`. El cliente (`PcCarrierClient`) expone estructuralmente sólo esas dos
   operaciones; no existe API genérica de rutas, y ninguna ruta de emisión/SAP/métodos de envío
   es alcanzable.
2. **Capas.** Sales / aplicación → `ShippingService` (puerto) → `ProductionShippingAdapter` →
   `PcCarrierClient` → pc-carrier. Los parámetros del owner (`destino`, `kilos`, `total_boleta`,
   dimensiones) no salen del adapter/cliente.
3. **Puerto.** `ShippingQuoteRequest = { destination: { commune }, basis }` con
   `basis = { type: 'reference' } | { type: 'order', totalWeightKg, declaredValueGross }`. No acepta
   carrier, nivel de servicio, instrucción tributaria, dirección ni datos del cliente.
4. **Neto del owner / bruto derivado.** `total_cost` es NETO CLP. Cada oferta conserva
   `ownerNet` intacto y agrega `customerGross = round-half-up(neto × 119/100)` bajo la política
   explícita y versionada `SHIPPING_VAT_POLICY` (`cl-iva-19@r4-j2b`), con
   `grossDerivedBy: 'r4_shipping_adapter'`. Se aplica una sola vez, siempre sobre el neto. J3 Quote
   puede tomar autoridad sobre totales finales usando el neto, la tasa y la política preservados.
   El incentivo DD (neto 1) queda en bruto 1, nunca "gratis".
5. **`total_boleta`.** Para `order`: subtotal bruto efectivo de los productos seleccionados
   (cantidad incluida, sin envío), con el `finalGross` unitario que Catalog entrega para el tramo de
   cantidad. R4 no recalcula precios de Catalog. Descuentos de carro/cotización no representados
   por Catalog quedan fuera de J2 v1. Para `reference` no se envía.
6. **Dimensiones.** Convención de producción 1×1×1 cm, fija en el cliente; R4 no infiere
   dimensiones. Subestima productos voluminosos: es una limitación conocida, compartida con todos
   los consumidores actuales.
7. **Peso.** `facts.weightKg` de producto de Catalog v2 (campo ya presente en el contrato del
   owner, ahora leído por el adapter de Catalog de R4 sin exponerlo al modelo). La capa de aplicación
   suma `peso × cantidad` en gramos enteros; peso nulo, ítem desconocido, variante requerida o
   precio no disponible fallan cerrado. No se consume Catalog v1. El adapter rechaza antes de HTTP
   todo peso ≤ 0, no finito o < 1 g (el owner los trataría silenciosamente como 1 kg y fabricaría
   una cotización).
8. **Comuna.** Resolución determinística contra `/location`: igualdad exacta tras trim, remoción de
   diacríticos Unicode y minúsculas. Sin fuzzy, sin corrección de typos, sin alias que el owner no
   tenga. Cero o varias coincidencias ⇒ `shipping_invalid_destination` y no se llama a `/all`. Se
   envía `destino=<id_comuna>`. El catálogo se lee en cada cotización (corrección sobre caché: el
   owner no publica frescura para él).
9. **Sin carrier seleccionado.** Se preservan todas las ofertas en el orden del owner (que no es un
   ranking de precio), con `ownerPosition`. El adapter no elige, no ordena ni recomienda; en modo
   `order` nadie elige la más barata automáticamente.
10. **Base de referencia.** `reference` cotiza 1 kg, 1×1×1, sin `total_boleta`, `quantity` ni
    `origin_code`. No es una tarifa mínima absoluta. La capa de aplicación expone
    `referenceLowestGross` (mínimo `customerGross` entre ofertas, fuera del adapter) para decir
    "como referencia, parte cerca de $X; el valor final depende del peso y tamaño de los productos".
    El adapter no contiene prosa para el cliente.
11. **Servicio vacío.** Comuna resuelta + `options: []` ⇒ éxito con `serviceable: false`, sin
    inventar "no soportada", "carrier caído" ni precio de respaldo (el owner no los distingue).
12. **Frescura.** El owner no entrega quote id, TTL ni validez: `ownerValidUntil = null`,
    `asOf` = momento de la respuesta. La capability declara sólo una frescura de runtime de R4
    (15 min, ADR-030) y no implica canje ni garantía en checkout.
13. **Errores tipados** (`DomainError.code`): `shipping_invalid_destination`,
    `shipping_invalid_weight`, `shipping_invalid_declared_value` (validation, antes de HTTP);
    `shipping_owner_timeout` (timeout); `shipping_owner_unavailable` (429/5xx/red);
    `shipping_owner_rejected_request` (400); `shipping_owner_unauthorized` (401/403);
    `shipping_owner_invalid_response` (otro status, JSON inválido, esquema inválido). 200 y 202 se
    aceptan como éxito. El texto de error del owner nunca se interpreta.
14. **Telemetría.** Por llamada al owner y por cotización: operación, resultado, status, duración,
    cantidad de ofertas, destino resuelto (id/nombre de comuna), tipo de base. Nunca texto del
    cliente, wa_id, nombre, teléfono ni dirección.
15. **Configuración.** `R4_SHIPPING_MODE=real`, `R4_SHIPPING_BASE_URL`, `R4_SHIPPING_TIMEOUT_MS`
    (100–10000; recomendado 5000). Sin credenciales (el owner no las pide). URL no local exige https
    y `R4_PROD_ALLOW_NETWORK=true`. `production:sales:plan` informa la configuración y que ningún
    perfil la compone.

## Consecuencias

- El puerto de fixture y el de producción son el mismo contrato; el fixture deriva el bruto con la
  misma política.
- El Quote shadow/fixture ya no lee el puerto de Shipping: usa una consulta de costo del owner
  fixture (como ya hacía con Catalog), porque cómo Quote obtiene el envío es decisión de J3 y R4 no
  elige carrier.
- Activar Shipping en producción requiere un perfil nuevo (no incluido aquí) y despliegue
  autorizado.
