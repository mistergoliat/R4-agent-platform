---
title: R4-J5 — Implementación del canary F1 (v12, @12, límites J3E, DS-1 ampliado)
status: R4_J5_F1_CANARY_IMPLEMENTATION_READY_FOR_REVIEW — nada registrado, activado ni desplegado
mandate: «R4 — J5 F1/F2 Owner Decisions» (owner, 2026-11-05, segundo), estado R4_J5_F1_F2_NEXT_INCREMENT_AUTHORIZED
date: 2026-11-05
base: main 0ec826f
---

# R4-J5 — Implementación del canary F1

## 0. Entregables

| # | Entregable | Resultado |
|---|---|---|
| 1 | Merges | #43 → `64bf81d`; #42 → `5fc9d74`; #44 → `0ec826f` |
| 2 | Composición v12 | `agents/sales/sales.v12.agent.json`, derivada de v7 (§2) |
| 3 | Perfil `@12` | Preparado, sólo para el canary, **no registrado ni activado** (§3) |
| 4 | Límites J3E | Implementados como techo del canary, exigidos en código (§4) |
| 5 | DS-1 ampliado | Prevención (v12), detector extendido y rúbrica semántica (§5) |
| 6 | Evaluación semántica | Ronda 2: 60 llamadas, US$0,25 (§6) |
| 7 | Dependencias Catalog/Quote | §7 |
| 8 | Matriz de gates F1 | §8 |

**Lo que no se hizo:**

- sin despliegues ni cambios en EC2;
- sin cotizaciones reales, carrito ni Checkout;
- `@3` y su presupuesto de escrituras sin cambios;
- sin cambios en el kernel;
- sin cutover de Catalog;
- ninguna llamada fuera del presupuesto autorizado.

## 1. Merges y condiciones del #42

**Verificaciones antes de cada merge:**

- el HEAD y la base;
- que no hubiera commits nuevos sin revisar;
- una fusión de prueba con el `main` vigente;
- las pruebas del alcance;
- GitGuardian y un escaneo propio.

**Orden: #43 → #42 → #44.** Después de #43, el #42 se volvió a verificar sobre el nuevo `main`: unit 419, contrato
106 e integración 109.

| Condición del owner para #42 | Antes | Acción | Verificación |
|---|---|---|---|
| La guarda se ejecuta antes de cualquier emisión | Cumplida | — | P5: la nueva comprobación en la emisión detiene la oferta confirmada con 0 llamadas al owner |
| El perfil F1 no habilita `quote.create` sin la guarda | **No cumplida** (guarda opcional) | `QUOTE_PARITY_REQUIRED_PROFILES` y `assertQuoteParityConfigured`: la composición rechaza sin guarda | Unit + contrato de `@12` (§3); la mutación detectada |
| La evidencia no se sustituye en silencio | **Parcial** | Huella SHA-256 de la evidencia canónica, registrada al componer | Unit: la misma evidencia da la misma huella; un cambio, otra |
| Los errores de lectura o validación bloquean | Cumplida | — | La evidencia inválida o ilegible impide componer; la falla de lectura de Catalog impide emitir |
| No se introduce una autoridad comercial alternativa | Cumplida | — | La guarda sólo agrega bloqueadores; Quote sigue siendo la autoridad |
| No se modifica el kernel | Cumplida | — | Diff limitado a Sales y adaptadores |

**Límite reconocido:** la huella vuelve auditable un reemplazo, pero no autentica a quien produjo la evidencia. Una
firma del owner de Catalog requeriría su propio diseño.

## 2. Composición v12 (decisión B)

- **Derivación:** v7 con exactamente tres cambios, verificados por pruebas:
  1. la regla «a proposal is not an effect» se reemplaza por la prevención DS-1 ampliada;
  2. se agrega una regla contra ofrecer operaciones o condiciones comerciales no confirmadas;
  3. se agrega la cláusula de promoción de Shipping, idéntica byte a byte a la evaluada (`e9ba6726`).
- **Se quita** la línea `customer.get_context` (que en `@7` producía `unknown_capability`) y el scope
  `customer.read`.
- **Incluye** Catalog, Shipping, Quote, la aclaración de la promoción y DS-1.
- **Excluye** Customer Profile, CIA, Checkout, carrito y el bloque G-sem.
- **Excepción registrada:** `sales-instruction-versioning` tiene una sección D que exige que v12:
  - no contenga ninguna línea propia de v8;
  - conserve la promoción;
  - no adopte el bloque G-sem.

  La secuencia aprobada (promoción desde v10, G-sem sin adjudicar) se sigue cumpliendo.
- **Identificadores:**
  - **Repositorio:** v12 y `@12` estaban libres. La v9 y `@9` siguen sin uso.
  - **Registro productivo (D5): pendiente.** Requiere autorización de lectura en EC2.
- **Registro de la definición: v12 es una candidata, no una definición declarada.**
  - **Lo que mostró la primera L2:** como `sales.v12.agent.json`, cualquier bootstrap, plataforma o arnés la
    registraba, y el registro la servía como «latest». Los escenarios y el shadow sin versión fijada corrían v12: 24
    fallas.
  - **Dónde vive ahora:** en `agents/sales/candidates/sales.v12.candidate.json`, declarada en
    `SALES_CANDIDATE_DEFINITION_FILES`. No termina en `.agent.json`, así que nadie la registra por recorrido de
    directorio.
  - **Quién la registra:** sólo `initCanary`, cuando el perfil está fijado a ella (`@12`) y únicamente en su base
    aislada. Lo comprobó un dry-run de punta a punta.
  - **Prueba de contrato:** el loader de la plataforma no encuentra `sales@12`, y «latest» sigue en 8.
  - **Ronda 2:** se ejecutó con la disposición anterior y con contenido idéntico (mismo hash).

## 3. Perfil `@12` preparado, no activado

- **Composición:** dominios y capacidades de `@7`, política autónoma (ADR-043) y la definición v12 fijada.
- **Sólo canary:**
  - Está en `SALES_CANARY_ONLY_PROFILES` y en `CANARY_PROFILES`, **no** en `SALES_PRODUCTION_PROFILES`.
  - Un worker productivo con `R4_PROD_POLICY_PROFILE=sales-production@12` recibe un rechazo.
  - La composición lo admite sólo con `canary: true`, que pasa únicamente el runtime del canary.
- **Gate en código (cierra GAP-13 para F1):**
  - sin guarda P-1 no hay composición;
  - los límites no pueden ser más laxos que los del §4;
  - el worker rechaza `maxWriteActions` fuera de 1..6, antes de tocar la base;
  - el runtime del canary carga `R4_QUOTE_PARITY_*` y rechaza una evidencia inválida.
- **Gate documentado:** `SALES_PRODUCTION_PROFILE_V12_GATE` (§8).
- **Pruebas:**
  - contrato de `@12`: 10 pruebas;
  - el contrato completo pasa (477);
  - las listas fijadas se actualizaron (perfiles del canary, archivos de definición, versiones fijadas). La lista de
    perfiles productivos no cambia.

## 4. Límites J3E para el canary (decisión C)

`SALES_F1_CANARY_LIMITS` y `SALES_F1_CANARY_MAX_WRITE_ACTIONS` son **techos del primer canary**, no valores por
defecto. La configuración puede ser más estricta, nunca más laxa. Ningún valor productivo cambia.

| Límite | Variable → clave | Valor | Dónde se exige | Semántica verificada | Autoridad |
|---|---|---|---|---|---|
| Monto | `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP` → `maxGrossClp` | 250 000 | Composición `@12` (techo) + vista previa (`autonomy_limit_amount`) | Total bruto con despacho de la cotización | Owner comercial |
| Líneas | `…_MAX_LINES` → `maxLines` | 3 | Ídem (`autonomy_limit_lines`) | Líneas de la cotización | Owner comercial |
| Unidades por línea | `…_MAX_UNITS_PER_LINE` → `maxUnitsPerLine` | 5 | Ídem (`autonomy_limit_quantity`) | Por línea, no total (J3E §15.1 corregido) | Owner comercial |
| Unidades totales | `…_MAX_TOTAL_UNITS` → `maxTotalUnits` | 5 | Ídem (`autonomy_limit_total_units`) | Total de la cotización: el valor J3E «5 totales», ahora exigible | Owner comercial |
| Por conversación | `…_MAX_PER_CONVERSATION` → `maxQuotesPerConversation` | 1 | Composición + emisión (`autonomy_limit_conversation`) | Cotizaciones autorizadas en la conversación | Owner comercial |
| Por hora | `…_MAX_PER_HOUR` → `maxQuotesPerHour` | 2 | Composición + emisión (`autonomy_limit_rate`) | Por hora, en la base del despliegue | Owner comercial |
| Ventana de confirmación | `…_CONFIRMATION_WINDOW_SECONDS` → `confirmationWindowSeconds` | 900 | Composición + emisión (`customer_confirmation_expired`) | Entre la oferta y la confirmación | Owner comercial |
| Techo de escrituras | `R4_EXEC_MAX_WRITE_ACTIONS` (worker) | 6 | Runtime del canary `@12` (1..6) | Ejecuciones autorizadas por task (D7-5) | Owner R4 |

- **Autoridad de los campos:** cada uno tiene una autoridad que lo aprueba. No hay campos sin autoridad: todos los
  campos de `AutonomousQuoteLimitsV6` están en la tabla y la prueba itera sobre todos.
- **Vigencia de 60 min:** **no es un campo de R4.** La define el perfil del principal en Quote, y queda condicionada
  al gate de Quote (§7).

## 5. DS-1 ampliado (decisión D): tres capas separadas

| Capa | Dónde | Qué cubre |
|---|---|---|
| **Prevención** | Instrucciones de v12 | 1) afirmaciones explícitas; 2) confirmaciones implícitas («done», «listo», «ok, two units»); 3) ofertas de operaciones no disponibles; 4) condiciones comerciales no verificadas (retiro en tienda, fechas, descuentos, condiciones de pago) |
| **Detección determinista** | `operation_claim_without_receipt` | Afirmaciones explícitas. Se amplió con «quedó / ya está / dejé (…) en tu selección», «tu selección quedó con…» y «quedan N unidades de…», que en la ronda 2 se escapaban. Se excluyen las frases de stock («quedan 3 unidades disponibles»). 2 mutaciones detectadas |
| **Detección semántica** | Rúbrica `sales.rubric.ds1_commitments@1` (sólo con juez), códigos `implicit_change_confirmation`, `unavailable_operation_offered` y `unverified_commercial_commitment` | Lo que un patrón no ve. Sin juez es inconclusa. No se ejecutó (requeriría llamadas fuera del presupuesto) |

Nada de esto vive en el kernel. Es configuración de Sales.

## 6. Evaluación semántica (ronda 2)

**Diseño.**

- Arnés `round2.mjs` (commit `c647d18`).
- Brazos, ambos con el techo F1 (6), los límites J3E y una base local desechable con todos los owners como fixtures:
  - A: `@7` + v7;
  - B: `@12` + v12, la definición real, sin inyección.
- Casos D1–D8 (D7 = retiro en tienda, D8 = descuento) y el control C1, con 2 réplicas recorridas réplica por réplica.
- **Tope:** 60 llamadas / US$1. **Se alcanzó en 60 llamadas, US$0,25:**
  - la réplica 1 está completa;
  - la réplica 2 cubrió D1–D4;
  - 3 muestras de D3 quedaron inválidas por el tope de 3 llamadas por muestra del arnés (no por el modelo).
- 23 muestras válidas.
- Etiquetas humanas asignadas por Claude: los 2 casos ambiguos quedan para la adjudicación del owner.
- Evidencia: `docs/architecture/evidence/j5-ds1-round2/`.

### 6.1 Comportamiento del modelo

| Brazo | Muestras | Afirmaciones sin recibo | Afirmaciones respaldadas | Ofertas de operaciones inexistentes | Compromisos comerciales incorrectos | Ambiguas | Handoffs |
|---|---|---|---|---|---|---|---|
| A (`@7`/v7) | 11 | 0 | 6 | 0 | **2** (D2#1, D6#1: «¿la retiras en tienda?») | 1 | 0 |
| B (`@12`/v12) | 12 | 0 | 8 | 0 | **0** | 1 | 0 |

**Lectura:**

- **Con el techo F1, el modelo hace el cambio pedido:** anota, modifica y deja en la selección. Por eso sus
  afirmaciones quedan respaldadas en los dos brazos. El riesgo de DS-1 en F1 no está ahí.
- **El riesgo de F1 son las condiciones comerciales no verificadas.** v7 ofrece el retiro en tienda en 2 de 11
  muestras; v12, en 0 de 12. En D7 (retiro), v7 consultó a una persona (`request_consultation`) y v12 lo declinó con
  claridad. En D8 (descuento), ambos lo rechazan.
- **Lo que mide la ronda 1:** con el techo en 0, como en `@3` productivo, el texto DS-1 elimina los 3 bloqueos
  `run_budget_exhausted` de 6, pero queda una confirmación implícita («Listo, dos unidades»).
- **Conclusión:** v12 se comporta mejor que v7 en las dos condiciones. **No se aprueba DS-1 sólo por la ausencia de
  handoffs:** en la ronda 2 no hubo handoffs en ningún brazo, y la diferencia está en los compromisos comerciales.

### 6.2 Detector

| Ronda | TP | FP | FN | TN | Afirmaciones respaldadas reconocidas |
|---|---|---|---|---|---|
| 1 (re-puntuada con el detector ampliado) | 0 | 0 | 1 (D4#B, implícita sin verbo) | 13 | 2/2 |
| 2 (detector ampliado) | 0 | 0 | 0 | 23 | **14/14** (antes 7/14) |

- **Sin verdaderos positivos en campaña:** no hubo afirmaciones reales sin recibo en ninguna ronda (el modelo se
  comportó). La capacidad de detectarlas está cubierta por las pruebas deterministas: 38 casos y mutaciones.
- **Una confirmación implícita sin verbo de estado** queda para la rúbrica semántica.

### 6.3 Limitaciones y recomendación

- **Limitaciones:**
  - La muestra es chica: 1 o 2 réplicas.
  - D5–D8 tienen 1 réplica y D3 tiene sólo 1 muestra válida.
  - No se ejecutó la rúbrica con juez.
- **Recomendación:** v12 es apta como definición **candidata** del canary F1, con estas condiciones:
  1. el owner adjudica las 2 muestras ambiguas («retirar sin envío»);
  2. se repite D3–D8 con un tope de 4 llamadas por muestra;
  3. la rúbrica semántica se ejecuta con juez dentro de la campaña L3 previa al canary.

  Las tres condiciones requieren presupuesto.

## 7. Dependencias Catalog y Quote

Leído sin modificar nada (API de GitHub y documentos), 2026-11-05.

**Catalog.**

- **Estado de la migración:** `main` avanzó a `5f2c086` (PR #52 y #53: modo productivo directo con cuenta de solo
  lectura y mapa de confianza).
- **Contrato y fixtures:** sin cambios. Los fixtures de R4 fijados en `d9c63cc` siguen vigentes.

**Quote.**

- **`main` `a79d33f`:** sin cambios. Incluye A10, con el carrito deshabilitado por defecto.
- **PR #23 (diseño de vigencia de precios promocionales):** abierto.
- **A10:** fusionado en Quote y en R4 (#32). Sin desplegar.

**Solicitudes a los responsables (decisión F).** Este mandato no las envía ni modifica sus repositorios; quedan
listas para el owner.

| Destinatario | Solicitud |
|---|---|
| Catalog | 1) Estado de la migración V2 y fecha estimada de `PRODUCTION_CUTOVER_GO`. 2) Fuente efectiva de precio y stock que hoy sirve cada binding (V1 y V2). 3) Evidencia de paridad contra PrestaShop vivo de los SKUs candidatos: precio, stock e identidad, con fecha. 4) Conjunto inicial de SKUs autorizables para F1, según los criterios del plan §5.2. 5) Procedimiento de actualización y vencimiento de la evidencia, y el formato del archivo (`schemaVersion 1` de la guarda P-1) |
| Quote | 1) Estado de R1.7: respaldo y restauración, reinicio, disco, 7 días. 2) SHA candidato para F1. 3) Compatibilidad A10 con R4 `main` (R4 #32 ya integrado). 4) Vigencia de 60 min: compatibilidad y autorización del principal R4 fuera de sintético. 5) Garantía de que el carrito sigue deshabilitado en el SHA candidato. 6) Gates del despliegue coordinado con R4 y la verificación A10 posterior |

## 8. Matriz de gates pendientes para F1

| Gate | Estado | Responsable | Bloquea |
|---|---|---|---|
| Evidencia de paridad de los SKUs (P-1) | Falta | Owner Catalog | Canary |
| Conjunto de SKUs autorizables | Falta | Owner Catalog + owner comercial | Canary |
| Quote R1.7 | No cumplido | Owner Quote | Canary |
| SHA de Quote y despliegue A10 en lockstep + verificación | Pendiente | Owner Quote + owner R4 | Canary |
| Vigencia de 60 min para el principal R4 | Pendiente | Owner Quote | Canary |
| D5: identificadores v12/`@12` libres en el registro productivo | Pendiente (requiere lectura en EC2) | Owner R4 | Registro de v12 |
| Integración de v12 y `@12` a `main` | Rama de desarrollo, en revisión | Owner R4 | Registro |
| Adjudicación de las 2 muestras ambiguas y repetición de D3–D8 | Pendiente (presupuesto) | Owner | Aceptación de DS-1 |
| Rúbrica DS-1 con juez en la campaña L3 | Pendiente (presupuesto) | Owner R4 | Aceptación de DS-1 |
| GAP-11: alertas de `unknown`, `needs_reconciliation` y `run_budget_exhausted` | Por diseñar | Owner R4 + infraestructura | Canary |
| ADR-036 o la topología de un solo productor de entrada | Pendiente | Owner R4 | Canary |
| ADR-037: decisiones 1–4 | Pendiente | Owner R4 | J7 (y recomendable antes del canary) |
| Kill switch de punta a punta en el host | Pendiente | Owner R4 | Canary |
| GAP-14 redefinido (sin PDF): prueba de aceptación | Por escribir | Owner R4 + owner Quote | G1 |
| L2 | Ver §9 | Owner R4 | Integración |
| L3 sobre los SHA exactos de R4 y Quote | No ejecutado | Owner R4 | Canary |
| Observación de R7-4 (auditoría de solo lectura) | Ventana vigente; desde 2026-11-06 01:53 UTC | Owner R4 | — |
| Autorización de despliegue por SHA | No otorgada | Owner | Canary |

## 9. Validación

- **Durante el desarrollo:** pruebas focalizadas y mutaciones del alcance:
  - guarda P-1: 5 + 1;
  - F2-1: 5;
  - detector DS-1: 3 + 2.
- **L2:** se ejecutó la cadena completa en una copia de trabajo con instalación y build propios (§9.1).
- **Hallazgo de entorno:** los 23 errores de typecheck que se registraban como preexistentes en `sales-canary-j4` y
  `sales-profile-v8` son un artefacto de esta máquina, no de `main`:
  - `tsconfig.json` no mapea `@r4-sales/agent/canary`;
  - esa entrada resuelve el build de otra copia de trabajo a través de junctions.

  En una copia con su propio `npm ci` y build, **el typecheck y el lint completos no dan ningún error.**

### 9.1 Resultado L2

Se ejecutó en una copia de trabajo con `npm ci` y build propios, para que `@r4*` resuelva a ese mismo código.

| Etapa | Primera L2 (v12 como `*.agent.json`) | L2 final (`f4d52c5`, v12 candidata) |
|---|---|---|
| Typecheck | 0 errores | 0 errores |
| Lint | 0 | 0 |
| Unit | 1 falla | **1603 / 1603** (4 skip) |
| Contrato | 479 | **480 / 480** |
| Integración | 8 fallas | 705 / 706. La falla era la expectativa del mensaje de perfiles del canary (ahora incluye `@12`); corregida en `e1cbcc5`: 15/15 |
| Sales | 9 fallas | **29 / 29** |
| Shadow | 4 fallas | **5 / 5** |
| Recovery | 2 fallas | 18 / 19. La falla era la expectativa de que el bootstrap productivo registrara también la versión fijada por `@12`; ahora excluye candidatas, conforme a la decisión B. Corregida en `e1cbcc5`: 1/1 |

Después de `e1cbcc5` sólo se volvieron a ejecutar los dos archivos afectados: el cambio toca expectativas de prueba, no
código de ejecución.

**Pruebas `NOT_RUN`** (`R4_TEST_STRATEGY_02`):

- las suites de mutación del repositorio (`tests/mutation/*`), entre ellas `evaluation`, `production` y `profile-v8`;
- en su lugar corrieron mutaciones manuales focalizadas sobre cada invariante nuevo (§9);
- las suites seleccionadas por el diff deben ejecutarse en L3.

Tampoco se ejecutaron:

- L3;
- la rúbrica DS-1 con juez.
