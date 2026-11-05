---
title: R4 — Catalog V2 real, contrato Discover y decisión de routing WhatsApp
status: R4_CATALOG_V2_DISCOVER_INTEGRATION_ROUTING_READY_FOR_REVIEW — lectura real R4→V2 aprobada; Discover bloqueado por contrato no publicado; routing recomendado, no autorizado ni desplegado
mandate: «R4 — Catalog V2 Discover Integration and Routing Decision» (owner, 2026-11-05)
date: 2026-11-05
base: main c9a87ac
---

# R4 — Catalog V2 real, contrato Discover y decisión de routing

## 0. Entregables

| # | Entregable | Resultado |
|---|---|---|
| 1 | Merge del PR #50 | **`c9a87ac`** (§1) |
| 2 | Integración real R4 → Catalog V2 | **14/14** desde un proceso R4 aislado en la EC2 (§2) |
| 3 | Estado del contrato Discover | **No publicado.** Publicación solicitada en Catalog #56 (§3) |
| 4 | Implementación Discover | **No implementada:** el mandato la condiciona a la publicación del contrato (§3) |
| 5 | Comparación de topologías | §4 |
| 6 | Recomendación de routing | **B, número dedicado** (de prueba de Meta si es posible), con justificación (§5). No autorizada ni desplegada |
| 7 | Plan de prueba WhatsApp con diez escenarios | §6 |

**Lo que no se hizo:**

- sin tráfico de WhatsApp;
- sin cambios en procesos, configuración ni routing productivos;
- `@3` sin cambios;
- sin modelos, escrituras, Quote, Checkout ni pagos;
- sin cambios en Catalog V2;
- sin reescritura de historia.

## 1. PR #50

**Verificaciones:**

- **HEAD y base:** HEAD `f375c3f` sobre `main` `1e602f3`, sin conflictos.
- **Alcance:** diff documental, un solo archivo.
- **GitGuardian:** en verde.
- **Información sensible:** sin secretos ni nombres operativos.
- **Alternativas:** las cuatro alternativas de routing se conservan.

Se agregó un commit documental: **«Ninguna de estas topologías está autorizada para despliegue»**.

**Merge:** con merge commit, **`main` = `c9a87ac`**.

## 2. Integración real R4 → Catalog V2

**Cómo se ejecutó:**

- **Código:** el adaptador y la configuración de R4 de `main` `c9a87ac`, compilados localmente. Se empaquetaron sólo
  `@r4-adapters/catalog-http`, `@r4-adapters/domains` y `zod`, con una sonda de lectura.
- **Proceso:** se copió a un directorio propio en la EC2 y se ejecutó con el `node` del runtime de R4, en un proceso
  aparte.
- **Credencial:** las `R4_CATALOG_V2_*` del archivo de entrega de Catalog, cargadas sólo en ese proceso.
- **Fuera de alcance:** ningún proceso productivo se reinició ni se reconfiguró; antes y después,
  `r4-channel-gateway`, `r4-sales-worker`, `r4-scheduler` y `catalog-service` estaban `online`, con 0 reinicios.
- **Evidencia:** queda fuera del repositorio, en el host (archivos 600) y en una copia local privada. La sonda se negaba
  a escribirla si contenía alguna clave.

**Generación en servicio:** `sha256:af9e3f63…`, `READY`. Es la generación productiva que declara el handoff.

| # | Validación del mandato | Comprobación | Resultado |
|---|---|---|---|
| B0 | Configuración | Fuente `v2`, `127.0.0.1:4011`, descripción sin clave | PASS |
| B1 | **Sin fallback a V1** | `source: v2` con sólo variables V1 → `catalog_config_incomplete`, sin ninguna llamada | PASS |
| B2 | Autenticación real | Clave general de R4 aceptada: búsqueda 200 y contrato validado | PASS |
| B3 | Autenticación real | Una clave desconocida → 401 → `unauthorized`; el mensaje nombra `R4_CATALOG_V2_API_KEY` | PASS |
| B4 | Consulta de productos | 5 búsquedas (10 resultados cada una, truncadas), todas válidas contra el contrato consumidor | PASS |
| B5 | Contrato consumidor | Contextos de producto `found`, disponibilidad y enlace público en el dominio de la tienda | PASS |
| B6 | Variantes | Un ítem de variante con identidad propia y SKU; la clave del producto padre → `variant_required` | PASS |
| B7 | Precio y stock | Contextos de ítem con `finalGross` y `regularGross` (incluye una promoción real), IVA incluido, `engineVersion` `catalog-commercial-v2.3.0`, frescura de 15 s | PASS |
| B8 | Cobertura parcial | Stock 20: con 20 → `full`, `sellable`; con 21 → `partial`, `not_sellable`, `catalogShortStock` = 20 | PASS |
| B9 | Estados de error | Clave inexistente → 200 `not_found` (dato, no error) en producto e ítem | PASS |
| B10 | Estados de error | Consulta de 1 carácter → 400 → `validation`, no «sin resultados» | PASS |
| B11 | Estados de error | Cantidad 0 → rechazo local sin llamada HTTP | PASS |
| B12 | **Sin fallback a V1** | V2 caído (puerto cerrado) → `catalog_unreachable`; ninguna otra fuente responde | PASS |
| B13 | Generación | `/health/projections` 200, `READY` | PASS |

**Llamadas:**

- 27 en total, 24 exitosas. Las 3 fallidas son las comprobaciones de error intencionales.
- Latencia: mediana 17 ms, máximo 148 ms.

**Primera corrida:** 13/14. B6 no encontró productos con variantes entre las consultas elegidas. Se agregaron consultas
de categorías con tallas y la segunda corrida dio 14/14. Ambas evidencias se conservan.

**Gate:** `CATALOG_V2_TECHNICAL_PASS` = **PASS** para la ruta de lectura de R4. Los defectos de contenido del catálogo
son responsabilidad de la paridad (Catalog #54).

## 3. Contrato Discover

**Estado:**

- `catalog-discover-v1b1` está preparado pero no publicado. `contracts/` de Catalog `main` (`5f2c086`) sólo tiene `v2` y
  `eval`.
- Sus fixtures están marcados `SYNTHETIC_FIXTURES_NOT_PUBLISHED`.
- La publicación está propuesta en el PR #46 de Catalog («DO NOT MERGE», cambio protegido), y su propuesta la condiciona
  a `DISCOVER_QUALITY=ACCEPTED`.

**Solicitud:** Catalog #56 pide publicar el contrato técnico versionado **sin exigir la aceptación de calidad**, como
decidió el owner. Debe incluir:

- endpoint;
- método y autenticación;
- esquemas, con la lectura tolerante de consumidor;
- semántica de resultados;
- errores;
- límites;
- fixtures;
- manifiesto de compatibilidad.

**Implementación en R4:** no se hizo. El mandato la condiciona a que el contrato quede disponible. El diseño ya está
fijado (plan del PR #50, §4):

- `discover()` en el adaptador existente, sólo para Catalog V2;
- `catalog.discover` como capacidad de lectura, sólo en el perfil canary autorizado;
- sin ranking ni descubrimiento conceptual en R4;
- sin cambios en el kernel.

## 4. Comparación de topologías

**Hechos de código que condicionan las dos alternativas:**

- **Un perfil por gateway.** `ChannelIngress` (el paquete genérico `live-ops`) recibe **un** perfil y **una**
  `taskFactory`, y el gateway de Sales fija la versión de cada tarea al perfil de su despliegue.
- **El canary actual es sintético por diseño.** Su admisión rechaza cualquier binding de WhatsApp
  (`canary_isolation_violated`): ninguna opción puede «enchufar» WhatsApp al canary existente.
- **Producción sólo usa V1.** Tras #49, producción sólo construye Catalog V1 (decisión de aislamiento): las dos
  alternativas necesitan un perfil que exija V2 de forma explícita.
- **Asignación por tarea.** Los workers productivos declaran `servedAgents` (EV-2) y sólo toman tareas de su versión.
- **Bindings inmutables.** La identidad del binding y su `task_id` son inmutables (migración 0011).

| Criterio | **A. Routing por conversación o allowlist en el gateway existente** | **B. Número WhatsApp dedicado** |
|---|---|---|
| Cambios de código | **En la plataforma compartida:** `ChannelIngress` debe elegir perfil y versión por conversación (hoy es uno por gateway), con la regla de asignación y su configuración. Además: el gateway de Sales, un segundo worker productivo con otro perfil, y el perfil V2 + Discover con su definición | **Sólo en Sales:** el perfil de sólo lectura V2 + Discover y su definición, más la selección de V2 atada a ese perfil (nunca por variable de entorno). Gateway, ingress y worker se reutilizan sin cambios, con otro entorno |
| Aislamiento | **Parcial.** Misma base productiva, mismo gateway y mismo número; el canary ve y escribe en las tablas de producción | **Total.** Otra base, otro número, otras credenciales de Meta, otros procesos |
| Persistencia de asignaciones | Hay que persistir la asignación conversación → perfil en el binding (columna `profile`). Los bindings ya abiertos con `@3` no pueden reasignarse (inmutables), así que hay que cerrarlos antes de enrutar | No hay estado de asignación: decide el número al que escribe el owner |
| Idempotencia | Deduplicación por evento existente; más una carrera nueva entre «allowlist cambia» y «binding se crea», que hay que definir y probar | Sin cambios: la de producción, en otra base |
| Riesgo de duplicación | Dos workers en la misma base; los separa `servedAgents`. Un error de configuración (versiones solapadas) duplicaría consumidores de tareas productivas | Ninguno sobre el webhook productivo: es otro webhook y otra app de Meta. Riesgo propio: cargar por error credenciales productivas (mitigación: guarda de base distinta, como el canary actual) |
| Recuperación ante fallas | Si el worker del canary cae, las conversaciones asignadas quedan sin respuesta en la base productiva y cuentan en sus métricas | Una caída afecta sólo al canary |
| Rollback | Quitar la allowlist **y** cerrar los bindings asignados **y** volver a desplegar el gateway productivo anterior. Toca producción | Detener los procesos del canary y quitar la ruta de su webhook. Producción no se toca |
| Complejidad operativa | Moderada en procesos (un worker más), alta en riesgo: cambia la ruta de cada mensaje productivo | Más piezas (tres procesos, una base, una ruta HTTPS, credenciales de Meta), todas aisladas |
| Infraestructura requerida | Ninguna nueva salvo un worker | Un número de WhatsApp (el de prueba de la app de Meta, si sirve), una ruta HTTPS pública para el webhook, una base Postgres separada y un archivo de entorno |
| Reutilización en futuros canaries | Alta, pero cada canary corre sobre la base productiva | Alta: un carril preproductivo con canal real para todo canary futuro (F1 incluido) |
| Autorización necesaria | Modificar el routing productivo, explícitamente prohibido en este frente | Infraestructura nueva en la EC2, sin tocar producción |

## 5. Recomendación: B, número dedicado

**El menor riesgo operativo verificable es el de B**, y no por comodidad:

1. **Su riesgo sobre producción es verificable por ausencia:**
   - huellas del entorno y de PM2 de los procesos productivos antes y después;
   - un mensaje al número productivo sigue llegando a `@3`;
   - un mensaje al número del canary no aparece en la base productiva.

   El riesgo de A sólo se puede reducir probando un cambio en la ruta de entrada de todos los mensajes productivos.
2. **A modifica justo lo que este frente prohíbe tocar,** la ruta de entrada productiva y la plataforma compartida
   (`ChannelIngress`), y además comparte la base productiva con un canary.
3. **El rollback de B no toca producción.** El de A exige cerrar bindings y volver a desplegar el gateway productivo.

**Por qué la «segunda infraestructura de mensajería» está justificada:**

- No es software nuevo: son los mismos binarios de gateway, worker y scheduler, con otro entorno.
- La alternativa (A) obliga a cambiar la plataforma y la ruta productiva.
- Queda como carril reutilizable para F1 y los canaries siguientes.

**Para minimizar costo:**

- Usar el número de prueba de la app de WhatsApp Cloud API de Meta, con el teléfono del owner como destinatario
  verificado, si sirve. Meta lo ofrece para desarrollo; **la disponibilidad y los límites los confirma el owner en
  Meta.**
- Si no sirve, un segundo número.

**Cuándo preferir A:** sólo si el owner necesita probar con el número productivo real, y aun así como un cambio de
plataforma con su propio ADR (extensión de ADR-029 y ADR-036), no como atajo de un canary.

**Estado:** recomendación. **Ninguna topología está autorizada ni desplegada.**

## 6. Plan concreto de la prueba WhatsApp (diez escenarios)

**Prerrequisitos (cada uno con su autorización):**

1. Contrato Discover publicado (Catalog #56) y Discover integrado en R4 (§3), revisado y fusionado.
2. Aprobación de la topología B.
3. Recursos de Meta: número del canary, app y webhook, con el teléfono del owner como único destinatario/allowlist.
4. Infraestructura en la EC2:
   - base separada;
   - procesos `r4-canary-*` en PM2;
   - ruta HTTPS del webhook;
   - archivo de entorno 600 con `R4_CATALOG_V2_*` y la clave Discover.
5. Perfil de sólo lectura:
   - Catalog V2 obligatorio y `catalog.discover`;
   - sin Quote, Checkout, carrito, pagos ni escrituras comerciales;
   - `maxWriteActions` 0, o sólo workspace en la base del canary (decisión del owner).

**Verificación de aislamiento antes del primer mensaje:**

- huellas del entorno productivo y `pm2 ls` sin cambios;
- un solo consumidor del webhook productivo;
- las bases son distintas;
- una prueba de humo con un mensaje al número productivo (sigue en `@3`) y otro al del canary (no aparece en
  producción).

**Escenarios.** El owner escribe al número del canary. Por cada uno se registra, en almacenamiento privado:

- mensaje;
- herramienta y consulta;
- respuesta de Catalog (`requestId`, estado y productos);
- productos usados;
- respuesta de R4;
- latencias;
- errores;
- etiqueta humana;
- si un defecto es del proveedor o del agente.

| # | Escenario | Mensaje de ejemplo | Capacidad esperada | Aprobado si… |
|---|---|---|---|---|
| 1 | Producto exacto | «¿Tienen la barra olímpica de 20 kg?» | `catalog.search` → contexto | Identifica el producto correcto con precio y stock del contexto |
| 2 | Categoría | «¿Qué kettlebells tienen?» | `catalog.discover` | Sólo productos que Discover devolvió como verificados |
| 3 | Necesidad funcional | «Quiero entrenar fuerza en casa con poco espacio» | `catalog.discover` | La necesidad se consolida sin datos personales; candidatos pertinentes |
| 4 | Presupuesto | «Algo para piernas por menos de $100.000» | `catalog.discover` con `maxUnitPriceClp` | Ningún precio por encima; R4 no recalcula precios |
| 5 | Compatibilidad | «¿Estos discos sirven para una barra de 50 mm?» | Discover o contexto | Sólo afirma compatibilidad observada; si no, lo dice |
| 6 | Producto inexistente | «¿Venden la caminadora X-9000?» | `search` / Discover vacío | No ofrece nada inexistente |
| 7 | Stock parcial | «Necesito 25 de este disco» (stock menor) | Contexto de ítem | Informa la cobertura parcial; no promete la cantidad |
| 8 | Comparación | «¿Cuál conviene, la barra A o la B?» | Contextos de producto | Compara sólo con datos observados |
| 9 | Ambigüedad | «Quiero una barra» | `catalog.discover` (`ambiguities`) | Pregunta lo que importa; no elige por el cliente |
| 10 | Refinamiento | Después de 3: «mejor más barato y que se guarde fácil» | `catalog.discover` con restricciones nuevas | Aplica las restricciones nuevas sin perder el contexto |

**Condiciones de detención inmediata:**

- cualquier mensaje del canary en la base productiva;
- cualquier cambio en `@3`;
- una escritura comercial;
- una respuesta con datos de Catalog V1;
- un error de credenciales.

**Evaluación:**

- etiquetas humanas del owner como referencia;
- el juez, si se usa, sólo como señal;
- defectos del proveedor separados de defectos del agente;
- `DISCOVER_QUALITY_ACCEPTED` y `COMMERCIAL_GO` no se aprueban por ejecutar la prueba.

## 7. GitGuardian (PR #49)

- **Justificación:** registrada en el comentario del PR #49 y en el plan del PR #50. Los hallazgos 39720883 y 39720884
  son cadenas sintéticas de prueba, ya reemplazadas en `a020a36`.
- **Historia:** no se reescribió.
- **Clasificación:** la debe hacer el owner, en el panel de GitGuardian y con sus permisos.
- **Credenciales:** no se modificó ninguna auténtica.

## 8. Gates

| Gate | Estado |
|---|---|
| `CATALOG_V2_TECHNICAL_PASS` | **PASS** para la ruta de lectura de R4 (§2) |
| `DISCOVER_WHATSAPP_EVALUATED` | No ejecutado: requiere §3, la topología aprobada y la infraestructura |
| `DISCOVER_QUALITY_ACCEPTED` | No (Catalog #55) |
| `COMMERCIAL_GO` | No |

**Sin cambios:**

- G0 `NOT_APPROVED`;
- canary F1 `NOT_AUTHORIZED`;
- Catalog #54 y Quote #32 `PENDING`;
- `@3` sin cambios.

## 9. Decisiones del owner

1. Aprobar la topología B o elegir A con su ADR.
2. Número de prueba de Meta o segundo número; quién configura la app y el webhook.
3. Si el perfil del canary permite escribir el workspace en su propia base, o ninguna escritura.
4. Seguimiento de Catalog #56: publicar el contrato técnico de Discover sin el gate de calidad.
5. Autorización de infraestructura en la EC2 para la topología elegida, cuando 1–4 estén resueltas.
