# R4-J3 — Registro de brechas del recorrido del cliente

Fecha: 2026-10-14 · Rama `r4-j3e-c-deterministic-commercial-offer` (`7783a08`, sin publicar) · Base `origin/main` `092715e` · Documento hermano: [`R4_J3_FINAL_ACCEPTANCE.md`](R4_J3_FINAL_ACCEPTANCE.md).

**Estado vigente (2026-10-15): J3 `CLOSED_WITH_RESCOPED_ACCEPTANCE`** (aceptación §17; registro de cierre [`R4_J3_CLOSURE_RECORD.md`](R4_J3_CLOSURE_RECORD.md)). GAP-02 y GAP-16 cerradas; GAP-01 diferida a R4 Media; las brechas con hito J7 siguen abiertas. El bloque siguiente es historia del 2026-10-14.

> **Re-delimitación de J3 (decisión del owner, 2026-10-14).** J3 pasa a ser *Quote Integration & Autonomous Issuance* y excluye explícitamente la entrega del PDF (aceptación §15).
>
> - **GAP-01:** pasa a `DEFERRED_TO_R4_MEDIA`. Deja de bloquear J3, pero sigue siendo requisito verificable antes de cualquier rollout comercial que prometa PDFs al cliente.
> - **GAP-03:** `GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0` (decisión del owner, 2026-10-14). Sale de J3 y no forma parte de R4 Media: pertenece a *Sales Response Integrity*.
> - **GAP-02:** sigue abierto. El canary EC2 de `@7` del 2026-10-14 quedó **BLOCKED** por acceso SSH ([informe](R4_J3_FINAL_EC2_CANARY_REPORT.md)). *(Superado: cerrada el 2026-10-15, canary PASS con PC-000006, informe §20.)*
>
> Las clasificaciones anteriores se conservan tachadas o en las filas "Disposición" como historia.

Cada brecha cita la evidencia que la sostiene. Etiquetas:
- **SOURCE**: código de la rama, con archivo y línea;
- **LOCAL**: ejecutado en esta estación;
- **REAL-MODEL**: DeepSeek V4 Flash real, con owners fixture;
- **EC2-DOC**: evidencia EC2 de informes anteriores, no repetida en esta sesión;
- **DOC**: afirmación de un documento, sin verificación propia.

Clases (mandato del owner, §8):

| Clase | Significado |
|---|---|
| **J3-FUNCTIONAL-BLOCKER** | Impide completar una cotización que pidió un cliente. |
| **J3-TECHNICAL-BLOCKER** | Impide garantizar la corrección o la integridad del dominio. |
| **J7-PRODUCTION-GATE** | Impide exponer la funcionalidad a clientes reales de forma gobernada. |
| **FUTURE-ENHANCEMENT** | No hace falta para el objetivo actual. |

## Resumen

| ID | Brecha | Clase | Prioridad | Hito |
|---|---|---|---|---|
| GAP-01 | El cliente no recibe el PDF oficial | ~~J3-FUNCTIONAL-BLOCKER~~ → **DEFERRED_TO_R4_MEDIA** (2026-10-14). Requisito previo a un rollout que prometa PDFs | P0 para ese rollout | ~~J3 (slice J3F)~~ → R4 Media & Communications |
| GAP-02 | `@7` sin canary EC2 contra owners reales | ~~J3-FUNCTIONAL-BLOCKER~~ → **CERRADA** (2026-10-15): canary EC2 PASS, PC-000006 ([informe §20](R4_J3_FINAL_EC2_CANARY_REPORT.md)). Historia: 2026-10-14 BLOCKED (SSH) y luego FAIL (límite de 60 s por llamada) | — | J3 |
| GAP-03 | El mensaje de emisión lo redacta el modelo | ~~J3-FUNCTIONAL (se resuelve dentro de J3F)~~ → **J7-PRODUCTION-GATE** (`GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0`) | ~~P1~~ → **P0 para J7** | ~~J3 (slice J3F)~~ → J7 (Sales Response Integrity) |
| GAP-04 | Productos con peso solo por variante no cotizan despacho | FUTURE-ENHANCEMENT (se reclasifica tras medir) | P2 | J1/J2 |
| GAP-05 | La cotización no identifica al cliente (invitado anónimo) | FUTURE-ENHANCEMENT | P2 | J4 / posterior |
| GAP-06 | Procedencia contractual de los inputs (ADR-036) | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-07 | El switch por canal no detiene escrituras ni admisión de `@7` | J7-PRODUCTION-GATE | P1 | J7 |
| GAP-08 | Operaciones retenidas por el kill switch: sin caducidad ni runbook | J7-PRODUCTION-GATE | P1 | J7 |
| GAP-09 | Rollback y drenaje sin runbook ensayado | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-10 | Handoff sin operadores (OIDC real ausente) | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-11 | Observabilidad mínima de decisiones autónomas | J7-PRODUCTION-GATE | P1 | J7 |
| GAP-12 | Límites comerciales de producción sin aprobar | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-13 | Los gates de `@7` no se hacen cumplir en código | J7-PRODUCTION-GATE | P1 | J7 |
| GAP-14 | Ningún perfil con cotización pasó por WhatsApp real | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-15 | Higiene: test de recovery obsoleto; definición v7 menciona `customer.get_context` | FUTURE-ENHANCEMENT | P3 | — |
| GAP-16 | Emisión autorizada varada si Quote V2 no está disponible al enviar | **J3-FUNCTIONAL-BLOCKER** → **corregido** en `quote.create@5` (límites remanentes en ADR-037) | P0 | J3 (antes del canary) |
| GAP-17 | Dos salidas mal formadas seguidas → handoff → el cliente queda sin respuesta | J7-PRODUCTION-GATE | P0 para J7 | J7 |
| GAP-18 | La oferta actualizada tras un cambio de precio no se marca como cambiada | FUTURE-ENHANCEMENT | P2 | Posterior |
| GAP-19 | Pedidos genéricos resueltos por suposición en vez de pregunta | FUTURE-ENHANCEMENT | P2 | Posterior |

Las cuatro últimas surgieron de las conversaciones con el modelo real de esta aceptación (aceptación §5.3–5.4).

## Detalle

### GAP-01 — El cliente no recibe el PDF oficial

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: el adaptador WhatsApp envía solo `type: 'text'` (`adapters/channels/whatsapp-cloud/src/outbound.ts:51`); `OutboundSubmission` sin adjuntos (`packages/live-ops/src/channel.ts:73-81`); `outbound_messages.origin in ('agent','operator')` (`packages/persistence-postgres/migrations/0007_governed_production.sql:116`); `settle` descarga el PDF solo para hashearlo (`agents/sales/src/capabilities/quote-v2.ts:355-363`); `@7` declara "no delivery of quotes" (`agents/sales/src/production/profile-v7.ts:27,30`). REAL-MODEL: tras emitir, el agente dice al cliente "no puedo enviarte el documento por correo ni compartirlo por este canal" (aceptación §5.3). |
| Impacto | El cliente recibe un número, totales y validez en texto, pero no el documento formal que podría presentar, imprimir o reenviar. El recorrido queda incompleto en el último paso. |
| Prioridad | P0 |
| Owner | Plataforma R4 (dueño de entrega en `packages/live-ops`, persistencia y adaptador WhatsApp) + Sales (capacidad). Quote V2: sin cambios. |
| Resolución mínima | Slice `R4-J3F — Quote Document Delivery` (aceptación §8.3): capacidad `quote.share_document@1` `{quoteNumber}` sin destinatario; envío solo por el dueño de entrega al `recipient_ref` del binding; clave `r4-doc:<quoteId>`; re-verificación del SHA-256 antes de subir; `type: document` por WhatsApp. |
| Dependencias | Autorización de cambio de harness y ADR (política autónoma `@2` o envío automático por la plataforma); límites de medios de Meta (desconocidos); ventana de 24 h. No depende de J4. |
| Test de aceptación | E2E en el canal sintético: emisión → un envío de documento capturado con SHA-256 = manifiesto y destinatario = binding; repetir la petición no crea un segundo envío; `mismatch` → 0 llamadas al proveedor; dos conversaciones con cotizaciones → cada PDF solo a su conversación. En J7: estado `delivered` del proveedor en el número dedicado. |
| Hito | **J3** (histórico) |
| Disposición (2026-10-14) | **DEFERRED_TO_R4_MEDIA** por decisión del owner (`J3F_DISPOSITION`).<br><br>El diseño se conserva sin implementar en la rama `r4-j3f-document-delivery-design` (commit local `19928db`): `ADR-038-governed-document-outbound.md` (`PROPOSED_DEFERRED`), `R4_J3F_DOCUMENT_DELIVERY_DESIGN.md` y `R4_J3F_IMPLEMENTATION_PLAN.md`. Ese diseño reemplaza la "Resolución mínima" de arriba: entrega automática por la plataforma, sin capacidad invocada por el modelo.<br><br>La evidencia de que S10 falló no se reescribe (aceptación §4, §8). **Requisito que se mantiene:** ningún rollout comercial que prometa PDFs al cliente sin cumplir el "Test de aceptación" de esta fila (roadmap §4.2). |

### GAP-02 — `@7` sin canary EC2 contra owners reales

| Campo | Contenido |
|---|---|
| Evidencia | C1 §15: `R4_EC2_CANARY=NOT_RUN`. Esta sesión: la exploración de credenciales SSH fue rechazada por el clasificador de permisos; no se accedió a EC2 (aceptación §6). Lo que sí existe: `@5/@6` contra Quote V2 real (PC-000004, PC-000005; EC2-DOC), y la aritmética estricta igual al ejemplo publicado por el owner (`tests/unit/quote-v2/owner-contract.test.ts:11-16`). |
| Impacto | No está demostrado que, con `@7`, una cotización confirmada llegue a `succeeded` contra el owner desplegado: la liquidación estricta compara además importes por línea, `exemptNet` y tipo de correlación. Si el owner desplegado difiere, cada emisión queda `unknown` (falla cerrado, sin éxito falso), y el cliente no recibe confirmación. Tampoco se verificó la cobertura de San Bernardo en el owner real de Shipping. |
| Prioridad | P0 |
| Owner | R4 (operador del canary) con autorización del owner. |
| Resolución mínima | El canary aislado de `@7` ya autorizado: **una** cotización real de Quote V2, escenario multiproducto con despacho a San Bernardo, preflight de §6.2 de la aceptación. |
| Dependencias | Acceso SSH a EC2 permitido en la sesión; transferencia del commit por bundle incremental (sin publicar la rama); ≥ 700 MB libres; cancelar `j3eb-pos-1`. |
| Test de aceptación | Recibo `succeeded`; decisión `authorized:eligible`; `offer_text_sha256` = renderización Sales; liquidación estricta sin `unknown`; PDF `verified`; 1 binding de idempotencia y 1 operación en Quote V2; producción en `@3` sin cambios; 0 outbound fuera del canal sintético. |
| Hito | **J3** |
| Estado (2026-10-15, vigente) | **CERRADA: PASS** ([informe §20](R4_J3_FINAL_EC2_CANARY_REPORT.md)), con timeouts del canary autorizados por el owner.<br><br>- PC-000006 emitida una sola vez contra Catalog, Shipping y Quote V2 reales (multiproducto, San Bernardo).<br>- Recibo `succeeded` con liquidación estricta; PDF `verified`; oferta = render Sales (SHA-256).<br>- Producción en `@3` / `ef5a354`, sin cambios antes y después. 0 outbound fuera del canal sintético. |
| Estado (2026-10-14, ejecución con la identidad SSH autorizada) | **FAIL, sin emisión** ([informe §18](R4_J3_FINAL_EC2_CANARY_REPORT.md)).<br><br>- Preflight y aislamiento en verde; producción intacta, verificada antes y después.<br>- En dos conversaciones, dos llamadas seguidas al modelo superaron el límite de 60 s por llamada de R4 (`R4_EXEC_MODEL_CALL_TIMEOUT_MS`, default). Resultado: handoff, sin oferta.<br>- 0 cotizaciones.<br>- Evidencia adicional para GAP-17. |
| Estado (2026-10-14, primer intento) | **BLOCKED** ([informe](R4_J3_FINAL_EC2_CANARY_REPORT.md)).<br><br>Esta estación no tiene el alias SSH `Master`, y el host documentado rechazó su identidad (`Permission denied (publickey)`). Se detuvo sin buscar llaves.<br><br>0 cotizaciones emitidas; producción no verificada. El informe contiene el procedimiento para un operador con acceso legítimo. |

### GAP-03 — El mensaje de emisión lo redacta el modelo

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: no hay plantilla de emisión; `sales.v7.agent.json:7` solo pide tomar número, totales y validez del resultado. La salida de `quote.create@5` trae los datos (`quote-v2.ts:85-98`). REAL-MODEL: en las conversaciones de §5.3 el texto coincidió con el resultado; no hay garantía de código. |
| Impacto | Un número o total mal copiado llegaría al cliente y le impediría identificar su cotización. |
| Prioridad | P1 |
| Owner | Sales |
| Resolución mínima | Mismo patrón B2 que la oferta: la nueva versión de `quote.create` devuelve `issuedMessage` renderizado por Sales (número, líneas, totales, validez, aviso del documento) y la definición pide copiarlo. Va dentro de J3F, porque el mensaje anunciará el PDF. |
| Dependencias | J3F (texto del aviso del documento). |
| Test de aceptación | Unit: golden de la plantilla. Integración: mutar número o total del texto entregado se detecta (no se registra como confirmación de emisión). Fidelidad de copia medida con el modelo real. |
| Hito | **J3** (dentro de J3F), histórico |
| Disposición (2026-10-14) | **J7-PRODUCTION-GATE, P0** (decisión del owner; `GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0`).<br><br>- Sale de J3 y **no** forma parte de R4 Media: pertenece a *Sales Response Integrity*.<br>- **Requisito:** antes del outbound, la emisión comunicada al cliente debe estar protegida mediante validación o composición determinista.<br>- Evidencia que se conserva: REAL-MODEL (§5.3) mostró copias correctas, sin garantía de código. La cotización emitida es correcta aunque el mensaje la cite mal.<br>- No se inicia implementación sin autorización. |

### GAP-04 — Productos con peso solo por variante no cotizan despacho

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: la base por pedido usa solo `facts.weightKg` del producto; nulo → `shipping_item_weight_unavailable` (`agents/sales/src/capabilities/shipping-basis.ts:18-37`); el contrato Catalog no da peso por variante (`adapters/domains/src/catalog/port.ts:208-213`). LOCAL: `tests/unit/sales/shipping-capability.test.ts:56-61` lo fija como limitación. |
| Impacto | Un cliente que pide un producto con variantes y despacho no obtiene cotización con despacho: solo sin despacho o derivación. Proporción del catálogo real afectada: **desconocida**. |
| Prioridad | P2 (se eleva si la medición lo justifica) |
| Owner | Catalog (contrato J1) y Shipping (J2) |
| Resolución mínima | Medir en el catálogo real cuántos productos activos tienen peso solo por variante. Si es relevante: exponer el peso de la variante en el contrato Catalog y usarlo en la base de despacho (nueva versión de capacidad). |
| Dependencias | Owner de Catalog. |
| Test de aceptación | Variante con peso propio + despacho → oferta con despacho; sin peso → bloqueo explícito, nunca un peso inventado. |
| Hito | J1/J2. **Reclasificar a J3-FUNCTIONAL-BLOCKER** si afecta a productos frecuentes. |

### GAP-05 — La cotización no identifica al cliente

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: `customer: { kind: 'guest' }` constante (`agents/sales/src/capabilities/commercial-snapshot.ts:218,233`); el nombre del perfil de WhatsApp no se lee (`adapters/channels/whatsapp-cloud/src/inbound.ts:105-112`). EC2-DOC: PC-000004 emitida como invitado contra el owner real. |
| Impacto | El PDF no nombra al cliente. No impide obtener la cotización. Puede no servir a un cliente empresa que necesita razón social o RUT. |
| Prioridad | P2 |
| Owner | Sales (dato declarado) / J4 (dato verificado) |
| Resolución mínima | Decisión de producto. Sin J4: `guest.displayName` declarado por el cliente, incluido en el snapshot y en la oferta. Con J4: `person`/`company` verificados. |
| Dependencias | J4 para datos verificados. |
| Test de aceptación | Nombre declarado aparece en la oferta y en el PDF; ningún dato de cliente sin declaración o verificación. |
| Hito | Posterior a J3 |

### GAP-06 — Procedencia contractual de los inputs (ADR-036)

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: `POST /v1/tasks/:id/inputs` acepta cualquier tarea y un `sourceRef` libre (`apps/api/src/app.ts:167-174`); `thread()` trata todo input como `contact` (`production-store.ts:554-555`). ADR-036 propuesto. |
| Impacto | La confirmación es auténtica solo si ChannelIngress es el único productor de inputs en la base del despliegue. |
| Prioridad | P0 para J7 |
| Owner | Plataforma R4 |
| Resolución mínima | ADR-036 D1–D4, o aceptación explícita de la topología con verificación en el host (sin API contra la base productiva). |
| Dependencias | Autorización de harness. |
| Test de aceptación | Un input de API sobre una tarea ligada a un canal nunca cuenta como confirmación. |
| Hito | J7 |

### GAP-07 — El switch por canal no detiene escrituras ni admisión de `@7`

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: `guard.ts:31` y `controls.ts:155` leen solo el global. LOCAL: test F5 (`tests/integration/sales-deterministic-offer-quote.test.ts:513`). |
| Impacto | Apagar solo WhatsApp no impide que un run ya admitido emita. |
| Prioridad | P1 |
| Owner | Plataforma R4 |
| Resolución mínima | Honrar el canal en el guard o en la admisión (harness), o aceptación explícita de "solo global". |
| Dependencias | — |
| Test de aceptación | Switch de canal activo → 0 llamadas `createAndIssue`. |
| Hito | J7 |

### GAP-08 — Operaciones retenidas por el kill switch

| Campo | Contenido |
|---|---|
| Evidencia | DOC C1 §6.3 casos 3–7 y §13.3: al liberar se envía el cuerpo congelado sin re-verificar precios, stock ni despacho; la retención no caduca. |
| Impacto | Una cotización retenida días puede emitirse con condiciones viejas. |
| Prioridad | P1 |
| Owner | R4 operación |
| Resolución mínima | Runbook (listar retenidas, cancelar o tomar antes de liberar) o caducidad por antigüedad; registrar la semántica `unknown` en un ADR. |
| Dependencias | Operadores (GAP-10). |
| Test de aceptación | Retenida más allá del umbral → no se envía al liberar. |
| Hito | J7 |

### GAP-09 — Rollback y drenaje

| Campo | Contenido |
|---|---|
| Evidencia | DOC gap plan R9: volver a `@3` deja ejecuciones `quote.create@5` sin handler (`action-executor.ts:112-113`). |
| Impacto | Un rollback apresurado deja reconciliaciones manuales. |
| Prioridad | P0 para J7 |
| Owner | R4 operación |
| Resolución mínima | Runbook: kill switch → drenar ejecuciones no terminales → cerrar o pasar a humano los bindings → cambiar perfil. Ensayarlo en el canary. |
| Dependencias | — |
| Test de aceptación | Tras volver al perfil anterior, 0 ejecuciones sin handler. |
| Hito | J7 |

### GAP-10 — Handoff sin operadores

| Campo | Contenido |
|---|---|
| Evidencia | DOC J3D: ADR-033 implementado, sin cliente OAuth ni registro reales. REAL-MODEL: un fallo de formato (recuperado) en la conversación positiva; dos seguidos producen handoff. |
| Impacto | Un handoff deja al cliente sin respuesta. |
| Prioridad | P0 para J7 |
| Owner | Owner del negocio (cliente OAuth) + R4 operación |
| Resolución mínima | Cliente OAuth, registro de operadores y tiempo de atención acordado. |
| Dependencias | — |
| Test de aceptación | Handoff atendido por un operador autenticado en el canary. |
| Hito | J7 |

### GAP-11 — Observabilidad

| Campo | Contenido |
|---|---|
| Evidencia | DOC gap plan R7. |
| Impacto | Sin alertas de `unknown`, `needs_reconciliation`, PDF `mismatch` ni handoffs. |
| Prioridad | P1 |
| Owner | Plataforma R4 / Sales |
| Resolución mínima | Reporte Sales read-only de decisiones autónomas por `reason_code` y alertas mínimas. |
| Dependencias | — |
| Test de aceptación | Cada estado de alerta produce una alerta en el canary. |
| Hito | J7 |

### GAP-12 — Límites comerciales de producción

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: siete variables sin valor por defecto (`autonomy-limits.ts:73-85`); la composición no arranca sin ellas. |
| Impacto | Sin valores aprobados no hay despliegue (falla cerrado). |
| Prioridad | P0 para J7 |
| Owner | Owner del negocio |
| Resolución mínima | Aprobar los siete valores. |
| Dependencias | — |
| Test de aceptación | Composición con los valores aprobados; una oferta sobre el límite no se presenta como emitible. |
| Hito | J7 |

### GAP-13 — Los gates de `@7` no se hacen cumplir en código

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE: `SALES_PRODUCTION_PROFILE_V7_GATE` (`profile-v7.ts:45-55`) no lo referencia ningún código. |
| Impacto | Un operador puede seleccionar `@7` en producción sin cumplir los gates. |
| Prioridad | P1 |
| Owner | R4 operación |
| Resolución mínima | Checklist de despliegue obligatoria, o verificación en `production:sales:validate`. |
| Dependencias | — |
| Test de aceptación | Validación de producción falla si un gate bloqueante no está declarado como cumplido. |
| Hito | J7 |

### GAP-14 — Ningún perfil con cotización pasó por WhatsApp real

| Campo | Contenido |
|---|---|
| Evidencia | SOURCE/LOCAL: el webhook firmado se prueba con `sales-production@1` (`tests/support/live-ops.ts:133`; `tests/integration/live-ops-reference.test.ts:36`); los canaries `@4–@7` usan el canal sintético sin firma (`agents/sales/src/cli/canary/channel.ts:22-34`). |
| Impacto | El ingreso es el mismo código, pero la combinación real (webhook, ventana de 24 h, límite de texto de Meta) con un perfil de cotización no se probó. |
| Prioridad | P0 para J7 |
| Owner | R4 operación |
| Resolución mínima | Canary en el número dedicado, con allowlist de una clave interna. |
| Dependencias | J3 cerrado; GAP-06, GAP-10, GAP-12. |
| Test de aceptación | Conversación real en el número dedicado → cotización emitida y PDF con estado `delivered`. |
| Hito | J7 |

### GAP-15 — Higiene

| Campo | Contenido |
|---|---|
| Evidencia | LOCAL: `tests/recovery/production-bootstrap-process.test.ts:48` espera solo `sales@3` (preexistente desde J2D). SOURCE: `sales.v7.agent.json:7` menciona `customer.get_context`, que producción no ofrece (`composition.ts:179`). |
| Impacto | Ruido en la regresión; una instrucción sin herramienta. |
| Prioridad | P3 |
| Owner | R4 |
| Resolución mínima | Actualizar la lista del test; quitar la mención en la próxima versión de la definición. |
| Dependencias | — |
| Test de aceptación | `test:recovery` verde. |
| Hito | — |

### GAP-16 — Emisión autorizada varada si Quote V2 no está disponible al enviar

**Estado: corregido** (decisión del owner del 2026-10-14; aceptación §14). `quote.create@5` retiene en su clave una emisión autorizada cuando el owner responde no disponible; la plataforma reconcilia y reproduce la misma clave. Verificado en el runtime real (3 tests, mutación detectada) y con el modelo real en tiempo real (PC-000001 emitida ≈ 5,5 min después de la confirmación, sin segunda confirmación). Lo que no resuelve queda en ADR-037 (L1–L4): espera de ≈ 5 min, silencio durante la retención y cortes más largos que las reconciliaciones del run (≈ 140 s), que requieren un operador.

| Campo | Contenido |
|---|---|
| Evidencia | REAL-MODEL (`artifacts/j3-acceptance/quote-down.json`): "Sí, emítela." → `authorized:eligible` (`0008`), cuerpo congelado (`0007`), 1 envío registrado → owner no disponible → recibo `failed quote_service_unavailable` tras **1** intento. Nueva propuesta del agente → `rejected:customer_confirmation_used`. El agente re-presentó la oferta sin decir que falló. SOURCE: `classifySend` → `failed` para `temporarily_unavailable` (`agents/sales/src/capabilities/quote-v2.ts:395`); `failed` es definitivo, sin reintento ni reconciliación (`packages/task-runtime/src/action-lifecycle.ts:67`); índice único de snapshot autorizado (`0008`) y de confirmación usada (`0009`). El test C8 (`tests/integration/sales-autonomous-quote.test.ts:380`) "recupera" invocando el handler con la misma clave e intento 2, algo que la plataforma nunca hace. |
| Impacto | Una caída momentánea de Quote V2 en el instante de emitir deja esa cotización imposible de emitir de forma autónoma en esa conversación, aunque el owner vuelva: el cliente confirmó y no obtiene nada, y un "Sí, emítela." nuevo se rechaza. No hay cotización errónea ni duplicada. Afecta a `@5`, `@6` y `@7` (código compartido). |
| Prioridad | P0 |
| Owner | Sales |
| Resolución mínima | Patrón C1 §6.2: con el cuerpo ya congelado, `temporarily_unavailable` → `unknown` (retenida en su clave). La plataforma reconcilia por lookup (`not_applied`) y reproduce la misma clave y cuerpo con el backoff declarado (20/40/80 s). Antes de decidir sigue `failed`. Mensaje de rechazo para `customer_confirmation_used` que no invite a re-presentar la oferta. Sin harness ni migración. |
| Dependencias | Decisión del owner: corrección de `@5` antes del merge (nunca publicado ni desplegado; actualiza la huella fijada `dc4d82dc…`) o versión nueva. |
| Test de aceptación | E2E en el runtime real (worker, ActionExecutor, scheduler): owner caído al enviar → ejecución `executing` con `action_retry`; owner arriba → `reconcile:not_applied` → `replay:applied`, misma `execution_key`, 1 cotización. Con el owner caído más allá de los intentos: `needs_reconciliation`, nunca una clave nueva; el agente informa "pendiente". Reemplazar la parte "Quote outage" de C8 por este E2E. Repetir la conversación con el modelo real. |
| Hito | **J3** |

### GAP-17 — Dos salidas mal formadas seguidas → handoff → el cliente queda sin respuesta

| Campo | Contenido |
|---|---|
| Evidencia | REAL-MODEL: 5 de 128 llamadas no parseables (3,9 %), todas en el turno 1 o 2, con `finishReason: stop` (JSON seguido de prosa, o marcado de llamada a herramienta). En 1 de 8 conversaciones ocurrieron dos seguidas en el primer turno → handoff, tarea `blocked`, **0 mensajes al cliente** (`artifacts/j3-acceptance/catalog-down.json`). Línea base de canaries: 3/65 (C1 §9). |
| Impacto | Sin operadores, el cliente no recibe nada. La conducta de la plataforma (no reparar la salida del modelo, ADR-028) es la correcta; lo que falta es quien atienda. |
| Prioridad | P0 para J7 |
| Owner | R4 operación (handoff atendido, GAP-10) + plataforma (observabilidad del fallo, gap plan §3) |
| Resolución mínima | Handoff atendido con tiempo acordado; alerta por handoff; registrar `finishReason` y la clase de fallo. Opcional (medir antes): experimentos E1–E5 del plan de cierre. |
| Dependencias | GAP-10, GAP-11. |
| Test de aceptación | Inyectar dos salidas inválidas en el canary → alerta y respuesta de un operador dentro del tiempo acordado. |
| Hito | J7 |

### GAP-18 — La oferta actualizada no se marca como cambiada

| Campo | Contenido |
|---|---|
| Evidencia | REAL-MODEL (`price-change.json`): tras `preview_stale`, el agente presentó la oferta nueva (precio $36.990 en vez de $34.990) sin decir que cambió; la plantilla solo advierte en sus condiciones que "si algo cambió, no se emite y te presento la oferta actualizada". La instrucción v7 pide copiar la oferta "sin palabras antes ni después". |
| Impacto | El cliente puede confirmar un precio mayor sin notarlo. La confirmación sigue siendo de la oferta exacta (correcto), pero la experiencia no es transparente. |
| Prioridad | P2 |
| Owner | Sales |
| Resolución mínima | Variante de plantilla renderizada por Sales con una línea "Oferta actualizada: cambió …" cuando hay una oferta anterior en la conversación. |
| Dependencias | — |
| Test de aceptación | Golden de la variante; el cambio de precio aparece en el texto confirmado. |
| Hito | Posterior a J3 |

### GAP-19 — Pedidos genéricos resueltos por suposición

| Campo | Contenido |
|---|---|
| Evidencia | REAL-MODEL: con "una rack, una barra olímpica y 100 kilos en discos", en una conversación el agente preguntó por el rack (3 opciones) y eligió barra y discos; en otra eligió los tres productos sin preguntar. En ambos casos lo informó con precios, y la oferta exacta los muestra antes de confirmar. La instrucción v7 obliga a preguntar por **variantes**, no entre productos distintos. |
| Impacto | El cliente recibe una oferta con productos que no eligió; puede corregirla antes de confirmar. |
| Prioridad | P2 |
| Owner | Sales (instrucciones) |
| Resolución mínima | Instrucción: si varios productos activos responden a un pedido genérico, presentar las opciones y preguntar antes de agregarlos. Medir con el modelo real. |
| Dependencias | — |
| Test de aceptación | En N conversaciones con pedidos genéricos, el agente pregunta antes de seleccionar en ≥ el umbral que fije el owner. |
| Hito | Posterior a J3 |
