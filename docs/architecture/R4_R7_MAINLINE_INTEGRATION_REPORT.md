---
title: R4 — integración de R7-1 y R7-2 en main (candidata B)
status: R4_R7_MAINLINE_PR_READY_FOR_OWNER_REVIEW
mandate: «R4 — Mainline Integration Owner Decision» (owner, candidata B seleccionada)
date: 2026-11-02
---

# R4: integración de R7-1 y R7-2 en `main`

## 1. Conclusión

Este PR integra en `main` la línea R7: R7-1, contingencia del runtime; ADR-041, aviso de plataforma; y R7-2, Turn Completion Guard, con las siete correcciones materiales de G2. Es la candidata B que eligió el owner.

- **Funcional.** El código ejecutable es idéntico al que corre hoy en producción. Respecto de ese commit, B sólo agrega una prueba de contrato y su fixture (§3).
- **Regresión.** Se ejecutó la cadena completa sobre un merge fresco de B en `d0bb7a7` (§4). Ningún resultado proviene de la candidata A.
- **Publicación.** Se auditó cada objeto Git que este PR publica, no sólo el árbol final. No contiene secretos, identificadores de infraestructura ni datos personales reales (§5). La auditoría de producción y los informes de despliegue quedan fuera del repositorio.
- **Dependencias.** Ningún PR abierto se incorpora. Las definiciones v9 y `@9` siguen retiradas, y no se crean v10 ni v11 (§6).

**Recomendación: fusionar con «Create a merge commit»** una vez que el owner revise la lista de archivos (§7). No se hizo merge, no se tocó producción y no se cambiaron el rollout, la allowlist ni `R4_TURN_GUARD`.

## 2. Composición

| Referencia | Commit | Nota |
|---|---|---|
| Base | `d0bb7a7` | `origin/main`, merge del PR #31. Sin cambios durante este trabajo |
| Rama del PR | `feat/r4-r7-mainline-integration` | 17 commits de R7 más este informe |
| Penúltimo commit | `61c94d7` | Cherry-pick de `581b44e` sobre `282a035`, con el mismo patch-id (`8a6e1e39`) |
| Merge de verificación | árbol `16e928a` | Idéntico al ensayo del 2026-10-31 |

**Reproducción:** `git checkout -b <rama> 282a035 && git cherry-pick 581b44e`. El árbol resultante es el de `61c94d7`, y su merge en `d0bb7a7` produce el árbol `16e928a`.

La línea R7 original tiene dos commits más, posteriores a `282a035`: una auditoría de producción y un informe de despliegue. **No son ancestros de esta rama.** Ninguno de sus objetos se publica, y no cambian ningún archivo ejecutable.

| Categoría | Commits |
|---|---|
| Código R7-1 y ADR-041 | `e25b6f8`, `1b2cefd` (mismo patch-id que el PR #27), `6577c5c` |
| Código R7-2 | `59041dc` |
| Correcciones G2 | `77f0822` (H-1 a H-3), `b12b7d5` (H-4 a H-7), `205a659` (anclas de mutación, H-8) |
| Documentos y evidencia | `026867d`, `0356388`, `665b50c`, `ee17cdb`, `2ce511f`, `af9c73d`, `282a035`, `61c94d7` |
| Arnés experimental G-sem | `b12b7d5`, `465b606`, `af9c73d`, `1de294b`. Ningún runtime lo importa; la prueba de contrato lee su bloque G-sem |

`main..rama`: 17 commits de R7 más este informe. `rama..main`: 0.

## 3. Comparación funcional con producción

Se comparó B con el commit desplegado en producción, en todo el árbol.

| Ámbito | Diferencia |
|---|---|
| `packages`, `apps`, `adapters`, `agents` | **0 archivos** |
| `package.json`, `package-lock.json`, `tsconfig*`, `eslint.config.js`, `vitest.config.ts` | 0 |
| `tests` | +2: `tests/contract/sales-instruction-versioning.test.ts` y su fixture `shipping-promotion.txt`. Sólo prueba: no se ejecuta en producción |
| `docs` | 15 archivos. No es código ejecutable |

**Diferencia ejecutable: ninguna.**

Cada garantía pedida queda cubierta así:

| Garantía | Dónde está | Verificación en B |
|---|---|---|
| R7-1 completo | `6577c5c`: contingencias terminales, recuperación, nuevos códigos de fallo | Ancestro de B; runtime igual a producción; mutaciones `runtime-contingency` y `run-failure-recovery` (§4) |
| ADR-041 | `e25b6f8`, `1b2cefd`, migración 0012, `SALES_RUN_FAILURE_FALLBACK_TEXT` | Mutación `run-failure-fallback`; `run-failure-fallback.test.ts` |
| R7-2 completo | `59041dc`: guard, steering durable, `R4_TURN_GUARD` | Mutación `turn-guard`; `turn-completion-guard.test.ts` |
| Siete correcciones G2 (H-1 a H-7) | `77f0822` y `b12b7d5` (`R4_J4_R7_G2_INDEPENDENT_REVIEW.md` §5) | Ancestros de B; TG-M13 a TG-M23 dentro de las 24 mutaciones de `turn-guard` |
| Migraciones | Una sola nueva, `0012_platform_fallback_outbound`, aditiva | `migrations.test.ts`, `migration-upgrade*.test.ts`; prefijos únicos en los tres directorios |
| Perfiles existentes | `profile-v2` a `profile-v8` y definiciones v4 a v8, sin cambios frente a `main` | Contratos de perfiles; `v3–v8 keep their registered content` |
| Protocolo v5 | Sin cambios en este PR | Contratos del protocolo y suites de Sales |
| Recuperación, idempotencia y steering | R7-1, R7-2 y G2 (H-5, H-7) | Suite `recovery`, integración en serie y mutaciones (§4) |

`R4_TURN_GUARD` vale `enforce` por defecto (`apps/worker/src/config.ts:34`). Este PR no lo cambia. Cada despliegue tiene que fijar la variable de forma explícita.

## 4. Regresión de B

Worktree limpio creado desde `d0bb7a7`, con merge fresco de la rama (árbol `16e928a`): sin `node_modules` ni `dist` previos, `npm ci` y luego todo en serie. Postgres local de `docker-compose.yml`. Windows, Node 22.

2026-11-02, de 13:21 a 16:25. Merge `3bc0311` (local, no publicado), árbol `16e928a`.

| Paso | Resultado | Duración |
|---|---|---|
| `npm ci`, build, typecheck | Pasa | 180 s, 92 s, 48 s |
| lint | Pasa | 141 s |
| unit | 1531 pasan, 4 omitidas | 69 s |
| contract | **461/462 en la cadena**; 462/462 al repetir (ver abajo) | 42 s |
| integration, en serie | 691 pasan, 12 omitidas | 1588 s |
| sales | 29/29 | 178 s |
| shadow | 5/5 | 176 s |
| recovery, en serie y aislado | 18/18 | 162 s |
| Cambios rastreados después de la cadena | 0 | |

**Mutaciones.** Las suites aplicables son las que mutan algún archivo de runtime que R7 cambia, según la regla de `R4_TEST_STRATEGY_02.md` §7. Son 10, y las 10 corrieron. Además corrieron otras dos.

| Suite | Resultado | Motivo |
|---|---|---|
| `runtime-contingency` | 11/11 | Del diff |
| `run-failure-recovery` | 14/14 | Del diff |
| `run-failure-fallback` | 6/6 | Del diff |
| `turn-guard` (incluye TG-M13 a TG-M23 de G2) | 24/24 | Del diff |
| `production` | 23/23 | Del diff |
| `production-control` | 13/13 | Del diff |
| `worker-readiness` | 15/15 | Del diff |
| `profile-v8` | 8/8 | Del diff |
| `canary-j4` | 13/13 | Del diff |
| `identity-verification-ingress` | 13/13 | Del diff (`production-store.ts`) |
| `binding-immutability` | 12/12 | Adicional: garantía de serialización y migraciones |
| `shadow` | 9/9 | Adicional |

**Total: 161/161 detectadas, con todas las fuentes restauradas.**

No se ejecutaron `evaluation`, `identity-verification`, `identity-verification-commercial`, `identity-verification-dispatch`, `identity-verification-state` ni `rr1-revalidation`. Ninguna muta un archivo que este PR cambie, y por eso no aplican en L2 para un cambio que no es de release. El owner pidió acortar la espera, y estas suites quedan para L3.

**Fallo de contract.** En la cadena, `identity-http-contract.test.ts` › «every copied file is byte-identical to the owner blob it records» terminó por **timeout**: 7,3 s contra un límite de 5 s. No fue un fallo de aserción. El archivo no cambia en este PR. Se repitió en otro worktree con el mismo árbol `16e928a`:
- el archivo solo: 23/23;
- contract completo, en paralelo con una suite de mutación: 2 fallos, no clasificados;
- contract completo, sin carga: **462/462**.

Se acepta como un timeout bajo carga y queda registrado. La propuesta de ajuste es O-8 en `R4_TEST_STRATEGY_02.md`.

**PR #28 sobre B.** Con un merge simulado sin commit, que luego se abortó, git integra limpio, pero `sales-instruction-versioning.test.ts` falla en 2 de 10 pruebas: «the retired identifiers are not in use» y «the registered definitions satisfy the sequence».

**Omitidas.** Las 12 de integration son los casos de `catalog-http-real.test.ts`, que necesitan un catálogo real. Las 4 de unit ya estaban omitidas en la línea base.

**Entorno y límites.** Windows, Node 22 y Postgres local de `docker-compose.yml`. Durante la cadena otra carga de trabajo usaba la máquina, y los tiempos son entre 1,5 y 2 veces los del ensayo. No hubo llamadas a un modelo real ni pruebas contra producción. Un merge verde no dice nada sobre el comportamiento conversacional: el guard sigue sin ejercitarse en producción y G-sem sigue pendiente de adjudicación.

Los logs completos están en almacenamiento privado, fuera del repositorio.

## 5. Auditoría de publicación

**Alcance.** Todo objeto alcanzable desde la rama y no desde `d0bb7a7`, es decir, lo que un push publica: 149 blobs (2,8 MB), incluidas 44 versiones intermedias que ya no están en el árbol final, más los mensajes de commit y los autores. Borrar un archivo en un commit posterior no lo retira del historial; por eso se auditaron todas las versiones.

| Búsqueda | Resultado |
|---|---|
| Direcciones IPv4 | Sólo `127.0.0.1`, y una versión de software |
| Infraestructura: hosts, usuarios y claves de acceso, rutas del servidor, procesos | 0 |
| Secretos: claves de proveedor, tokens de GitHub, Meta o Slack, claves privadas, `Bearer` | 0 |
| URL con credenciales | 7, todas locales o placeholders de prueba (`u:p@…`, y la credencial local de `docker-compose.yml`, que ya está en `main`) |
| Teléfonos | Todos sintéticos (`569333…`, `569999…`, `56914000901/2`, ya en `main`). Un aparente teléfono es un fragmento de UUID |
| RUT y correos en el contenido | 0 |
| Rutas locales del equipo de desarrollo | 3 archivos de evidencia con la ruta del worktree en la salida de vitest. Ya aparecen en 6 archivos de `main`. Sin impacto |
| Menciones a EC2 en documentos | Genéricas («canary en EC2, datos sintéticos», «no autorizado»). Ninguna describe la configuración ni el estado operativo |
| Mensajes de commit | Sin términos de infraestructura |
| Datos de G-sem | Conversaciones sintéticas contra Postgres local. Sin clientes ni bases de producción |

**Excluido del repositorio** y conservado en almacenamiento privado del owner: la auditoría de producción, el informe y la evidencia del despliegue, el informe de validación en WhatsApp, el informe preliminar de integración y los logs completos de esta regresión.

**Límites.** Es un escaneo por patrones, no una garantía. Los tokens `synthetic-*` del arnés y las URL de prueba pueden dar falsos positivos en GitGuardian.

## 6. Dependencias

Simulación con `git merge-tree` de cada PR abierto sobre el merge de B.

| PR | Contra B | Relación con R7 | Recomendación |
|---|---|---|---|
| #26 `ac7ccfe`, códigos de fallo de Customer Profile | Limpio | Toca `composition.ts`, sin conflicto | Sigue su propio camino. No se incorpora |
| #27 `93fe35a`, aviso de plataforma | **Conflicto en 7 archivos** | Sus dos commits tienen el mismo patch-id que `e25b6f8` y `1b2cefd`, ya incluidos. El conflicto viene de que R7-1 extendió esos archivos después | **Cerrar como reemplazado** tras el merge de este PR, si el owner lo decide. No resolver el conflicto |
| #28 `2f12304`, v9 y `@9` | **Limpio, y ése es el riesgo** | Agrega `sales.v9.agent.json` y `profile-v9`, que el owner retiró. Sólo lo frena la prueba de contrato, que corre en local: el repositorio no tiene CI | No fusionar. **Pasarlo a borrador** hasta su reemplazo v10/v11, si el owner lo autoriza |
| #32 `89942da`, aritmética A10 de Quote | Limpio | Sin archivos en común | Sigue su propio camino: se despliega junto con Quote |

**Cambios fuera del código de R7 que sí entran, con su justificación:**
- `61c94d7`: registro de la decisión de versionado Sales, más una prueba de contrato y su fixture. La prueba es la que impide reintroducir v9 o `@9` y la que valida la secuencia de definiciones. No crea ni modifica ninguna definición.
- El arnés G-sem en `scripts/experiments/j4r7-gsem/`. La prueba de contrato lo lee y excluirlo la rompe. Ningún runtime lo importa.

**Sin cambios:** v9 y `@9` siguen retirados. No hay v10 ni v11. No cambian `package-lock.json`, workflows, Dockerfiles, variables de entorno nuevas ni scripts de despliegue. `package.json` sólo suma 3 scripts de mutación.

## 7. Recomendación de merge

**Fusionar**, con estas condiciones:

1. Antes de fusionar, revisar en GitHub la lista de archivos del PR: 105 archivos de R7 (58 añadidos, 47 modificados, +11.305/−108) más este informe. Confirmar que `origin/main` sigue en `d0bb7a7`. Si cambió, repetir la cadena del §4.
2. Usar **«Create a merge commit»**. No usar squash ni rebase: se conservan los commits auditados y queda un único punto de reversión (`git revert -m 1 <merge>`).
3. Después del merge, repetir en limpio build, typecheck, lint, unit y contract sobre `origin/main`, porque no hay CI.
4. PR #27: cerrar como reemplazado. PR #28: borrador hasta su reemplazo.
5. El commit desplegado no será ancestro de `main`. El próximo despliegue debe hacer checkout de un SHA explícito; `git pull --ff-only` fallará.

**Qué no cambia con el merge:** producción. EC2 no sigue `main`, y la migración 0012 ya está aplicada allí. Integrar R7 tampoco cierra G-sem, que sigue pendiente de adjudicación humana, ni autoriza `enforce`, v10, v11 ni R7-3.

## 8. Estado

`R4_R7_MAINLINE_PR_READY_FOR_OWNER_REVIEW`
