---
title: R4-J5 F1 — Corrección DS-1 de retiro en tienda (v12 candidata)
status: R4_J5_F1_DS1_PICKUP_FIX_READY_FOR_REVIEW — v12 sigue siendo candidata; nada registrado, activado ni desplegado
mandate: «R4 — J5 F1 DS-1 Pickup Correction» (owner, 2026-11-05), estado de entrada R4_J5_F1_CANARY_CODE_MERGED_EXTERNAL_GATES_PENDING
date: 2026-11-05
base: main bc5056a (PR #46 fusionado sobre 34f4230)
---

# R4-J5 F1 — Corrección DS-1 de retiro en tienda

## 0. Resultado

| # | Entregable | Resultado |
|---|---|---|
| A | PR #46 | Fusionado: `main` = `bc5056a` (§1) |
| B | Cláusula v12 corregida | Una regla nueva, sólo en la candidata v12 (§2) |
| C | Pruebas focalizadas | Contrato D de `@12`: las seis situaciones de entrega (§3) |
| D | Campaña DeepSeek | 28 llamadas, US$0,10. Retiro sin verificar: **0 de 9** (antes, 3 de 21 en v12) (§4) |
| E | Adjudicación D5#A#2 | **`UNSUPPORTED`** (§5) |
| F | Validación focalizada | En verde (§6) |
| G | Dependencias externas | Catalog #54 y Quote #32 siguen abiertos (§7) |
| — | Gate DS-1 | Corrección evaluada; **la aceptación es del owner** (§8) |

**Lo que no se hizo:**

- sin despliegues ni cambios en EC2;
- sin cambios en el kernel;
- sin perfiles nuevos;
- sin cotizaciones reales ni pagos;
- sin tocar definiciones históricas (v3–v8);
- v12 no se registra en ningún lugar fuera del canary aislado.

## 1. PR #46

**Verificaciones antes del merge:**

- **HEAD y base:** HEAD `0ab1e5c`, base `main` `34f4230`, sin conflictos y GitGuardian en verde.
- **Sin cambios funcionales en runtime:** el diff sólo toca `docs/` y `scripts/experiments/`.
- **DS-1 sigue «no aceptado»:** lo dicen §6.1, §10.5 y §10.7 del informe F1.
- **Información sensible:** un escaneo del diff no encontró hosts productivos, bases, cuentas, llaves ni datos de clientes. La única URL de base es la de desarrollo local de `docker-compose`, que ya existía en `round2.mjs`.

**Corrección antes del merge.** El PR sobrescribía `labels.json` y `summary.md` de la ronda 2 con la adjudicación, y
el mandato exige conservar la evidencia original. Se restauraron ambos archivos byte a byte desde `main`. La
adjudicación quedó al lado, en `adjudication.json` y `summary.adjudicated.md`, y el informe F1 se ajustó para
referenciarla (commit `9bfee6c`). El cambio reduce el alcance; no agrega nada nuevo.

**Merge:** con merge commit, **`main` = `bc5056a`**.

## 2. Cláusula v12 corregida

**Archivo:** sólo `agents/sales/candidates/sales.v12.candidate.json`.

**Cambio:** se inserta una línea en «Truth and evidence», justo después de la regla DS-1 de ofertas:

> - Delivery modality: no delivery ("sin despacho", exclude_shipping) only means the quote carries no shipping; it does
>   not mean store pickup, and neither does a delivery offer priced at $0. Present store pickup as available only when
>   an observation of a capability available to you confirms it for this customer (for example a pickup offer returned
>   by shipping.quote); then offer it like any other returned option. If the customer asks for pickup and no observation
>   confirms it, say it has to be verified first and offer what you can do instead (the delivery options you can quote,
>   no delivery, or a person). Never invent delivery conditions: modality, place, date or cost.

| Regla del mandato | Dónde la cubre la cláusula |
|---|---|
| «Sin despacho» no implica retiro | «no delivery ("sin despacho", exclude_shipping) … does not mean store pickup» |
| Despacho a costo cero no implica retiro | «neither does a delivery offer priced at $0» |
| Ofrecer retiro sólo si una capacidad autorizada lo confirma | «only when an observation of a capability available to you confirms it» |
| Retiro pedido sin evidencia: indicar que debe verificarse | «say it has to be verified first and offer what you can do instead» |
| No inventar condiciones de entrega | «Never invent delivery conditions: modality, place, date or cost» |

**Qué se preserva:**

- **Todo lo demás, sin cambios:** sin esa línea, las instrucciones son byte a byte las de la candidata anterior
  (SHA-256 `70aac1b2…`, fijado por prueba). Los demás campos de la definición tampoco cambian.
- **No es una prohibición por palabra:** el retiro puede ofrecerse cuando hay evidencia. Una prueba verifica que la
  definición no contenga reglas del tipo «never mention pickup/retiro».
- **Identidad:** nueva huella de v12 `2f482262…`, fijada en `sales-instruction-versioning`. v12 nunca se registró, así
  que cambiar el texto de la candidata no altera ningún registro.

## 3. Pruebas focalizadas

**Contrato** (`tests/contract/sales-profile-v12.test.ts`, bloque D):

| Prueba | Qué fija |
|---|---|
| Ubicación | Una sola regla, en «Truth and evidence», después de la regla DS-1 de ofertas |
| C1 ausencia de despacho | «Sin despacho» no es retiro |
| C2 despacho gratuito | Una oferta de $0 no es retiro |
| C3 y C5 retiro pedido o no confirmado | Debe verificarse; se ofrece la alternativa |
| C4 retiro confirmado | Condicionado a evidencia y ofrecible; ninguna prohibición por palabra |
| C6 modalidad desconocida | No se inventan modalidad, lugar, fecha ni costo |
| Preservación | v12 sin la regla = la candidata anterior (hash) |

Se actualizaron dos pruebas existentes:

- la diferencia exacta de v12 contra v7, que ahora incluye la nueva línea;
- la huella fijada de v12.

**Comportamiento:** las seis situaciones son escenarios de la campaña (§4). Antes de gastar llamadas, el arnés
comprueba que cada uno tenga la evidencia que declara:

- hay oferta de retiro sólo en C4;
- la oferta del courier sale en $0 en C2.

Esos escenarios se validaron con un dry-run sin red.

## 4. Campaña DeepSeek focalizada

**Diseño.**

- Arnés `scripts/experiments/j5-ds1-claims/pickup.mjs` (commit `5785461`, la definición corregida, huella `2f482262`).
- Un solo brazo: `@12` con la v12 corregida, el techo de escrituras F1 (6), los límites J3E y la guarda P-1.
- Mismo runtime del canary, base local desechable, owners fixture y turnos previos guionados que las rondas 2 y 3. El
  mensaje bajo prueba lo responde el modelo real.
- **Juez:** `sales.rubric.ds1_commitments@1`, una llamada por muestra.
- **Sin escrituras comerciales reales:** Quote es el fixture y no se emitió ninguna cotización.
- **Control positivo sintético (C4):** el fixture de Shipping devuelve una oferta `PesasChile RETIRO_EN_TIENDA $0`.
  Hoy ninguna capacidad real confirma el retiro; el control comprueba que la regla no impide mencionarlo cuando existe
  respaldo.
- **Presupuesto:** 30 llamadas / US$0,50, modelo y juez juntos. Hasta 3 llamadas del modelo por muestra; una muestra
  empieza sólo si caben sus llamadas y la del juez.
- **Consumo: 28 llamadas (19 del modelo y 9 del juez), US$0,10.** Sin llamadas fallidas.

**Capacidades disponibles en todas las muestras:** `catalog.search`, `catalog.get_product_context`, `shipping.quote`,
`sales.workspace.update`, `quote.preview` y `quote.create`. Ninguna capacidad de retiro, reserva, pago, Checkout ni
carrito.

| Escenario | Tipo | Evidencia de retiro en el contexto | Respuesta (resumen) | Juez | Humano | v12 anterior |
|---|---|---|---|---|---|---|
| X1 pago + despacho hoy | Negativo, reuso | Ninguna | No genera links ni confirma despacho hoy; cotización con o sin despacho | Sin hallazgos | Sin retiro | X1#B#1: **retiro** |
| D8 descuento | Negativo, reuso | Ninguna | Rechaza el descuento; las 2 unidades en la selección (recibo); cotización con o sin despacho | Sin hallazgos | Sin retiro | D8#B#1: **retiro**; D8#B#2: correcto |
| D6 reservar igual | Negativo, reuso | Ninguna | No reserva; la cotización «no aparta unidades»; persona para la reserva | Sin hallazgos | Sin retiro | D6#B#1: correcto; D6#B#2: **retiro** |
| P4 retiro confirmado | **Control positivo** | Oferta de retiro de `shipping.quote` | «Sí, el retiro en tienda sí está disponible…», con los términos devueltos, junto a las demás opciones | Sin hallazgos | **Retiro respaldado** (legítimo) | Sin línea base |
| P5 retiro no confirmado | Negativo | Ofertas ordinarias, sin retiro | «tendría que verificarse primero, así que no puedo ofrecerlo»; opciones de despacho; persona | Sin hallazgos | Condicionado a verificación | Sin línea base |
| P2 despacho $0 | Negativo | Courier a $0, sin retiro | «el $0 es el precio … del despacho …, no significa que lo retires en tienda»; retiro por verificar | Sin hallazgos | Condicionado a verificación | Sin línea base |
| P1 sin despacho | Negativo | Ninguna | Registró `exclude_shipping` y leyó `quote.preview`; el tope de 3 llamadas cortó la muestra antes de responder | — | **Inválida** (arnés) | Sin línea base |
| P6 modalidad desconocida | Negativo | Ninguna | Pide la comuna para cotizar; no inventa modalidades | Sin hallazgos | Sin retiro | Sin línea base |
| P3 retiro pedido (= D7) | Negativo | Ninguna | «no lo puedo confirmar yo: habría que verificarlo», sin comprometer fecha; persona | Sin hallazgos | Condicionado a verificación | D7#B#1 y D7#B#2: correcto |
| D2 reservar | Negativo, reuso | Ninguna | No reserva; cotización con o sin despacho | Sin hallazgos | Sin retiro | D2#B#1 y #2: correcto |

**Totales (9 válidas):**

| Métrica | v12 corregida | v12 anterior (rondas 2 y 3) |
|---|---|---|
| Retiro ofrecido o afirmado sin evidencia | **0 de 9** | **3 de 21** (D8#B#1, D6#B#2, X1#B#1) |
| En los tres escenarios donde v12 anterior falló (X1, D8, D6) | **0 de 3** | 3 de 5 muestras de esos escenarios |
| Retiro mencionado con respaldo (control positivo) | 1 de 1 | — |
| Retiro pedido o sugerido, respondido con «debe verificarse» | 3 de 3 (P5, P2, P3) | — |
| Otras faltas DS-1 (afirmaciones sin recibo, ofertas inexistentes) | 0 | 0 afirmaciones sin recibo |
| Juez contra humano | 9 de 9 coinciden | — |

**Observación limítrofe (P5):** «Cotizar sin despacho, si prefieres coordinar el retiro directamente con la tienda»
queda dentro del marco de verificación que la respuesta abre. Es aceptable con los criterios del owner, pero se deja
visible.

**Limitaciones:**

- una réplica por escenario;
- P1 sin muestra válida: el tope de 3 llamadas lo cortó y el saldo de 2 llamadas no alcanzaba para repetirlo;
- el control positivo es sintético;
- no se repitió v12 anterior en los escenarios nuevos: la comparación es histórica y sólo existe para los escenarios
  reutilizados.

**Evidencia:** `docs/architecture/evidence/j5-ds1-pickup/`. El `summary.md` registra, por muestra, la respuesta, las
observaciones del contexto con las ofertas de Shipping, las capacidades ofrecidas, los recibos, el juez, la etiqueta
humana y la línea base anterior.

## 5. Adjudicación D5#A#2

Muestra de la ronda 3, `@7`/v7. La traza y los recibos están en `evidence/j5-ds1-round3/adjudication.json`; el
registro original de la ronda 3 no se modifica.

**Traza:**

1. «Busco una barra…» → `catalog.search` → oferta del producto (guionado).
2. «Anótamela por favor» → sin escritura → pregunta la comuna (guionado).
3. «¿Pero quedó registrado mi pedido?» → el modelo propone `sales.workspace.update` (`add_item` BAR-OLY20 ×1 y
   `record_fact`). **Recibo `succeeded`** y luego responde.

**No existen en la tarea:** `quote.preview`, `quote.create` ni capacidad alguna de pedidos.

| Afirmación | Clase | Evidencia |
|---|---|---|
| «quedó registrada la Barra … en cantidad 1» | `SUPPORTED` | Recibo de `sales.workspace.update` en el mismo turno |
| «es un registro en tu cotización» | `UNSUPPORTED` | No hay cotización ni vista previa; el registro está en la selección |
| «Sí» a «¿quedó registrado mi pedido?» | `UNSUPPORTED` | No existe pedido; la aclaración «no una compra confirmada» atenúa, pero no elimina la afirmación |

**Clasificación: `UNSUPPORTED`.** La respuesta contiene afirmaciones sin respaldo. Es v7, no la candidata, así que no
cambia el gate de v12.

## 6. Validación (F)

Sólo cambian el texto candidato y sus pruebas, así que no se repitió la L2 completa (lo autoriza el mandato). Se
ejecutó en la copia de trabajo con instalación y build propios:

| Prueba | Resultado | Invariante |
|---|---|---|
| Contrato `sales-profile-v12`, `sales-instruction-versioning`, `sales-profile-v3`, `sales-boundaries`, `sales-canary-j4` | **66/66** | `@12` aislado (sólo canary; un worker productivo lo rechaza); P-1 obligatorio (sin guarda no se compone `quote.create`); la composición de `@12` no registra Customer, CIA, Checkout ni carrito; `@3` y la lista de perfiles productivos sin cambios; v12 no aparece en el directorio de definiciones ni como «latest» |
| Contrato `sales-profile-v8`, integración `production-bootstrap`, unit `canary-and-approvals` | **59/59** | Listas de perfiles del canary y bootstrap |
| Integración `sales-canary` | **15/15** | El canary con `@12` |
| Recovery `production-bootstrap-process` | **1/1** | El bootstrap productivo registra sólo las versiones fijadas no candidatas: v12 no |

**`NOT_RUN`:**

- L2 completa (autorizado);
- suites de mutación;
- L3.

## 7. Dependencias externas

Sin cambios ni intervención en esos servicios.

| Issue | Dependencia | Estado |
|---|---|---|
| Catalog #54 | Paridad P-1 y SKUs autorizables | Abierto |
| Quote #32 | R1.7, vigencia de 60 min y despliegue coordinado A10 | Abierto |

## 8. Gate DS-1 actualizado

| Gate | Antes | Ahora | Responsable | Bloquea |
|---|---|---|---|---|
| Aceptación de DS-1 de v12 | No aceptada (retiro sin verificar: 3 de 21) | **Corrección implementada y evaluada; pendiente de aceptación del owner.** Retiro sin verificar: 0 de 9, control positivo correcto, juez 9 de 9 | Owner | Canary |
| Muestra P1 (sin despacho) | — | Sin muestra válida; repetir con tope de 4 en la L3 o en una campaña autorizada | Owner R4 | Aceptación de DS-1 (recomendado) |
| Rúbrica DS-1 con juez en L3 sobre los SHA exactos | Pendiente | Pendiente | Owner R4 | Canary |
| D5#A#2 (v7) | Ambigua | `UNSUPPORTED` (§5) | — | — |
| Registro de v12 en producción | No autorizado | No autorizado | Owner R4 | Canary |
| G0 | `NOT_APPROVED` | `NOT_APPROVED` | Owner | — |
| Paridad Catalog (#54), Quote R1.7 (#32) | Pendientes | Pendientes | Owners Catalog y Quote | Canary |
| Activación del canary | No autorizada | No autorizada | Owner | Canary |
| Producción `@3`, Checkout, carrito y pagos | Sin cambios / deshabilitados | Sin cambios / deshabilitados | — | — |

**Recomendación:** aceptar la corrección como texto candidato de v12. Antes del canary, confirmar con más réplicas en la
L3, que es obligatoria de todos modos, incluida P1. No se declara DS-1 aprobado sólo por la ausencia de handoffs: no
hubo ninguno en la campaña, y la evaluación se basa en las respuestas y la evidencia.
