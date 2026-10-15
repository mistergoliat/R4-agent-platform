# R4-J3E-C1 — Deterministic Offer & Write Safety: informe de implementación

Fecha: 2026-10-14 · Rama: `r4-j3e-c-deterministic-commercial-offer` (base `origin/main` `092715e`) · Commit local en la rama, **sin merge ni push** · Autorización: R4-J3E-C1 del owner, 2026-10-14, y su corrección previa al commit (kill switch tras la autorización, control pareado `@6`/`@7`, reproducibilidad), del mismo día.

Referencias:
- `R4-J3E_C_DETERMINISTIC_OFFER_ARCHITECTURE.md` (alternativa B2);
- `R4_J3E_PRODUCTION_GAP_CLOSURE_PLAN.md` (B1, B3, línea base);
- ADR-034, ADR-035;
- ADR-036 (borrador, §11).

```
R4_J3EC1_IMPLEMENTATION=PASS
R4_DETERMINISTIC_OFFER=PASS
R4_OFFER_EXACT_MATCH=PASS
R4_QUOTE_SETTLEMENT_STRICT=PASS
R4_KILL_SWITCH_WRITE_GUARD=PASS
KILL_SWITCH_POST_AUTH_RECOVERY=PASS (retenida en su clave y enviada una vez al liberar; ciclo de vida E2E, §6.2–6.3); disposiciones humanas explícitas en los casos 3, 4, 5 y 7; sujeto a confirmación del owner
KILL_SWITCH_GLOBAL=PASS
KILL_SWITCH_CHANNEL=LIMITATION (no bloquea escrituras de @7; gate operacional, §6.4)
QUOTE_RECONCILIATION_WHILE_DISABLED=PASS
R4_MODEL_COPY_FIDELITY=108/108 exactas (100 %; IC 95 % Clopper-Pearson ≥ 96,6 %): 89 ofertas y 19 re-presentaciones; LOCAL con modelo real, contexto parcialmente guionado; exploratorio, no es aprobación de rollout
R4_STRUCTURED_OUTPUT_FAILURE_RATE=0/108 llamadas reales en los turnos de copia (0 %; IC 95 % ≤ 3,4 %); histórico de canaries: 3/65 llamadas en total y 3/8 en el paso de oferta
MODEL_AB_CONTROL=18 pares, 40 llamadas (§8.7): integridad comercial @7 18/18 vs @6 8/18 (McNemar exacto p = 0,002; @4 emitió 6 ofertas incompletas); JSON en 1.ª llamada 18/18 vs 14/18 (p = 0,125, no concluyente); emitidas 18/18 vs 17/18; latencia p50 5,3 vs 7,4 s (p = 0,10); exploratorio
MODEL_EXPERIMENT_REPRODUCIBLE=YES (scripts/experiments/j3ec1-offer-fidelity; métricas recalculables desde salidas con hash, §8.5 y §8.8)
R4_LEGACY_PROFILES_UNCHANGED=YES
R4_HARNESS_MODIFIED=NO
R4_PRODUCTION_PROFILE=@3
R4_EC2_CANARY=NOT_RUN
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

Etiquetas de evidencia:
- **SOURCE**: código de esta rama;
- **LOCAL**: ejecutado en esta estación (Docker PostgreSQL, owners fixture);
- **REAL-MODEL**: llamadas reales a DeepSeek desde esta estación, sin EC2 ni Quote V2;
- **EC2-RO**: lectura de registros del canary en EC2, sin modificar nada.

## 1. Resultado

Sales escribe el mensaje comercial completo que el cliente confirma. `quote.create@5` emite solo si el mensaje que la plataforma registró y entregó es **byte a byte** la renderización Sales del snapshot recalculado en ese momento. La respuesta de Quote V2 se liquida comparando cada importe que el owner expone. Ninguna escritura de Quote V2 llega al owner con el kill switch activo, ni desde un run en curso ni desde un replay; las lecturas de reconciliación siguen funcionando. Si el switch detiene una cotización ya autorizada y congelada antes de su primer envío, queda **retenida en su propia clave** y la plataforma la envía una vez al liberar el switch, con los mecanismos existentes (§6.2–6.3).

Nada de esto cambia el harness ni requiere migración. Los perfiles `@1–@6`, las capacidades anteriores y los hashes históricos son idénticos a `main`: se verificaron compilando `092715e` en un worktree temporal (§3.4).

## 2. Archivos

| Archivo | Cambio |
|---|---|
| `agents/sales/src/capabilities/offer-presentation.ts` | `OFFER_TEMPLATE_VERSION = 'r4-sales-offer-es-v1'`, `OFFER_MESSAGE_MAX_CHARS = 3500`, `renderOfferMessage()`. Lo existente no cambia. |
| `agents/sales/src/capabilities/quote-preview.ts` | `quote.preview@3` (`quotePreviewV3Capability`, `quotePreviewV3Output`). `@1`/`@2` intactos. |
| `agents/sales/src/capabilities/quote-v5.ts` (nuevo) | `quote.create@5`, `QuoteWriteAdmission`, `quoteWritesBlockedError`. Corrección previa al commit: retención en la propia clave después de autorizar (`sendHeld`, `unknown`), chequeo antes de registrar el envío y `retryPolicy.initialBackoffMs = 20 000` (§6.2). |
| `agents/sales/src/capabilities/quote-v2.ts` | `SettleOptions { strict }` y `strictProblems()`. Desactivado por defecto: `@2–@4` liquidan igual. `reconcileQuoteV2Command` pasa la opción. |
| `agents/sales/src/capabilities/quote-v4.ts` | Solo exporta `judgeConfirmedQuote` y `confirmedQuoteRefusalMessage` (reutilizados por `@5`). Sin cambio de comportamiento. |
| `agents/sales/src/production/profile-v7.ts` (nuevo) | `SALES_PRODUCTION_PROFILE_V7`, `SALES_PRODUCTION_PROFILE_V7_GATE`, `isDeterministicOfferProfile`; el registro de perfiles y versiones de definición se movió aquí, como en J3B, J3E y J3E-B. |
| `agents/sales/src/production/profile-v6.ts` | Pierde el registro (movido). `SALES_CONFIRMED_INTENT_PROFILES` incluye `@7`, que usa los mismos límites v6. El objeto `@6` no cambia. |
| `agents/sales/src/production/profile-v5.ts` | `SALES_AUTONOMOUS_QUOTE_PROFILES` incluye `@7`: política autónoma, workspace v2, preview. |
| `agents/sales/src/production/composition.ts` | Rama `@7`: `quote.preview@3`, `quote.create@5` y `killSwitchGuardedQuotes()`. La rama `@6` no cambia. |
| `agents/sales/sales.v7.agent.json` (nuevo) | Definición v7: idéntica a v6 salvo descripción e instrucciones de `quote.preview`/`quote.create`. |
| `definition.ts`, `index.ts`, `production/{index,bootstrap,control}.ts`, `cli/{production,operator-command}.ts`, `cli/canary/runtime.ts` | Imports del registro movido, export de `quote-v5`/`profile-v7`, definición 7, canary acepta `@7`. |
| Tests nuevos | `tests/unit/sales/offer-message.test.ts`, `tests/integration/sales-deterministic-offer-quote.test.ts`, `tests/integration/sales-deterministic-offer-canary.test.ts`, `tests/contract/sales-deterministic-offer.test.ts` |
| Tests existentes | Solo listas de inventario: se agregan `@7`, v7 y `sales@7` (§7.3). |
| Docs | Este informe; `docs/adr/ADR-036-contractual-input-provenance.md` (propuesto); actualización de los dos documentos de arquitectura. |
| `scripts/experiments/j3ec1-offer-fidelity/` (nuevo) | Herramientas del experimento con el modelo real: `run.mjs`, `analyze.mjs`, `baseline-analyze.mjs` y `README.md` (§8.5). No forman parte del producto. |

Totales:
- modificados: 23 archivos, +232/−88;
- nuevos:
  - 3 de código y definición (351 líneas);
  - 4 de tests (1 234 líneas);
  - 4 de herramientas del experimento (624 líneas);
  - ADR-036;
- `git diff -- packages apps adapters`: **vacío**;
- `agents/sales/migrations`: sin cambios.

## 3. Contratos y versiones

### 3.1 Plantilla `r4-sales-offer-es-v1` (SOURCE: `offer-presentation.ts`)

Ejemplo real (variante y sin despacho, golden del test unitario):

```
Cotización lista para emitir (Ref. Q-ABCDEF-7)

1. Kettlebell de competición
Variante: Peso: 12 kg
Cantidad: 2; precio unitario: $44.990; subtotal: $89.980

2. Seguros para barra olímpica (par)
Variante: Color: Rojo; Material: Nylon
Cantidad: 3; precio unitario: $9.990; subtotal: $29.970

Despacho: Fixture Courier, a Valparaíso: $1

Neto: $100.765
IVA: $19.186
Total: $119.951 (IVA incluido)

Condiciones: montos en pesos chilenos, con IVA incluido salvo el neto. No incluye descuentos ni otros cargos. Al emitir se verifican de nuevo precios, stock y despacho: si algo cambió, no se emite y te presento la oferta actualizada. El número y la validez de la cotización se informan al emitirla.
¿Emito esta cotización? Puedes responder: Sí, emítela.
```

- **Contenido:**
  - referencia;
  - por línea: producto, variante (atributos), cantidad, precio unitario con IVA y subtotal;
  - despacho (transportista, servicio, comuna, región, monto) o "no incluido";
  - neto, IVA y total;
  - condiciones y exclusiones;
  - pregunta explícita.
- No hay número ni validez antes de emitir.
- **Sin aritmética:** cada cifra viene del snapshot, es decir de Catalog, Shipping y `quoteV2ChargeAmounts`/`quoteV2Totals`. Hay un test que cambia una sola cifra del snapshot y verifica que cambia solo esa línea del texto.
- El texto fijo no tiene comillas dobles, barras invertidas ni marcas de formato del canal.
- Supera 3 500 caracteres → el preview queda `blocked` (`offer_message_too_long`).
- La confirmación sugerida ("Sí, emítela.") la acepta la gramática `r4-sales-confirmation-es-v1`.

### 3.2 `quote.preview@3`

= `@2` y además `presentation.{offerTemplate, offerMessage, offerMessageSha256}`.

`presentation` existe **solo** si `status=ready` e `issuable=true`: con un límite excedido no hay oferta que el cliente pueda confirmar. Un preview nombra contenido y no autoriza nada.

### 3.3 `quote.create@5` (SOURCE: `quote-v5.ts`)

Entrada `{ previewId }`, igual que `@3`/`@4`. Pasos:

1. **Kill switch** (`admission.admit()`, leído de la base en cada ejecución), solo si el comando aún no tiene cuerpo congelado. Si está activo, devuelve `failed: autonomy_disabled` **antes de decidir nada**.
2. Snapshot recalculado desde workspace y owners; mismo `previewId` (si no, `preview_stale`); límites del snapshot.
3. Versión comercial actual → referencia → `expected = renderOfferMessage(snapshot, referencia)`.
4. Hilo real de la plataforma (`thread`), con las reglas de `@4` sin cambios (`locateConfirmation`):
   - gramática;
   - inmediatez;
   - oferta del agente con referencia y total;
   - entrega `accepted|delivered|read`;
   - ventana.
5. **Byte a byte:** `sha256(texto de la oferta en el hilo) === sha256(expected)`. Si no, `offer_not_presented`, con `offerTemplate`, `expectedSha256` y `presentedSha256`.
6. Bajo el lock de decisiones (sin cambios): uso único de la confirmación, duplicado del snapshot, límites por conversación y por hora.
7. En la misma transacción: decisión (`0008`) + cuerpo congelado (`0007`) + evidencia (`0009`).
8. Kill switch otra vez, antes de registrar el envío. Envío por el puerto Quote con guard y liquidación **estricta**. Si el switch lo detiene aquí, el comando queda retenido en su clave (`unknown`) y la plataforma lo reproduce al liberarse (§6.2).

Lo hacen cumplir el Policy Engine (política `sales-production-autonomous-policy@1`, hash `515ce98f…` sin cambio, `allow/autonomous`) y el ActionExecutor. El canary E2E lo verifica en `policy_decisions` y `action_receipts`.

**Persistencia sin migración y sin copiar texto:**
- `0009.offer_text_sha256` es el hash del texto confirmado; en `@5` es igual por construcción al hash esperado.
- `0008.quote_request` (jsonb) agrega `offerTemplate` y `offerMessageSha256`.
- Un auditor puede recalcular el mensaje exacto desde `0008.snapshot` y la referencia.

### 3.4 Invariabilidad (verificada contra `main`)

Compilé `092715e` en un worktree temporal del scratchpad, con un junction a `node_modules`.

| Elemento | `main` = rama |
|---|---|
| Huellas `@1…@6` | `bd30523f…`, `2430a3e0…`, `847aa0ef…` (EC2), `c905ca76…`, `a043636e…`, `5ce5f371…` |
| `SALES_PRODUCTION_ACTION_POLICY` / política autónoma | `5dbbd0f2…` / `515ce98f…` |
| Definiciones de `quote.create@2/@3/@4`, `quote.preview@1/@2` (fingerprint de `definition`+`recovery`) | `f147e3b2…`, `f33b98c7…`, `b7e144e9…`, `44d28bae…`, `3ab91fae…` |
| `@7` (nuevo) | `dc4d82dc…` |

Todos quedan fijados en `tests/contract/sales-deterministic-offer.test.ts`. La huella de `@6` no estaba fijada en ningún test; ahora lo está.

## 4. Verificación del mensaje confirmado

Matriz de integración (Postgres real, `sales-deterministic-offer-quote.test.ts`, 38 casos). Cada mutación de la oferta entregada produce `rejected: offer_not_presented`, **0 llamadas al owner** y la decisión `rejected:offer_not_presented`:

- producto;
- variante;
- cantidad;
- precio unitario;
- subtotal;
- transportista, destino y monto de despacho;
- neto, IVA y total;
- referencia de otra versión comercial;
- doble espacio, CRLF, acento quitado, `¿` quitado, formato de miles;
- texto antes o después;
- "descuento" agregado.

El caso B2 muestra que `quote.create@4` **sí** emitía con una cantidad falsa si la oferta llevaba referencia y total: era la debilidad D1 documentada, y `@5` la cierra.

La re-presentación válida (B3, C1) funciona así:
- la oferta de una versión comercial anterior se rechaza aunque el contenido sea idéntico;
- la oferta actual, re-presentada tras una respuesta ambigua, emite una vez.

## 5. Liquidación estricta contra Quote V2

**Contrato real inspeccionado** (`adapters/domains/src/quote/v2.ts:114-127`; `adapters/domains/quote/http/src/schemas.ts:22-40`).

El owner devuelve:
- `lines[{position, amounts{net,tax,gross}}]`;
- `shipping{amounts}|null`;
- `totals{net,tax,gross,exemptNet}`;
- `currency`, `externalCorrelation{sourceSystem, externalReferenceType?, externalReference?}`;
- `validity`, `issuance`, `document{available,pdfSha256,byteLength,…}`.

**No devuelve** producto, cantidad, descripción, transportista ni destino.

| Campo | Antes (`@2–@4`) | `@5` (estricto) |
|---|---|---|
| Totales neto/IVA/bruto | sí | sí |
| `exemptNet` | no | **sí** (= `quoteV2Totals(request).exemptNet`) |
| Líneas | cantidad | **cada línea por `position`**: neto/IVA/bruto = `quoteV2ChargeAmounts(unitPrice, quantity)` del cuerpo congelado |
| Despacho | presencia | **neto/IVA/bruto** = `quoteV2ChargeAmounts(amount, "1")` |
| Correlación | sistema + referencia | **+ tipo de referencia** |
| Documento | manifiesto + SHA-256 | sin cambio |
| Productos, cantidades, transportista, destino | — | **no expuestos**: los vinculan el cuerpo congelado y el `Idempotency-Key` (otro cuerpo con la misma clave = 409). No se inventaron campos. |

Una discrepancia mantiene la semántica existente: `unknown` ("issued but does not match the approved snapshot"), nunca éxito. La reconciliación vuelve a leer y sigue en `unknown`. Un replay usa la misma clave y el mismo cuerpo, y el owner devuelve la misma cotización: **nunca hay una clave nueva**. Los casos E1 cubren líneas redistribuidas con totales iguales, líneas intercambiadas, componentes del despacho, `exemptNet` y tipo de correlación; en todos queda 1 sola cotización en el owner. El PDF se verifica por SHA-256: un documento corrupto queda `mismatch`, nunca `verified` (E2).

## 6. Kill switch sobre escrituras

### 6.1 Auditoría de `guardProductionWrites` (`live-ops/src/guard.ts:13-39`)

| Pregunta | Hallazgo |
|---|---|
| ¿Lee el estado en cada llamada? | Sí. `AutonomyControls.state()` va a la base sin caché (`controls.ts:15-16`); si no puede leerse, cuenta como activo (falla cerrado). |
| ¿Se usaba? | **No.** No tenía ningún uso ni test en el repositorio. |
| ¿Funciona sobre el cliente real? | **No, aplicado directamente.** Devuelve los métodos que no son de escritura **sin `bind`**. `QuoteV2HttpClient` guarda su estado en campos `#private`, así que toda lectura a través del proxy lanza `TypeError`. Eso rompería la reconciliación y la verificación del PDF. Lo demuestra un test de contrato contra el cliente HTTP real. |
| Alcance | Solo el switch **global**: un switch por canal no bloquea escrituras. |
| Momento | El worker solo consulta la admisión antes de reclamar ("never mid-run", `worker.ts:20-23`). Un run en curso no se detiene; el guard actúa en la llamada misma. |

**Conclusión:** el guard da las garantías exigidas desde una composición Sales-owned **si** recibe un puerto de funciones planas. `killSwitchGuardedQuotes()` (`composition.ts`) adapta el puerto, guarda solo `createAndIssue` y deja abiertas `lookupIdempotency`, `getQuote`, `getOperation` y `getDocument`. No se modificó el harness. El defecto de `bind` queda documentado para una corrección separada del harness (§13).

### 6.2 Corrección previa al commit: autorizada, congelada y bloqueada antes del primer envío

**Hallazgo.** El informe anterior se contradecía.

- **F2 decía:** "liberado, la misma clave envía su cuerpo congelado una vez".
- **El "Límite conocido" del §6.2 anterior decía:** el comando termina `failed` (definitivo).

El §6.2 anterior describía bien el ciclo de vida. F2 mostraba un artefacto: invocaba el handler **directamente**, con la misma clave y `attempt = 3`, después de un `failed`. La plataforma nunca hace esa llamada.

**Escenario exacto con el código anterior** (fuente y E2E del canary anterior, que afirmaba el recibo `failed/autonomy_disabled`):

1. `quote.create@5` valida la oferta y la confirmación.
2. Registra `authorized:eligible` en 0008 y congela el cuerpo en 0007.
3. Registra un envío en `sales.quote_v2_sends`.
4. El puerto con guard lanza `autonomy_disabled` y el handler devuelve `failed`.

| Pregunta del owner | Respuesta (código anterior) | Evidencia |
|---|---|---|
| Estado final exacto | `action_executions.status = failed`, intento `1:execute:failed:autonomy_disabled`, recibo `failed/autonomy_disabled`, observación `write_execution_failure`. 0008 `authorized:eligible`, 0007 congelado, 1 fila en `quote_v2_sends` sin POST. | `action-runtime.ts:494-495` → `settleWithin` |
| ¿Es terminal? | Sí. `failed` no tiene transiciones de salida. | `action-lifecycle.ts:106-113` |
| ¿Puede reintentar el scheduler? | No. `deferRetry` solo programa `action_retry` si queda un intento (`next.kind = attempt`); un recibo resuelve el comando. | `action-runtime.ts:186-199`, `action-lifecycle.ts:57` |
| ¿Sigue activa la reconciliación? | No. Solo `needs_reconciliation` crea trabajo de reconciliación. | `0005` (trigger), `action-runtime.ts:532` |
| ¿Se puede reejecutar la misma clave? | No. La clave se deriva del `executionId` (`action-runtime.ts:844`). El ActionExecutor solo recibe concesiones de `advanceAction`, y un comando resuelto no tiene ninguna. | `action-runtime.ts:430-435` |
| ¿Una propuesta nueva? | Tiene otra clave y se rechaza como `duplicate_quote`, porque el snapshot está autorizado en esa conversación. | F2 |
| ¿Recuperación sin alterar el snapshot? | Ninguna en la plataforma. `rescheduleReconciliation` solo rearma reconciliaciones agotadas de comandos inciertos. | `temporal-runtime.ts:691-698` |
| ¿Intervención humana? | Sí: un cambio comercial (otro snapshot) o una emisión fuera de R4. | — |

**Decisión implementada (sin tocar el harness, sin claves nuevas, sin borrar registros).** Una vez autorizado y congelado, un bloqueo deja el comando **retenido en su propia clave**, no `failed`. Se reanuda con los mecanismos que la plataforma ya tiene.

1. **`unknown` en vez de `failed`** cuando hay cuerpo congelado (`sendHeld`, `quote-v5.ts`).
   - Es la regla del propio harness: un intento que no llegó al dominio es `unknown` (`action-executor.ts:144-145`), y solo una búsqueda puede establecer "no aplicado" (`action-executor.ts:245-246`; `execute` no puede devolver `not_applied`).
   - Con `reconcile_before_retry`, el siguiente paso es una reconciliación: un lookup por la clave, que es lectura y está abierto con el switch activo. Devuelve `not_applied` y, con intentos disponibles, la plataforma reproduce **la misma clave y el mismo cuerpo** (`action-lifecycle.ts:71-73`).
2. **Segundo chequeo antes de registrar el envío.** Con el switch activo no se registra un envío que no ocurrió, así que el lookup puede decir `not_applied` de inmediato. El guard del puerto sigue siendo la última barrera.
3. **El chequeo previo a la decisión se mantiene** (`failed`, nada autorizado). Ya no se aplica a un comando autorizado: un replay retenido no puede volverse `failed` por el switch.
4. **Backoff durable declarado:** `retryPolicy.initialBackoffMs` pasa de 0 a 20 000 (20 s, 40 s, 80 s).
   - Entre intentos, `deferRetry` libera el lease y programa `action_retry`. La tarea vuelve así a la **admisión del worker**, que no reclama nada mientras el switch está activo. La espera no consume intentos ni tiene límite de tiempo.
   - Con backoff 0 no hay espera: los tres ciclos ocurren en milisegundos y terminan `failed/write_not_applied`. El mutante lo muestra: `execute, reconcile, replay, reconcile, replay, reconcile` → `write_not_applied`.
   - Las tres reconciliaciones dentro del run (≥ 20, 60 y 140 s después del intento) cubren la ventana de "no encontrado" del owner (90 + 30 s). Un test de contrato fija esa aritmética.

**Para confirmar por el owner:** clasificar como `unknown` un intento que la capacidad sabe que no envió. Sigue la convención del ActionExecutor y deja que la plataforma establezca el hecho con una lectura. Aun así, es una decisión de semántica y conviene registrarla (por ejemplo, en ADR-036 o en un ADR propio).

### 6.3 Ciclo de vida completo (LOCAL, PostgreSQL + worker + kernel + ActionRuntime + ActionExecutor + scheduler)

`tests/integration/sales-deterministic-offer-canary.test.ts` usa el runtime real del canary `@7` y el kill switch real de la base. El reloj temporal (`r4_now()`) lo mueve el test, siempre por delante del reloj real. Ningún caso invoca el handler.

| # | Situación | Disposición observada en PostgreSQL | Caso |
|---|---|---|---|
| 1 | Activado a mitad del run, **antes** de que `quote.create@5` decida | `1:execute:failed:autonomy_disabled`, recibo `failed`, **0008 vacío** (nada autorizado), 0 envíos. La respuesta queda retenida (`pending/autonomy_disabled`) y se entrega al liberar. Una propuesta nueva puede emitir después (F1). | "engaged mid-run before the issuance decides" |
| 2 | Activado **después** de autorizar; se libera | Mientras está activo: `1:execute:unknown:domain_unknown`, ejecución `executing`, sin recibo ni respuesta, `action_retry` pendiente, run `running` sin lease. El retry vence y se dispara, pero el worker no reclama. Al liberar: `2:reconcile:not_applied` y luego `3:replay:applied`. Queda **la misma `execution_key`**, recibo `succeeded`, 1 llamada `createAndIssue`, 1 cotización (el lookup del owner devuelve esa clave) y 1 fila en `quote_v2_sends`. La respuesta "Cotización PC-000001 emitida." se entrega. | "held on its key … replays the SAME key once" |
| 3 | Igual que 2, pero **el cliente escribe** con el switch activo | El ingreso retiene la tarea para humanos (`handoff requested`, `autonomy_disabled`, tarea `blocked`) y el run termina. La ejecución pasa a `needs_reconciliation` y la reconciliación, una lectura **con el switch activo**, da `2:reconcile:not_applied` → recibo `failed/write_not_applied`. Nunca se envía, ni siquiera al liberar. 0008 sigue `authorized`: una propuesta nueva en esa conversación sería `duplicate_quote` y decide el operador. | "held, and the customer writes while engaged" |
| 4 | Igual que 2, pero la retención dura **más que el presupuesto del run** | Al liberar emite **una vez** con la misma clave (recibo `succeeded`). Después, el run termina `budget_exhausted/max_run_duration_ms`, la tarea queda `failed` y **no hay respuesta al cliente**. El presupuesto cuenta desde el inicio del run, incluido el tiempo retenido (`context.ts:109`). | "held longer than the run budget" |
| 5 | Igual que 2; el operador **cancela o toma** la tarea antes de liberar | Mismo mecanismo que el caso 3 (`finishRunWithin` → `flagUnresolvedActionExecutions`, `mutations.ts:128-129`): reconciliación → `not_applied` → nunca se envía. | Por código; el mecanismo es el del caso 3 |
| 6 | Activado entre el último chequeo y la llamada (carrera residual: solo un INSERT entre ambos) | El guard rechaza y el comando queda `unknown`. Como hay un envío registrado, el lookup dice `unknown` dentro de la ventana del owner (F2b) y `not_applied` después. Las reconciliaciones a 20, 60 y 140 s la cubren. | F2b + contrato; el E2E requeriría 120 s reales, porque `quoteV2SendAgeMs` usa `clock_timestamp()` |
| 7 | Switch reactivado en cada reanudación, tres veces | Con `maxAttempts = 3`, el comando termina `not_applied` definitivo → `failed/write_not_applied`. La autorización queda varada y se requiere un humano. | `action-lifecycle.ts:71-73`; la forma es la del mutante con backoff 0 |
| 8 | Activado durante la reconciliación de una cotización ya enviada | Las lecturas liquidan (`applied`, PDF `verified`) y no hay llamadas de creación. | F3; el caso 3 muestra la reconciliación del worker con el switch activo |
| 9 | Controles ilegibles | Cuentan como activo (falla cerrado). | F4 |

En ningún caso hay una segunda cotización ni una clave nueva para el mismo comando.

**Respuestas con el código corregido:**

- **Estado mientras está activo:** `executing`, no terminal.
- **Scheduler:** dispara el `action_retry`.
- **Reconciliación:** la del run se ejecuta al reanudar; la del scheduler, si el run termina (casos 3 y 5), corre con el switch activo.
- **Misma clave:** sí; se reproduce una vez.
- **Propuesta nueva:** `duplicate_quote`, que es correcto mientras la original esté retenida o emitida.
- **Recuperación sin alterar el snapshot:** automática al liberar (caso 2).
- **Intervención humana:** solo en los casos 3, 4, 5 y 7.

### 6.4 Alcance real del kill switch

| Aspecto | Comportamiento actual | Evidencia |
|---|---|---|
| Switch **global** | Bloquea las escrituras de Quote V2 en tres puntos: antes de decidir, antes de registrar el envío y en el puerto. El worker no reclama tareas. Las respuestas salientes quedan retenidas y el ingreso retiene para humanos. | F1, F2, F2b, F4; E2E 1–4 |
| Switch **por canal** | **No bloquea las escrituras de `@7`.** Solo se lee el global (`guard.ts:31`, `controls.ts:46-50`). Un switch de canal retiene el ingreso (`autonomy.ts:52`) y la salida (`delivery.ts:88`) de ese canal. Un run ya admitido sigue y puede emitir; su respuesta queda retenida. | **F5** (canal `whatsapp` apagado, global encendido: emite y llama al owner una vez) |
| Runs ya iniciados | No se interrumpen: la admisión solo se consulta antes de reclamar (`worker.ts:120-125`). La escritura de cotización se detiene en la llamada misma: `failed` antes de decidir, retenida después de autorizar. | E2E 1–2 |
| Mutaciones ya enviadas | **No se pueden deshacer ni interrumpir.** El switch solo se consulta antes de la llamada. La única señal del `createAndIssue` en curso es el timeout del ActionExecutor (`action-executor.ts:172-190`). No hay garantía de cortar un HTTP ya enviado; su resultado se liquida como siempre (`applied`, o `unknown` → reconciliación). | Código |
| Reconciliaciones de solo lectura | Siguen funcionando: el worker reconcilia antes de consultar la admisión (`worker.ts:120-123`), y lookup, quote, operation y document no pasan por el guard. | F3; E2E 3 |
| Replays mutantes | Bloqueados mientras esté activo, porque el handler se chequea antes de enviar y el puerto tiene guard. En el camino diferido ni siquiera se intentan, porque el worker no reclama. | F2; E2E 2 (retry disparado, sin intento mientras está activo) |

**Gate operacional de producción:** mientras el guard no honre el switch por canal, el único kill switch de las escrituras de `@7` es el **global**.

### 6.5 Mutaciones de verificación (LOCAL)

| Mutante (código cambiado a mano, luego restaurado) | Tests que fallaron |
|---|---|
| Sin igualdad exacta (medido en C1) | 19 de 38 |
| `settle` no estricto en `@5` (medido en C1) | 5 (E1) |
| Bloqueo después de autorizar devuelve `failed` (el código anterior) | 5: F2, F2b y E2E 2, 3 y 4 |
| `initialBackoffMs: 0` | 3: E2E 2, 3 y 4. Con backoff 0 el comando agota sus intentos en milisegundos → `failed/write_not_applied` |
| Puerto sin guard | 3: F2b, F4 y contrato D (`killSwitchGuardedQuotes` debe rechazar antes de cualquier request) |
| Sin el chequeo antes de registrar el envío (solo el guard) | 4: F2 (envío registrado sin POST, lookup `unknown`) y E2E 2, 3 y 4 (`not_applied` llega tarde y la retención no se reanuda) |
| Sin el chequeo previo a la decisión | 3 directos: F1, F4 y E2E 1. El E2E 2 falla además por arrastre: la tarea del caso 1 queda retenida y la reanuda el avance de reloj del caso 2 |

## 7. Tests

### 7.1 Resultados (LOCAL, Docker PostgreSQL 16; regresión completa después de la corrección previa al commit)

| Paso | Resultado |
|---|---|
| `npm run build`, `typecheck` | exit 0 |
| `npm run lint` | exit 0 sobre el producto, los tests y las herramientas del experimento (§8.6) |
| `test:unit` | 73 archivos; **1 025 passed**, 1 skipped (preexistente, solo POSIX) |
| `test:contract` | 26 archivos; **329 passed** (+1: el backoff declarado de `quote.create@5`) |
| `test:integration` (`--no-file-parallelism`) | 37 archivos (36 passed, 1 skipped); **468 passed**, 12 skipped (preexistentes). Las 5 nuevas de la corrección son F2b, F5 y tres casos del ciclo de vida (§6.3); F2 y el caso E2E del kill switch se reescribieron. |
| `test:sales` / `test:shadow` | 29 / 5 passed |
| `test:recovery` | 17 passed, **1 fallo preexistente**: `production-bootstrap-process.test.ts:48` espera solo `registered: sales@3`. El bootstrap registra `sales@3…@7`, y en `main` ya registraba `@3…@6`. Viene de J2D; `tests/recovery` no fue tocado. |

### 7.2 Casos exigidos → tests

| Caso | Test |
|---|---|
| Oferta idéntica y emisión | A1; canary "exact" |
| Producto, variante, cantidad, precio unitario, subtotal, despacho, neto/IVA/total, referencia | B1 (filas), B1-variante, B3 |
| Espacios y caracteres alterados; texto antes o después | B1 |
| Oferta vencida, confirmación ambigua, confirmación reutilizada | C2, C1, C2 |
| Re-presentación válida | B3, C1; canary "own summary" |
| Concurrencia, replay | D1, D2; replay de la misma clave en E1 y F2 |
| Quote V2 inconsistente | E1 (5 variantes) |
| Kill switch antes de decidir, después de autorizar, durante la reconciliación; ilegible; por canal; recuperación al liberar | F1, F2, F2b, F3, F4, F5 (handler); E2E 1–4 del ciclo de vida completo (§6.3) |
| Ninguna emisión duplicada | cada caso afirma el conteo del owner |
| PDF íntegro | A1, D2, F3 (`verified`); E2 (`mismatch`) |
| Invariabilidad de perfiles anteriores | contrato A (huellas, políticas y definiciones contra `main`) |
| Defecto del guard | contrato D |

### 7.3 Listas de inventario actualizadas (no son aserciones debilitadas)

Agregar una versión hace crecer las listas que fijan el inventario; J2D, J3E y J3E-B hicieron lo mismo. Solo se **agregó** el elemento nuevo:

| Archivo | Lista |
|---|---|
| `tests/contract/sales-boundaries.test.ts:82,86` | archivos de definición |
| `tests/contract/sales-confirmed-intent.test.ts:95` | perfiles registrados |
| `tests/contract/sales-profile-v3.test.ts:67,136-138` | definiciones, perfiles y versiones fijadas |
| `tests/unit/agent-registry/loader.test.ts:24` | definiciones cargadas |
| `tests/integration/agent-registry.test.ts:31-32,53` | registrados; última versión de Sales 6 → 7 |
| `tests/integration/api.test.ts:42` | `loaded: 5` → `6` |
| `tests/integration/production-bootstrap.test.ts:72-80,87-89,192` | salida del bootstrap |
| `tests/integration/sales-canary.test.ts:181-182` | perfiles del canary |

El test de recovery obsoleto **no** se modificó.

## 8. Experimento con el modelo real (REAL-MODEL)

### 8.1 Método

- **Runtime real de `@7`**, local, sobre una base de datos desechable con "canary" en el nombre (el guard lo exige):
  - ChannelIngress sintético, kernel y compilador de contexto, Policy Engine, ActionExecutor;
  - `ProductionStore.thread` y dueño de entrega reales.
- **Owners fixture.** Quote V2 es el fixture: **nunca** el servicio real. **Sin EC2.**
- **Decisiones guionadas** en todo, **salvo** en los puntos donde el modelo debe copiar:
  - (a) la respuesta que presenta la oferta, después de `quote.preview@3`;
  - (b) la re-presentación después de que `quote.create@5` rechaza una confirmación ambigua.

  En esos puntos el request exacto que armó el kernel (protocolo, schema, instrucciones v7, capacidades `@7`, workspace, conversación, observaciones) va al modelo real.
- Su decisión **vuelve al kernel**: el texto se registra, se entrega y lo juzga `quote.create@5` cuando el cliente confirma. Los veredictos de §8.3 son los de la capacidad, no una comparación offline.
- **Configuración del modelo, única y fija:** el perfil productivo fijado por test y verificado en EC2 (§9).
  - `deepseek-flash`, perfil `deepseek-v4-flash`;
  - `json_object`, `thinking: enabled`, sin `max_tokens`, timeout 120 s.
  - El `.env` local trae `R4_MODEL_MAX_OUTPUT_TOKENS=8192`: se dejó vacío para igualar el canary. No hubo otro cambio.
- **Presupuesto:** corte automático a 150 llamadas o US$10, estimado con todo el input facturado como fallo de caché a precio punta (cota superior).
- **Usado:** **109 llamadas** y **≈ US$0,55** (cota superior: 1 377 628 tokens de entrada y 113 998 de salida). El control pareado de §8.7 usó 40 más: 149 de 150 en total.

### 8.2 Fases

| Fase | Conversaciones | Muestras | Nota |
|---|---|---|---|
| P (piloto) | 1 | 1 | **Defecto del escenario:** el cliente guionado dijo "Esa opción de despacho está bien" con dos opciones listadas. El modelo, razonablemente, preguntó cuál, en lugar de presentar la oferta. `quote.create@5` rechazó (`offer_not_presented`): falla cerrado. Se excluye de la fidelidad y se corrigió el escenario (el cliente nombra la opción). |
| A | 30 | 30 | Exploratoria: 30/30 exactas. |
| B0 | 3 completas + 1 interrumpida | 5 | Detenida: el generador usaba los bits bajos de un LCG y cubría 1 de 8 nombres especiales y 3 comunas. Muestras válidas (misma configuración); se cuentan. |
| C | 55 | 73 | Generador corregido; una de cada tres conversaciones con confirmación ambigua. |
| **Total A+B0+C** | **88** | **108** | |

**Cobertura:**
- 1, 2 y 3 líneas: 27, 33 y 28 conversaciones;
- 52 con despacho a 12 comunas (Ñuñoa, Peñalolén, Viña del Mar, Concepción, Puerto Montt…) y 36 sin despacho;
- 10 con variante de catálogo;
- 41 con nombres de producto reescritos con caracteres especiales: `"`, `“ ”`, `–`, `—`, `®`, `|`, `×`, `Ø`, `·`, `ñ`, y un nombre de 120 caracteres;
- 18 con otra tasa de impuesto (0,1);
- 9 formas de confirmación (5 explícitas y 4 ambiguas: "Sí", "ok", "dale", "Perfecto");
- ofertas de 572 a 833 caracteres (p50 705).

### 8.3 Resultados

| Métrica | Valor |
|---|---|
| **Fidelidad exacta** (primera llamada de cada punto de copia) | **108/108** (ofertas 89/89; re-presentaciones 19/19). IC 95 % ≥ 96,6 % |
| Fallos JSON (`invalid_structured_output`) | **0/108** (IC 95 % ≤ 3,4 %); `finishReason` 108 `stop`; 0 errores del proveedor |
| Llamadas por punto de copia | 1,00 (0 reintentos, 0 recuperaciones ADR-028, 0 handoffs) |
| Tipo de decisión devuelta | 108 `respond` |
| Veredictos de `quote.create@5` | 88 `authorized:eligible`; 19 `rejected:customer_confirmation_not_explicit` (las ambiguas, como corresponde) |
| Emisiones que se habrían rechazado por la oferta | **0** (sin contar el piloto) |
| Conversaciones emitidas | 88/88 (una por conversación; la interrumpida de B0 no llegó a confirmar) |
| Tokens de entrada por llamada | p50 12 798, máx 14 624 |
| Tokens de salida por llamada (incluyen razonamiento) | p50 950, p90 1 510, máx 3 761. Oferta: p50 1 002; re-presentación: p50 751 |
| Latencia por llamada | p50 5,2 s, p90 7,7 s, máx 19,6 s. Oferta: p50 5,3 s; re-presentación: p50 4,2 s |
| Modelo reportado | `deepseek-flash` (108/108) |

### 8.4 Validez y límites del experimento

1. **Contexto parcialmente guionado.** Las respuestas previas del agente son textos guionados y cortos, no las del modelo. En una conversación real el historial es más largo y heterogéneo.
2. **Datos fixture.** El catálogo y el despacho son sintéticos; los nombres especiales se inyectaron con un parche de catálogo.
3. **Una sola configuración, una ventana de tiempo, un modelo.** No se varió nada del modelo, por instrucción.
4. **Turnos idealizados.** El piloto muestra que, ante un mensaje ambiguo del cliente, el modelo puede (con razón) no presentar la oferta. Eso cuesta un turno, no integridad.
5. **El resultado no es una aprobación de rollout.** La instrucción fija el 95 % sobre 30 como indicador exploratorio; esto lo supera, pero el gate `copy-fidelity` de `@7` exige además una medición en el canary con el modelo real.

### 8.5 Herramientas preservadas en el repositorio

`scripts/experiments/j3ec1-offer-fidelity/` contiene:

- `run.mjs`: el ejecutor;
- `analyze.mjs`: métricas, intervalos exactos y pruebas pareadas;
- `baseline-analyze.mjs`: la línea base EC2;
- `README.md`: requisitos, comandos por fase, versiones de configuración, definición de cada métrica, presupuesto, custodia y límites.

Son las herramientas originales hechas *lint-clean* (`npm run lint` las cubre, sin cambiar su configuración). Se agregaron:

- `--profiles`, para el pareado;
- `--dry-run`: un modelo sustituto que copia la renderización, para verificar el arnés sin gastar llamadas;
- `texts.jsonl`, con la renderización de Sales y el texto del modelo, verificables contra los hashes de `calls.jsonl`;
- la métrica de integridad.

El generador de escenarios y los turnos guionados no cambian.

**Verificación de reproducibilidad** con los datos guardados:

- `analyze.mjs A B0 C` reproduce las cifras de §8.3: 108/108, IC ≥ 0,9664, tokens y latencias idénticos. Regenera `analysis-AB0C.json` con esas mismas cifras; los `calls`/`samples` originales no cambian.
- `baseline-analyze.mjs` reproduce `baseline.json` byte a byte (`f8512ca3…`).
- La fase B0 usó el generador anterior y no se puede regenerar; sus salidas se analizan tal cual.

Las herramientas originales siguen fuera de Git, sin cambios, con su ubicación y hash en el README: `fidelity-run.mjs` `6b46eaa6…`, `fidelity-analyze.mjs` `8073b31a…`, `baseline-analyze.mjs` `5f5950b4…`.

Las bases desechables se eliminaron.

### 8.6 Nota sobre lint

Las herramientas del repositorio pasan `npm run lint` sin cambiar su configuración.

### 8.7 Control pareado `@6` frente a `@7` (REAL-MODEL, autorizado: hasta 40 llamadas)

**Método.** Mismo arnés y misma configuración del modelo, en los mismos 20 escenarios (n 500–519, generados por número): productos, cantidades, destinos, nombres, tasa y confirmación.

- **Lo que varía:** solo el perfil, es decir la estrategia de presentación.
  - `@6`: el modelo redacta la oferta a partir de `quote.preview@2`, y la emisión con `quote.create@4` exige referencia y total.
  - `@7`: el modelo copia el `offerMessage` de `quote.preview@3`, y la emisión con `quote.create@5` exige el mensaje exacto.
- **Comparabilidad:** la renderización de Sales resultó **idéntica byte a byte** entre los brazos en cada escenario (mismo snapshot y misma referencia).
- **Orden:** contrabalanceado; el brazo que va primero alterna con n.
- **Confirmación:** explícita en todos los escenarios, así que hay un solo punto de copia por conversación.
- **Integridad comercial**, sobre la primera llamada:
  - la referencia aparece como token;
  - cada importe distinto de la renderización aparece como número, y no hay importes `$` ajenos;
  - cada descripción de línea aparece literal (README).
- **Estadística:** IC Clopper-Pearson; McNemar exacto para los resultados pareados binarios; prueba de signos para tokens y latencia.

**Ejecución.** 40 llamadas, que llevan el libro de 109 a 149 de 150 (cota superior ≈ US$0,22). Se completaron **18 pares** (n 500–517): dos llamadas de reintento de `@6` consumieron el margen, y el arnés no inicia un par que no pueda completar. No se usó EC2 ni Quote V2 real.

| Métrica | `@6` (redacta) | `@7` (copia) |
|---|---|---|
| Conversaciones / puntos de copia | 18 / 18 | 18 / 18 |
| JSON válido en la primera llamada | 14/18 (IC 52–94 %) | **18/18** (IC ≥ 81 %) |
| JSON válido, todas las llamadas | 17/22; 5 `invalid_structured_output`, todas con `finishReason=stop` | 18/18 |
| Reintentos (recuperación ADR-028) | 4: 3 recuperadas y 1 agotada → handoff (n 506, sin cotización) | 0 |
| Llamadas por oferta | 1,22 | 1,00 |
| Copia exacta de la renderización de Sales | 0/18 (no se pide) | **18/18** |
| Integridad comercial en la primera llamada | **8/18** (IC 22–69 %). Fallos: 4 sin JSON; 6 ofertas que **omiten** importes (precios unitarios, o neto e IVA). Ningún importe ajeno, ningún nombre alterado, referencia en 14/14. | **18/18** |
| Ofertas mostradas al cliente | 17: 11 completas y 6 incompletas. Las 3 de reintento estaban completas. | 18, todas exactas |
| Emisión | 17/18; **0 rechazos por la oferta**. `quote.create@4` emitió las 6 ofertas incompletas. | 18/18 |
| Tokens de entrada por llamada (p50) | 12 344 | 12 822 (+478: el `offerMessage` en la observación) |
| Tokens de salida por llamada (p50 / p90 / máx) | 1 147 / 2 619 / 3 722 | 971 / 2 139 / 2 232 |
| Latencia por llamada (p50 / p90 / máx) | 7,4 / 16,5 / 22,2 s | 5,3 / 11,4 / 11,9 s |
| Tokens totales (entrada / salida) | 266 380 / 33 523 | 228 369 / 21 993 |

**Comparación pareada** (18 pares, primera llamada):

| Resultado | `@6` | `@7` | Discordantes (solo `@6` / solo `@7`) | p exacto |
|---|---|---|---|---|
| Integridad comercial | 8 | 18 | 0 / 10 | **0,002** (McNemar) |
| JSON válido | 14 | 18 | 0 / 4 | 0,125 (McNemar) |
| Emitida | 17 | 18 | 0 / 1 | 1 |
| Tokens de salida | — | mediana −168 | `@7` menor en 12/18 | 0,24 (signos) |
| Latencia | — | mediana −2,0 s | `@7` menor en 13/18 | 0,10 (signos) |
| Tokens de entrada | — | mediana +478 | `@7` mayor en 18/18 | < 0,001 (signos) |

**Interpretación (exploratoria; no es un criterio de rollout).**

- **Integridad:** la única diferencia clara con 18 pares. Con `@6` el modelo omitió cifras en un tercio de las ofertas que escribió, y `quote.create@4` las emitió igual. Es la debilidad D1, ahora **observada** con la configuración productiva y no solo mostrada por mutación.
  - No apareció ninguna cifra **errónea**; las fallas fueron por omisión.
  - Con `@7`, la integridad es una condición de la emisión (§4).
- **Fallos de formato:** 4/18 frente a 0/18 en la primera llamada **no es significativo** (p = 0,125). Es coherente con:
  - la línea base de los canaries: 3/8 en el paso de oferta;
  - el 0/108 de `@7` en §8.3, que suma 0/126 copias de `@7` sin fallo de formato.
- **Costo:** tokens de salida y latencia **no difieren de forma concluyente**. `@7` paga unos 480 tokens de entrada más por llamada; `@6` paga reintentos (1,22 llamadas por oferta) y una cola de latencia mayor, con dos llamadas inválidas de ≈ 3 700 tokens y 22 s.
- **Límites:** son los de §8.4, más una muestra pequeña, una sola ventana de tiempo, confirmaciones solo explícitas y un escenario de handoff que deja a `@6` con 17 conversaciones emitidas.

### 8.8 Hashes de la evidencia (SHA-256)

Todos en `artifacts/` (ignorado por git), en esta estación. La custodia está en el README de las herramientas.

| Archivo | SHA-256 |
|---|---|
| `j3ec1-fidelity/phase-AB/calls.jsonl` | `09772dfa3240dd61408be04933f335f218d0467a1884ea9501aded2c3e94b80f` |
| `j3ec1-fidelity/phase-AB/samples.jsonl` | `95c5222b1dc12e370c5b0cbf04e120232b24a014abf5d45f565eff4eb8e72669` |
| `j3ec1-fidelity/phase-AB/texts.jsonl` | `0352c79c2b9a37da50d9e9375abd88026474f98431fbf2b36da97c72dc6f071d` |
| `j3ec1-fidelity/phase-AB/summary.json` | `60bfa9de3e8c155d4eca28469f6ef8cd1c0a68d90f3fd349f8fd1c3d8f557ef8` |
| `j3ec1-fidelity/phase-AB.log` | `fde323b9feadf5c2c5a96cf6450aff0a7ee6b8cfbe85866e61a9b29c63db9fee` |
| `j3ec1-fidelity/analysis-AB.json` | `a557e324a8a62aa896783adfead62ecc7825da4e75f90d93de9371b2489537c1` |
| `j3ec1-fidelity/phase-P/calls.jsonl` | `4e5dde362768ed84988ca6d904637754becf1e5eab6121e9feaa3aa35bd66032` |
| `j3ec1-fidelity/phase-P/samples.jsonl` | `f3246ffb72b2ba2d5501a97838be68f98072af4ec5ed35ca7bcdf0e48c0cac07` |
| `j3ec1-fidelity/phase-A/calls.jsonl` | `016c9572a12f5ed6bb3fc73b7277f0dfe21700804b212dc057d26889ce2df9ca` |
| `j3ec1-fidelity/phase-A/samples.jsonl` | `2dc5166f638f86080593b4eec35400fed5b894cb743303e69ef68f934a061c7b` |
| `j3ec1-fidelity/phase-B0/calls.jsonl` | `d345886be84d217363678bbd4ba9a83b208db45a3c7d94aeee9c9def9fa086d5` |
| `j3ec1-fidelity/phase-B0/samples.jsonl` | `073d25c7bc5b00160517763da61e08061bd1b7c2503fbcccc139268ba078cf74` |
| `j3ec1-fidelity/phase-C/calls.jsonl` | `b7c59b7483a062804f3c9a0aa054424cf51d801f9b475c0aeac8618c147b87a6` |
| `j3ec1-fidelity/phase-C/samples.jsonl` | `14684dccff5d7ba59050e2cf84f1c9c21537bc393e60d4c1d2172a7b24839e10` |
| `j3ec1-fidelity/analysis-AB0C.json` | `bd8105d094678c182e4661b18a69a0e78dddd8f950f2dd631c0ddd748c09f005` |
| `j3ec1-fidelity/budget.json` (149 llamadas) | `0664e77617e28011cc2089634bca5635d95f7581b06768bab0650d35bd17a402` |
| `j3ec1-baseline/canary-events.jsonl` | `86043485d79817b9d96d553b0d8ed49024f7f0b885368752e813e20c47d6b6c7` |
| `j3ec1-baseline/canary-config.txt` | `bc2e9e38ee0adeba56633d09a721c4889327342fa4a165c3a0033f830897c794` |
| `j3ec1-baseline/baseline.json` | `f8512ca3feecfb3bf102ea1d938e8d17901eb5066fa099e02632ed83c7cdd294` |

**Procedencia de `phase-AB/texts.jsonl`.** La corrida empezó antes de que el ejecutor escribiera ese archivo. Durante la corrida se corrigió la métrica de integridad: contar importes **distintos**, porque una oferta libre no repite un precio unitario igual a su subtotal. Por eso los textos se reconstruyeron desde los archivos de captura de entrega de la propia corrida, y cada texto se aceptó solo si su SHA-256 coincide con el registrado en `calls.jsonl` al momento de la llamada (40/40). `analyze.mjs` vuelve a verificar esos hashes antes de calcular. Las corridas nuevas escriben `texts.jsonl` directamente.

## 9. Línea base histórica (EC2-RO)

**Acceso.**
- SSH de solo lectura a `~/r4-j3d/j3e-canary-run.log`, `~/r4-j3d/j3eb-canary-run.log` y a los **nombres** `R4_MODEL_*`/`R4_EXEC_*`/`R4_PROD_POLICY_PROFILE` de `~/.config/r4-canary/canary-j3e{,b}.env`.
- Se extrajeron solo campos de una lista blanca: tiempos, ids, proveedor, modelo, `finishReason`, tokens, latencia, tipo y resultado de la decisión, estado del run y eventos de recuperación. **Ningún** texto de conversación, snapshot ni secreto.
- No se consultó la base productiva ni conversaciones de clientes. Todas las tareas del canary son sintéticas.
- No se modificó ni borró nada en EC2.
- Los datos están en `artifacts/j3ec1-baseline/` (ignorado por git).

**Configuración verificada:** los dos canaries corrieron con `R4_MODEL_RESPONSE_FORMAT` **sin definir**, que por defecto es `json_object` (`config.ts:70`), con `R4_MODEL_EXTRA_BODY={"thinking":{"type":"enabled"}}`, `R4_MODEL_MAX_OUTPUT_TOKENS` vacío, `deepseek-flash` y perfil `deepseek-v4-flash`. Es el perfil fijado por `openai-compatible-provider.test.ts:163-181`. Confirma la corrección del plan §3.2: el JSON mode ya estaba activo.

| Métrica | J3E-A (`@5`) | J3E-B (`@6`) |
|---|---|---|
| Llamadas al modelo | 34 | 31 |
| `finishReason` | 34 `stop` | 31 `stop` |
| `invalid_structured_output` | 1 (2,9 %) | 2 (6,5 %) |
| Posición del fallo | inmediatamente después de `quote.preview` (1/1) | después de `quote.preview` (2/2, la misma conversación; recuperación agotada → handoff) |
| Llamadas que redactan la oferta tras `quote.preview` | 3 (1 inválida) | 5 (2 inválidas) |
| Input por llamada (p50) | 12 976 | 12 120 |
| Output por llamada (p50 / máx) | 796 / 7 215 | 620 / 2 705 |
| Latencia por llamada (p50 / p90 / máx) | 5,1 / 17,0 / 40,1 s | 4,2 / 8,0 / 14,5 s |
| Runs | 7 suspendidos, 1 fallido | 8 suspendidos, 2 fallidos |
| Recuperaciones ADR-028 | 1 recuperada | 1 agotada |
| Conversación positiva | 13 llamadas, 165 787 in / 9 978 out | 12 llamadas, 150 351 in / 11 367 out |

Línea base del paso de oferta: **3 fallos de formato en 8 llamadas que redactaban la oferta (≈ 37 %)**, frente a 0 en las otras 57 decisiones. El n es muy pequeño.

## 10. Comparación con los canaries

| Métrica | Canary J3E-A (`@5`) | Canary J3E-B (`@6`) | C1 experimento (`@7`, local) |
|---|---|---|---|
| Configuración del modelo | deepseek-flash, json_object, thinking, sin max_tokens | igual | **igual** |
| Quién redacta la oferta | el modelo (texto libre) | el modelo (texto libre + referencia y total) | **Sales** (el modelo copia) |
| Qué verifica la emisión | nada de la oferta | referencia y total | **el mensaje completo, byte a byte** |
| Fallos de formato en el paso de oferta | 1/3 | 2/5 | **0/108** |
| Fallos de formato en total | 1/34 | 2/31 | 0/108 (solo turnos de copia) |
| Tokens de entrada por llamada (p50) | 12 976 | 12 120 | 12 798 |
| Salida de llamadas `respond` | 513–5 989 | 499–2 705 | oferta p50 1 002, máx 3 761 |
| Latencia de llamadas `respond` (p50 aprox.) | 8,5 s | 5,7 s | oferta 5,3 s |

**Interpretación.**
- La diferencia en fallos de formato (3/8 frente a 0/108) es estadísticamente improbable bajo la misma tasa (Fisher unilateral p ≈ 0,0002).
- Pero **no es un experimento controlado**: cambiaron a la vez la definición (v5/v6 → v7), la tarea (redactar → copiar), el historial (real → guionado), los datos (reales → fixture) y la fecha.
- Es **compatible** con la hipótesis de que quitar la redacción libre de la oferta elimina el punto donde ocurrían los fallos, **no la prueba**.
- El control con una sola variable se ejecutó en la corrección previa al commit: §8.7, con 18 pares. Con la misma configuración, el mismo arnés y los mismos escenarios, `@7` tuvo integridad 18/18 frente a 8/18 de `@6` (p = 0,002). En JSON de primera llamada, 18/18 frente a 14/18 (p = 0,125, no concluyente).
- Integridad: en los canaries la coincidencia de la oferta fue **observada**. En C1 es una **condición de la emisión**, demostrada por mutación (§4, §6.5). En el control pareado, `quote.create@4` emitió 6 ofertas de `@6` que omitían cifras (§8.7).

## 11. ADR-036 (propuesto, no implementado)

`docs/adr/ADR-036-contractual-input-provenance.md`:
- **D1:** exponer `actorKind`, `actorRef` y `sourceRef` en los `contact.refs` de `thread()`. Los datos ya existen en `task_inputs` (`0005`); sin migración.
- **D2:** reservar `channel:` para ChannelIngress. La API rechaza ese `sourceRef`. Además se propone autenticar la ruta de inputs o prohibir inputs de API sobre tareas ligadas a un canal; esto puede ir en otro ADR.
- **D3:** orden **causal** con `agent.refs.contextFrontierInputId` (la misma lógica que `materializeResponses`), en lugar de comparar el reloj del worker con el de la base.
- **D4:** `quote.create@6` exige `actorKind=user`, `sourceRef = channel:<binding.channel>`, ningún `contact` de otro origen después de la oferta y una confirmación no vista por la oferta.

No acepta un `sourceRef` libre como garantía. Detalla compatibilidad, tests, consecuencias para otros agentes e impacto de plataforma.

## 12. Recomendación: B2 frente a composición por la plataforma

**Recomendación: mantener B2 como diseño de `@7` y llevarlo al canary EC2 cuando se autorice. La composición por la plataforma (Alt. C) queda como evolución con disparadores explícitos, no como requisito previo.**

Fundamentos:
1. **La corrección no depende del modelo.** Con B2, un mensaje distinto del de Sales nunca se emite (19 mutaciones, 4 mutantes de código detectados). Lo que depende del modelo es la disponibilidad, y se midió: 108/108 copias exactas y 0 fallos de formato con la configuración productiva.
2. **Sin harness.** B2 cierra el bloqueo de emisión (B1) sin tocar protocolo, kernel ni migraciones. Alt. C cambia el protocolo de decisión (v5 → v6) y el kernel, y requiere un ADR.
3. **Lo que B2 no cubre:** que el cliente **vea** una cifra errónea antes de confirmar. No ocurrió en 126 copias (108 de §8.3 y 18 de §8.7). El costo de copiar es ≈ 1 000 tokens de salida y ≈ 5 s por oferta; en el control pareado no fue mayor que el de redactar (§8.7).

Activar Alt. C (ADR propio) si ocurre cualquiera de estos casos:
- la fidelidad medida en el canary o en producción baja del umbral que fije el owner (propuesta: < 99 % en una ventana de ≥ 100 ofertas);
- hay un incidente de oferta mal presentada que llega a un cliente;
- el owner exige que ninguna cifra comercial errónea llegue nunca al cliente;
- el costo o la latencia del turno de oferta pasa a ser prioritario.

## 13. Limitaciones

1. **Integridad previa al envío:** con B2, un mensaje mal copiado **llega** al cliente; no se puede emitir, pero se ve. Solo la composición por la plataforma (Alt. C) lo evita.
2. **Igualdad estricta sin normalización:** cualquier cambio de espacios o formato rechaza. Es deliberado; en el experimento no ocurrió (§8).
3. **Kill switch después de autorizar:** la cotización queda retenida y se envía al liberar (§6.2–6.3). Requiere un humano en estos casos:
   - el cliente escribe durante la retención, o el operador cancela o toma la tarea: nunca se envía, y la autorización queda y bloquea una reemisión autónoma (`duplicate_quote`);
   - la retención supera el presupuesto del run: emite, pero sin respuesta al cliente;
   - el switch se reactiva en tres reanudaciones: `write_not_applied`.

   Al liberar se envía el cuerpo congelado tal como se confirmó. Precios, stock y despacho **no se vuelven a verificar** con los owners al reanudar, igual que en cualquier replay. Si el switch se activó por un problema comercial, el operador debe cancelar o tomar las retenidas **antes** de liberar.
4. **Kill switch por canal:** no bloquea las escrituras de `@7`. Solo el global lo hace (§6.4, F5).
5. **`guardProductionWrites` sin `bind`** (harness): Sales lo rodea; la corrección general queda pendiente de una decisión de harness.
6. **Liquidación estricta:** Quote V2 no devuelve productos, cantidades, transportista ni destino; esos quedan vinculados por el cuerpo congelado y la clave, no por eco.
7. **Hallazgo previo, J2:** un producto con peso solo por variante no obtiene despacho por pedido (`shipping-basis.ts:35-37`). El experimento usa variantes solo sin despacho.
8. **Procedencia y orden:** siguen sujetos a la topología y a dos relojes hasta ADR-036.
9. **Validez de los experimentos:** ver §8.4 y §8.7. El control pareado tiene 18 pares; solo la diferencia de integridad es concluyente.
10. **`unknown` para un intento que la capacidad sabe que no envió** (§6.2): es una decisión de semántica que debe confirmar el owner y registrarse en un ADR.
11. **Backoff de `quote.create@5`** (20, 40 y 80 s) también rige después de un timeout del owner.
    - La reconciliación dentro del run espera 20 s en lugar de ser inmediata, así que el cliente espera más.
    - A cambio, un timeout ordinario puede resolverse dentro del run. Antes, tres reconciliaciones instantáneas dentro de la ventana de 120 s del owner casi siempre terminaban en `needs_reconciliation`.
    - `action_retry` no tenía uso ni test en el repositorio antes de esta corrección; ahora lo cubren los E2E 2–4.
12. **La carrera residual** (caso 6 de §6.3) se cubre en el handler y con aritmética de contrato, no con un E2E: requeriría 120 s reales, porque la antigüedad del envío usa `clock_timestamp()`.

## 14. Bloqueos productivos que permanecen

| # | Bloqueo | Estado |
|---|---|---|
| 1 | Procedencia contractual y orden causal | ADR-036 propuesto; requiere aceptación e implementación de harness, o aceptación explícita del gate de topología con verificación en el host |
| 2 | Límites de producción | **SIN APROBAR** (los valores del canary solo se usaron en tests) |
| 3 | Rollback y drenaje | Runbook pendiente: un cambio de perfil deja ejecuciones `quote.create@5` sin handler de reconciliación |
| 4 | Handoff atendido | Sin operadores OIDC reales |
| 5 | Observabilidad mínima | `finishReason` y clase de fallo solo en logs; sin reporte de decisiones autónomas; sin tokens de caché ni de razonamiento |
| 6 | Canary EC2 de `@7` | No ejecutado (requiere autorización) |
| 7 | Despliegue | Producción en `@3`/`ef5a354`; faltan `0008`/`0009` en la base productiva y el registro de `sales@7` |
| 8 | Entrega del PDF | Hito siguiente |
| 9 | Kill switch por canal sobre escrituras de `@7` | **Gate operacional.** Solo el global detiene las escrituras. Se cierra con una corrección de harness (honrar el canal en el guard o en la admisión) o con la aceptación explícita del owner. |
| 10 | Runbook de retenciones por kill switch | Pendiente. Antes de liberar, el operador debe:<br>• listar las cotizaciones retenidas (ejecuciones `quote.create@5` en `executing` con `action_retry` pendiente o disparado);<br>• decidir por cada una si se envía, se cancela o se toma;<br>• avisar al cliente cuando la retención supere `R4_EXEC_MAX_RUN_DURATION_MS` (§6.3, caso 4). |
| 11 | Semántica `unknown` de una retención | Confirmación del owner y registro en un ADR (§6.2) |

## 15. Estado

- **Commit local** en la rama `r4-j3e-c-deterministic-commercial-offer`, **sin merge ni push**. El SHA se informa al cerrar, porque este archivo forma parte del commit.
- **Modelo real:** 40 llamadas del control pareado, desde esta estación, contra fixtures; 149 de 150 en el libro del experimento.
- **EC2:** solo lectura (§9). No hubo canary, migración, reinicio de PM2, cambio de WhatsApp ni de Gmail.
- **Producción:** `@3`.
- **Recursos locales:**
  - Docker Desktop iniciado;
  - bases de prueba temporales eliminadas por cada suite;
  - el worktree temporal de `main` se eliminó (`git worktree list` muestra solo la rama), después de desvincular su junction a `node_modules`.
