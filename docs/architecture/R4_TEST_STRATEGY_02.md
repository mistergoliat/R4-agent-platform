---
title: R4 — estrategia de pruebas 02, validación progresiva por riesgo
status: R4_TEST_STRATEGY_02_READY_FOR_REVIEW
mandate: «R4 — Risk-Based Development Validation» (owner)
date: 2026-11-02
---

# R4: estrategia de pruebas 02

## 1. Conclusión

Hoy cada cambio, por pequeño que sea, se valida con la cadena completa, que tarda entre 3,5 y 5 horas. Esta estrategia la divide en cuatro niveles. El desarrollo corre sólo lo que el cambio puede romper, mientras que el PR y el release conservan la cadena completa. Ninguna garantía crítica se valida con menos pruebas que hoy. Cuando un cambio toca una garantía protegida (§6), se corren todas sus pruebas y mutaciones desde L1, sin selección.

| Nivel | Cuándo | Duración objetivo | Mutaciones |
|---|---|---|---|
| **L0** | Ciclo de edición | 1–5 min | Ninguna, o una puntual |
| **L1** | Cierre de una funcionalidad | 10–40 min | Las suites cuyo código muta el diff |
| **L2** | Integración y PR | ~1 h más las mutaciones seleccionadas | Las suites del diff y las de cada garantía tocada. Todas, si el cambio es transversal |
| **L3** | Release y despliegue | Igual que hoy | Las 18 suites |

**Qué no cambia:** los gates de producción, los resultados de G1 y G2, los scripts de mutación, el criterio de aceptación de una mutación (N/N detectadas), el protocolo v5 y el runtime. Este documento no modifica código.

**Ahorro principal** (§10): la mayor parte del tiempo de mutación es arranque de procesos, no prueba. Agrupar los tests de cada mutación en un solo proceso reduciría L2 y L3 sin cambiar qué se exige. Es una propuesta y no está implementada.

## 2. Tiempo medido hoy

Hay tres cadenas completas medidas, todas en Windows con Node 22 y Postgres local en Docker: ensayo A (2026-10-31), candidata B (2026-11-02) y R7-1. En la segunda, otra carga de trabajo compartía la máquina, y eso la hizo entre 1,5 y 2 veces más lenta.

| Paso | Mín. | Prom. | Máx. | Nota |
|---|---|---|---|---|
| `npm ci` | 45 s | 91 s | 180 s | Sólo en un worktree limpio |
| build (`tsc -b`) | 41 s | 62 s | 92 s | Incremental si se conserva `dist` |
| typecheck | 29 s | 36 s | 48 s | Todo el repositorio |
| lint | 62 s | 93 s | 141 s | ESLint con tipos, sin caché |
| unit | 38 s | 49 s | 69 s | 1535 tests. El arranque (import) pesa más que la ejecución |
| contract | 20 s | 28 s | 42 s | 462 tests. Barato, y cubre fronteras que nada más cubre |
| **integration** | **1269 s** | **1428 s** | **1588 s** | 703 tests en 50 archivos, en serie (`--no-file-parallelism`) |
| sales | 78 s | 113 s | 178 s | |
| shadow | 89 s | 120 s | 176 s | |
| recovery | 118 s | 140 s | 162 s | En serie y **aislado**: reinicia el contenedor de Postgres |
| **Mutaciones, 10 suites** | ~62 min | — | ~110 min | El resto, unos 8, no tiene medición en cadena |

**Distribución.** Sin mutaciones, la cadena dura unos 35–45 min, y integration consume el 60 % de ese tiempo. Las mutaciones agregan entre 1 y 2 horas para 10 suites, y entre 2 y 3,5 horas para las 18. Son el 65–75 % del total.

**Por qué las mutaciones son lentas.** Cada script lanza un `npx vitest run` por cada par mutación×test, más una pasada base por test. `turn-guard` hace unas 64 invocaciones para 24 mutaciones, a 12–22 s cada una, y la mayor parte de ese tiempo es arrancar `npx` y vitest y transformar los imports. En unit, el import acumulado es de 216 s contra 66 s de ejecución.

**Lo que no se puede medir hoy.** El reporter por defecto no deja la duración por archivo de integration, así que no se sabe qué archivos dominan. Medirlo es el primer paso de §10.

**Inestabilidad observada.** Con la máquina cargada, `identity-http-contract`, la prueba de procedencia de CIA, superó su límite de 5 s. Repetida sobre el mismo árbol pasó. Desde R7-1 se registran también de 1 a 2 timeouts por corrida en integration en paralelo, y por eso integration corre en serie.

## 3. Niveles: matriz de pruebas

**✓** = obligatorio. **S** = seleccionado según §5. **—** = no se corre.

| Paso | L0 desarrollo | L1 cierre | L2 integración/PR | L3 release |
|---|---|---|---|---|
| Worktree limpio, `npm ci` | — | — | ✓ | ✓ |
| build | S, incremental | ✓, incremental | ✓, desde cero | ✓, desde cero |
| typecheck | ✓ | ✓ | ✓ | ✓ |
| lint | S, con caché, sobre los archivos tocados | ✓, con caché | ✓, sin caché | ✓, sin caché |
| unit | S | ✓ | ✓ | ✓ |
| contract | S | ✓ | ✓ | ✓ |
| integration | S, por archivo | S, más todos los archivos de las garantías tocadas | ✓, en serie | ✓, en serie |
| sales | S | S | ✓ | ✓ |
| shadow | — | S | ✓ | ✓ |
| recovery | — | S, aislado | ✓, aislado | ✓, aislado |
| interop (CIA y CP) | — | — | S | S. Obligatorio si cambian CIA, CP o sus adaptadores |
| Mutaciones | — o puntual (§7) | S, las suites del diff | S, las del diff y las de las garantías tocadas. ✓ todas si el cambio es transversal | ✓, las 18 |
| Gates del mandato (G-sem, canary, verificaciones) | — | — | — | Según el mandato |
| Registro de evidencia (§8) | No requerido | ✓ | ✓, en el PR | ✓, sobre el SHA que se despliega |

Reglas comunes:
- **contract corre completo desde L1.** Cuesta menos de un minuto, y sus pruebas de frontera (`core-purity`, `dependency-boundaries`, `frozen-migrations`, entre otras) leen archivos por ruta. La selección por imports no las encontraría.
- **recovery nunca corre a la vez** que otra suite ni que un experimento sobre el mismo Postgres, porque termina conexiones del servidor.
- **L2 y L3 se corren sobre el árbol del merge**, no sobre la punta de la rama, porque es lo que va a quedar en `main`.
- **L3 se corre sobre el SHA exacto que se despliega.**

## 4. Criterios de riesgo

Un cambio se clasifica por la combinación de tres ejes. El nivel mínimo en el PR nunca baja de L2. El riesgo determina cuánto de L2 se selecciona y cuánto corre ya en L1.

**Eje 1. Alcance según el grafo de paquetes.** Las dependencias se leen de `package.json`.

| Zona | Paquetes | Quién depende de ella | Riesgo |
|---|---|---|---|
| **Transversal** | `contracts`; `persistence-postgres` y sus migraciones; `task-runtime`; `agent-kernel`; `context-compiler`; `live-ops` | Casi todo el runtime. `persistence-postgres` depende de siete paquetes, y `worker` de diez | Alto |
| **Proceso** | `apps/worker`, `apps/channel-gateway`, `apps/api`, `apps/scheduler` | Sólo despliegue | Medio–alto |
| **Hoja** | `policy-engine`, `capability-runtime`, `agent-registry`, `model-gateway`, `observability` | Pocos | Medio |
| **Fuera de Core** | `adapters/*`, `agents/sales` (salvo `production/`) | El pack y sus pruebas | Medio |
| **Pack productivo** | `agents/sales/src/production/`, definiciones `sales*.agent.json`, perfiles | El comportamiento que ve el cliente | Alto |
| **Herramientas** | `scripts/`, `tests/support`, `tests/mutation` | Las pruebas | Medio: pueden invalidar evidencia |
| **Documentación** | `docs/**/*.md` | La prueba de contrato que lee documentos (`production-topology`) | Bajo |

**Eje 2. Garantías protegidas tocadas (§6).** Basta con tocar una para que su conjunto de pruebas y mutaciones corra completo desde L1.

**Eje 3. Tipo de cambio.**

| Tipo | Riesgo mínimo |
|---|---|
| Sólo `.md` | Bajo |
| Sólo pruebas o fixtures | Medio: puede debilitar una garantía. Corre la suite tocada y las mutaciones que la usan |
| Runtime | Según los ejes 1 y 2 |
| Migración | **Alto, siempre** |
| Definición, perfil o protocolo | **Alto, siempre** |
| Dependencias (`package-lock.json`) o configuración de build, lint o test | **Alto: transversal** |

**Transversal** significa riesgo alto en el eje 1, una migración o un cambio de dependencias o configuración. Un cambio transversal se valida con la cadena completa en L2, con todas las mutaciones.

## 5. Reglas de selección

Para cada modificación:

1. **Archivos modificados.** `git diff --name-only <base>...HEAD`, sobre el merge con la base y no sólo sobre la rama.
2. **Dependencias.**
   - Pruebas que importan los archivos tocados: `npx vitest related --run <archivos>`. Vitest recorre el grafo de imports, incluidos los alias.
   - Paquetes afectados: la tabla del eje 1.
   - Lo que el grafo no ve, y por eso se agrega a mano: archivos leídos por ruta (contract, ya incluido completo), SQL leído por las migraciones y fixtures cargados con `readFileSync`.
3. **Invariantes.** Contra la tabla de §6: qué garantía protegida vive en los archivos tocados.
4. **Selección.** La unión de:
   - las pruebas de `vitest related`;
   - todos los archivos de prueba de cada garantía tocada;
   - contract completo, desde L1;
   - las suites de mutación del diff (§7).
5. **Ejecución.** En serie lo que comparte recursos (§10, O-4). recovery siempre aislado.
6. **Registro de lo omitido**, con su motivo (§8). Si algo se omite y no queda registrado, la evidencia no vale para L1 ni para L2.

**Nunca se seleccionan a la baja:**
- las pruebas de una garantía protegida tocada;
- contract, desde L1;
- las pruebas que el propio cambio agrega o modifica;
- las mutaciones de una suite cuyo código muta el diff.

## 6. Garantías protegidas

Cuando un cambio toca el código de una garantía, desde L1 se corren completos sus archivos de prueba y sus suites de mutación, y recovery cuando figura en la fila.

| Garantía | Código principal | Pruebas | Mutaciones |
|---|---|---|---|
| **Idempotencia** | `persistence-postgres/src/production-store.ts` (deduplicación de entrada y salida), `live-ops/src/delivery.ts`, claves de ejecución gobernada | `live-ops-reference` (replay), `governed-execution`, `run-failure-fallback`, `turn-completion-guard` (H-7); unit `live-ops/delivery` | `production`, `run-failure-fallback`, `turn-guard` |
| **Persistencia** | `persistence-postgres/src/*` | `restart-persistence`, `task-runtime`, `context-snapshots`; recovery `database-restart` | Las suites que mutan `persistence-postgres` |
| **Serialización** | `production-store.ts` (orden de entrada y takeover), `execution-leases`, `temporal-runtime.ts` | `live-ops-reference` («serializes inbound»), `execution-leases`, `binding-identity-immutability` (carreras) | `production`, `binding-immutability` |
| **Recuperación** | `task-runtime/src/execution-runtime.ts`, `temporal-runtime.ts`, `apps/worker/src/session.ts`, `contracts/src/run.ts` | `run-failure-recovery`, `runtime-contingency`, `worker-recovery`, `governed-execution-recovery`; **recovery completo** | `run-failure-recovery`, `runtime-contingency` |
| **Autorizaciones** | `policy-engine`, `live-ops/src/autonomy.ts`, `administration.ts`, autenticación de operador, aprobaciones (`human-collaboration`) | `production-control`, `human-collaboration`, `governed-execution`; contract `operator-auth-boundaries`, `governed-execution-boundaries` | `production-control`, `production` |
| **Conciliación** | `capability-runtime`, conciliación de ejecuciones gobernadas | `reconciliation`, `governed-execution-recovery`; recovery `governed-write-crash` | `runtime-contingency` (usa `reconciliation`) |
| **Integridad de migraciones** | `*/migrations/*.sql` | `migrations`, `migration-upgrade`, `migration-upgrade-c2`; contract `frozen-migrations` | `binding-immutability`, `identity-verification-state`, `production` (mutan SQL) |
| **Control de ejecución** | `live-ops` (kill switch, rollout, autonomía), `agents/sales/src/production/control.ts`, `worker/presence`, perfiles fijados | `production-control`, `worker-readiness`, `profile-pinned-claims`, `production-bootstrap`; recovery `production-control-process`, `worker-presence-process` | `production-control`, `production`, `worker-readiness`, `profile-v8` |
| **Outbox** | `live-ops/src/outbound.ts`, `delivery.ts`, tablas `outbound_*` | `live-ops-reference`, `live-ops-hardening`, `run-failure-fallback`; unit `live-ops/delivery` | `production`, `run-failure-fallback` |
| **Pagos** | Aún no existe en R4. Llegará con J5.5 Checkout & Payments (PRD §40 R4-L): capacidades de checkout y pago y sus adaptadores, fuera de Core | Las que entregue J5.5, con su contrato HTTP, idempotencia y conciliación | Las que entregue J5.5. Una capacidad de pago **no se acepta sin su suite de mutación** |

**Pagos es más estricto que el resto.** Todo cambio que toque una capacidad, un adaptador o una política de pago se valida como L3 en cualquier nivel desde L1: cadena completa, todas las mutaciones e interop contra el servicio real o su doble contractual. **La selección de §5 nunca se aplica a pagos.** Su evidencia se invalida con cualquier cambio en el adaptador, en el servicio externo o en su contrato (§9.7).

La tabla se mantiene junto con el código. Cuando un cambio agrega una garantía, o mueve su código, la tabla se actualiza en el mismo PR.

## 7. Política de mutaciones

**Qué suites corresponden a un diff.** Son las suites que mutan algún archivo tocado por el diff. Los scripts nombran sus fuentes con la ruta completa:

```bash
F=$(git diff --name-only <base>...HEAD -- packages apps adapters agents)
for m in tests/mutation/*-mutations.mjs; do for f in $F; do grep -qF "'$f'" "$m" && { echo "$m"; break; }; done; done
```

La comprobación cubre las 18 suites actuales. Si una suite llega a construir las rutas dinámicamente, hay que revisarla a mano.

| Nivel | Qué se corre |
|---|---|
| L0 | Nada, o la mutación puntual del invariante que se está editando (requiere O-3) |
| L1 | Las suites del diff, más las mutaciones nuevas de los invariantes nuevos. La evaluación se entrega con la implementación |
| L2 | Las suites del diff y las de cada garantía tocada (§6). **Todas**, si el cambio es transversal |
| L3 | Las 18 suites, sobre el SHA del release |

Reglas que no cambian:
- **Aceptación: N/N detectadas.** Una mutación que sobrevive es un fallo. Ningún umbral se relaja.
- **Una línea base roja invalida la corrida.**
- **`SKIPPED` cuenta como fallo.** Si el ancla cambió, se reapunta en el mismo PR y se revisa que siga mutando la misma garantía. El antecedente es H-8 en G2.
- **No se eliminan scripts ni mutaciones.** Una mutación obsoleta sólo se retira con decisión registrada del owner.
- **No se editan fuentes mientras corre una cadena**, porque los scripts restauran lo que leyeron al empezar. Para detener una cadena hay que matar también el shell padre.

**Ejemplo de esta semana.** En el PR de R7, las suites del diff son 10: `runtime-contingency`, `run-failure-recovery`, `run-failure-fallback`, `turn-guard`, `production`, `production-control`, `worker-readiness`, `profile-v8`, `canary-j4` e `identity-verification-ingress`. La primera cadena corrió `binding-immutability` y `shadow` en lugar de las dos últimas. Aplicando la regla, las dos faltantes se corrieron antes del merge y detectaron 13/13 cada una. Las 12 suites sumaron 161/161, y el informe de integración registra las 6 que no se corrieron.

## 8. Evidencia

Cada validación de L1 o superior deja un registro con estos campos:

| Campo | Contenido |
|---|---|
| Identidad | Commit **y árbol** probado (`git rev-parse HEAD^{tree}`), base y, en L2, el árbol del merge |
| Nivel y clasificación | L1, L2 o L3; zona, garantías tocadas y tipo de cambio (§4) |
| Diff | Archivos tocados |
| Ejecutado | Cada suite, con el comando y su resultado (tests y mutaciones N/N) |
| Omitido | Cada suite que la matriz pedía y no se corrió, con su motivo |
| Motivo de la selección | Qué regla de §5 incluyó cada suite seleccionada |
| Repeticiones | Toda prueba fallida que se repitió: el error original (timeout o aserción), el árbol de la repetición y su resultado |
| Entorno | SO, Node, imagen de Postgres y carga concurrente conocida |
| Riesgos residuales | Lo que la selección no cubre |

Los logs completos pueden contener rutas locales o datos operativos. Por eso se guardan fuera del repositorio público, y el informe cita su resumen.

Una prueba que falla y pasa al repetirse **no cuenta como verde** si no se clasifica. Un timeout repetido sobre el mismo árbol puede aceptarse, registrándolo. Un fallo de aserción no se acepta por repetición.

## 9. Invalidación de evidencia

La evidencia previa se reutiliza **sólo si sus condiciones de validez se mantienen**. Esas condiciones se definen por árbol, no por fecha.

**Sigue siendo válida** cuando el árbol nuevo difiere del probado sólo en archivos que ninguna prueba lee: `.md` fuera de los que lee `production-topology`. Hay que mostrarlo con `git diff --name-only <árbol probado> <árbol nuevo>`.

**Se invalida** cuando cambia cualquiera de estos:
1. Runtime: `packages`, `apps`, `adapters`, `agents`.
2. Pruebas, fixtures, `tests/support` o un script de mutación.
3. `package.json`, `package-lock.json`, `tsconfig*`, `eslint.config.js`, `vitest.config.ts` o `docker-compose.yml`.
4. Una migración.
5. La base. Un rebase o un merge con una `main` que cambió en cualquiera de las rutas 1 a 4 invalida aunque el diff propio sea igual.
6. El entorno: versión mayor de Node, imagen de Postgres o un valor por defecto de configuración.
7. Para interop, canary o G-sem: la versión del servicio externo, del modelo o de la definición.

Más reglas:
- La evidencia de **otra candidata** no se reutiliza, salvo que su árbol sea idéntico en las rutas 1 a 4.
- Lo que el owner excluya expresamente no se reutiliza aunque sea idéntico. Es el caso de la candidata A frente a la B en la integración de R7.
- **G1 y G2 no se reabren.** Sus resultados siguen valiendo para los commits que aprobaron. Esta política sólo rige validaciones nuevas.

## 10. Propuesta de optimización

Ninguna de estas propuestas está implementada. Las estimaciones se derivan de §2, salvo donde se indica que hay que medir antes.

| # | Propuesta | Efecto estimado | Riesgo | Prerrequisito |
|---|---|---|---|---|
| **O-1** | **Medir por archivo**: integration con `--reporter=default --reporter=json --outputFile=…`, guardando la duración de cada archivo y cada test | Ninguno por sí sola. Sin ella, O-4 y O-5 son conjeturas | Nulo | Ninguno |
| **O-2** | **Agrupar las mutaciones**: un proceso de vitest por mutación y archivo, con los tests listados en un `-t` combinado y el reporter JSON para verificar que **cada** test listado falla. La línea base se agrupa por archivo | Las invocaciones de `turn-guard` bajan de ~64 a ~30. Se estima un 40–60 % menos de tiempo de mutación: de ~1–2 h a ~0,5–1 h en L2. **Hay que medirlo** | Bajo. El criterio no cambia: cada test listado sigue teniendo que fallar por separado | Una utilidad común para los 18 scripts. Es un cambio de herramientas, no de runtime |
| **O-3** | **Filtro `--only <id>`** en los scripts, para L0 y L1 | Una mutación en ~1 min en lugar de la suite | Nulo en L2 y L3, donde se corre la suite completa | O-2, o un cambio menor por script |
| **O-4** | **Integration en paralelo limitado** (`--maxWorkers=2`–`4`) **sólo en L0 y L1**. L2 y L3 siguen en serie | Integration podría bajar de 21–26 min a ~8–12 min | Medio. Cada archivo crea su propia base (`createTestDatabase`), pero hay timeouts conocidos en paralelo. Antes hay que identificar los archivos que comparten recursos (puertos, procesos) y dejarlos en serie | O-1 y un inventario de recursos compartidos |
| **O-5** | **Base de plantilla**: `globalSetup` migra una vez y cada archivo usa `CREATE DATABASE … TEMPLATE`. La clave de la plantilla es un hash de las migraciones. `migrations`, `migration-upgrade*` y recovery siguen migrando de verdad | Desconocido: depende de cuánto pesa migrar por archivo. **Medir con O-1** | Medio. Una plantilla vieja ocultaría un error de migración, y por eso depende del hash | O-1 |
| **O-6** | **Reutilizar el build** en L0 y L1 (`tsc -b` incremental, sin limpiar `dist`). L2 y L3 siguen limpios | 40–90 s por ciclo | Bajo. Un `dist` viejo afecta a recovery y a los CLI, que resuelven `@r4/*` por `node_modules` | No compartir `node_modules` entre worktrees por junctions, como ya se hizo, en L2 y L3 |
| **O-7** | **`eslint --cache`** en L0 y L1 | La mayor parte de 60–140 s | Nulo en L2 y L3, que corren sin caché | Ninguno |
| **O-8** | **Timeout explícito** en la prueba de procedencia de CIA, que hashea 48 archivos con un límite de 5 s | Elimina un fallo espurio bajo carga | Bajo. Es un límite de tiempo, no un criterio de aceptación, pero cambiarlo requiere decisión del owner | Decisión del owner |
| **O-9** | **No correr L2 ni L3 junto a otras cargas pesadas** (otros repositorios en Docker) | Hasta 2x | Nulo | Disciplina operativa |

**Paralelismo que no se propone**, porque no es seguro sobre recursos compartidos:
- recovery junto a cualquier otra cosa;
- dos suites de mutación en el mismo worktree, porque editan las mismas fuentes;
- L2 y L3 en paralelo.

Dos suites de mutación **en worktrees distintos** son seguras en cuanto a las fuentes, y cada archivo usa su propia base. Aun así, no se proponen para L2 y L3 hasta que O-1 muestre que la carga no introduce timeouts.

**Orden propuesto:** O-1, O-7 y O-9, que no tienen riesgo. Después O-2 y O-3, que traen el mayor ahorro. Por último O-4 y O-5, cuando O-1 aporte datos. O-8 queda a decisión del owner.

## 11. Aplicación

El nivel definitivo se confirma con el diff real de cada entrega. Esta tabla anticipa la clasificación más probable.

| Desarrollo | Zona y garantías previsibles | L1 | PR (L2) |
|---|---|---|---|
| **R7-3** (TTL de esperas humanas, avisos, horizonte de aprobaciones) | Transversal: `task-runtime`, `persistence-postgres`, probablemente una migración. Recuperación, autorizaciones, outbox y control de ejecución | Pruebas completas de esas cuatro garantías, más recovery. Mutaciones `turn-guard`, `runtime-contingency`, `run-failure-recovery`, `run-failure-fallback`, `production-control` y las nuevas de R7-3 | **Cadena completa**, con todas las mutaciones |
| **R7-4** (linaje, predecesor, v10) | Transversal, más definición y perfil (riesgo alto siempre). Persistencia, migraciones y control de ejecución | Contratos de perfil y versionado, `profile-pinned-claims`, migraciones. Mutaciones `profile-v8` o su sucesora, `production`, `binding-immutability` | **Cadena completa**. v10 requiere autorización aparte |
| **J5 Sales Autonomy** | Pack Sales fuera de Core. Si toca `production/` o perfiles, sube a riesgo alto. Control de ejecución y autorizaciones | sales, shadow, contract completo. Mutaciones `profile-v8`, `shadow` y `production-control`, si cambia la política | Selección L2. **Completa** si toca Core, perfiles o la política de acciones |
| **Integraciones comerciales** (Quote, Checkout, Shipping, CP) | `adapters/domains/*`, fuera de Core. Idempotencia y conciliación, si escriben | Contrato HTTP del adaptador, sus unit, escenarios sales, `reconciliation` y `governed-execution` si escriben | Selección L2, más interop si cambian CIA o CP. **L3 con el servicio real** antes de desplegar, coordinado con el otro repositorio. **Lo que toque pagos (Checkout) se valida siempre como L3** (§6) |

## 12. Riesgos residuales

| # | Riesgo | Mitigación |
|---|---|---|
| RR-1 | La selección no ve dependencias dinámicas ni archivos leídos por ruta | contract completo desde L1. L2 completo en los cambios transversales. El registro de lo omitido hace revisable la selección |
| RR-2 | Un error humano al clasificar un cambio, porque **no hay CI** que lo verifique | La clasificación queda escrita en la evidencia y el owner la revisa en el PR. Con CI, §7 y §9 se pueden automatizar |
| RR-3 | Repetir pruebas inestables puede ocultar un defecto | §8: sólo se acepta un timeout repetido sobre el mismo árbol y registrado; nunca una aserción |
| RR-4 | La tabla de §6 puede quedar desactualizada | Se actualiza en el mismo PR que mueve el código. L3 corre todo de todos modos |
| RR-5 | Las estimaciones de §10 vienen de pocas corridas en una sola máquina | O-1 primero. Ninguna optimización se adopta sin una medición que la respalde |

## 13. Decisiones para el owner

1. Aprobar los niveles y la matriz (§3), y los criterios de riesgo (§4).
2. En L2, aprobar que las mutaciones se limiten a las del diff y a las de las garantías tocadas, con todas en los cambios transversales y todas en L3. Recomendado.
3. Autorizar la implementación de O-1, O-7 y O-9. Después, O-2 y O-3, como un cambio de herramientas con su propia regresión y sin tocar el runtime.
4. Decidir O-8.
5. Aprobar el tratamiento de pagos (§6): validación de nivel L3 desde L1 y sin selección.

## 14. Estado

`R4_TEST_STRATEGY_02_READY_FOR_REVIEW`
