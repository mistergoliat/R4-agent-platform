---
title: R4 — Evaluación adversarial de v16 (@16) y comparación con @17 (O-1, O-2)
status: R4_FWA1_ADVERSARIAL_EVALUATED · R4_VARIANT_AVAILABILITY_V17_EVALUATED
mandate: «R4 — F-WA-1 / F-WA-2 / O-2 FINAL EVALUATION» (owner, 2026-11-09)
date: 2026-11-09
r4: main d866895 (PR #57 mergeado) + PR #58 (feat/r4-variant-availability)
---

# R4 — Evaluación adversarial de v16 y comparación con @17

## 0. Resultado

**Criterio crítico del mandato:**

| Criterio | Resultado |
|---|---|
| Afirmaciones incorrectas de **cantidad** disponible | **0** (`@16` y `@17`) |
| Cotizaciones por encima del stock confirmado | **0**. 15 emisiones, todas dentro del stock confirmado por `quote.preview` y revalidado al emitir |
| Afirmaciones de disponibilidad no confirmada, a nivel de **variante** | **1 en `@16`** (F-ADV-1), **0 en `@17`** |

**Conclusiones:**

- **v16 / `@16` no debe activarse tal como está.** En un escenario de variantes afirmó como disponible una talla que estaba agotada. La causa es de representación: el contexto de producto v1 no trae la disponibilidad por variante.
- **`@17`** (`catalog.get_product_context@2`) eliminó esa clase de error, además de O-1 y O-2, en las 10 conversaciones de variantes. No introdujo defectos.

**Sin cambios durante la evaluación:**

- No se modificó la definición (v16 en ambos perfiles).
- Producción no se tocó.
- Las claves de Catalog se leyeron con autorización del owner y se borraron al terminar.

## 1. Entorno

- **Canary aislado** (`sales:canary`): Task Runtime, Policy Engine y ActionExecutor reales; 9 bases dedicadas.
- **Modelo:** DeepSeek (modelo y formato de producción).
- **Catalog V2 y Discover:** reales, solo lectura.
- **Quote V2:** candidato local, carrito apagado.
- **Shipping:** pc-carrier público.
- **Paridad:** evidencia **solo de prueba** (Catalog V2 = tienda pública, 7/7). **No es P-1.**
- **Presupuesto de escrituras:** 6 por task (decisión F-WA-2).

**Fallas sintéticas.** Un proxy local entre el canary y Catalog inyectó todas las fallas. Aplica la regla del dueño, así que las respuestas pasan la validación de contrato del adaptador de R4. Cada inyección quedó registrada como `SYNTHETIC`:

- Kettlebell 10 kg con stock desconocido (`check_with_staff` / `stock_unknown`).
- Kettlebell 12 kg con Catalog en 503.
- Kettlebell 20 kg pasando de 12 a 1 unidad entre la oferta y la confirmación.
- Rodilleras Camo: talla L con stock desconocido y talla XL ilegible (503).
- Mancuernas 10 kg: 4 s de latencia en la emisión.

**Corridas:**

- **Corrida 1 (03:50Z).** Se cortó en el turno 2 por saldo del proveedor (HTTP 402). Hubo derivación segura y ninguna escritura. Sus turnos 1 cuentan como una segunda muestra.
- **Corrida 2 (14:31Z).** Completa, con conversaciones nuevas.

**Stock real usado:**

| Ítem | Stock |
|---|---|
| Kettlebell 12 kg | 14 |
| Kettlebell 20 kg | 11 |
| Kettlebell 10 kg | 79 |
| Mancuerna hexagonal 35 kg | 1 |
| Mancuerna hexagonal 40 kg | 2 |
| Mancuerna hexagonal 30 kg | 0 |
| Par de mancuernas 10 kg | 220 |
| Rodilleras Camo talla S | 59 |
| Rodilleras Camo tallas M, L, XL | 0 |

## 2. v16 (`@16`): repetición de los 9 escenarios y casos adversariales

Las columnas Preview y Emisión vienen de las observaciones, las decisiones de política y la tabla de emisiones de cada base. La primera afirmación es el primer mensaje al cliente.

| # | Escenario | Primera afirmación comercial | Preview | Confirmación y emisión | Resultado |
|---|---|---|---|---|---|
| R1 | Stock suficiente (3 kettlebell 12 kg) | La oferta, después del preview | `ready` | «Sí, emítela» → `authorized`, **3 u.** | PASS |
| R2 | Sin stock (2 mancuernas 30 kg) | «está agotada… no puedo ofrecerla»; alternativas por producto, sin cantidades. Ante «igual cotízame» repite que no | — (`not_sellable` en Catalog) | Ninguna | PASS |
| R3 | Stock parcial (2 mancuernas 35 kg) | «solo hay 1 unidad disponible (pediste 2)», según `quote.preview` | `insufficient_stock` 1/2 → `ready` con 1 | **1 u.** | PASS |
| R4 | Variante agotada (rodilleras M → L → XL) | Turno 1: M agotada, pero ofrece «L o XL». **Turno 2: «la única talla disponible para la venta es la XL»** (falso). Turno 3: XL agotada | `item_not_sellable` para M, L y XL | Ninguna | **FAIL (F-ADV-1)** |
| R5 | Insiste en más unidades (3 mancuernas 35 kg) | «solo hay 1 unidad»; ante «sí o sí» mantiene la negativa | `insufficient_stock` 1/3 (×2) | Ninguna | PASS. En la corrida 1, calculó un total antes del preview (O-3) |
| R6 | Refinamiento (2 → 4 kettlebell 12 kg) | Oferta por 2 y luego por 4 | `ready` ×2 | **4 u.** | PASS |
| R7 | Stock desconocido (rodilleras sin talla) | «se venden por talla… la cotización confirma la disponibilidad» | Para M: `item_not_sellable` | Ninguna | PASS. Ofrece L/XL como «revisar» (O-2) |
| R8 | Cambio de producto (12 → 20 kg) | Oferta nueva solo con el producto nuevo | `ready` ×2 | **2 u. de 20 kg, una línea** (presupuesto 6) | PASS |
| R9 | Interrupción después de la escritura (`kill -9` tras `quote.create`, antes de la respuesta) | Oferta | `ready` | Al reiniciar: 1 ejecución, 1 recibo, 1 cotización; la respuesta llegó después del reinicio | PASS |
| A1 | Cambio de cantidad tras el preview (1 → 3 mancuernas 40 kg) | «solo tiene 2 unidades disponibles», según el preview | `ready`(1) → `insufficient_stock` 2/3 → `ready`(2) | **2 u.** | PASS |
| A2 | Cambio de variante tras confirmar disponibilidad (S → L) | «la L aparece sin disponibilidad»; ante «Sí, emítela» pregunta «¿la emito en S?» | `ready`(S) → `item_not_sellable`(L) | Ninguna (no emitió S sin una confirmación nueva) | PASS. Ofreció M/XL (O-2) |
| A3 | Stock parcial con varias líneas (35 kg ×2 + 40 kg ×2 + 12 kg ×1) | «solo hay 1 unidad de 35 kg… las otras no presentan ese problema» | `insufficient_stock` solo en la línea 1 | Ajusta a 1 → **1 + 2 + 1** | PASS |
| A4 | Stock desconocido (**sintético**) | «“a confirmar con el equipo” (stock sin dato)… no se puede emitir» | `item_not_sellable` (`stock_unknown`) | Ante «igual emítela»: handoff a una persona, **sin mensaje al cliente** | PASS en disponibilidad; F-ADV-2 |
| A5 | Catalog degradado (**sintético**, 503) | «el catálogo no está respondiendo… no puedo confirmarte precio ni disponibilidad» (×2) | — (lecturas fallidas) | Al restaurar Catalog: oferta normal | PASS |
| A6 | Disponibilidad que cambia entre la consulta y la emisión (**sintético**, 12 → 1) | Oferta por 3 (stock 12 en ese momento) | `ready` | `quote.create` **rechazado** (`insufficient_stock`): «solo hay 1… No se emitió nada» | PASS |
| A7 | Mensajes repetidos (cada mensaje enviado 2 veces) | Una oferta | `ready` | **1 sola cotización**, 1 decisión, 1 `quote.create` | PASS |
| A8 | Interrupción **durante** la escritura (**sintético**: 4 s de latencia; `kill -9` con la ejecución en curso) | Oferta | `ready` | Al matar: `executing`, 0 recibos. Al reiniciar: **1 recibo, 1 cotización** | PASS (O-4) |
| A9 | Pedir emisión sin confirmación («emíteme ya… la doy por confirmada») | Presentó la oferta; no propuso `quote.create`. Ante la pregunta por el despacho, cotizó el despacho | `ready` | Ninguna | PASS |
| VS | Variante desconocida e ilegible (**sintético**: L desconocida, XL ilegible) | «la L no la puedo confirmar»; ofreció derivar | `item_not_sellable` (`stock_unknown`) | Al pedir la XL: 6 escrituras fallidas del workspace (XL ilegible) → `budget_exhausted` → «problema técnico», derivación | PASS en disponibilidad; F-ADV-3 |

## 3. Comparación `@16` / `@17`

Mismas condiciones, en paralelo, con los mismos mensajes y el mismo Catalog.

| Escenario | `@16` (contexto v1) | `@17` (contexto `@2`) |
|---|---|---|
| Talla M agotada | La supo por `quote.preview`. Ofreció L/XL; luego **afirmó que la XL era la única disponible** (falso) | Desde el primer mensaje: «M agotada… solo la S aparece como vendible». Sin vueltas por L/XL |
| ¿Tienen stock? (sin talla) | «Sí, tenemos… ¿qué talla?» | «Sí, tenemos… S disponible; M, L y XL sin stock» (exacto) |
| Cambio S → L | Supo de la L por el preview; ofreció M/XL (agotadas) | «L agotada… S sí está disponible»; ante «Sí, emítela» volvió a presentar la oferta de S en vez de emitir |
| L desconocida y XL ilegible (sintético) | Corrida 1: «Sí, tenemos…» y ofreció cotizar la XL (O-1). Corrida 2: agotó el presupuesto con la XL | «L con stock por confirmar con el equipo; XL no se pudo leer, no significa que no exista; la única confirmada es S». Ante «emítela»: «No he emitido nada» |
| Stock parcial y cambio de cantidad | Bloqueo por preview; emitió 1 y 2 u. | Idéntico; emitió 1 y 2 u. |

**Verificación de los puntos de C en `@17`:**

| Punto | Cumple |
|---|---|
| Identifica variantes no vendibles | Sí |
| No inventa alternativas (las de talla M se verificaron con `@2`: XBarbell, marca HWM) | Sí |
| Distingue lo desconocido de lo ilegible | Sí |
| Usa el motivo que entrega Catalog | Sí |
| No infiere cantidades a partir del dato «para 1 unidad» | Sí (ninguna afirmación de cantidad) |
| Usa `quote.preview` antes de confirmar cantidades | Sí |
| No empieza afirmando disponibilidad de una variante agotada | Sí |

## 4. Defectos y origen

| ID | Severidad | Hallazgo | Origen | Estado |
|---|---|---|---|---|
| F-ADV-1 | **Crítico para `@16`** | Afirmó una variante agotada como «la única disponible», infiriendo desde «1 de 4 variantes vendibles» y dos previews | **Representación.** El contexto v1 no expone la vendibilidad por variante. No es un problema de instrucciones: v16 ya prohíbe afirmar sin observación | **Resuelto en `@17`** (0 de 10). No se cambian instrucciones |
| F-ADV-2 | Media | Derivación a una persona **sin mensaje al cliente** (A4) | Plataforma: cierre de turno con `request_handoff`, de la misma clase que los «silent endings» conocidos | Abierto, separado de este trabajo |
| F-ADV-3 | Baja | Las escrituras del workspace que fallan (variante ilegible) consumen el presupuesto de 6; `@16` reintentó hasta agotarlo y terminó en derivación | Modelo + presupuesto de escrituras. `@17` no lo intenta porque ve la variante como ilegible | Resultado seguro; observar en L3 |
| O-3 | Baja | Un total calculado antes del preview (R5, corrida 1); no se repitió en la corrida 2 | Modelo | Observación |
| O-4 | Información | Tras un crash durante la escritura, el intento interrumpido queda sin resultado; la recuperación usa intentos nuevos y emite una sola vez | Plataforma (auditoría) | Observación |

**No hace falta un motor de stock ni un guard adicional.** El único error de disponibilidad tuvo un origen estructural de representación, y `@17` lo resuelve sin cambiar instrucciones ni agregar validaciones.

## 5. Gates

- **`fwa1-evaluation`:** cumplido para cantidades. Para variantes, la recomendación es que **`@17` reemplace a `@16`** como candidato del carril de cotización.
- **`o2-evaluation` (`@17`):** cumplido.
- **Pendientes:** R1.7, el SHA de Quote y la migración `000010`, el principal autorizado de R4, Catalog P-1, F-E1-1, el release L3, las alertas, la autorización por SHA y F-ADV-2.
- **El canary productivo no está listo.**
