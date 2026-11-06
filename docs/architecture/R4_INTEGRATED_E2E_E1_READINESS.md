---
title: R4 — Integrated Commercial E2E: matriz de servicios, Discover, carril WhatsApp y plan E1
status: R4_INTEGRATED_E2E_E1_IMPLEMENTATION_READY_FOR_REVIEW — código y pruebas listos; despliegue y activación pendientes de gates y de autorización de acceso a producción
mandate: «R4 — Integrated Commercial E2E Deployment» (owner, 2026-11-05)
date: 2026-11-05
base: main c9a87ac
branch: feat/r4-integrated-e2e
---

# R4 — Integrated Commercial E2E: estado para E1

## 0. Resumen

| # | Entregable | Estado |
|---|---|---|
| 1 | Matriz de SHAs y readiness | §1, con verificación en vivo de solo lectura (§1.2) |
| 2 | Integración funcional de Discover | **Implementada** con el adaptador existente, contra el contrato v1b1 fijado por hash. Sigue **sin publicar** (Catalog #56), pero el owner aceptó el borrador fijado para E1 (D-1) (§2) |
| 3 | Routing controlado desde el WhatsApp actual | **Implementado** (ADR-045) y probado. **No activado** (§3) |
| 4 | Plan de despliegue coordinado | §4 |
| 5 | Resultado E1 real por WhatsApp | **No ejecutado:** requiere el despliegue (§4) y los mensajes del owner (§5) |
| 6 | Bloqueos concretos de E2 y E3 | §6 |
| 7 | Evidencia de gates | §7 |

**Lo que no se hizo:**

- ningún cambio en la EC2;
- `@3` sin cambios;
- sin tráfico real;
- sin llamadas a modelos pagados;
- sin cambios en Catalog, Quote, Checkout, CIA ni PrestaShop;
- sin cambios en el kernel.

## 1. Matriz de servicios

### 1.1 Matriz

Fuente: auditoría de solo lectura de cada repositorio (2026-11-05) y los informes de despliegue citados.

| Servicio | SHA candidato | Desplegado (según informes) | Contrato vigente | E1 | E2 | E3 |
|---|---|---|---|---|---|---|
| **R4** | rama `feat/r4-integrated-e2e` sobre `main` `c9a87ac` | **Verificado:** gateway, worker y scheduler en `9078584`; registro sin v13 ni `@13` | — | Listo tras revisión, merge y despliegue (§4) | Bloqueado (§6) | Bloqueado (§6) |
| **Catalog V2** (lectura) | `main` `5f2c086` | Paquete de `8a72c38`, mismo código que `5f2c086`; generación `sha256:af9e3f63…` | `/v2/catalog` schemaVersion 1. Lectura real R4→V2 **14/14** | Listo | Paridad P-1 pendiente (Catalog #54) | — |
| **Catalog Discover** | `main` `5f2c086` | **Verificado:** `/health/discover` `READY`, generación `sha256:af9e3f63…`; calidad `NOT_ACCEPTED` (#55); revisión de dominio PENDING → `DEGRADED` | `catalog-discover-v1b1` **DRAFT_NOT_PUBLISHED** (#56; PR #46 desactualizado) | Listo: el owner aceptó el borrador fijado (D-1) | — | — |
| **Shipping** (pc-carrier) | sin repositorio (API del owner) | REAL en `@3` | PC Carrier API 1.2.0 (ADR-032) | Listo; hallazgo abierto (§1.3) | Sin mapeo a transportistas de PrestaShop (H1) | Sólo retiro a costo 0 en alcance; transportista sin designar (O-10) |
| **Quote V2** | `main` `a79d33f` (A10 `ca66a2e`, cart `#28`) | **Verificado:** contenedor de integración `6735352` arriba (anterior a A8 y A10); `quote-service` V1 (PM2) detenido | OpenAPI 2.0.0; A10 compatible con R4 `main` | No participa | **Bloqueado:** R1.7 C–F | Bloqueado |
| **Checkout** | rama local `pay-02b` `c8aae41` (sin remoto) | **Verificado:** contenedor sandbox `1a8a0ca` arriba; sin API de comandos servida; perfil `live` prohibido | `/v1` 1.0.3-proposed (1.0.4 candidato, sin aprobar) | No participa | No participa | **Bloqueado:** F-4 falla, F-7 no ejecutado |
| **CIA** | `main` `7525395` (código `929e72e`) | No desplegado; modo sólo `synthetic` | `cia/v1-d2` candidato | No participa | No participa | **Bloqueado** |
| **Customer Profile** | `main` `bbd766e` | Versión previa a J4 | `sales-context v1-rc2` candidato | No participa | No participa | Fuera de la ruta de compra |
| **PrestaShop** | 8.2.3 | Producción | Webservice estándar | — | — | WS-01 no aprobado (§6.2) |

### 1.2 Verificación en vivo

Ejecutada el 2026-11-05 con autorización del owner. Fue de solo lectura: procesos PM2, SHA de cada proceso, contenedores, salud
de Discover y consultas a la base con `default_transaction_read_only`. No se cambió nada.

- **Procesos R4:** `r4-channel-gateway`, `r4-sales-worker` y `r4-scheduler` corren `9078584`.
- **Registro:** `v13` y `@13` están libres (gate G-D).
- **Discover:** `READY`, en la generación que declara el handoff.

### 1.3 Hallazgo que E1 hereda

`@13` corre el texto de la definición v4, el mismo de `@3`. Por eso hereda el hallazgo conocido de producción: el
agente puede presentar el «Despacho Directo» a $1 (una promoción real del owner) como la tarifa real del
transportista. La cláusula correctora sólo existe en las definiciones candidatas (v12). E1 debe etiquetar este caso
como defecto **previo**, no como defecto de Discover.

## 2. Discover

**Implementación existente reutilizada:**

- `HttpCatalogAdapter.discover()` en el mismo adaptador de Catalog V2;
- la misma clasificación de fallas;
- la misma telemetría.

**Lo nuevo:**

- **Clave propia.** Catalog exige una clave habilitada para Discover; la clave general de R4 recibe 403. La nueva
  variable es `R4_CATALOG_V2_DISCOVER_API_KEY`: opcional, sólo para V2 y distinta de la general.
- **Contrato.** Es un port del esquema **tolerante** del owner (`agentContract.ts`, modo `tolerant`), fijado por los
  hashes de su manifiesto en `DISCOVER_CONTRACT_PIN`. Los fixtures dorados se copiaron sin cambios y el test verifica
  su sha256 contra el manifiesto. Las 24 respuestas parsean.
- **Capacidad `catalog.discover`.** Es de lectura y sólo la registra `@13`. Proyecta la respuesta del owner campo
  por campo, en su orden, sin agregar, quitar ni reordenar candidatos.

**Lo que R4 no hace:**

- ranking;
- ontología;
- búsqueda semántica;
- precio o stock con autoridad de compra.

La descripción de la capacidad y la línea agregada en v13 obligan a usar `catalog.get_product_context` antes de
presentar precio o stock como oferta.

**Evidencia de invocación real.** En la prueba de integración L2, el worker del carril llama a Discover a través de
la capacidad y queda una observación `catalog.discover` con el `requestId` del owner. En E1, la misma consulta sobre
`observations` es la evidencia de que R4 invoca Discover (§5).

**Contrato no publicado (D-1).** El mandato pide la versión publicada y aprobada, y no existe. La integración se hizo
contra el borrador fijado por hash, que es exactamente lo que sirve la generación desplegada. Publicarlo es un gate
de **activación**, no de código: el owner decide entre esperar #56 o aceptar el borrador fijado para E1. Si se
publica una revisión distinta, se fija de nuevo; nunca se edita la versión fijada.

## 3. Routing: carril de conversación (ADR-045)

**Mecanismo existente auditado:**

- `ChannelIngress` admite un solo perfil por gateway;
- el binding ya persiste `profile`;
- los workers se separan por `servedAgents`.

Ese mecanismo no permite dirigir **una** conversación a otro perfil, así que se hizo la modificación mínima: un carril
opcional en `ChannelIngress`. No es un sistema de routing nuevo. El detalle está en `docs/adr/ADR-045-conversation-lane.md`.

| Invariante del mandato | Cómo se cumple | Prueba |
|---|---|---|
| Asignación determinista | Al abrir el binding, por clave; se persiste en `binding.profile` y después se sigue el binding | L1, L5 |
| Exclusión de otras conversaciones | Conjunto cerrado de claves, y cada una también debe estar en la allowlist del rollout | L1, L7 |
| Una ejecución por mensaje | Deduplicación existente por evento; v13 tiene su propio worker y ninguno toma tareas del otro | L2, L3 |
| Historia | `PriorConversationContextSource` (R7-4) también en `@13` | L4 |
| Sin respuestas duplicadas | Un outbound por respuesta, también con 5 entregas del mismo evento y los dos workers activos | L3 |
| Recuperación tras reinicio | Asignación desde el binding persistido. Un resto sin tarea de un perfil no servido adopta la tarea ya creada (L5c) o se reabre (`profile_not_served`, L5b). Un gateway con carril no arranca sin v13 registrada | L5, L5b, L5c, L7b |
| Rollback | Runbook §4.1: quitar el carril, dejar que el worker del carril vacíe su tarea, cancelarla, detener el worker; sin mensajes perdidos | L6 |
| `@3` intacto | Probado con `@3` como perfil principal (L9: su huella y v4). Sin carril, el gateway es R4-I; `SALES_PRODUCTION_PROFILES` y las huellas no cambian; V2 sólo por `salesCatalogSourceOf(@13)` | Contrato `sales-profile-v13`, `catalog-v2-isolation` y suite completa |

**Mutaciones manuales:**

- «el carril nunca asigna»: fallan 6 de 9;
- «la fábrica sigue a la configuración»: falla L5;
- «sin adopción de la tarea huérfana»: falla L5c;
- «sin chequeo de la definición al arrancar»: falla L7b.

## 4. Plan de despliegue coordinado

**Para E1 sólo se despliega R4.** Catalog V2 y Discover ya están desplegados. No hay migraciones nuevas.

**Gates previos:**

| Gate | Estado |
|---|---|
| G-A. Revisión focalizada y merge; SHA fijado | Pendiente |
| G-B. Decisión D-1 (contrato Discover) | **Aceptada:** borrador v1b1 fijado por hash para E1 |
| G-C. Autorización de acceso a producción para verificar y desplegar | **Otorgada** por el owner |
| G-D. `v13` y `@13` libres en el registro | **PASS** (§1.2) |
| G-E. Clave Discover de R4 disponible para el entorno del worker del carril | **Disponible:** entregada por Catalog en PROD-R3 en un archivo 600 del usuario que ejecuta R4 en la EC2, con las cuatro variables `R4_CATALOG_V2_*`. Sólo la carga el entorno del worker del carril; nunca entra al repositorio |
| G-F. Decisión D-2 (escrituras del workspace en `@13`) | Pendiente |

**Pasos:**

| # | Paso | Verificación | Rollback del paso |
|---|---|---|---|
| 1 | Backup de la base y del entorno; registrar el SHA y `pm2 ls` actuales | dump verificable | — |
| 2 | Release del SHA aprobado en un directorio nuevo; `npm ci` y `build` | `git rev-parse` = SHA | borrar el directorio |
| 3 | Gateway, worker principal y scheduler al SHA nuevo, **sin** variables de carril | `/ready`; `production:sales:plan` muestra `lane: none` y la huella de `@3` sin cambios | volver al release anterior |
| 4 | `production:sales:bootstrap --lane` con `R4_PROD_POLICY_PROFILE=sales-production@13` | registra **sólo** `sales@13` | v13 registrada es inerte sin carril ni worker |
| 5 | Nuevo proceso PM2 del worker del carril. Su entorno: el de producción, con `R4_PROD_POLICY_PROFILE=sales-production@13`, `R4_CATALOG_V2_*`, la clave Discover, otro `R4_WORKER_ID` y el límite de escrituras de D-2 | log `service.composed` con `sales-production@13` y sin errores | detener y borrar el proceso |
| 6 | **Activación** (autorización específica): cancelar la tarea abierta del owner en `@3` (`tasks cancel`; gate `owner-binding`: un binding abierto sigue a su tarea); agregar `R4_PROD_LANE_PROFILE` y `R4_PROD_LANE_ALLOWLIST=<clave del owner>` al gateway; reiniciarlo | `/ready` muestra `lane: { profile: sales-production@13, conversations: 1 }` | §4.1 |
| 7 | E1 (§5) | evidencia privada | §4.1 |

### 4.1 Rollback de la activación

Probado en L6. El orden importa: el binding abierto del carril sigue a su tarea.

1. Quitar las dos variables del carril del gateway y reiniciarlo.
2. **Mantener el worker del carril en marcha** hasta que su tarea no tenga entradas sin procesar. Si se detiene antes, esos mensajes no se responden; si se cancela antes, se pierden.
3. Cancelar la tarea del carril (`tasks cancel`).
4. Detener el worker del carril.

El siguiente mensaje del owner abre un binding con `@3`. La definición v13 queda registrada e inerte.

## 5. E1 desde WhatsApp

Se reutilizan los diez escenarios de `R4_CATALOG_V2_DISCOVER_ROUTING_DECISION.md` §6, con el número productivo y sólo
la conversación del owner.

**Evidencia por escenario**, en almacenamiento privado y fuera del repositorio:

- mensaje;
- capacidad y argumentos;
- `requestId` de Discover;
- productos;
- respuesta;
- latencia;
- etiqueta humana;
- si el defecto es del proveedor o del agente.

**Detención inmediata si ocurre cualquiera de estos:**

- otra conversación aparece en `@13`, o la del owner en `@3` durante E1;
- dos respuestas a un mensaje;
- una escritura comercial;
- datos de Catalog V1 en `@13`;
- errores de credenciales;
- cualquier cambio en `@3`.

**Gates que E1 no aprueba:** `DISCOVER_QUALITY_ACCEPTED` y `COMMERCIAL_GO` no se dan por aprobados por haber
ejecutado E1.

## 6. Bloqueos de E2 y E3

### 6.1 E2 (cotizaciones reales)

1. **Quote R1.7 C–F no ejecutado:**
   - restore real;
   - reinicio del host;
   - disco (G2-D01..D03);
   - 7 días estables;
   - aceptación.
2. **Sin SHA candidato de Quote.** `main` trae la migración `000010`, que necesita aprobación porque R1.7C se planificó
   contra `000009`.
3. **A10 en lockstep.** Desplegar R4 y Quote juntos y correr el chequeo posterior (92 792×1 + 3 992×4 → 91 395 /
   17 365 / 108 760).
4. **Principal de 60 minutos** (`cl-retail-session-60m-v1`): aprobado sólo para sintético y staging. La alternativa es
   el principal estándar de 5 días, y elegirla es decisión del owner. La elegibilidad de promociones está pendiente.
5. **P-1:** evidencia de paridad del owner de Catalog (Catalog #54, sin respuesta).
6. **Gates del perfil.** `@12` está definido, pero sus gates están en `SALES_PRODUCTION_PROFILE_V12_GATE`. E2 sobre
   el número real necesita además un perfil de carril con Quote, que requiere su propio mandato.
7. Quote #32 sin respuesta.

### 6.2 E3 (carrito, pago y orden)

Requiere todo lo de E2, más:

- **CIA:** no desplegado y sólo en modo sintético. DEP-2, DEP-3 (el endpoint de búsqueda de cuentas no está
  implementado en la tienda), DEP-5, DEP-6 y DEP-10 están abiertos. El grant de compra H3 no existe. RR-1, BA-01..06,
  OA-10 y la cobertura de texto SEC-OTP siguen pendientes.
- **Quote carrito:**
  - el flag está apagado y `H3_MODE` está cerrado en producción;
  - `ps-cart-totals/v1` no está provisionado;
  - falta el transportista de retiro (O-10);
  - faltan dirección y envío (H1, H2);
  - falta la fase C sobre un clon de la tienda.
- **Checkout:**
  - no sirve la API de comandos ni el endpoint de enlace;
  - el contrato `/v1` no está aprobado;
  - **F-4 falla:** la expiración del proveedor no está verificada (observada unos 3 min tarde), y una captura posterior
    a `expiresAt` con el intento aún abierto se confirma y crea la orden (D-07/OD-06);
  - F-7 no tiene suite de mutaciones;
  - el runtime usa `DisabledPrestaShop`;
  - no hay remoto ni CI.
- **PrestaShop WS-01:** la arquitectura no está aprobada. Falta decidir el estado de entrada de la orden, el módulo
  autor y los efectos de los módulos productivos.

## 7. Gates

**Pruebas** (R4_TEST_STRATEGY_02, cambio transversal: `live-ops`):

| Nivel | Resultado |
|---|---|
| L1 | unit 1642 ✓, contract 492 ✓, carril 13/13 ✓, typecheck 0, lint 0 |
| L2 | **PASS** (§7.1): regresión completa y las 19 suites de mutación, 242/242 detectadas |
| L3 | NOT_RUN: se hace en el despliegue, sobre el SHA exacto |

| Gate | Estado |
|---|---|
| `CATALOG_V2_TECHNICAL_PASS` | PASS (14/14, PR #51) |
| `DISCOVER_INTEGRATION_IMPLEMENTED` | PASS (fixtures del owner, prueba de integración) |
| `DISCOVER_CONTRACT_PUBLISHED` | **NO** (Catalog #56). El owner aceptó el borrador fijado para E1 (D-1) |
| `LANE_ROUTING_VERIFIED` | PASS en L1/L2; revisión focalizada §7.2 |
| `PRODUCTION_STATE_VERIFIED` | **PASS** (§1.2) |
| `E1_DEPLOYED` | NO |
| `E1_VALIDATED` | NO |
| `E2_ENABLED` / `E3_ENABLED` | NO (§6) |

### 7.1 Regresión L2

Árbol de runtime y pruebas de `448cc69`. `e0e6b7d` sólo agrega documentación. Por ser un cambio transversal, se
corrieron todas las suites de mutación.

**Regresión:**

| Suite | Resultado |
|---|---|
| integration | 719 ✓, 12 omitidas |
| recovery | 19 ✓ |
| sales | 29 ✓ |
| shadow | 5 ✓ |

**Mutaciones (19 suites):**

| Suite | Detectadas |
|---|---|
| evaluation | 6/6 |
| shadow | 9/9 |
| recovery | 14/14 |
| production | 23/23 |
| production-control | 13/13 |
| worker-readiness | 15/15 |
| identity-verification | 23/23 |
| identity-verification-state | 16/16 |
| identity-verification-ingress | 13/13 |
| identity-verification-dispatch | 11/11 |
| identity-verification-commercial | 9/9 |
| rr1 | 5/5 |
| binding-immutability | 12/12 |
| profile-v8 | 8/8 |
| canary-j4 | 13/13 |
| run-failure-fallback | 6/6 |
| runtime-contingency | 11/11 |
| turn-guard | 24/24 |
| prior-conversation | 11/11 |
| **Total** | **242/242** |

**Interrupción:** la cadena se pausó por un apagado del equipo y se retomó al día siguiente.

- Las suites que habían terminado conservan su resultado.
- `identity-verification-dispatch` quedó interrumpida y se repitió completa.
- La interrupción dejó una mutación aplicada en una fuente local. Se detectó con `git status`, se restauró y se
  recompiló antes de retomar.
- Nunca se commiteó.
- Después de cada suite se verificó que el árbol quedara limpio.

### 7.2 Revisión focalizada

La hizo un revisor independiente sobre `384288f`, sin ejecutar pruebas. **Sin bloqueos.** Hubo siete puntos a
corregir, todos resueltos en la rama:

| # | Hallazgo | Corrección |
|---|---|---|
| 1 | El regex de la allowlist del carril perdió la barra (`[s,]`): una lista separada por espacios o saltos de línea impediría arrancar al gateway | Corregido; L7b lo prueba con espacios, saltos de línea y comas |
| 2 | El worker del carril se componía sin la clave Discover y fallaba en cada llamada | `discoverConfigured` en el puerto; la composición lo exige (L8 y unit) |
| 3 | Rollback: cancelar antes de vaciar la tarea pierde mensajes | Runbook reordenado (§4.1, ADR-045 §7); L6 verifica que el mensaje intermedio se responde |
| 4 | Caída entre crear la tarea y adjuntarla, más la quita del carril: segunda tarea y doble respuesta | El binding adopta la tarea por su clave de creación (L5c) |
| 5 | Gateway con carril sin v13 registrada: 500 en cada mensaje | El gateway no arranca (`lane_definition_not_registered`, L7b) |
| 6 | Ninguna prueba usaba `@3` como perfil principal | L9 |
| 7 | L5 no cambiaba la configuración; faltaban primeros mensajes concurrentes distintos | L5 quita el carril; L3b |

**Nits:**

- **Aceptados y documentados:**
  - el cambio en el camino sin carril (ADR-045 §4);
  - v13 como la última versión del registro, y `/ready/r4` sin contar el worker del carril (ADR-045 §8);
  - el gate de activación `owner-binding`.
- **Corregido:** un `FAILED` con HTTP 200 es una violación de contrato.
- **Sin cambios:**
  - los 503 no reintentables de Discover se clasifican como `temporarily_unavailable`, igual que el resto del adaptador;
  - `contractVersion` se acepta tolerante, como en el consumidor de referencia del owner.

## 8. Decisiones del owner

- **D-1. Resuelta (2026-11-05):** el owner acepta para E1 el contrato v1b1 fijado por hash (Catalog `5f2c086`). La
  publicación (#56) sigue pendiente para cualquier uso posterior.
- **D-2.** Escrituras del workspace en `@13`:
  - con `R4_EXEC_MAX_WRITE_ACTIONS=0` se reproduce el defecto D-7 de `@3` (propuesta rechazada, handoff
    `run_budget_exhausted`);
  - la recomendación es un tope bajo (por ejemplo 6, como D7-5 para `@12`) sólo en el worker del carril: es estado
    interno de R4, sin efecto comercial.
- **D-3. Otorgada (2026-11-05):** acceso a producción para la verificación de §1.2 y para los pasos 1 a 5.
- **D-4.** Autorización específica de activación (paso 6) con el SHA aprobado.
