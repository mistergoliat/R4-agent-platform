# R4-J4-R1C — Registro de decisiones compartidas R4 ↔ Customer Profile (J4)

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Mandato | R4-CP-J4-F0F1-EXECUTION-01: fases F0 (decisiones) y F1 (procedencia) del roadmap coordinado |
| Referencia | Auditoría cruzada R4-CP-J4-ALIGNMENT-01 (`R4_CP_J4_CROSS_REPOSITORY_ALIGNMENT_REPORT.md`, fuera de ambos repositorios): §4–§7 y §12 |
| Contraparte | `MS-pesaschile-customer-profile`: `docs/reviews/CP_J4_R4_CONTRACT_ALIGNMENT.md` (DEC-01..DEC-08, AP-01..AP-11) |
| Estado | **Posiciones de R4 registradas.** Ninguna conformidad de Customer Profile, del owner de datos, de Catalog ni de la Customer Identity Authority está registrada |
| Alcance | Solo documentos. No congela el contrato v1-rc (F2), no inicia CP-CONTEXT-02C y no autoriza J4-R2 |

Documentos de R4 que aplican este registro: [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md), [especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md), [requisitos a Customer Profile](R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md) e [informe de diseño](R4-J4-R1_DESIGN_REPORT.md).

---

## 1. Qué registra y qué no

- **Columna R4:** decisión interna de R4, instruida por su owner en el mandato. Desde esta revisión, los cuatro documentos anteriores la aplican.
- **Demás columnas:** solo el **estado** de la aceptación. `PENDIENTE` significa que el owner no se pronunció. R4 no presume ninguna conformidad.
- **No es** la aprobación del contrato productor: `contractStatus` sigue en `candidate` y el contrato sigue siendo el candidato 02B (`f631f32`).
- ADR-039 sigue **Propuesto**. La confirmación de su aceptación interna (OD-13 de la auditoría) es un acto aparte, no incluido aquí.

**Leyenda:**

| Valor | Significado |
|---|---|
| `ACEPTADA` | Decisión interna de R4, registrada |
| `PENDIENTE` | Requiere un pronunciamiento explícito de ese owner. No está registrado |
| `DEPENDE` | Para cerrarse, requiere un artefacto o una decisión de ese owner |
| `CONSULTADO` | Se le informa; su conformidad no es condición |
| `—` | No participa |

## 2. Matriz

| ID | Tema | R4 | Conformidad CP | Owner de datos / negocio | Catalog | CIA | Condiciones abiertas |
|---|---|---|---|---|---|---|---|
| AP-01 | Una ruta factual con `purpose`; dos capacidades R4 | ACEPTADA | PENDIENTE | — | — | DEPENDE: los valores de `purpose` serán los propósitos del grant (D2) | Componentes exactos de cada propósito (F2) |
| AP-02 | `POST` de solo lectura; identificadores en el cuerpo; `no-store` | ACEPTADA | PENDIENTE | — | — | — | Códigos 400/405/413/415 (F2) |
| AP-03 | Minimización en tres fronteras; sin montos ni predictivos en J4 | ACEPTADA | PENDIENTE (incluye enmendar el PRD CP J4-03) | **PENDIENTE**: legitimidad de los propósitos | — | — | Aprobación de negocio de los propósitos |
| AP-04 | Scope dedicado `customer.sales_context.read` | ACEPTADA | PENDIENTE | — | — | — | — |
| AP-04-H | Hardening de `commercial-profile` (hoy bajo `customer.facts.read`) | Registrado como asunto propio; no es gate de J4 | PENDIENTE: decisión e inventario de impacto | — | — | — | Inventario de consumidores. Ningún permiso existente cambia antes |
| AP-05 | Ciclo de vida y `authorizationBasis` | ACEPTADA | PENDIENTE | — | — | DEPENDE (D2) | D2 abierta. Ninguna lectura real con `service_scope_only` |
| AP-06 | Error plano de CP; R4 mapea a `DomainError` | ACEPTADA | PENDIENTE: corregir H-15 | — | — | — | H-15: `requiredScope: null` en el 403 |
| AP-07 | Tamaños en bytes UTF-8; R4 pide ≤ 10 ítems | ACEPTADA | PENDIENTE: máximo explícito del propósito | — | — | — | — |
| AP-08 | Estados del puerto sin `degraded`; `withheld` | ACEPTADA | PENDIENTE: conformidad con la lectura de sus estados | — | — | — | Codificación del componente incompleto (F2) |
| AP-09 | Cuentas no divulgables | ACEPTADA (regla provisional, fail-closed) | CONSULTADO | **PENDIENTE**: guest, inactiva y eliminada | — | — | Política definitiva antes de cualquier dato real |
| AP-10 | Productos históricos y precio cero | ACEPTADA (criterio) | PENDIENTE: clasificación `lineKind` | **PENDIENTE**: aceptación comercial | — | — | Clasificación y excepciones |
| AP-11 | Presupuesto de CP y timeout de R4 | ACEPTADA | PENDIENTE | — | — | — | p95 medido en 02C. No es un SLO |
| D6 | Mapeo de producto a Catalog | Posición registrada: **diferida** | PENDIENTE: CP realiza el mapeo | — | **DEPENDE**: autoridad de claves y contrato verificado | — | `catalogKey: null` mientras tanto |

---

## 3. Posiciones de R4

### AP-01 — Forma del contrato

- **Una** ruta factual de CP: `POST /v1/capabilities/customer/sales-context`.
- La petición lleva un `purpose` obligatorio: `sales_context` o `purchase_history`.
- CP decide qué componentes calcula y emite para cada propósito. No envía el envelope comercial completo cuando la operación solo necesita un indicador de historial.
- R4 mantiene **dos** capacidades independientes, proyectadas desde ese contrato: `customer.get_context@2` (`purpose: sales_context`) y `customer.get_purchase_history@1` (`purpose: purchase_history`).
- La forma del cable es de CP. El puerto y las capacidades son de R4. Las formas que R4 publicó como CP-04 y CP-05 son **tipos del puerto R4, no rutas**.
- Desaparece el uso de `limit: 0` para pedir contexto sin ítems (DEC-08c de CP).

**Lo que R4 necesita de cada propósito** (CP elige la codificación en F2):

| Propósito | Necesidad de R4 | Uso |
|---|---|---|
| Ambos | `schemaVersion`, `contract`, `status`, `statusDetail`, `completeness`, eco de `customerRef`, `account.primaryState`, `freshness.asOf` y `validUntil`, campos de ciclo de vida (AP-05), `correlationId`, `meaning` y `limitations` | Verificar, mapear el estado, decidir la no divulgación, vigencia y gate |
| `sales_context` | Un indicador de existencia de compras válidas, o un dato del que se derive sin ambigüedad, con su `status`/`reason` | `purchaseHistory: present \| none \| unknown` |
| `purchase_history` | Por ítem: nombre histórico (`null` admitido), `catalogKey` (`null` en J4), unidades brutas (≥ 0), órdenes válidas (≥ 1), día de última compra y `lineKind`. Además, página (`limit`, `offset`, `returned`, `hasMore`, `order`) y `timezoneStatus` | Lista al modelo, filtro AP-10 y precisión de fechas |

R4 **no** necesita: montos, componentes monetarios, derivados, conteos de canceladas o reembolsadas, primera compra, antigüedad del cliente, flags crudos de cuenta, ids de PrestaShop ni SKU.

### AP-02 — Transporte

- Los identificadores de cliente van en el **cuerpo JSON**.
- Ningún identificador comercial aparece en paths, query strings, URLs de logs ni trazas.
- `POST` de solo lectura, sin efecto transaccional. Respuesta con `Cache-Control: no-store`.

### AP-03 — Minimización

Tres fronteras distintas:

| Frontera | Qué es | Autoridad | Regla en J4 |
|---|---|---|---|
| **A. Dominio factual de CP** | Todo lo que CP necesita para representar fielmente los hechos comerciales | CP (y negocio para las definiciones) | **Sin restricción por J4.** CP conserva montos, componentes de gasto, derivados e ids para otros productos y consumidores legítimos |
| **B. Cable CP → R4** | Lo que CP transmite a R4 | Acuerdo CP + R4. La legitimidad del propósito la decide el owner de datos | Solo lo necesario para el propósito (AP-01). **Sin montos, componentes monetarios ni datos predictivos.** Que el modelo no vea un dato **no** justifica transmitirlo |
| **C. Observación del modelo** | Lo que el agente ve como salida de la capacidad | R4 (pack Sales) | Allowlist de proyección y esquemas estrictos (especificación §6 y §10) |

- R4 valida la respuesta con un **esquema estructurado por propósito** y proyecta por **allowlist**. No usa una lista de prefijos de clave (`total*`, `amount*`, `price*`), que rechaza cantidades legítimas y deja pasar montos con otro nombre (auditoría §9.2).
- Un componente monetario o predictivo presente en una respuesta J4 es `contract_violation` (`purpose_minimization_violated`). Lo detecta la estructura, no el nombre de la clave.
- **Pendiente:** la aprobación de negocio de los propósitos `sales_context` y `purchase_history`.

### AP-04 — Scopes

- El consumidor `r4-sales` usa **exclusivamente** `customer.sales_context.read`.
- No se le asigna `customer.facts.read`, `customer.pii.read`, `customer.analytics.read` ni `dashboard.read`, tampoco de forma transitoria.
- La distinción entre contexto e historial la da el `purpose` y, con D2, el grant. No hace falta un segundo scope.
- **AP-04-H:** se registra aparte el hardening de `commercial-profile` (RFM, cluster, CLV), hoy accesible con `customer.facts.read` (`CP: src/http/auth/route-families.ts:66`). No se cambian los permisos de consumidores existentes sin un inventario de impacto.

### AP-05 — Ciclo de vida y autorización

- Se adoptan `schemaVersion`, `contractStatus`, `policyVersion`, `serviceBuildRef` y `authorizationBasis`.
- `authorizationBasis` es **evidencia declarada** de la configuración de CP. **Nunca** es por sí sola una autorización individual suficiente.
- Ninguna lectura privada real de J4 puede habilitarse con `authorizationBasis: service_scope_only`. Los modos sintéticos sí lo aceptan.
- `customer_grant_verified` es condición **necesaria, no suficiente**. Además hace falta D2 acordada, implementada en CP y verificada (I4).
- D2 sigue abierta hasta que la autoridad de identidad y CP aprueben el grant.

### AP-06 — Errores

- CP conserva su formato plano `{"error":"<code>"}`.
- R4 lo transforma a sus categorías `DomainError` existentes según el status HTTP y el código. No agrega categorías.
- 503 y 504 son indisponibilidad (`temporarily_unavailable`). 401 y 403 son denegación (`unauthorized`).
- Una denegación nunca se confunde con un cliente inexistente (I5).
- Se retira CP-09 (cuerpo anidado) para CP.

### AP-07 — Límites

- Los tamaños se miden en **bytes UTF-8**, no en caracteres JavaScript (UTF-16).
- R4 pide como máximo **10 ítems** por página (y `offset` ≤ 40).
- CP puede mantener límites generales distintos para otros consumidores, siempre que el propósito J4 tenga un **máximo explícito y verificable** (schema y test).

### AP-08 — Estados

| Situación de CP | Puerto R4 | Capacidades |
|---|---|---|
| 200 `available` con cuenta divulgable | `available` | `verified` |
| 200 `available` + `completeness: partial` | `available`. Solo se usan los componentes con `status: available` | Contexto: `unknown` si el indicador no está respaldado. Historial: **fallo** si los ítems no están disponibles |
| Historial incompleto o no disponible | — | **Fallo** `temporarily_unavailable` (`history_unavailable`) o no divulgable, según el contrato. Nunca una lista parcial |
| 200 `not_applicable` | `withheld` | `unavailable/withheld` |
| 200 `not_found` | `not_found` | `unavailable/not_on_file` |
| 401 / 403 | Fallo `unauthorized` | Fallo. Nunca `not_on_file` |
| 503 / 504 | Fallo `temporarily_unavailable` | Fallo |
| Cuerpo que no valida, eco distinto, componente fuera del propósito | Fallo `contract_violation` | Fallo |

- El vocabulario del puerto **no** incluye `degraded` como estado de éxito: en CP, `degraded` es un 503 sin hechos.
- La información retenida tiene un `reason` propio, **`withheld`**. `not_on_file` queda reservado para `not_found` de CP y no se usa para ocultar una cuenta existente.

### AP-09 — Estados de cuenta

- No se divulga información privada de cuentas **eliminadas**, **operacionales** (`not_applicable`) ni de estado **desconocido** (`withheld`).
- La política definitiva para cuentas **guest** e **inactivas** no se fija. Requiere aprobación del owner de datos.
- Hasta esa aprobación, la regla provisional de R4 es fail-closed: guest e inactivas también se tratan como `withheld`. Revertirla no cambia la forma del puerto.

### AP-10 — Productos históricos

- No se excluyen universalmente los registros con precio cero: un producto físico entregado gratis puede ser relevante para postventa o recomendaciones.
- Los servicios puramente administrativos no se presentan como equipamiento adquirido (`lineKind: administrative_service` queda fuera de la salida al modelo).
- La clasificación y sus excepciones requieren aceptación comercial.

### AP-11 — Presupuestos

| Valor | Hoy | Relación |
|---|---|---|
| Conexión a PrestaShop de CP | 2 000 ms (`PRESTASHOP_DB_CONNECT_TIMEOUT_MS`) | < presupuesto de CP |
| Presupuesto de la ruta en CP | 2 500 ms por defecto (`CUSTOMER_PROFILE_REQUEST_BUDGET_MS`, configurable 100–10 000) | ≤ timeout de R4 − 500 ms |
| Timeout de R4 hacia CP | 3 000 ms (`R4_CUSTOMER_PROFILE_TIMEOUT_MS`, rango 3 000–5 000) | + timeout del resolver ≤ `timeoutMs` de la capacidad |
| Timeout del resolver | 1 500 ms (rango 100–3 000) | — |
| `timeoutMs` de la capacidad | 10 000 ms | — |

- Los 500 ms de margen cubren transporte, serialización y validación.
- Son presupuestos locales: **ninguno es un SLO productivo**. El p95 real se mide en 02C.

### D6 — Mapeo de productos

- Catalog conserva la autoridad sobre las claves de producto.
- CP debe hacer el mapeo cuando exista un contrato verificado de Catalog que permita hacerlo sin ambigüedad.
- Mientras tanto: `catalogKey: null`.
- No se generan claves Catalog desde ids de PrestaShop, ni se equipara el SKU con `catalogKey`.
- **D6 queda diferida, no aceptada.**

---

## 4. Estado D1–D8

| ID | Estado | Cambio en R1C | Responsable |
|---|---|---|---|
| D1 | **BLOCKED** | Ninguno. CIA recomendada, owner por designar ([ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md)) | Negocio; owner de la CIA |
| D2 | **PROPOSED** | `authorizationBasis` registrada como evidencia declarada, nunca suficiente (AP-05). La verificación individual sigue sin implementarse | CP + CIA |
| D3 | ACCEPTED | Ninguno | R4 |
| D4 | Corregida en R1A; ampliada en R1C (AP-03). Confirmación del owner pendiente | Tres fronteras; minimización por propósito en el cable | R4 (C); CP + R4 (B) |
| D5 | ACCEPTED_WITH_CONDITIONS | Condición 4: solo se persiste la salida proyectada (ADR-039 §6) | R4 |
| D6 | **DEFERRED_WITH_NULL** (no aceptada) | Antes BLOCKED | Catalog + CP |
| D7 | **PROPOSED_PRODUCTION_BLOCKER** | Ninguno | Plataforma R4 (J7) |
| D8 | ACCEPTED | Ninguno | R4 / producto |

## 5. Divergencias de la auditoría cruzada (H-01 a H-17)

| ID | Divergencia | Tratamiento en R4 (R1C) | Lado CP |
|---|---|---|---|
| H-01 | `degraded` con significados opuestos | AP-08: el puerto no usa `degraded` (especificación §5, §7) | Sin cambio: CP conserva su vocabulario |
| H-02 | Lista de denegación que veta `productId` y deja pasar montos | AP-03: esquema por propósito y allowlist (especificación §10) | — |
| H-03 | Rutas con forma de consumidor (CP-04, CP-05) | AP-01: tipos del puerto, una ruta con `purpose` (requisitos CP-04, CP-05) | DEC-01 corregida |
| H-04 | PRD CP J4-03 pide valor monetario; ADR-039 §7 lo prohíbe | ADR-039 §7: sin montos en B; CP los conserva en A | Enmienda del PRD J4-03: **pendiente del owner de CP** |
| H-05 | "El modelo no ve los montos" como justificación del cable | — | DEC-03 corregida |
| H-06 | "Los ids hacen falta sea cual sea D6" | D6 diferida con `catalogKey: null` | DEC-03 corregida |
| H-07 | Error anidado frente a plano | AP-06: CP-09 retirado para CP (especificación §9) | — |
| H-08 | Uno o dos scopes | AP-04: un scope (requisitos CP-02) | DEC-04 confirmada |
| H-09 | `customer.facts.read` incluye `commercial-profile` | AP-04-H registrado (requisitos CP-07) | Hardening pendiente con inventario |
| H-10 | 64 KiB falso con 50 ítems de 4 bytes | AP-07: bytes UTF-8, ≤ 10 ítems | Test en bytes (F2) |
| H-11 | Restricciones de presentación aplicadas al cable | Puerto: nombre `null`, cantidad ≥ 0, truncado solo en C (especificación §5, §6.2) | — |
| H-12 | "Antigüedad del cliente" en ADR-039 §7 | Eliminada | — |
| H-13 | Binding de `@1` frente a sujeto de `@2` | ADR-039 (contexto) y especificación §3 distinguen ambos | — |
| H-14 | Las rutas v1 de CP colapsan el timeout y agregan `Z` | La especificación exige `sourceDate` sin zona y acepta `prestashop_timeout` | 02C no reutiliza esas proyecciones |
| H-15 | `requiredScope: null` en el 403 de ruta no clasificada | AP-06: R4 no depende del valor | Corrección menor (F2) |
| H-16 | PRD CP J4-02 frente a la recomendación de la CIA | Aparente. Sin cambio | Sin cambio |
| H-17 | El alineamiento de CP desconoce `1f67633` | — | Corregido en el documento de CP (procedencia y fila 51) |

---

## 6. Gate F2 (contrato candidato revisado, v1-rc)

F2 es trabajo de CP. Esta sección fija lo que R4 exige para **iniciarlo** y para **aceptarlo** como base de J4-R2. Superarlo **no** autoriza J4-R2 (OD-14), no aprueba el contrato y no declara interoperabilidad.

### 6.1 Condiciones de entrada

| # | Condición | Estado al cerrar F0/F1 |
|---|---|---|
| E-1 | Posiciones de R4 registradas y publicadas con SHA en `origin` | Este registro |
| E-2 | Conformidad del owner de CP con las AP que cambian la forma (AP-01 a AP-07), registrada en su documento de alineamiento | **PENDIENTE** |
| E-3 | Documento de alineamiento de CP versionado | Commit local de CP |
| E-4 | Autorización explícita para iniciar F2 en CP | **PENDIENTE** |

No bloquean la entrada, pero sí `contractStatus: approved` y cualquier dato real: la aprobación del owner de datos (AP-03, AP-09), la aceptación comercial (AP-10), D2 y D6.

### 6.2 Criterios de aceptación (validados desde R4)

| # | Criterio | Cómo lo verifica R4 |
|---|---|---|
| G-01 | Schema de **petición** publicado: `POST`; `customerRef` y `purpose` obligatorios; paginación solo con `purchase_history`; sin query; propiedades desconocidas → 400; cuerpo ≤ 1 KiB | Lectura del schema y fixtures de petición |
| G-02 | Composición por propósito declarada: cada componente es obligatorio, ausente o `null` según el `purpose` | Fixtures de ambos propósitos |
| G-03 | Ningún componente monetario ni predictivo en las respuestas J4, impedido por **estructura** del schema | Sondeo: 0 montos en los fixtures J4 |
| G-04 | Sin `productId`, `productAttributeId` ni SKU en las respuestas J4. `catalogKey: null` (D6) | Sondeo |
| G-05 | `schemaVersion` entero; `contractStatus` enum (`candidate`, `approved`, `deprecated`); `policyVersion` con patrón; `serviceBuildRef`; `authorizationBasis` enum | Schema |
| G-06 | Estados: `available`, `not_found` y `not_applicable` en 200; `degraded` solo en 503; parcial = `available` + `completeness: partial` con `status`/`reason` por componente | Fixtures por estado y propósito |
| G-07 | Errores planos; 401/403 iguales a los del middleware; `requiredScope` del 403 siempre string (H-15) | Fixtures de error |
| G-08 | `purchase_history`: máximo explícito por página (≥ 10, que es lo que R4 pide), `offset` ≤ 40 aceptado, orden total declarado | Schema y fixtures |
| G-09 | Tamaño en **bytes UTF-8**: test con caracteres de 4 bytes en el máximo del propósito, ≤ 64 KiB | Test de CP; sondeo en bytes |
| G-10 | Fechas: `sourceDate` sin zona y `utcInstant: null` mientras `timezoneStatus: unverified`. Nunca `Z` agregada | Sondeo |
| G-11 | Nombre histórico nullable; unidades brutas ≥ 0, descritas como brutas | Schema y fixtures |
| G-12 | Scope `customer.sales_context.read` declarado para la ruta en el contrato | Documentación del contrato |
| G-13 | Fixtures para cada propósito × estado y cada error, con MANIFEST y hashes. `SOURCE.json` normalizado: procedencia de generación y de incorporación, sin autorreferencia (cierra `PARTIAL_DEFERRED_TO_F2`) | Test de hashes; lectura de `SOURCE.json` |
| G-14 | Contrato en un SHA alcanzable desde una rama remota de CP; test de contrato y typecheck verdes | `git ls-remote`; log del test |
| G-15 | **Sondeo cruzado de R4 sin fallos** con las reglas de esta revisión sobre **todos** los fixtures J4 | Script de sondeo, resultado archivado |
| G-16 | Conformidad del owner de CP registrada para AP-01 a AP-08 y AP-11 | Documento de alineamiento de CP |

---

## 7. Estado

```text
F0_R4_DECISIONS_RECORDED
F0_CP_OWNER_ACCEPTANCE_PENDING
F0_DATA_OWNER_ACCEPTANCE_PENDING
F2_NOT_STARTED
CP_CONTEXT_02C_NOT_STARTED
R4_J4_R2_NOT_AUTHORIZED
D1_BLOCKED  D2_PROPOSED  D6_DEFERRED_WITH_NULL  D7_PRODUCTION_BLOCKER
PRODUCTION_UNCHANGED (sales-production@3)
```
