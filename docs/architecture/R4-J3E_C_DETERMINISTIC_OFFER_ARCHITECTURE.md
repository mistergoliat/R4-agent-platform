# R4-J3E-C — Arquitectura de oferta comercial determinista

Fecha: 2026-10-14 · Rama: `r4-j3e-c-deterministic-commercial-offer` (desde `main` `092715e`) · Tipo: **auditoría read-only y propuesta**. No hay código, migraciones, commits ni ejecuciones en EC2.

Complementa: `R4_J3E_PRODUCTION_GAP_CLOSURE_PLAN.md`, que cubre la procedencia (Fase 2), la robustez y el rendimiento (Fase 3), los riesgos de producción (Fase 4) y la propuesta de implementación consolidada.

Etiquetas de evidencia: **SOURCE** = verificado en el código de `092715e`; **DOC** = afirmado en un informe o ADR del repositorio; **HIPÓTESIS** = no verificado, requiere un experimento.

```
R4_J3EC_BRANCH=r4-j3e-c-deterministic-commercial-offer (base 092715e = origin/main)
R4_J3EC_CODE_CHANGED=NO
R4_J3EC_HARNESS_CHANGE_REQUIRED_FOR_ISSUANCE_INTEGRITY=NO
R4_J3EC_HARNESS_CHANGE_REQUIRED_FOR_PRESENTATION_INTEGRITY=YES   (§5.3)
R4_J3EC_MIGRATION_REQUIRED=NO
R4_J3EC_RECOMMENDED=Alternativa B2: mensaje de oferta completo renderizado por Sales + igualdad exacta verificada por quote.create@5
```

> **Actualización 2026-10-14 (R4-J3E-C1 implementado, sin commit).** La alternativa B2 está implementada en la misma rama: `quote.preview@3`, `quote.create@5`, definición v7 y `sales-production@7`. Ver `R4-J3E_C1_IMPLEMENTATION_REPORT.md`. Diferencias con lo propuesto abajo:
> - `presentation` (con `offerMessage`) solo existe cuando el preview está `ready` **e** `issuable`. Con un límite excedido no hay nada que el cliente pueda confirmar.
> - La línea de condiciones de la plantilla quedó como "montos en pesos chilenos, con IVA incluido salvo el neto", válida con y sin despacho.
> - La igualdad se verifica sobre el hash exacto del texto, sin normalización (§5.4).
> - Fidelidad de copia medida localmente con el modelo real: 108/108 exactas (89 ofertas y 19 re-presentaciones), 0 fallos JSON. El paso C1.2 está hecho; C1.3 (canary EC2) y C1.4 (decisión sobre la Alt. C) siguen pendientes. Recomendación en el informe §12.
> - Hallazgo previo, J2 (no modificado): un producto con peso solo por variante no obtiene cotización de despacho por pedido (`shipping-basis.ts:35-37`).

## 0. Recuperación y verificación (Fase 0)

| Comprobación | Resultado |
|---|---|
| `git fetch origin`; `main` = `origin/main` | `092715e` (handoff J3E). Solo aparecieron ramas remotas nuevas ajenas a J3E (`r4-discover-i1-catalog-discover`, `r4-j3d-r-sales-canary-tooling`). |
| Commits esperados en `main` | `cc1e6c3` (J3E-A), `4fc071a` (evidencia J3E-A), `a841adb` (J3E-B), `51e98b8` (evidencia J3E-B), merges `6592987` y `29d0fc4`, handoff `092715e`. Todos presentes. |
| Working tree | Limpio antes de crear la rama. |
| Rama | `r4-j3e-c-deterministic-commercial-offer` creada desde `092715e`. |
| Lectura previa | `R4_J3E_CROSS_PC_HANDOFF.md`, ADR-034, ADR-035, informes J3E-A y J3E-B completos. |
| EC2 y producción | No se tocaron. |

## 1. Flujo auditado y contratos reales (SOURCE)

```
Workspace Sales (escrito por el modelo vía sales.workspace.update@2)
  └─► buildCommercialSnapshot (commercial-snapshot.ts:113-222)   owners AHORA: Catalog, Shipping; aritmética Quote V2
        └─► quote.preview@2 (quote-preview.ts:149-199)            snapshot + previewId + presentation {reference, grossClp, totalText}
              └─► Agent: decisión `respond` (texto libre del modelo, contracts/decision.ts:51-54, máx. 8000)
                    └─► agent_run_steps.decision->>'content'       registrado tal cual (decision.ts:13-22)
                          ├─► materializeResponses → outbound_messages (production-store.ts:221-291; content_sha256 del mismo texto)
                          ├─► claimNextOutbound: el texto enviado es el MISMO campo (production-store.ts:333-335)
                          ├─► WhatsApp: body = texto, sin transformación (whatsapp-cloud/src/outbound.ts:51)
                          └─► ProductionStore.thread(): entrada `agent` con ese texto y el estado de entrega (production-store.ts:556-563)
  Cliente responde ─► ChannelIngress → task_inputs (entrada `contact`)
        └─► quote.create@4 {previewId} (quote-v4.ts:66-178)
              1. snapshot recalculado; previewId igual; límites
              2. locateConfirmation(thread) (quote-v4.ts:188-243): gramática, inmediatez, presentsOffer(texto, referencia, total), entrega, ventana
              3. decisión (0008) + evidencia (0009) + cuerpo congelado (0007), una transacción (store.ts:367-432)
                    └─► Quote V2 createAndIssue → settle (quote-v2.ts:308-368) → PDF SHA-256
```

Hechos de contrato que determinan el diseño:

| Hecho | Fuente |
|---|---|
| `respond` se registra **exactamente como se decidió**: "no validator, correction or degradation stands between it and outbound". Termina el turno. | `packages/contracts/src/decision.ts:13-22` |
| El único origen de mensajes de agente es un paso `respond`; `materializeResponses` solo materializa pasos `respond` registrados. | `production-store.ts:221-231`; `live-ops/src/delivery.ts:27` (`OUTBOUND_ORIGINS = ['agent', 'operator']`) |
| El texto que muestra `thread()` y el que se envía al proveedor salen de la misma columna (`decision->>'content'`). Verificar el texto del hilo es verificar lo enviado. | `production-store.ts:333-335`, `:558` |
| Un outbound `operator` es un acto humano: no lo frenan el kill switch, el rollout ni la propiedad humana. | `delivery.ts:83-87` |
| `quote.create@4` verifica de la oferta solo la referencia (token, sin distinguir mayúsculas) y que el total bruto aparezca como **algún** número del texto. | `offer-presentation.ts:21-27`, `quote-v4.ts:212` |
| La referencia es `Q-<6 hex del previewId>-<versión comercial>` (24 bits del hash). | `offer-presentation.ts:11-13` |
| `settle` compara totales, correlación, cantidad de líneas y presencia de despacho, pero **no** los montos por línea ni el monto del despacho que Quote V2 devuelve. | `quote-v2.ts:323-333`; `adapters/domains/src/quote/v2.ts:121-122` |
| `0009` ya guarda `offer_text_sha256` (hash del mensaje completo de oferta). `0008.quote_request` es `jsonb` objeto libre. | `migrations/0009…sql`, `migrations/0008…sql` |
| Un test de contrato prohíbe columnas Sales con nombres `*text`, `words`, `body`, `message` (no copiar texto). | `tests/contract/sales-confirmed-intent.test.ts:157` |
| Las instrucciones no pueden usar `intent`/`stage` ni el código usar esos identificadores con `:`/`=`. | `tests/contract/sales-boundaries.test.ts:89-96` |

## 2. Quién controla qué hoy (`@6`)

| Elemento | Origen | ¿Garantizado por Sales? |
|---|---|---|
| Productos y variantes del workspace | Modelo (`sales.workspace.update`), con claves de Catalog | Solo existencia y vendibilidad; **qué** producto quería el cliente lo interpreta el modelo |
| Cantidades del workspace | Modelo | No respecto de las palabras del cliente |
| Destino y oferta de despacho elegida | Modelo; la oferta se recotiza contra Shipping (`select_shipping_offer`) | Que la oferta existe a ese neto: sí. Que es la que eligió el cliente: no |
| Precio unitario, tramo, impuesto, stock | Catalog, en el snapshot | **Sí** |
| Monto de despacho | Shipping, en el snapshot | **Sí** |
| Neto, IVA, total | Aritmética Quote V2 (`quoteV2ChargeAmounts`, `quoteV2Totals`) | **Sí** |
| `previewId`, referencia, versión comercial | Sales | **Sí** |
| Texto de la oferta mostrado al cliente (líneas, variantes, cantidades, precios, despacho, neto, IVA) | **Modelo** | **No**. Solo referencia y total |
| Afirmaciones extra en la oferta (descuentos, despacho gratis, plazos, validez) | **Modelo** | **No** |
| Validez antes de emitir | Modelo (la instrucción lo prohíbe; nada lo impide) | No. La validez la fija Quote V2 al emitir |
| Confirmación del cliente | Hilo de la plataforma + gramática cerrada | Sí, sujeta a la topología y a un orden que compara dos relojes distintos (plan §2.2, P2–P3) |
| Cotización emitida | Cuerpo congelado del snapshot recalculado; Quote V2 | Totales, líneas (cantidad), despacho (presencia), correlación, PDF por SHA-256 |
| Mensaje posterior a la emisión (número, total, validez) | Modelo, a partir del recibo | No (ya está emitida) |

Consecuencia central: el snapshot refleja fielmente el **workspace**, que escribe el modelo. Lo único que conecta el snapshot con lo que el cliente quería es que el cliente **vea** el contenido exacto y lo confirme. Hoy lo que ve lo escribe el modelo. Por eso la integridad de la oferta presentada es la condición que da sentido a la confirmación de `@6`.

## 3. Debilidades confirmadas

| # | Debilidad | Evidencia | Efecto |
|---|---|---|---|
| D1 | Las líneas, variantes, cantidades, precios unitarios, despacho, neto e IVA del mensaje de oferta no se verifican. | `quote-v4.ts:212`; J3E-B §11.6 (coincidencia **observada**, no garantizada) | Un cliente puede confirmar una descripción falsa con la referencia y el total correctos, y se emite. |
| D2 | `presentsOffer` acepta el total si aparece como **cualquier** número del texto. | `offer-presentation.ts:25-26` | "Total $49.990 … ahorras $52.980" pasaría. |
| D3 | El texto libre puede contradecir la oferta (descuento, despacho gratis, validez). | `decision.ts:13-22`; sin verificación | La confirmación cubre condiciones que la cotización no tendrá. |
| D4 | La oferta se vincula al snapshot por 24 bits del `previewId` + versión comercial + total, no por el contenido. | `offer-presentation.ts:11-13` | Riesgo práctico bajo; no es "correspondencia exacta". |
| D5 | Ningún mecanismo impide que una oferta errónea **llegue** al cliente. | `decision.ts:13-16`; `production-store.ts:221-291` | Con cualquier diseño sin cambio de harness, el error se detecta al emitir, no al enviar. |
| D6 | `settle` no compara montos por línea ni monto de despacho devueltos por el owner. | `quote-v2.ts:323-333` | Un owner defectuoso que redistribuya montos con totales iguales se reportaría como éxito. Probabilidad baja; control barato. |
| D7 | El mensaje posterior a la emisión lo escribe el modelo. | instrucciones v6 | Puede citar mal número, total o validez. No afecta la cotización emitida. |
| D8 | `respond` admite 8000 caracteres; el adaptador WhatsApp envía el texto sin límite propio. | `decision.ts:53`; `outbound.ts:51` | Un mensaje de oferta largo podría ser rechazado por el proveedor (límite del proveedor no verificado aquí). |

## 4. Alternativas

| Alt. | Descripción | Integridad de la emisión | Integridad de lo que ve el cliente | Cambia harness | Veredicto |
|---|---|---|---|---|---|
| A | Mantener `@6` y endurecer la heurística (parsear líneas del texto libre). | Parcial; es NLP sobre texto libre | No | No | **Rechazada**: frágil, no determinista. |
| B1 | Bloque de oferta renderizado por Sales; la oferta debe **contenerlo**. | Bloque: sí. Texto fuera del bloque: no (D3) | No | No | Rechazada: el texto libre alrededor puede contradecir el bloque. |
| **B2** | **Mensaje de oferta completo** renderizado por Sales; `quote.create@5` exige que el mensaje entregado sea **idéntico**. | **Sí, exacta** | No (se detecta al emitir) | **No** | **Recomendada** (§5). |
| B3 | B2 con un preámbulo libre restringido (sin dígitos, `$`, `%`). | Casi; las palabras pueden contradecir ("despacho gratis") | No | No | Diferida a una versión de plantilla posterior si la UX lo exige. |
| C | Respuesta **compuesta por la plataforma**: `respond` referencia el texto renderizado de una observación READ y el kernel compone el contenido registrado. El modelo nunca escribe cifras. | Sí | **Sí** | **Sí** (protocolo de decisión, kernel, ADR) | Evolución recomendada si la fidelidad de copia de B2 no alcanza o si el owner exige que el cliente nunca vea una cifra errónea. |
| D | Capacidad Sales que envía la oferta con `ProductionStore.createOperatorOutbound`. | Sí | Sí | No | **Rechazada**: atribuye a un humano un mensaje automático y evita kill switch, rollout y propiedad humana (`delivery.ts:83-87`). `quote-v4` además trata un mensaje `operator` como interrupción. |
| E | Nuevo origen de outbound `capability`, enviado por una escritura gobernada EXTERNAL_COMMUNICATION. | Sí | Sí | Sí, mayor que C | Rechazada por ahora: más cambio que C, dos mensajes por turno. |

## 5. Diseño recomendado: B2

### 5.1 Principio

Sales es el autor del texto comercial que el cliente confirma. El modelo solo lo transporta. La emisión exige que el mensaje que la plataforma registró y envió sea byte a byte el que Sales renderiza **ahora** a partir del snapshot recalculado. Si el modelo no lo copia bien, no se emite (`offer_not_presented`). La corrección **no depende** de que el modelo copie bien; solo la disponibilidad depende de ello.

### 5.2 Componentes

1. **Plantilla `r4-sales-offer-es-v1`** (`offer-presentation.ts`, nueva función pura `renderOfferMessage(snapshot, reference)`).
   - Entrada: el `CommercialSnapshot` y la referencia. Solo formatea valores que ya están en el snapshot con `formatClp` (existente). **Sin aritmética**: los montos por línea, el despacho, el neto, el IVA y el total vienen de `quoteV2ChargeAmounts`/`quoteV2Totals`, como hoy.
   - Contenido: referencia; por línea, descripción, atributos de variante, cantidad, precio unitario con IVA y subtotal; despacho (transportista, servicio, comuna, región, monto) o "no incluido"; neto; IVA; total; una frase fija sobre número y validez ("los indica la cotización al emitirse"); y la pregunta de confirmación con un ejemplo que la gramática `r4-sales-confirmation-es-v1` acepta.
   - Sin comillas dobles ni barras invertidas en el texto fijo (reduce escapes JSON) y sin `*`, `_`, `~` fijos (formato WhatsApp).
   - Si el mensaje supera un máximo fijo (por ejemplo 3 500 caracteres), el preview queda `blocked` con `offer_message_too_long`.

   Ejemplo con el snapshot de PC-000005:

   ```
   Cotización lista para emitir. Ref. Q-5F57B2-2

   1. Par Mancuernas Hexagonales 12.5kg | HWM®
      Cantidad: 1. Precio unitario: $47.990. Subtotal: $47.990

   Despacho: Pesas Chile, Despacho Directo, a Ñuñoa (Metropolitana de Santiago): $4.990

   Neto: $44.521
   IVA: $8.459
   Total: $52.980 (IVA incluido)

   Montos en CLP. El número y la validez se informan al emitir la cotización.
   ¿Emito esta cotización? Puedes responder: Sí, emítela.
   ```

2. **`quote.preview@3`** (`quote-preview.ts`): salida de `@2` más `presentation.offerTemplate`, `presentation.offerMessage` y `presentation.offerMessageSha256`. `@1` y `@2` no cambian.
3. **`quote.create@5`** (`quote-v5.ts`, nuevo): igual a `@4` (misma entrada `{previewId}`, misma maquinaria Quote V2, misma gramática y reglas del hilo), con una regla más fuerte:
   - `expected = renderOfferMessage(snapshotRecalculado, offerReference(previewId, versiónComercialActual))`;
   - se emite solo si `sha256(textoDeLaOfertaEnElHilo) === sha256(expected)`; si no, `offer_not_presented` con `offerTemplate`, `expectedSha256` y `presentedSha256` en los detalles;
   - como `previewId(recalculado) = previewId` implica snapshot canónico idéntico, la igualdad vincula **todos** los elementos: productos, variantes, cantidades, precios, despacho, neto, IVA, total y referencia.
   - Implementación mínima: `locateConfirmation` de `@4` ya calcula `offerTextSha256`; `@5` compara ese hash con el esperado. `quote-v4.ts` no cambia.
4. **Evidencia sin migración.** `0009.offer_text_sha256` pasa a ser, en `@5`, la prueba de que el mensaje confirmado era exactamente el renderizado. La versión de plantilla y el hash esperado se agregan al objeto `quote_request` (`jsonb`) de `0008`. No se copia texto en Sales (respeta `sales-confirmed-intent.test.ts:157`).
5. **`settle` estricto (D6).** Parámetro opcional, desactivado por defecto, que además compara los montos por línea y el monto del despacho devueltos por Quote V2 con el cuerpo congelado. `@2–@4` siguen idénticos.
6. **Definición Sales v7** (`sales.v7.agent.json`): al presentar, responder **solo** con `presentation.offerMessage`, sin texto antes ni después; repetir el mismo mensaje cuando la confirmación se rechace por ambigüedad o falte presentarla; preguntas laterales en un turno aparte; no afirmar validez antes de emitir. Sin las palabras prohibidas por `sales-boundaries.test.ts`.
7. **Perfil `sales-production@7`**: `@6` con `quote.preview@3`, `quote.create@5` y la definición v7. Misma política autónoma (las reglas se resuelven por `capabilityId`, así que el hash `515ce98f…` no cambia), mismos límites v6.

### 5.3 Qué se puede demostrar sin cambiar el harness

| Pregunta de la instrucción | Respuesta | Base |
|---|---|---|
| ¿Se puede **construir** la presentación de forma determinista? | **Sí.** Función pura sobre el snapshot. | §5.2.1 |
| ¿Se puede **enviar** por interfaces existentes? | **Solo a través del `respond` del modelo.** No hay otra vía de mensaje de agente. La vía `operator` no es aceptable (Alt. D). | `decision.ts:13-22`; `production-store.ts:221-291`; `delivery.ts:83-87` |
| ¿Se puede **verificar** su persistencia? | **Sí.** `thread()` devuelve el texto registrado, que es el texto enviado, y su estado de entrega. `@6` ya usa este puerto. | `production-store.ts:333-335`, `:556-563` |
| ¿Integridad de la cotización emitida respecto de lo confirmado? | **Sí, exacta, sin harness** (B2). | §5.2.3 |
| ¿Integridad de lo que el cliente **ve** antes de confirmar? | **No sin harness.** | ver abajo |

**Bloqueo exacto de la integridad previa al envío.** El protocolo v5 prohíbe cualquier validador o corrección entre `respond` y el outbound (`decision.ts:13-16`), y el único origen de mensajes de agente es `respond` (`production-store.ts:221-231`). Ningún componente Sales puede impedir que un mensaje de oferta mal copiado llegue al cliente. Con B2 ese mensaje **no se puede emitir**: el cliente lo confirma, la emisión se rechaza con `offer_not_presented` y el agente presenta el mensaje correcto.

**Alternativa arquitectónica para cerrarlo:** Alt. C (respuesta compuesta por la plataforma). Requiere un ADR propio:
- `respond` acepta, de forma opcional, una referencia a una observación READ de la tarea y a un campo de texto declarado por la capacidad;
- el kernel compone el contenido **antes** de registrar el paso, de modo que `decision->>'content'`, `thread()`, el outbound y el hash siguen siendo una sola fuente;
- es genérico (no introduce conceptos de ventas en Core);
- cambia `packages/contracts` (decisión), `packages/agent-kernel` (parser y registro) y las pruebas de protocolo.

No se recomienda empezar por C: B2 cierra el bloqueo de emisión sin tocar el harness y genera la evidencia (fidelidad de copia) que decide si C hace falta.

### 5.4 Riesgos de B2

| Riesgo | Mitigación |
|---|---|
| El modelo altera el texto (espacios, `®`, guiones, formato de miles). Cada fallo cuesta un turno de confirmación. | Experimento de fidelidad de copia antes del canary (plan §3.4). Si la tasa no alcanza el umbral, normalización definida en una versión `r4-sales-offer-es-v2` o Alt. C. |
| Igualdad estricta: el cliente no recibe respuesta a una pregunta lateral en el mensaje de oferta. | Instrucción v7: responder la pregunta en otro turno. Medir en canary. B3 queda como opción posterior. |
| Re-presentaciones idénticas y `duplicate_content` (`production-store.ts:243-284`). | Solo cancela dentro del mismo contexto de entrada; la re-presentación sigue a un mensaje nuevo del cliente. Test obligatorio. |
| Texto del owner con caracteres de formato WhatsApp. | Se envía tal cual; el texto registrado no cambia. Riesgo de presentación, no de integridad. |
| HIPÓTESIS: menos fallos `invalid_structured_output` porque el modelo deja de redactar la oferta. | No se afirma. El modelo sigue copiando ≈ 500 caracteres dentro de un string JSON, y en R4-H también hubo fallos en decisiones `read_capability` (plan §3.3). Se mide (plan §3.4, E1). |

## 6. Archivos a modificar (propuesta)

Nuevos:
- `agents/sales/src/capabilities/quote-v5.ts`
- `agents/sales/src/production/profile-v7.ts` (el registro de perfiles se mueve aquí, como en J3B/J3E/J3E-B)
- `agents/sales/sales.v7.agent.json`
- tests: `tests/unit/sales/offer-message.test.ts`, `tests/integration/sales-deterministic-offer-quote.test.ts`, `tests/integration/sales-deterministic-offer-canary.test.ts`, `tests/contract/sales-deterministic-offer.test.ts`

Modificados (solo pack Sales):
- `capabilities/offer-presentation.ts`: `renderOfferMessage`, `OFFER_TEMPLATE_VERSION` (lo existente no cambia)
- `capabilities/quote-preview.ts`: `quote.preview@3` (`@1`, `@2` intactos)
- `capabilities/quote-v2.ts`: opción estricta de `settle`, desactivada por defecto
- `production/{profile-v6,composition,bootstrap,control,index}.ts`, `definition.ts`, `index.ts`; en `composition.ts`, rama `@7`, además el guard del kill switch sobre `createAndIssue` (plan §4 R8 y §8)
- `cli/{production,operator-command}.ts`, `cli/canary/runtime.ts` (aceptar `@7`)
- listas fijadas en tests existentes (perfiles, definiciones, mensaje del canary)

Sin cambios: `packages/`, `apps/`, `adapters/`, migraciones (no hay `0010`), `quote-v3.ts`, `quote-v4.ts`, perfiles `@1–@6`.

## 7. Tests obligatorios

| Nivel | Casos |
|---|---|
| Unit (plantilla) | Golden de los mensajes de 3 snapshots fijos (una línea con despacho; varias líneas con variantes; sin despacho) y hash fijado. Sin comillas dobles ni barras invertidas en el texto fijo. Límite de largo → `offer_message_too_long`. Ningún cálculo: alterar un monto del snapshot cambia solo esa cifra. El ejemplo de confirmación de la plantilla es aceptado por `parseConfirmation`. |
| Integración (`@5`, Postgres real) | Oferta idéntica → emitida. Una mutación por elemento → `offer_not_presented`: producto, variante, cantidad, precio unitario, subtotal, transportista, servicio, comuna, monto de despacho, neto, IVA, total, referencia de otra versión comercial. Texto agregado antes o después → rechazo. Espacios alterados → rechazo (documenta la igualdad estricta). Re-presentación idéntica tras ambigüedad → emitida una vez. Todos los casos de `@4` repetidos sobre `@5` (gramática, inmediatez, ventana, entrega, uso único, concurrencia, reinicio, `unknown`). `settle` estricto con montos por línea redistribuidos y totales iguales → `unknown`. |
| Contrato | Huellas `@1–@6` y ambos hashes de política sin cambios; huella de `@7` fijada. `quote.create@2/@3/@4` y `quote.preview@1/@2` intactos. El pack no importa nada nuevo del harness. Sin columnas de texto nuevas. Instrucciones v7 sin `intent`/`stage`. |
| Canary local (modelo guionado) | Runtime real con ingress sintético, Policy Engine, ActionExecutor y entrega: emisión con oferta exacta; un turno guionado con oferta alterada → rechazo y re-presentación. |
| Modelo real (fuera de EC2) | Experimento de fidelidad de copia y de errores de formato en el turno de oferta (plan §3.4). |
| EC2 | Canary `@7`, con autorización separada. |

## 8. Impacto sobre `@1–@6`

| Perfil | Impacto |
|---|---|
| `@1–@4` | Ninguno. Huellas y `SALES_PRODUCTION_ACTION_POLICY` fijadas en tests. |
| `@5` | Ninguno. Sigue con intención atestiguada por el modelo. |
| `@6` | Ninguno. Sigue verificando referencia y total. Queda superado por `@7` para cualquier decisión de producción. |
| Registro de definiciones | Registrar `sales@7` cambia la "última" versión de Sales. Solo afecta tareas creadas sin versión fijada (API genérica); las tareas de canal quedan fijadas por perfil, como en J2D/J3E. |
| Producción EC2 (`@3`) | Ninguno hasta un despliegue autorizado. |

## 9. Roadmap del slice J3E-C1

| Paso | Contenido | Autorización |
|---|---|---|
| C1.1 | Plantilla, `quote.preview@3`, `quote.create@5`, `settle` estricto, perfil `@7`, definición v7, tests locales | Autorización de implementación |
| C1.2 | Experimento de fidelidad de copia con el modelo real, sin EC2 ni Quote V2 (plan §3.4) | Gasto de modelo |
| C1.3 | Canary EC2 `@7` en el entorno aislado J3E | Autorización separada |
| C1.4 | Decisión: B2 suficiente, o ADR de la Alt. C | Owner |

## 10. Criterios de aceptación del slice

1. Ninguna cotización se emite si `sha256(mensaje de oferta registrado) ≠ sha256(renderOfferMessage(snapshot recalculado, referencia actual))`. Probado por mutación de cada elemento (§7).
2. La evidencia de una emisión (`0009.offer_text_sha256` y la versión de plantilla en `0008.quote_request`) permite a un auditor recalcular el mensaje exacto que el cliente confirmó desde el snapshot de `0008`.
3. `settle` estricto activo en `@5`; `@2–@4` sin cambios.
4. Huellas `@1–@6`, ambos hashes de política, migraciones liberadas y harness sin cambios (`git diff -- packages apps adapters` vacío).
5. Fidelidad de copia medida con el modelo real: el umbral lo fija el owner (propuesta: ≥ 95 % en N ≥ 30 turnos de oferta). Si no se alcanza, se activa el paso C1.4.
6. La tasa de `invalid_structured_output` del turno de oferta se compara con la línea base (plan §3). No se reporta mejora sin esa medición.
