---
title: R4 — Canary WhatsApp de Catalog V2 + Discover (detenido antes del tráfico; plan de enrutamiento)
status: R4_CATALOG_V2_DISCOVER_WHATSAPP_CANARY_BLOCKED_ROUTING_PLAN_REQUIRED — PR #49 fusionado; sin tráfico; sin cambios en EC2
mandate: «R4 — Catalog V2 + Discover WhatsApp Canary» (owner, 2026-11-05)
date: 2026-11-05
base: main 1e602f3
---

# R4 — Canary WhatsApp de Catalog V2 + Discover

## 0. Resultado y por qué se detuvo

| Paso del mandato | Resultado |
|---|---|
| §2 PR #49 | **Fusionado** con merge commit: `main` = `1e602f3` (§1) |
| §3 Integración Discover | **Ninguna de las tres rutas que usa R4 pasa por Discover** (§2). La integración está diseñada (§4) y no implementada: depende de la topología del §3 y de un contrato aún no publicado |
| §4 Canary aislado | **Detenido antes del tráfico.** No hay forma de que mensajes reales de WhatsApp lleguen a un canary sin modificar el enrutamiento compartido o sin un segundo número. El mandato pide detenerse y presentar un plan: §3 |
| §5 Evaluación | Diez escenarios preparados, con protocolo y registro (§5). **No ejecutados** |
| §7 Gates | Sin cambios de aprobación (§6) |

**Lo que no se hizo:**

- ningún mensaje real ni sintético hacia Catalog V2;
- sin cambios en EC2;
- sin tocar el webhook, el gateway ni el worker productivos;
- `@3` sin cambios;
- sin llamadas a modelos;
- sin escrituras.

## 1. PR #49

**Verificación:**

- **HEAD y diff:** HEAD `a020a36` sobre `main` `6962ae7`.
- **Diff:** adaptador, configuración, CLI del canary, pruebas y documento, como se revisó, más un commit que reemplaza dos
  claves sintéticas de prueba por valores calculados.
- **Pruebas:** las dos suites nuevas 28/28, typecheck 0 y lint 0 sobre `a020a36`. La L2 proporcional se había
  ejecutado sobre `e62fc94`:
  - unit 1631;
  - contrato 487;
  - integración seleccionada 61;
  - mutaciones 8/8 y 13/13.

**Revisión de seguridad:**

- la configuración nunca registra ni describe el valor de la clave;
- los errores 401/403 nombran la variable, nunca su valor;
- la telemetría no lleva clave ni cuerpo;
- sin fallback a V1;
- producción no puede elegir V2 por configuración;
- la clave de Discover no se lee.

**GitGuardian:**

- **Hallazgos 39720883 y 39720884:** «Generic High Entropy Secret». Son **falsos positivos**: los cadenas sintéticas
  de prueba `v1-key-…` y `v2-key-…` del commit `e62fc94`, que nunca fueron credenciales de ningún servicio.
- **`a020a36`:** las reemplaza por valores calculados; el árbol actual no las contiene.
- **Historia:** reescribir `e62fc94` fue rechazado por el control de permisos de la sesión, así que el check sigue en
  rojo porque escanea todos los commits del PR.
- La justificación quedó como comentario en el PR.
- **Acción del owner:** marcar los incidentes como *false positive / test credential* en el panel. No hay nada que rotar.

**Merge:** `main` = `1e602f3`, árbol idéntico al HEAD revisado.

## 2. Auditoría: ¿qué motor de Catalog responde cada consulta de R4?

Se leyó el código de Catalog en `5f2c086` (el desplegado), en sólo lectura.

| Capacidad de R4 | Ruta | Código de Catalog que responde | ¿Usa Discover? |
|---|---|---|---|
| `catalog.search` | `POST /v2/catalog/search` | `catalogV2Routes.ts` → `CatalogContractService.search` → `domain/catalog/v2/nominalSearch.ts` (`matchNominal`/`compareNominal`). El propio archivo dice: «It is not conceptual discovery» | **No.** Búsqueda nominal y léxica (`searchMode: "lexical"`) |
| `catalog.get_product_context` | `GET /v2/catalog/products/{k}/context` | `catalogV2Routes.ts` → `CatalogContractService` (contexto de producto) | **No** |
| (contexto de ítem para preview/quote) | `GET /v2/catalog/items/{k}/context` | `catalogV2Routes.ts` → `CatalogContractService` (verdad comercial del ítem) | **No** |
| — | `POST /v2/catalog/discover` | `catalogDiscoverRoute.ts` (CAT-DISCOVER-V1-B1), motor propio | Es Discover. **R4 no lo llama:** una prueba fija que el adaptador sólo usa las tres rutas anteriores |

**Notas:**

- La relación existe en la otra dirección: Discover reutiliza el lector de contexto de producto
  (`CAT-DISCOVER-C2`) y el presupuesto de precio unitario compartido con la búsqueda.
- **No hay trazas de ejecución:** nada llamó a V2 desde R4 y leer los logs de la EC2 no está autorizado. La conclusión
  se apoya en el código y en la prueba del adaptador.

## 3. Por qué el canary no puede recibir WhatsApp real hoy, y opciones

**Hechos (código de R4 en `main`):**

1. **Un solo consumidor del proveedor.** `r4-channel-gateway` es el único proceso que habla con WhatsApp
   (`SALES_PRODUCTION_PROCESSES`): recibe el webhook en `/v1/channels/:channel/webhook`, escribe el inbound, el binding
   y la tarea **en la base productiva**, y despacha la salida.
2. **El gateway decide la versión de la tarea.** `salesConversationTaskFactory` fija cada conversación a la definición
   del perfil productivo (`@3` → `sales@4`), y el worker productivo sólo atiende ese perfil.
3. **El canary existente es sintético.** Su entrada es `sendSynthetic` y su salida un `CaptureOutboundAdapter` que
   escribe a un archivo: nada sale a WhatsApp. `startCanaryGateway` sólo es el inspector de identidad de `@8`, no una
   entrada de WhatsApp.
4. **Las credenciales son por número:** `R4_WHATSAPP_PHONE_NUMBER_ID`, el token de acceso, el secreto de la app y el
   token de verificación pertenecen al número productivo.

**Consecuencia:** para que mensajes reales de la allowlist lleguen a Catalog V2 + Discover hay que hacer una de dos
cosas:

- cambiar quién consume el webhook o cómo enruta el gateway compartido;
- usar otra entrada de WhatsApp.

Lo primero es exactamente lo que el mandato pide no hacer sin un plan.

| Opción | Qué es | Webhook y gateway compartidos | `@3` | Aislamiento | Cambios necesarios | Recomendación |
|---|---|---|---|---|---|---|
| **A. Número de WhatsApp dedicado al canary** | Un segundo número (o el número de prueba de Meta) con su propia app y webhook, servido por un **gateway del canary** sobre la **base del canary**. Worker del canary con un perfil de sólo lectura (Catalog V2 + Discover) | **Sin cambios** | Sin cambios | Total: otra base, otro número, otras credenciales; el owner escribe a otro número | Meta: número, app, webhook y token. EC2: ruta HTTPS pública para el nuevo webhook y procesos del canary. R4: entrada y salida reales en el canary (hoy son sintéticas), el perfil de sólo lectura con Discover y su definición | **Sí** |
| B. Enrutamiento por allowlist en el gateway compartido | El gateway productivo crea las tareas de la allowlist con otra versión, y un segundo worker con el perfil del canary las atiende en la base productiva | **Se modifica** | El proceso cambia, aunque el perfil no | Parcial: misma base, mismo gateway, mismo número | Código del gateway productivo, despliegue productivo, un segundo worker productivo | No: es justo el cambio de enrutamiento compartido, con la base productiva compartida |
| C. Reenvío desde el gateway compartido al canary | El gateway productivo reenvía los mensajes de la allowlist al canary | **Se modifica** | El proceso cambia | Parcial | Código y despliegue del gateway productivo | No |
| D. Cambio temporal del perfil productivo | El worker productivo corre un perfil V2 durante una ventana | — | **Cambia** | Ninguno | — | Excluida por el mandato |

**Plan detallado de la opción A (para aprobar; nada ejecutado):**

1. **Meta (owner):** un número dedicado al canary, con app y webhook propios y un token de acceso con permisos sólo
   sobre ese número. La allowlist del canary contiene sólo el teléfono del owner.
2. **R4 (código, PR revisable):**
   - modo de canal real del canary: reutilizar el adaptador WhatsApp existente con `R4_CANARY_WHATSAPP_*` (variables
     propias, nunca las productivas) y un proceso de entrada del canary sobre su base aislada
     (`assertIsolatedCanaryDatabase`);
   - un perfil sólo canary de lectura: Catalog V2 (`R4_CANARY_CATALOG_SOURCE=v2`, obligatorio), Discover y Shipping
     opcional. Sin Quote, Checkout, carrito, pagos ni escrituras comerciales. Escritura sólo del workspace de Sales
     en la base del canary, o ninguna (decisión 3);
   - la definición candidata correspondiente;
   - pruebas de que el canary rechaza las credenciales WhatsApp productivas y la base productiva.
3. **EC2 (autorización propia):**
   - una ruta HTTPS pública nueva para el webhook del canary, sin tocar la productiva;
   - los procesos del canary en PM2 con su archivo de entorno 600;
   - las claves R4 de Catalog V2 copiadas desde el archivo de entrega.
4. **Verificación de aislamiento antes del tráfico:**
   - el webhook productivo sigue con un solo consumidor;
   - las bases son distintas;
   - el perfil `@3` y su entorno no cambian (huella del entorno antes y después);
   - un mensaje al número productivo sigue llegando a `@3`;
   - un mensaje al número del canary no aparece en la base productiva.
5. **Rollback:** detener los procesos del canary y quitar la ruta del webhook del canary. Producción nunca cambió.

## 4. Integración de Discover (diseño; no implementado)

**Contrato a consumir:** `catalog-discover-v1b1`, `schemaVersion 1`, `POST /v2/catalog/discover`, con la clave
Discover de R4.

- El owner define una **lectura tolerante** para consumidores: campos desconocidos ignorados, vocabularios abiertos
  aceptados y enums cerrados estrictos.
- **Estado:** contrato preparado, no publicado (nivel 2); fixtures `SYNTHETIC_FIXTURES_NOT_PUBLISHED`, 24 respuestas y
  12 errores.

| Pieza | Diseño | Regla |
|---|---|---|
| Adaptador | `HttpCatalogAdapter.discover()` en el mismo adaptador. Sólo fuente `v2`. Clave `R4_CATALOG_V2_DISCOVER_API_KEY` (usada sólo para esa ruta) | Reutiliza el transporte, la clasificación de errores y la telemetría. Sin fallback a V1: con `v1`, `discover` no existe |
| Esquema | Copia de consumidor de la lectura tolerante del owner (`agentContract.ts`), fijada por hash como los fixtures actuales | No se replica búsqueda, ranking ni ontología: R4 sólo valida y transporta |
| Semántica | `COMPLETE`, `DEGRADED` y `PARTIAL` son respuestas válidas. `commercial.status` distinto de `OBSERVED` (`EXPIRED`, `UNKNOWN`) nunca se presenta como vendible. Una disposición distinta de `VERIFIED_MATCH` no es un producto verificado | Precio y stock para cotizar siguen saliendo del contexto del ítem |
| Errores | 403 → `unauthorized`. 503 `capability_saturated`, `capability_not_ready` y similares → `temporarily_unavailable`. `capability_disabled` e `index_incompatible` → falla de operación | Un error nunca es «no hay productos» |
| Capacidad de Sales | `catalog.discover` (lectura): necesidad en palabras del cliente consolidada por el agente, sin datos personales, con límite y restricciones del contrato | Convive con `catalog.search` (nombres y SKU). La elección la registra la traza (§5) |
| Composición | Sólo en el perfil del canary de la opción A | Ningún perfil productivo la compone |

**Por qué no se implementó ahora:**

- **Contrato no publicado:** el owner advierte que puede cambiar al publicarse.
- **Depende de la topología:** el perfil y la definición dependen de la opción que elija el owner (§3).
- **Costo de hacerlo antes:** implementar ahora fijaría un consumidor sobre un borrador y requeriría una definición
  nueva, sin poder usarse hasta resolver la entrada de WhatsApp.

**Es lo primero que se haría** una vez aprobado el plan.

## 5. Evaluación preparada (diez escenarios; no ejecutada)

**Registro por escenario** (almacenamiento privado: la carpeta de evidencia del canary en la EC2 o una rama local que
no se publica):

- mensaje (sin datos personales en el informe);
- herramienta invocada y consulta enviada;
- respuesta de Catalog (`requestId`, estado y productos);
- productos usados por R4;
- respuesta de R4;
- latencia de Catalog y del turno;
- errores;
- etiqueta humana;
- clasificación del defecto (proveedor o agente).

| # | Escenario | Mensaje de ejemplo | Ruta esperada | Defecto del proveedor si… | Defecto del agente si… |
|---|---|---|---|---|---|
| 1 | Producto exacto | «¿Tienen la barra olímpica de 20 kg?» | `search` (nominal) o Discover con coincidencia exacta; luego contexto | No aparece el producto existente; identidad equivocada | Elige otro producto o inventa atributos |
| 2 | Categoría | «¿Qué kettlebells tienen?» | Discover | Resultados fuera de la categoría | Lista algo que Catalog no devolvió |
| 3 | Necesidad funcional | «Quiero entrenar fuerza en casa con poco espacio» | Discover | Candidatos irrelevantes para la necesidad | No consolida la necesidad o pregunta de más |
| 4 | Presupuesto | «Algo para piernas por menos de $100.000» | Discover con `maxUnitPriceClp` | Devuelve precios sobre el límite | Ignora el límite o recalcula precios |
| 5 | Compatibilidad | «¿Estos discos sirven para mi barra de 50 mm?» | Discover o contexto de producto | Atributo de diámetro equivocado | Afirma compatibilidad no observada |
| 6 | Producto inexistente | «¿Venden caminadoras eléctricas X-9000?» | `search` / Discover vacío | Inventa una coincidencia | Ofrece un producto inexistente |
| 7 | Stock parcial | «Necesito 8 de este disco» (con stock menor) | Contexto de ítem (`stockCoverage`) | Cobertura mal informada | Promete las 8 unidades |
| 8 | Comparación | «¿Cuál conviene más, la barra A o la B?» | Contexto de producto de ambas | Datos inconsistentes | Compara con datos no observados |
| 9 | Ambigüedad | «Quiero una barra» | Discover (`ambiguities`) | No marca la ambigüedad | No pregunta lo que importa |
| 10 | Refinamiento | Después de 3: «mejor algo más barato y que se guarde fácil» | Discover con restricciones nuevas | Ignora las restricciones nuevas | Pierde el contexto anterior |

**Criterios:**

- **Calidad:** las etiquetas humanas del owner son la referencia; un juez, si se usa, es sólo una señal.
- **Separación:** un defecto se atribuye al proveedor cuando la respuesta de Catalog ya es incorrecta, y al agente
  cuando Catalog es correcto y R4 lo usa mal.

## 6. Gates

| Gate | Estado | Nota |
|---|---|---|
| `CATALOG_V2_TECHNICAL_PASS` | **Parcial, no aprobado.** Contrato consumidor y exactitud offline aprobados (#49). La conectividad desde el runtime de R4 con sus claves la verificó Catalog (20/20). Falta una lectura real desde un proceso de R4 | Requiere la opción A o una verificación de sólo lectura autorizada en la EC2 |
| `DISCOVER_WHATSAPP_EVALUATED` | **No ejecutado** | Requiere §3 y §4 |
| `DISCOVER_QUALITY_ACCEPTED` | **No** | Catalog #55. El canary aporta evidencia, pero no la aprueba automáticamente |
| `COMMERCIAL_GO` | **No** | — |

Se mantienen:

- G0 `NOT_APPROVED`;
- canary F1 `NOT_AUTHORIZED`;
- Catalog #54 y Quote #32 `PENDING`;
- `@3` sin cambios.

## 7. Decisiones que se necesitan

1. **Topología:** aprobar la opción A (número dedicado) o elegir otra. La B y la C modifican el enrutamiento compartido.
2. **Recursos de Meta:** ¿hay un segundo número o se usa el número de prueba de Meta? ¿Quién crea la app y el webhook?
3. **Escrituras en el canary:** perfil sin ninguna escritura, o con escritura sólo del workspace de Sales en la base
   del canary.
4. **Discover sobre un contrato no publicado:** implementar ya el consumidor sobre `catalog-discover-v1b1` (borrador),
   o esperar la publicación del nivel 2.
5. **Autorización de EC2:** la ruta del webhook del canary, los procesos y los secretos, cuando 1–3 estén decididos.
6. **Opcional, para cerrar el gate técnico antes:** una lectura de sólo lectura con el adaptador de R4 contra V2 en la
   EC2, sin tráfico de WhatsApp.
