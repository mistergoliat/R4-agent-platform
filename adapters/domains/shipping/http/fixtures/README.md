# pc-carrier owner fixtures

Verbatim owner answers captured from production with read-only GET requests
during the R4-J2A audit (2026-10-02, `https://ms.pesaschile.cl/api/pc-carrier`).
They are the test oracle of `@r4-adapters/shipping-http`. No customer data:
the location tree is public geography, quotes carry only carrier offers.

| File | Request | HTTP |
|---|---|---|
| `location.json` | `GET /location` (16 regions, 346 communes) | 200 |
| `quote-nunoa-reference.json` | `GET /carrier/v1/all?destino=Ñuñoa&alto=1&ancho=1&largo=1&kilos=1` (no `total_boleta`: Despacho Directo absent) | 202 |
| `quote-nunoa-order-50000.json` | same, `total_boleta=50000` | 202 |
| `quote-nunoa-order-120000.json` | same, `total_boleta=120000` (Despacho Directo incentive: net 1) | 202 |
| `quote-temuco-reference.json` | `destino=Temuco`, 1 kg, no `total_boleta` (Starken has no `estimated_delivery`) | 202 |
| `quote-santiago-centro-order-50000.json` | `destino=Santiago Centro`, 1 kg, `total_boleta=50000` (owner order is not price-ranked) | 202 |
| `quote-empty.json` | an unserved commune (e.g. Tirúa) | 202 |

`total_cost` is NET CLP (owner-confirmed). Prices change over time; these
files pin the contract shape and semantics, not current tariffs.
