---
title: R4 — F-WA-1, evaluación de la definición candidata v16 (sales-production@16)
status: R4_FWA1_CANDIDATE_EVALUATED
mandate: «R4 — PR #55 Final Acceptance» §C–§D (owner, 2026-11-09)
date: 2026-11-09
r4: PR #56 (feat/r4-fwa1-quantity-availability), candidato 6f9ef50; main = 96f6075 (PR #55 mergeado)
---

# R4 — F-WA-1: evaluación de v16

## 0. Resultado

**`R4_FWA1_CANDIDATE_EVALUATED`.** Se cumple el criterio de aceptación en los 9 escenarios con DeepSeek y los componentes comerciales reales:

- **ninguna afirmación incorrecta sobre disponibilidad;**
- **ninguna cotización por encima del stock confirmado.**

Quedan dos observaciones de presentación (O-1, O-2) y un defecto de presupuesto de escrituras (F-WA-2) que no afecta la corrección.

**Producción intacta:**

- PR #55 se mergeó en `main` (`96f6075`) con un merge commit. El repositorio no tiene workflows y no hubo despliegue.
- La EC2 sólo se leyó, para las claves de Catalog V2 que autorizó el owner. Esas claves se borraron al terminar.
- `@13`, `@14` y `@15` no cambiaron y ninguno está activo.

## 1. Candidato

- **Definición v16** = v14 + **una** regla: la disponibilidad de una cantidad nunca se afirma a partir de la disponibilidad por producto que entregan `catalog.search` y `catalog.get_product_context` (vendible o no, motivo, variantes vendibles). Sólo la confirma `quote.preview` para esa cantidad: su `insufficient_stock` informa la cantidad disponible. «No vendible», «backorder» y «consultar con el equipo» se dicen tal cual.
- **`sales-production@16`** = `@14` (mismas capacidades, política, guarda P-1 y techos F1) fijado a v16. Es perfil de carril y de canary aislado.
- **Sin cambios en:** el kernel, Quote, Checkout, `@14` y las capacidades. No hay segundo motor de validación: la única verificación de cantidad sigue siendo `quote.preview`, que ya usa los datos de ítem de Catalog V2.

## 2. Entorno

El canary aislado (`sales:canary`) con `@16`: Task Runtime, Policy Engine y ActionExecutor reales; entrada por `ChannelIngress`; tres bases dedicadas, una por grupo de escenarios, para respetar el límite global de 2 cotizaciones por hora.

| Componente | Instancia |
|---|---|
| Modelo | DeepSeek, el modelo y formato de producción |
| Catalog V2 y Discover | **Reales**, la generación productiva, sólo lectura por túnel; claves del carril autorizadas por el owner para esta evaluación y borradas al terminar |
| Shipping | pc-carrier público |
| Quote V2 | Candidato `a79d33f` local, carrito apagado, principal con scopes de R4 |
| P-1 | Evidencia de paridad **sólo de prueba** (Catalog V2 = tienda pública, 4/4 ítems coinciden). **No es P-1** |

Stock real leído de Catalog V2 para los ítems usados:

| Ítem | Stock |
|---|---|
| Kettlebell 12 kg | 14 |
| Kettlebell 20 kg | 12 |
| Kettlebell 10 kg | 79 |
| Mancuerna hexagonal 35 kg | **1** |
| Mancuerna hexagonal 30 kg | **0** |
| Rodilleras Camo talla S | 59 |
| Rodilleras Camo tallas M, L, XL | **0** |

## 3. Resultados

| # | Escenario | Mensaje inicial | Emisión final (evidencia en la base) | Resultado |
|---|---|---|---|---|
| 1 | Stock suficiente (3 kettlebell 12 kg; stock 14) | La oferta salió **después** de `quote.preview`, sin afirmación previa | `authorized`, **3 unidades**, cotización emitida | PASS |
| 2 | Stock insuficiente (mancuerna 30 kg; stock 0) | «está sin stock… no puedo ofrecerla ni reservarla», con alternativas sin cantidades | Ninguna | PASS |
| 3 | Stock parcial (2 mancuernas 35 kg; stock 1) | «la cotización es la que confirma la disponibilidad para las 2» | `quote.preview` → `insufficient_stock` (1 de 2). El cliente acepta 1 → `authorized`, **1 unidad** | PASS |
| 4 | Variantes con disponibilidad distinta (rodilleras talla M; M en 0, S en 59) | «Sí, tenemos el producto… la talla M es una de sus variantes; el catálogo no confirma la talla M para una cantidad» | `quote.preview` → `item_not_sellable` (M, out_of_stock). Ninguna emisión. Ofreció probar S, L o XL | PASS (O-1, O-2) |
| 5 | Más unidades que las disponibles (insiste en 3 mancuernas 35 kg; stock 1) | Sin afirmación; «la cotización confirmará la disponibilidad» | `insufficient_stock` (1 de 3). Ninguna emisión de 3; ofreció 1, alternativa o una persona | PASS |
| 6 | Refinamiento de cantidad (2 → 4 kettlebell 12 kg) | Oferta por 2, luego oferta actualizada por 4 | `authorized`, **4 unidades** | PASS |
| 7 | Stock desconocido (2 pares de rodilleras sin talla) | «el catálogo no informa cuántas unidades hay en stock… no todas las tallas están disponibles» y pidió la talla | Ninguna | PASS |
| 8 | Cambio de producto (2 kettlebell 12 kg → 2 de 20 kg) | Oferta nueva sólo con el producto nuevo | Con techo de escrituras 4: `budget_exhausted`, sin cotización, handoff a una persona (F-WA-2). Con techo 6 (8b): `authorized`, **2 kettlebell 20 kg, una sola línea** | PASS con F-WA-2 |
| 9 | Recuperación tras interrumpir el proceso (`kill -9` del worker tras el `quote.create` y antes de la respuesta) | Oferta por 2 kettlebell 10 kg | Al reiniciar se retomó el turno: **1 ejecución, 1 recibo, 1 cotización**; la respuesta con el número llegó después del reinicio | PASS |

**Comparación con `@14`** (preparación anterior, escenario 5): con v14 el modelo afirmó «Tenemos stock disponible… las 2 unidades» con stock 1. Con v16, en los 5 escenarios con stock limitado o desconocido (3, 4, 5, 7 y el refinamiento), **ninguna respuesta afirmó una cantidad**.

## 4. Origen de los errores

| Capa | Hallazgo |
|---|---|
| Catalog V2 | **Sin defecto.** Los datos de ítem son exactos (stock por variante, cobertura), y `quote.preview` los usa correctamente |
| Representación de capacidades | **Límite real.** El contexto de producto que ve el modelo trae la disponibilidad por producto y la lista de variantes, pero **no la disponibilidad por variante** (aunque Catalog la tiene). Por eso el modelo no puede saber qué talla hay (O-2) |
| Interpretación del modelo | **Corregida por v16.** Con v14 infería una cantidad desde «vendible / con stock». Con v16 siempre la remitió a `quote.preview` |

## 5. Defectos restantes y propuestas

| ID | Severidad | Hallazgo | Propuesta |
|---|---|---|---|
| F-WA-2 | **Media** | El presupuesto de escrituras por task (`R4_EXEC_MAX_WRITE_ACTIONS`) lo consumen también las actualizaciones del workspace de Sales. Una conversación con cambios de producto o cantidad (4 actualizaciones) agotó el techo 4 antes de `quote.create`: no hubo cotización y el caso pasó a una persona (resultado seguro). Con 6, el máximo F1 aprobado, pasó; una conversación más larga podría agotarlo igual | Decisión del owner: (a) configurar el carril con 6 (inmediato); (b) no contar `sales.workspace.update`, escritura interna y reversible del pack, contra el presupuesto de escrituras externas. Eso es una decisión de política y presupuesto de plataforma, no de este perfil, y no se tocó el kernel |
| O-2 | Baja | Tras una variante sin stock, el modelo ofrece probar otras que tampoco tienen (L, XL). Son vueltas de más, no afirmaciones falsas | Control estructural en la representación: incluir en el contexto de producto la vendibilidad por variante, que Catalog V2 ya entrega. No es una herramienta nueva ni un segundo motor; es un cambio de salida de capacidad que necesita su propia evaluación |
| O-1 | Baja | En el escenario 4 la apertura «Sí, tenemos…» es ambigua para una variante agotada, aunque el mensaje aclara que la talla no está confirmada | Lo resuelve O-2. Si no, ajustar el texto (sin ciclos de instrucciones) |
| — | Información | Las dos interrupciones cayeron **después** de la escritura (el Quote local responde en menos de 1 s). La interrupción **durante** la escritura no se ejercitó en esta campaña | La cubren las pruebas de integración de recuperación y la falla inyectada de E3-A |
| — | Información | Una sola corrida por escenario con un modelo no determinista: no es evidencia estadística | Repetir el conjunto antes de activar, como parte del gate `fwa1-evaluation` |

**No hace falta, por ahora, un control estructural en la frontera de presentación** para la afirmación de stock: v16 la eliminó en todos los casos. Como defensa en profundidad, si reaparece en evaluaciones repetidas, se propone un chequeo determinista en la frontera de respuesta: una respuesta que afirme disponibilidad para una cantidad sin una observación de `quote.preview` para esa cantidad en el turno se reconsidera, mediante el guard de fin de turno existente.

## 6. Pendiente

- Revisión y merge del PR #56, por decisión del owner.
- Decisión sobre F-WA-2.
- O-2, como trabajo separado.
- Todos los gates de activación de `@14`/`@16`: R1.7, P-1, principal, F-E1-1, L3 y autorización por SHA.
