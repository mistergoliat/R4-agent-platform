# R4-J5 — Promoción de despacho "Pesas Chile — Despacho Directo: $1"

Estado: implementado en rama `feat/r4-j5-shipping-promotion-v9` (PR abierto, sin merge). **No desplegado.** Ningún perfil de producción selecciona `sales-production@9`.

## 1. Hechos del owner (mandato J5)

- La opción de despacho "Pesas Chile — Despacho Directo: $1" es una **promoción comercial autorizada**, no una anomalía de precio.
- Condiciones conocidas por el owner:
  - monto final **neto** de compra mínimo CLP 120.000 y máximo CLP 499.990;
  - comunas seleccionadas de la Región Metropolitana de Santiago.
- **Shipping** (el servicio externo de despacho, pc-carrier) sigue siendo la autoridad: determina la elegibilidad real y devuelve la oferta final.
- **Pendiente** del owner comercial/Shipping: la lista completa de comunas aprobadas y la base monetaria exacta (neto vs bruto, antes/después de descuentos). No se inventaron; quedan como puntos abiertos (§7).

Evidencia (canary J4-R5 en EC2, 2026-10-26, API real de Shipping, cliente sintético): para 1 × "Par Discos Olímpicos Grip Rubber 10kg | PROmachine" ($47.990) + 1 × "Barra Olímpica 20kg Classic Serie | PROmachine" ($99.990) a Ñuñoa, `shipping.quote` devolvió "Pesas Chile — Despacho Directo: $1 (1 a 2 días hábiles)" y "Blue Express — EXPRESS: $12.777". El agente @8 listó "$1" sin explicación. El cliente eligió Blue Express; la cotización PC-000007 se emitió con despacho $12.777 (neto $135.090, IVA $25.667, total $160.757).

## 2. Qué expone Shipping

Contrato pc-carrier v1.2.0 (`adapters/domains/shipping/http/src/schemas.ts`), `GET /carrier/v1/all`:

| Campo del owner | En R4 (`ShippingOffer`) |
|---|---|
| `carrier_name` | `carrierName` ("Pesas Chile") |
| `service_type` | `serviceType` ("Despacho Directo") |
| `total_cost` (NETO CLP) | `price.ownerNet.amount` (1), intacto |
| — | `price.customerGross` derivado por R4 con `cl-iva-19@r4-j2b` (neto 1 → bruto 1; nunca "gratis") |
| `estimated_delivery` | `estimatedDelivery` (texto del owner, no se parsea) |
| orden de la respuesta | `ownerPosition` (no es ranking) |

**Shipping no expone ningún indicador de promoción**, ni motivo de elegibilidad, ni la lista de comunas. La promoción se reconoce únicamente porque Shipping devuelve la oferta "Pesas Chile / Despacho Directo" con su monto. Lo que R4 le envía para decidir: la comuna resuelta (`destino`), el peso (`kilos`) y, para `basis=order`, `total_boleta` = **valor declarado bruto** (suma de `finalGross` del Catalog × cantidad, IVA incluido, sin despacho). En la evidencia: $47.990 + $99.990 = $147.980 bruto (≈ $124.353 neto).

Flujo hacia Quote: el cliente elige una oferta → `sales.workspace.update` `select_shipping_offer` (carrierName, serviceType, ownerNetClp de esa oferta) → `quote.preview` vuelve a cotizar Shipping y bloquea si la oferta desapareció (`shipping_offer_unavailable`) o cambió de precio (`shipping_offer_changed`) → el snapshot lleva `amount = ownerNet` exacto (tasa del owner) → `quote.create` envía ese mismo monto en `CreateQuoteRequest.shipping.amount`.

## 3. Guía comercial (definición Sales v9)

`agents/sales/sales.v9.agent.json` = v8 byte a byte excepto `version`, `description` y **una línea nueva** de instrucciones, insertada inmediatamente después de la regla de `shipping.quote`:

> - Despacho Directo promotion: "Pesas Chile — Despacho Directo" at $1 is an authorized store promotion, not a pricing error and not free shipping. The store applies it to purchases with a final net amount from CLP 120.000 to CLP 499.990 delivered to selected communes of the Región Metropolitana de Santiago; the Shipping owner holds the exact rule and the commune list, and alone decides whether an order qualifies. The offer exists only when a current shipping.quote (basis=order) for that selection and commune returns it: then state its price exactly as returned ($1; never $0, "free" or another amount), explain briefly that it is the store's Despacho Directo promotion for that order and commune, and present it with the other returned offers so the customer chooses. Before such a quote you may explain the promotion and its conditions and say that Shipping confirms it once the products and the commune are known, but never promise or imply that an order qualifies, never state $1 as the price of their delivery, and never decide eligibility yourself from amounts, communes or these instructions. If shipping.quote does not return it, the order does not qualify for it now: say so if asked, without guessing the reason, and offer the returned options. If shipping.quote fails or serviceable=false there is no shipping price: never fall back on the promotion or any amount. The quote carries exactly the Shipping amount of the chosen offer; if quote.preview reports that offer changed or is no longer offered (for example after the selection changed), read shipping.quote again and let the customer choose again.

Cobertura de los siete requisitos del mandato:

| Requisito | Dónde |
|---|---|
| (1) entender y explicar la promoción | "authorized store promotion…", condiciones conocidas |
| (2) reconocer compras potencialmente elegibles | "Before such a quote you may explain… Shipping confirms it once the products and the commune are known" |
| (3) obtener la oferta autoritativa | "exists only when a current shipping.quote (basis=order)… returns it" |
| (4) decir $1 solo cuando Shipping lo devuelve | "state its price exactly as returned"; "never state $1 as the price of their delivery" antes de eso |
| (5) nunca prometer elegibilidad por instrucciones | "never promise or imply… never decide eligibility yourself from amounts, communes or these instructions" |
| (6) monto exacto en Quote | "The quote carries exactly the Shipping amount of the chosen offer" (y lo garantiza el código, §4) |
| (7) oferta no disponible / no elegible sin inventar | "does not qualify for it now… without guessing"; "fails or serviceable=false… never fall back" |

Las condiciones (CLP 120.000–499.990, RM) aparecen solo como **explicación** al cliente; la guía dice expresamente que no deciden nada.

## 4. Por qué no hay lógica de elegibilidad en R4

- La Constitución y AGENTS.md: los conceptos de dominio quedan fuera de Core, la salida del modelo no es confiable y Shipping es el owner del precio de despacho. Reimplementar la regla duplicaría una autoridad y divergiría en silencio: la lista de comunas y la base monetaria **no se conocen** con exactitud.
- La base que R4 envía (`total_boleta` bruto) ni siquiera es la que el owner describió (neto); quien la interpreta es Shipping. Si R4 filtrara o agregara ofertas con su propia regla, podría mostrar $1 a una compra que Shipping rechazaría al emitir, o esconder una promoción vigente.
- La garantía de R4 es estructural y ya existía: `shipping.quote` reenvía todas las ofertas del owner sin seleccionar ni modificar; `quote.preview`/`quote.create` re-cotizan y solo aceptan el monto neto exacto que el cliente eligió. J5 no agrega código de runtime: solo la definición v9, el perfil @9 y su registro.
- Un test de contrato de fuentes (`tests/unit/sales/shipping-promotion.test.ts`, "no R4 code decides the promotion") falla si algún `.ts` de `packages/`, `adapters/` o `agents/` nombra "Despacho Directo", o si alguna ruta de Shipping/Quote/workspace contiene los umbrales 120.000/499.990.

## 5. Perfil `sales-production@9`

`agents/sales/src/production/profile-v9.ts`:

- `SALES_PRODUCTION_PROFILE_V9` = `{ ...SALES_PRODUCTION_PROFILE_V8, version: 9, description }`: mismos dominios, canal, capacidades, versiones de capacidades, política de acciones (`sales-production-autonomous-policy@2`), límites y composición (worker y gateway con inspector). Fingerprint fijado: `f2858bcc0366280e10682e222e5e2ba45fff48044c644fc42063cd8467ea20a7`.
- `SALES_PRODUCTION_AGENT_VERSIONS['sales-production@9'] = 9`. El registro seleccionable (`SALES_PRODUCTION_PROFILES`, `salesProductionProfile`, `salesProductionAgentVersion`) se movió de `profile-v8.ts` a `profile-v9.ts`, igual que hizo J4-R4 con v7→v8.
- @9 entra en los conjuntos por etiqueta que ya contenían @8 (autonomous quote, confirmed intent, deterministic offer, customer identity), así que compone exactamente lo de @8.
- `CANARY_PROFILES` acepta @9 (con las mismas reglas de @8: `R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude`); no se ejecutó ningún canary.
- `SALES_PRODUCTION_PROFILE_V9_GATE` (todo bloqueante): `v8-gate`, `j5-review`, `promotion-terms`, `real-model-compatibility`, `canary-evidence`, `explicit-authorization`.
- `SALES_AGENT_LATEST_VERSION` sigue en 4 (composiciones no productivas sin cambios).

@1–@8 y las definiciones v3–v8 quedan byte a byte: sus fingerprints y content hashes están fijados en `tests/contract/sales-profile-v9.test.ts` (y los existentes siguen pasando).

## 6. Tests

Nuevos:

- `tests/unit/sales/shipping-promotion.test.ts` (15 tests, deterministas, sin modelo real). Un owner Shipping guionado (doble de test) al que cada escenario le **dice** si concede la promoción; R4 no conoce la regla:
  - bajo el mínimo, exactamente el mínimo, exactamente el máximo, sobre el máximo, comuna elegible, comuna no elegible: R4 envía el valor declarado del Catalog sin alterar, y la oferta $1 aparece en `shipping.quote` **solo** si el owner la devuelve (neto 1 → bruto 1, nunca 0; orden del owner; Blue Express $12.777 intacto);
  - misma compra, respuesta del owner alternada → R4 la sigue sin opinión propia;
  - Shipping no disponible → observación `failed` tipada (`temporarily_unavailable` / `shipping_owner_unavailable`), sin ofertas ni precio;
  - `quote.preview`/`quote.create`: oferta $1 elegida → snapshot con `amount 1 excluded 0.19`, mensaje de oferta "Despacho: Pesas Chile, Despacho Directo, a Ñuñoa, Metropolitana de Santiago: $1" y `CreateQuoteRequest.shipping.amount = 1`; oferta pagada (caso canary, Blue Express neto 10.737) intacta;
  - descuento que saca la compra del rango (el Catalog baja el precio; el owner retira la oferta) → preview bloqueado `shipping_offer_unavailable`, sin precio inventado; owner que cambia el precio → `shipping_offer_changed`; Shipping caído en preview → error del owner propagado, sin snapshot;
  - ningún código de R4 nombra la promoción ni sus umbrales; la promoción vive solo en la guía v9.
- `tests/contract/sales-profile-v9.test.ts` (10 tests): fingerprints @1–@9 y content hashes v3–v9 fijados; @9 = @8 salvo versión/descripción; misma composición (capacidades, versiones, definiciones, política, reporte), fail-closed y gateway con inspector; v9 = v8 + una línea; contenido de la guía; canary acepta @9; gate.

Inventarios actualizados (como en J4-R4): `sales-profile-v2` (etiqueta inexistente ahora `@10`), `sales-profile-v3`, `sales-profile-v8`, `sales-confirmed-intent`, `sales-deterministic-offer`, `sales-canary-j4`, `sales-boundaries`, `customer-http-contract`, `identity-verification-boundaries` (contract); `agent-registry`, `production-bootstrap`, `sales-canary` (integration); ancla de `tests/mutation/profile-v8-mutations.mjs` (PV8-M4). `tests/recovery/production-bootstrap-process.test.ts` deriva de `SALES_PRODUCTION_AGENT_VERSIONS` y no requirió cambios (no se ejecutó `test:recovery`, por instrucción).

Inventario adicional: `tests/unit/agent-registry/loader.test.ts` y `tests/integration/api.test.ts` (`/ready` carga 8 definiciones).

Resultados (local, Windows, PostgreSQL Docker `r4-agent-platform-postgres`):

| Suite | Resultado |
|---|---|
| `npm run lint` | 0 errores, 0 warnings |
| `npm run typecheck` / `npm run build` | OK |
| `npm run test:unit` | 86 archivos OK (1 skipped); 1534 passed, 4 skipped |
| `npm run test:contract` | 34 archivos; 460 passed |
| `npm run test:integration` (completo, en paralelo) | 595 passed, 12 failed, 12 skipped (619). 11 fallos eran timeouts de 30 s por carga; 1 era real (`api.test.ts`, conteo de definiciones 7→8) |
| re-ejecución `--no-file-parallelism` de los 11 archivos fallidos | 177 passed, 1 failed (el mismo `api.test.ts`, luego corregido) |
| `tests/integration/api.test.ts` tras la corrección | 22 passed |
| `npm run test:sales` | 4 archivos; 29 passed |
| `npm run test:shadow` | 5 passed |

No se ejecutaron `test:recovery` (por instrucción), los mutation tests ni experimentos con modelo real.

## 7. Puntos abiertos

1. **Lista completa de comunas aprobadas** (owner comercial/Shipping). La guía dice solo "comunas seleccionadas de la RM" y defiere a Shipping.
2. **Base monetaria exacta**: neto vs bruto y antes/después de descuentos. Nota: R4 envía a Shipping `total_boleta` = valor **bruto** de productos (sin despacho, sin descuentos: Quote V2 de R4 no aplica descuentos). Si el owner evalúa sobre neto, debe convertir él; si necesita otra base, es un cambio de contrato con Shipping, no una regla en R4.
3. Confirmar con el owner que el texto de la guía (rango y alcance geográfico) es el aprobado (`promotion-terms` en el gate).
4. **Compatibilidad con modelo real**: no se corrieron experimentos (`scripts/experiments/*`). Antes de cualquier rollout, @9 necesita un chequeo de compatibilidad con modelo real contra @8 (explica el $1, no lo promete, sin regresiones en cotización exacta e identidad) y luego un **canary** aislado con Shipping real y cliente sintético, con compras elegibles y no elegibles.
5. Despliegue y selección de @9: requieren autorización explícita (gate `explicit-authorization`). Nada en producción selecciona @9.
