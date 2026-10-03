# R4-J2A — Auditoría del owner de Shipping (pc-carrier)

Estado: **CERRADA** (auditoría de solo lectura, 2026-10-02; decisiones del owner confirmadas por el usuario el mismo día)
Fecha: 2026-10-02
Modo: AUDIT ONLY — no se modificó pc-carrier, CRM, n8n, PrestaShop, Catalog, bases de datos ni infraestructura.
Sucesor: R4-J2B (adapter de producción), ver ADR-032.

---

## 0. Fuentes de evidencia

No existe repositorio fuente de pc-carrier accesible localmente. La evidencia viene de:

- **[S] Swagger publicado** — `GET https://ms.pesaschile.cl/api/pc-carrier/swagger/doc.json`, "PC Carrier API" v1.2.0.
- **[CRM] Integración productiva del CRM** — `CRM-Customer-360/lib/integrations/carrier-service/httpCarrierServiceAdapter.ts`, `docs/releases/CRM-R1-T13E-shipping-calculation.md` (capturas en vivo, agosto 2026), `docs/integrations/quote-input-assembly.md`.
- **[N8N] Workflow productivo** "Tool - Cotizar Envío Invoice" (`active: true`).
- **[P] ~110 GET de solo lectura** contra producción el 2026-10-02 (19:15–19:30 UTC): `/`, `/location`, `/carrier/v1/all`, `/carrier/v1/{0..3}`. Ninguna llamada a rutas de emisión, SAP o métodos de envío. Las respuestas capturadas son los fixtures de `adapters/domains/shipping/http/fixtures/`.

Todo comportamiento interno del servicio es **observado**, no verificado en código.

## 1. Diagnóstico

1. Ruta autoritativa de cotización: **`GET /api/pc-carrier/carrier/v1/all`** (usada por CRM y n8n, verificada en vivo). Éxito = **HTTP 202**.
2. Comuna + kg **no basta**: el precio depende también de `total_boleta` (Despacho Directo existe sólo si > 0 y se tarifica por monto; Blue Express agrega seguro ≈ 0,6 % desde ~100k), de las dimensiones (peso volumétrico) y de `quantity` (sólo Blue Express).
3. `total_cost` es **NETO en CLP** (confirmado por el owner; evidencia previa: n8n multiplica por 1,19 y los tramos de DD × 1,19 caen en precios retail X.990).
4. El servicio no entrega quote id, TTL ni validez; la cotización es informativa.

## 2. Arquitectura del owner

| Aspecto | Hallazgo |
|---|---|
| Servicio | "PC Carrier API" v1.2.0 (Depto. Informática PesasChile); probablemente Go/swaggo (inferido) |
| Host | `https://ms.pesaschile.cl/api/pc-carrier`, detrás de nginx/1.24.0, Internet pública, CORS `*` |
| Spec | `host`/`basePath` del Swagger son incorrectos (`/pc-orders`); el prefijo real es `/api/pc-carrier` |
| BD | pc_pos (inferido: tramos de DD = `carrier_rangos_dd`; `/all` aplica `carrier_coverage`; `/location` = 346 comunas de pc_pos) |
| Carriers | Starken y Blue Express (APIs externas); Despacho Directo (tarifa interna) |
| Auth | El Swagger declara JWT, pero las rutas de cotización responden sin credenciales |
| Rutas de escritura en el mismo host | emisión Blue Express, shipment pendiente/patch, nota de entrega SAP, CRUD de métodos de envío — **R4 nunca debe llamarlas** |

Grafo de llamada de `/all` (inferido del comportamiento):

```
GET /carrier/v1/all
  ├─ resolver destino (nombre | id_comuna) — desconocido ⇒ options:[] (~0,55 s)
  ├─ filtro de cobertura (carrier_coverage)
  ├─ Despacho Directo: sólo si total_boleta > 0; precio = tramo por total_boleta
  ├─ Blue Express API: kilos, dimensiones, quantity, total_boleta (seguro)
  └─ Starken API: kilos, dimensiones
  ⇒ 202 {"options":[{carrier_name, service_type, total_cost, estimated_delivery?}]}
```

## 3. Contrato

- **`GET /carrier/v1/all`** — query: `destino` (obligatorio: nombre o id de comuna), `alto`/`ancho`/`largo` (cm), `kilos`, `quantity`, `origin_code`, `total_boleta`. Respuesta 202 `{options:[{carrier_name, service_type, total_cost, estimated_delivery}]}`; 400 `{"error":"destination is required"}` con destino vacío.
- **`GET /carrier/v1/{id}`** — por carrier (0 Starken, 1 Blue Express, 2 DD), forma de respuesta inconsistente y **se salta el filtro de cobertura** (cotiza Starken en Ñuñoa, donde `/all` no lo ofrece). No apto para R4.
- **`GET /location`** — árbol Región › Ciudad › Comuna (`id_comuna`, `comuna_name`), HTTP 200, 16 regiones, 346 comunas, sin duplicados tras normalizar.

## 4. Semántica de inputs (observada)

- `destino`: insensible a mayúsculas y acentos; acepta `id_comuna` (99 = Ñuñoa); **no recorta espacios**; no resuelve alias (`Rapa Nui`), typos (`San Migel`), regiones ni "Santiago" (sí "Santiago Centro"). Desconocida y sin cobertura responden igual: `{"options":[]}`.
- `kilos`: kg decimal (1,01 cruza tramo). Ausente, 0, negativo o no numérico **no da error**: se cotiza como el paquete por defecto (≈ 1 kg). Sin máximo (5000 kg cotiza).
- Dimensiones: cambian fuertemente el precio (volumétrico). Todos los clientes actuales envían 1×1×1.
- `total_boleta`: ausente/0 ⇒ DD desaparece; define el tramo de DD y el seguro de Blue Express. n8n no lo envía (nunca ofrece DD).
- `quantity`: sólo afecta Blue Express. Nadie lo envía.

## 5. Peso

- Tramos Blue Express (Ñuñoa): ≤1 kg plano; 1,01–3; 5–6; 10; 20…; Starken (Temuco): 0,5 kg más barato que 1 kg.
- Fuente autoritativa de peso de producto: Catalog v2 `facts.weightKg` (nivel producto, `ps_product.weight`).
- Las variantes del catálogo actual son Talla/Color: **0 de 225 combinaciones activas tienen `weightImpact` ≠ 0**; ítems de distinto peso (mancuernas 10/12 kg) son SKUs distintos. Los 7 productos activos con peso 0 son servicios. ⇒ el peso de producto es suficiente.

## 6. Precio

- `total_cost` NETO CLP; sin moneda, IVA ni desglose explícitos. Seguro de Blue Express y recargos de zona remota incluidos.
- El 1,19 hoy sólo lo aplica un consumidor (n8n), nunca el owner.
- **Tramo DD 120.000–499.990 ⇒ $1**: incentivo comercial intencional (confirmado), no anomalía.

## 7. Carriers

- Una oferta por carrier; **orden fijo DD → Blue Express → Starken, no ordenado por precio** (Santiago Centro: Blue Express 3175 antes que Starken 2885).
- Sin oferta seleccionada/recomendada. n8n elige la más barata en el consumidor.
- `estimated_delivery`: fecha (Blue Express), texto libre (DD) o **ausente (Starken)**. (Hallazgo lateral: el parser del CRM exige el campo y falla cerrado en toda comuna con Starken.)
- Determinístico en repeticiones; Blue Express estable entre agosto y octubre.

## 8. Cobertura (muestras)

| Caso | Observado |
|---|---|
| RM con DD (Ñuñoa, Las Condes, Maipú) | DD + Blue Express |
| Santiago Centro | Blue Express + Starken |
| Regiones (Rancagua, Valparaíso, Temuco, Punta Arenas) | Blue Express + Starken |
| Isla de Pascua, Cabo de Hornos, Antártica, Ollagüe | sólo Blue Express |
| Juan Fernández, Camarones | sólo Starken |
| Tirúa, desconocida, typo, región, alias, con espacios | `options: []` |

## 9. "Desde $X" con 1 kg — decisión

Evaluado inicialmente como engañoso si se presenta como mínimo absoluto (Starken bajo 1 kg es más barato; el incentivo DD de $1 depende del monto; el neto subestima el bruto). **Decisión de producto (2026-10-02):** responder "¿cuánto cuesta enviar a mi comuna?" con comuna + 1 kg + 1×1×1, sin `total_boleta`, presentando el menor bruto como **referencia aproximada** y explicando que el valor final depende del peso y tamaño de los productos. Clasificación: **CONDICIONALMENTE SEGURO** con esa redacción (nunca "mínimo garantizado").

## 10. Frescura, efectos y latencia

- Sin TTL/validez del owner; no canjeable en checkout; el checkout puede diferir.
- GET sin efectos observables; la emisión vive en rutas separadas.
- Latencia `/all`: 0,77–2,53 s (RM ~0,8–0,9 s; con Starken 1,0–2,1 s; comuna desconocida ~0,55 s). Consultas a carriers aparentemente en paralelo. Apto para un turno de WhatsApp con 5 s de timeout.

## 11. Seguridad

Sin auth en cotización; Internet pública; R4 no necesita secretos. El query sólo lleva comuna, peso y monto (sin PII). Las rutas de escritura del mismo host no fueron probadas (no correspondía).

## 12. Decisiones cerradas para J2

| Tema | Decisión |
|---|---|
| IVA | `total_cost` es neto; R4 deriva el bruto `round(neto × 1,19)` en un único lugar explícito y conserva el neto (ADR-032) |
| Tramo $1 | incentivo; se muestra tal cual, nunca como "gratis" |
| Peso | Catalog v2 `weightKg` de producto; no se consume Catalog v1 |
| `total_boleta` | subtotal bruto efectivo de los productos seleccionados (cantidad incluida, sin envío), con el precio que entrega Catalog; descuentos de carro fuera de J2 v1 |
| Dimensiones | convención de producción 1×1×1 |
| "Desde" | base de referencia 1 kg, presentada como referencia aproximada |
