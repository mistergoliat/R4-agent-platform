---
title: R4 — Gates de release del canary F1 de cotizaciones por WhatsApp (Quote V2, sales-production@17)
status: R4_F1_WHATSAPP_QUOTE_RELEASE_GATES_READY_FOR_REVIEW
mandate: «R4 — F1 WHATSAPP QUOTE CANARY RELEASE GATES» (owner, 2026-11-09)
date: 2026-11-09
r4: main 8e75b5e + PR de este documento (F-ADV-2 y registro del candidato)
---

> **Estado vigente (2026-11-10).** El resumen inicial, §2 (auditoría de Quote) y §7 (bloqueos) describen el estado **previo** al despliegue del 2026-11-09 y quedan superados por la matriz de §1.1. En particular:
> - Quote V2 `a79d33f` está desplegado en producción, con la migración `000010` **aplicada**. Se ensayó (890 ms) y se verificaron el restore y el rollback (G4–G9).
> - El canary F1 se activó en la allowlist: `@17`, y después `@18` (R4 `2b3b5a2`).

# R4 — Gates de release del canary F1 de cotizaciones por WhatsApp

## 0. Estado

**`R4_F1_WHATSAPP_QUOTE_RELEASE_GATES_READY_FOR_REVIEW`.**

- **Lo que R4 podía preparar está preparado:**
  - `@17` quedó registrado como único candidato;
  - la corrección de F-ADV-2 está implementada y probada;
  - L3 está definido;
  - la matriz de gates está completa;
  - las solicitudes a Quote y Catalog están enviadas.
- **El canary no puede iniciarse.** Hay cinco bloqueos externos: R1.7 de Quote, el SHA de Quote y la migración `000010`, el principal de 60 minutos, P-1 de Catalog, y la autorización de despliegue por SHA. Ninguno está cerrado y este documento no presenta ninguno como cerrado.
- **Sin cambios en producción:** no se desplegó ni se activó nada. `@13` sigue operativo y sin cambios.

## 1. Candidato (A)

| Elemento | Valor |
|---|---|
| Perfil | **`sales-production@17`**, único candidato de Sales F1. Reemplaza a `@16` (F-ADV-1 en la evaluación adversarial) |
| Definición | v16 (`SALES_PRODUCTION_AGENT_VERSIONS['sales-production@17'] = 16`) |
| Catalog | Catalog V2 + Discover. `catalog.get_product_context@2`: vendibilidad por variante para 1 unidad, nunca cantidades |
| Shipping | pc-carrier |
| Quote | Quote V2: `quote.preview@3` y `quote.create@5` (oferta determinista de Sales y confirmación explícita registrada por la plataforma) |
| Presupuesto de escrituras | `R4_EXEC_MAX_WRITE_ACTIONS=6` (F-WA-2) |
| Límites F1 (`SALES_F1_CANARY_LIMITS`, vigentes y sin cambios) | ≤ 250.000 CLP brutos; 3 líneas; 5 unidades por línea y 5 en total; 1 cotización por conversación; 2 por hora; ventana de confirmación de 900 s |
| Otros controles | Guard P-1, kill switch, idempotencia, autorización de `quote.create` |
| Topología | Perfil de carril ADR-045 (allowlist explícita y su propio worker). **`@13` no cambia** y sigue siendo el carril operativo |
| Estado | **Inactivo.** No está registrado en producción ni en el gateway |

El registro en código está en `profile-v17.ts` (`SALES_PRODUCTION_PROFILE_V17_GATE`, todos sus ítems bloqueantes). `profile-v16.ts` queda marcado como reemplazado.

### Candidato de release por SHA

| Repositorio | SHA | Estado |
|---|---|---|
| R4 | `8e75b5e` + el merge de este PR | **Se define al mergear el PR**, que trae F-ADV-2, un gate de `@17`. Pendiente de revisión |
| Quote V2 | **`a79d33f`, desplegado** el 2026-11-09 con `000010` aplicada (G4, G5). *Antes del despliegue: no designado; opciones `a79d33f`, `ca66a2e` o `d419640`* | Owner de Quote (§2) |
| Catalog V2 | Desplegado `8a72c38` (`RELEASE.json`); `origin/main` `5f2c086` | Lo confirma el owner de Catalog junto con P-1 (§4) |

## 1.1 Matriz de gates (actualizada 2026-11-09, mandato «F1 commercial eligibility and release preparation»)

**Inicio** = indispensable para iniciar el canary. **Release** = necesario para declarar terminado el release completo. **Hecho** = verificado con evidencia.

| # | Gate | Responsable | Para | Estado |
|---|---|---|---|---|
| G1 | Candidato `@17` registrado | R4 | Inicio | **Hecho** |
| G2 | F-ADV-2: aviso ante una consulta o derivación del agente | R4 | Inicio | **Hecho** (PR #59, `05139bb`) |
| G22 | Una sola emisión de Quote en vuelo entre todos los workers | R4 | Inicio | **Hecho** (PR #60, `cc8dde7`) |
| G23 | Política comercial F1 aplicada en `quote.preview` y `quote.create` (`@17`) | R4 | Inicio | **Simplificada** (PR #61): Catalog V2 es la autoridad; se exigen procedencia, validez acotada, precio y stock; sin promociones ni despacho |
| G3 | SHA final de R4 | Owner | Inicio | **Hecho**: `a704319`, desplegado en producción (etapa 1, 2026-11-09) con Core `0014` y Sales `0010`; el carril siguió en `@13` |
| G4 | SHA de Quote | Owner de Quote | Inicio | **Hecho**: `a79d33f`, desplegado en EC2 |
| G5 | Migración `000010` | Owner de Quote / ops | Inicio | **Hecho**: aplicada (aditiva, 890 ms ensayada) |
| G6 | Restore verificado | Ops | Inicio | **Hecho**: base, documentos y configuración, en un entorno aislado |
| G7 | Simulacro de rollback (F21) | Ops | Inicio | **Hecho**: unos 40 s; requiere revertir también `principals.json` |
| G8 | Espacio en el host | Ops | Inicio | **Hecho**: 6,2 GB libres; sin swap (recomendado agregarlo) |
| G9 | Procedimiento de actualización | Ops | Inicio | **Hecho**: ejecutado en el lugar, con respaldos en `~/backups/quote-v2-integration/` |
| G10 | A10 conjunto (R4 + Quote) | R4 + Quote | Inicio | **Hecho** en el ensayo (91.395 / 17.365 / 108.760) y en el runtime de R4; en producción se verifica con la primera emisión autorizada |
| G11 | Principal de 60 minutos | Owner de Quote | Inicio | Provisionado (`r4-sales-retail-session`); conectividad de solo lectura validada; **autorizado** por el owner de Quote (Quote #33): solo allowlist, sin despacho, sin promociones, sin carrito ni Checkout, 60 minutos, límites F1, una emisión a la vez |
| G24 | Política comercial `F1-COMMERCIAL-POLICY-v1` | Owner | Inicio | **Definida por el owner** (mandato «F1 simplified commercial canary»); las promociones esperan autorización del owner comercial y del owner de Quote |
| G25 | Clasificación de precio (Catalog #57) | Owner de Catalog | — | **Fuera de F1** (decisión del owner); solo sería necesaria para habilitar promociones |
| G13 | P-1: archivo estático por SKU | Owner de Catalog | — | **Fuera de F1** (decisión del owner: Catalog V2 es la autoridad comercial) |
| G12 | Autorización de escrituras de Quote en producción (etapas 2–4) | Owner | Inicio | **Autorizada** (mandato «F1 canary activation without CloudWatch»): etapa 2 y **una única** emisión controlada desde WhatsApp |
| G14 | L3 sobre los SHAs fijos | R4 + owners | Inicio | **Hecho**: conversacional (13 escenarios, 8 emisiones reales) y técnico sobre `a704319` (20 suites de mutación, 279/279 mutantes detectados; recuperación 19/19) |
| G15 | Observabilidad del carril | R4 / ops | Inicio | **F1:** PM2 y logs disponibles, readiness de R4 y de Quote, monitoreo manual durante la primera emisión, kill switch operativo, rollback documentado y conciliación de cada operación contra Quote. **`CLOUDWATCH = DEFERRED_FOR_GENERAL_ROLLOUT`** (decisión del owner): CloudWatch/SNS (`ops/r4-f1-alerts/`) es requisito del rollout comercial general, no del canary; no se instala el agente, roles IAM ni SNS, y su ausencia no es un fallo del canary |
| G16 | Autorización de activación por SHA (allowlist; `@13` como rollback) | Owner | Inicio | **Autorizada** (`a704319` / Quote `a79d33f` / Catalog `8a72c38`): carril de la allowlist a `@17`; la allowlist y el rollout general no cambian |
| G17–G21 | Etapas de Quote, ensayo con datos reales, 7 días, W10 y aceptación §Z | Owner de Quote | Release | Pendientes |

## 2. Estado de Quote R1.7 (B)

Auditoría de `origin/main` de Quote, solo lectura. No hay documentos de R1.7 posteriores al 2026-10-08. El veredicto vigente es **`R1.7_READY_TO_START=NO`, `PRODUCTION_OWNER_READY=NO`** (`docs/reviews/R1.7_PRODUCTION_READINESS_PRE_FLIGHT.md` §AF).

| # | Punto | Estado | Evidencia |
|---|---|---|---|
| 1 | SHA candidato definitivo | **Superado (2026-11-09): `a79d33f` designado y desplegado.** *Auditoría previa:* no designado. `main` = `a79d33f`, 36 commits adelante del desplegado `6735352`. En `000009` y con A10: `ca66a2e` (+22) y `d419640` (+29) | §S del pre-flight exige un SHA aprobado y fijo |
| 2 | Migración `000010` | **Superado: aplicada en producción el 2026-11-09** (aditiva, 890 ms en el ensayo; restore y rollback verificados). *Auditoría previa:* no aplicada en ningún entorno. `a79d33f` la exige (`readiness-gate` responde `schema_not_ready` sin ella, aun con el carrito apagado). Es reversible en código, pero el pre-flight prohíbe `down` en producción | El plan de despliegue está abierto (owner) |
| 3 | Restore verificado | **No** (G2-D02 abierto; F14) | |
| 4 | Preparación del host | Reinicio: **no** (G2-D03 abierto; solo un workaround manual). Inventario B-S2: solo hay plan, no informe | |
| 5 | Espacio | **No cumple.** 1.064 MB libres frente a un pico de carga de 1.213 MB y un requisito de ≥ 3.000 MB. Dato del 2026-10-08, sin medición posterior | |
| 6 | Procedimiento de despliegue | Existe para `6735352` (pasos 1–9). **No existe procedimiento de actualización a un SHA nuevo** | Pre-flight §R: respaldo y restore → quiesce → migrar → arranque privado → etapas 2–4 con autorización |
| 7 | Compatibilidad A10 | **Sí** en los tres candidatos; no en `6735352`. El despliegue es conjunto. Chequeo posterior: una cotización multilínea vía R4 con totales 91.395 / 17.365 / 108.760 | `docs/cart/HANDOFF_R4_A10_ARITHMETIC.md` |
| 8 | Condiciones del canary | Etapas: 0 salud privada, 1 lecturas, 2 borrador sintético, 3 emisión controlada, 4 PDF, 5 correo W10, 6 integración con R4. Las etapas 2–4 requieren autorización explícita | Pre-flight §T |
| 9 | Observación posterior | 7 días consecutivos sin reinicio no planificado ni emisiones atascadas; un reinicio no planificado reinicia la cuenta. Los umbrales los decide el owner (F22) | Pre-flight §X |

**Indispensable para iniciar** (según el texto de Quote):

- restore verificado;
- simulacro de rollback (F21, «STOP deploy until demonstrated»);
- SHA e imagen fijados;
- plan de `000010` o un SHA en `000009`;
- autorización de las etapas 2–4;
- despliegue conjunto A10 con su chequeo.

La holgura de disco es una inferencia de R4, a partir del gate de 3 GB del README.

**Para el release completo:** C, la etapa 6 y el canary escalonado en PASS, W10, el cutover de V1 más 7 días estables, y §Z firmado.

## 3. Principal de R4 con vigencia de 60 minutos (C)

- **Decisión del owner:** `r4-sales-integration`, con vigencia máxima de 60 minutos para F1. No se usa la de cinco días. R4 no implementa expiraciones propias, y no hay ninguna en R4: la vigencia que muestra Sales viene del resultado de la emisión.
- **Mecanismo en Quote:**
  - En el registro de principales, `commercialProfile: "retail-session"` → política **`cl-retail-session-60m-v1`**. Sin el campo se usa `standard` → `cl-retail-5-calendar-days-v1`.
  - Ningún request puede elegir la vigencia.
  - El límite es `floor((issuedAt + 60 min) / 1 s)`, así que puede quedar hasta 999 ms bajo los 60 minutos.
- **Disponibilidad:** el perfil existe en `ca66a2e`, `d419640` y `a79d33f`. **No existe en el desplegado `6735352`**: su registro rechaza el campo. Requiere el SHA nuevo (G4).
- **Autorización:** **no otorgada.**
  - `docs/cart/RETAIL_SESSION_TEST_PRINCIPAL.md` dice: «Production: Not authorized. The existing R4 production principal is not migrated».
  - El diseño de Quote prevé un id dedicado, `r4-sales-retail-session`. Mover `r4-sales-integration` a ese perfil es «a separate owner decision».
  - La condición O-1 de Quote (`HANDOFF_RETAIL_PROMOTION_ELIGIBILITY.md`: `RETAIL_PROMOTION_ELIGIBILITY_PENDING`) impide usar el perfil en ofertas cuyo vencimiento promocional no se puede establecer. Esto afecta a ítems con promoción del catálogo.
- **Solicitud al owner de Quote:** Quote #33.
  1. Configurar `r4-sales-integration` con `commercialProfile: "retail-session"` en producción, en el SHA designado. Si el owner prefiere el id dedicado, R4 cambia la credencial, no la lógica.
  2. Autorizar el cambio de registro en producción (pre-flight §AD.2).
  3. Resolver la condición O-1 de promociones, o declarar qué ítems quedan excluidos.

**Confirmación del principal de 60 minutos: PENDIENTE.**

## 4. Catalog P-1 (D)

| Pedido | Estado |
|---|---|
| Conjunto autorizado de SKU | **Sin evidencia.** Ni publicado ni aprobado (pedido 4 de #54) |
| Evidencia vigente de paridad | **Solo agregada:** 156/156 (105 unidades de muestra + 59 packs), corridas PROD-R1/R2 del 2026-11-05. Los informes están en una rama local de Catalog **sin publicar**, y la salida por SKU (`review-packages/.../parity/`) no está disponible |
| Procedencia verificable | **Pendiente.** Las herramientas de paridad de producción no están en `origin`; no hay id de corrida ni hash de la salida |
| Frescura | **Sin evidencia.** No hay ventana, cadencia ni reglas de invalidación (pedido 5 de #54) |
| Restricciones para el canary | **Sin evidencia.** Solo hay anomalías conocidas que conviene excluir (una variante con desajuste de stock en DEVELOP; variantes con `available_for_order=0`) |
| Issue #54 | **Abierto, sin comentarios** desde el 2026-11-05 |

**Compatibilidad con el guard P-1 existente.** El guard consume `{ schemaVersion: 1, items[1..200] }` por SKU, con estos campos: `itemKey`, `productRef`, `variantRef`, `sku`, `finalGross`, `availableQuantity`, `verifiedAt` y `source`. La edad máxima es `R4_QUOTE_PARITY_MAX_AGE_SECONDS` (≤ 7 días).

- Todos los campos salen de los datos que ya produce la corrida de paridad de Catalog. Alcanza con una **conversión de formato** de la salida por SKU, filtrada al conjunto aprobado. No hace falta cambiar el guard.
- **Sales no define ninguna lista comercial propia.**
- El archivo lo produce el owner de Catalog desde una corrida nueva con id de corrida, con el conjunto coaprobado por el owner comercial.

**Evidencia P-1: PENDIENTE.** La solicitud se agregó a Catalog #54 (2026-11-09).

## 5. F-ADV-2: aviso ante una consulta o derivación del agente (E)

**Auditoría:**

- **Qué pasa hoy.** Cuando el agente abre una solicitud humana (`request_consultation` o `request_handoff`), la plataforma crea la solicitud y suspende la tarea. Al cliente no le llega nada: un `respond` cierra el turno, así que la solicitud nunca comparte la corrida con una respuesta.
- **Es el mismo defecto que F-E1-1.** La consulta del 2026-11-06 en `@13` es de la misma clase.
- **Qué cubre ADR-041 hoy.** El mecanismo de avisos existe y es determinista: un texto fijo del pack, uno por solicitud (`human_request_id` único, migraciones 0012/0014), despachado por el dueño de la entrega con su ciclo completo (reintentos y supersesión por operador). Solo cubre las derivaciones **de la plataforma** tras una falla de corrida.
- **Por qué el guard de cierre de turno (R7-2) no alcanza.** Solo se aplica a `WAIT_FOR_INPUT`.

**Corrección mínima (este PR).** Reutiliza ADR-041; no cambia el kernel, las instrucciones del modelo ni el esquema:

- `ProductionStore.materializeHumanRequestNotices({ text, profiles, limit })` crea un aviso de plataforma por cada solicitud **abierta por el agente** que siga pendiente:
  - consultas;
  - derivaciones con `initiatedBy=agent`;
  - solo en conversaciones de los perfiles indicados.
- Comparte el insert del fallback ADR-041, con una clave de idempotencia propia (`r4-human-notice:`).
- `OutboundDeliveryRuntime` recibe la opción `humanRequestNotice`, y el gateway y el canary la conectan.
- En Sales, `SALES_HUMAN_REQUEST_NOTICE_TEXT` es un texto fijo que no afirma ningún efecto comercial: «Gracias por tu mensaje. Tu consulta quedó pendiente de revisión por una persona del equipo de PesasChile. La respuesta llegará por este mismo chat; no hace falta que repitas lo que escribiste.»
- El alcance es **solo `@17`** (`SALES_HUMAN_REQUEST_NOTICE_PROFILES`). `@13` y los demás perfiles conservan su comportamiento. Extenderlo a `@13` es una decisión del owner (una línea).
- **Se conserva:** la solicitud humana sigue abierta y la resolución comercial sigue en manos de la persona. Las retenciones de plataforma (autonomía apagada, ventanas de protección) siguen sin aviso, como están diseñadas.

**Pruebas:** `tests/integration/human-request-notice.test.ts`, 7 pruebas con la composición real de producción sobre PostgreSQL:

- derivación y consulta: un aviso entregado, idempotente, con la solicitud abierta;
- un perfil fuera del alcance no recibe aviso;
- una respuesta en un turno anterior no silencia una solicitud posterior;
- una retención de plataforma no crea aviso;
- una falla de corrida conserva su propio fallback.

**Mutaciones:**

- quitar el alcance por perfil: detectada;
- quitar las consultas: detectada;
- avisar cualquier derivación: detectada.

**Resultados:** ADR-041 sigue en 14/14; contract 520; unit 1715; integración completa 753; tsc y lint limpios.

## 6. L3 (F)

**Preparado. No se ejecuta** mientras los SHAs varíen (G3, G4, Catalog).

**Precondiciones:**

- G3, G4, G5, G11 y G13 cumplidos;
- Quote desplegado en el SHA designado;
- el archivo P-1 real;
- presupuesto de escrituras 6;
- los límites F1;
- una allowlist cerrada (owner y testers).

**Partes:**

1. **L3 técnico de R4** (`R4_TEST_STRATEGY_02`): las 18 suites de mutación sobre el SHA exacto de R4 que se despliega. No aplica el gate financiero (sin Checkout ni pagos).
2. **L3 con los servicios reales** sobre los SHAs fijos: Quote en el SHA designado con el principal de 60 minutos, Catalog en su SHA con P-1 real, Shipping real y DeepSeek. Con `@17` en el carril.

**Matriz de escenarios:**

- La base es la campaña de `R4_FWA_ADVERSARIAL_V16_V17_EVALUATION.md`, que **no** es L3.
- Se repite cada escenario **dos veces**. El criterio crítico es el de esa evaluación: 0 afirmaciones incorrectas de cantidad o de variante, y 0 cotizaciones sobre el stock confirmado.

| Área | Escenarios |
|---|---|
| Disponibilidad por variante | Variante agotada; sin variante indicada; cambio de variante tras la oferta; variante desconocida o ilegible (si Catalog lo presenta en vivo; si no, con falla sintética etiquetada) |
| Cantidades | Stock suficiente; parcial (una línea y varias líneas); insistir en más unidades; cambio de cantidad tras el preview |
| Cambios de producto | Reemplazo de ítem; refinamientos hasta el presupuesto de 6 |
| Reintentos | Catalog degradado (sintético); `rate_limited` del proveedor; reintento de entrega del aviso |
| Recuperación | Interrupción del worker después de la escritura y durante ella: 1 recibo y 1 cotización |
| Consultas al administrador | Una consulta y una derivación del agente: **aviso F-ADV-2 entregado una vez**, solicitud abierta, respuesta del operador entregada |
| Emisión sin confirmación | «Emíteme ya»; confirmación ambigua; confirmación después de un cambio |
| Evidencia comercial | La línea emitida coincide con P-1 (SKU, precio, cantidad); la vigencia emitida es de 60 minutos; chequeo A10 multilínea |
| Duplicaciones | Mensajes repetidos; replay de `quote.create`: 1 cotización |
| Límites | 250.000 CLP; 3 líneas; 5 unidades; 1 por conversación; 2 por hora; ventana de 900 s; SKU fuera de P-1 bloqueado |

**Evidencia por escenario:**

- lo que entregó Catalog;
- las capacidades invocadas;
- la primera afirmación comercial;
- el preview;
- la confirmación;
- la emisión;
- el resultado;
- los errores.

**Resultado:** `L3_PASS` solo si no hay ningún `NOT_RUN` en un punto obligatorio.

## 7. Bloqueos restantes (al 2026-11-09, antes del despliegue; superados, ver la nota inicial y §1.1)

1. **Quote R1.7** (G4–G10, G12): falta designar un SHA, decidir `000010`, verificar el restore, hacer el simulacro de rollback, liberar disco y escribir el procedimiento de actualización. Responsable: owner de Quote / ops.
2. **Principal de 60 minutos** (G11): no está autorizado en producción. Además depende del SHA nuevo y de la condición O-1 de promociones. Responsable: owner de Quote.
3. **P-1** (G13): no hay archivo por SKU, conjunto autorizado, procedencia ni reglas de frescura. Responsables: owner de Catalog y owner comercial.
4. **Revisión y merge de F-ADV-2** (G2, G3), y alertas (G15). Responsables: owner y R4.
5. **L3** (G14) y **autorización por SHA** (G16): después de lo anterior.

**El 9/9 y la evaluación adversarial no declaran listo el canary productivo.**
