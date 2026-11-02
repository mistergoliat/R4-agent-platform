# ADR-043 — Las cotizaciones ordinarias no requieren aprobación humana

- **Identificador:** `R4-COMMERCIAL-AUTONOMY-POLICY-01`
- **Estado:** **Registrado** (decisión de política del owner, «R4 — Implementation Mandate J4-R7-1», §4,
  2026-10-28). **No modifica ningún perfil existente** ni la configuración de políticas en código.
- **Fecha:** 2026-10-28
- **Autoridad superior:** Constitución; PRD; ADR-016/017 (Policy Engine), ADR-034 (emisión autónoma), ADR-035
  (verificación de intención conversacional), ADR-037 (semántica de escrituras comerciales autorizadas)
- **Relacionado:** ADR-042 (R4-OWNER-COLLABORATION-01), R4-J4-R7 BLK-AP1

## Decisión

> **La creación y emisión de cotizaciones ordinarias no requieren aprobación humana.**

La autonomía comercial se gobierna con autoridades deterministas, no con una aprobación humana por cotización:

| Autoridad | Responsabilidad |
|---|---|
| **Quote Service** | Precios, productos, servicios, despacho, vigencia y numeración: autoridad de la cotización |
| **Policy Engine** | Autorización de cada escritura (riesgo, scopes, identidad, límites configurados) |
| **Confirmación comercial J3** | Sólo se emite lo que el cliente confirmó explícitamente sobre la oferta presentada (ADR-035; compuerta de confirmación que puede negar, nunca concede por sí sola) |
| **Checkout** | Conciliación |
| **Acreditación de pago** | Condición para crear órdenes |

## Alcance

- **No elimina `REQUIRE_APPROVAL`.** Se reserva para capacidades excepcionales que de verdad necesiten autorización
  humana (por ejemplo, excepciones de precio o condiciones fuera de política; véase ADR-042).
- **No cambia perfiles.** `quote.create@2` (perfil `sales-production@4`) conserva `REQUIRE_APPROVAL` mientras exista.
  Los perfiles J3E (`@5`–`@8`) ya emiten de forma autónoma dentro de sus límites. Cualquier cambio de perfil exige su
  propio mandato.
- **No cambia Quote ni Checkout.**

## Consecuencias

- La dependencia operativa de R4-J4-R7 (BLK-AP1: ningún perfil con `REQUIRE_APPROVAL` en un canal autónomo con
  clientes reales hasta *Approval Horizon Hold*) sigue vigente para las capacidades excepcionales. Esta política la
  hace menos frecuente, pero no la elimina.
- Las cotizaciones ordinarias dependen de que la compuerta J3 y los límites autónomos sean correctos. Su regresión
  (`sales-autonomous-quote`, `sales-confirmed-intent-*`, `sales-deterministic-offer-*`) es requisito de cualquier
  cambio en ese camino.
