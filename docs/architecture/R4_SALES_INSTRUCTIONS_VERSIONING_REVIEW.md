---
title: R4 — revisión de versiones de las instrucciones Sales
status: R4_SALES_VERSIONING_DECISION_RECORDED. Numeración aprobada; sin definiciones ni perfiles nuevos
mandate: «R4 — Sales Instruction Consolidation» (owner)
date: 2026-10-30
---

# R4: versiones de las instrucciones Sales

## 1. Conclusión

**El owner aprobó esta numeración** (`R4_J4_R7_OWNER_DECISION_RECORD.md` §4). Las secciones siguientes conservan el análisis que la sustentó; las condiciones vigentes están en §8.

**El identificador v9 ya tiene cuatro contenidos distintos y hay que retirarlo.** Se retira también el perfil `@9` y se numera así:

| Identificador | Contenido | Cuándo se crea |
|---|---|---|
| v9 y `@9` | **Retirados.** No se reutilizan | Nunca |
| v10 | v8 + cláusula de promoción | Cuando el owner autorice una definición para `@8` o posterior |
| v11 | v10 + bloque conversacional de G-sem | Según las condiciones de §8 |
| v12 en adelante | Trabajo posterior, como R7-4 | Según su propio mandato |

**Cada versión desde v10 conserva lo anterior**, de modo que ninguna función puede desaparecer al avanzar. Mientras tanto, los dos textos siguen siendo cambios independientes, fijados por hash en una prueba de contrato (§7).

**Esto corrige una decisión mía anterior.** Tras la aclaración de Shipping dije que la promoción conservaría el número 9. Eso reutilizaba el identificador con otro contenido, lo que prohíbe la decisión 7.

**Producción no cambia.** Por la decisión 6, `@3` sigue con v4 y la promoción no llega a producción hasta que exista un perfil de la familia `@8` (§5, R-1).

## 2. Inventario

### 2.1 Definiciones estables

Cada versión tiene un solo contenido en todas las ramas y worktrees revisados.

| Versión | Archivo | Hash de contenido | Perfiles | Estado |
|---|---|---|---|---|
| v1 | `sales.agent.json` (histórico) | `50f9080e442f` | — | Solo en ramas antiguas |
| v2 | `sales.agent.json` (histórico) | `aff34793cf6a` | — | Solo en ramas antiguas |
| v3 | `sales.agent.json` | `44b5b0935c0c` | `@1`, `@2` | En `main` |
| v4 | `sales.v4.agent.json` | `c91f0e9da593` | `@3`, `@4` | En `main`. **Corre en producción con `@3`** |
| v5 | `sales.v5.agent.json` | `003402e25796` | `@5` | En `main` |
| v6 | `sales.v6.agent.json` | `2499d50f9297` | `@6` | En `main` |
| v7 | `sales.v7.agent.json` | `1d593691a030` | `@7` | En `main` |
| v8 | `sales.v8.agent.json` | `1065b99836be` | `@8` | En `main`; no desplegado en producción |

El archivo `sales.agent.json` cambió tres veces en la historia, pero con distinto campo `version`, así que no es una colisión.

### 2.2 Lo que se ha llamado v9

| # | Contenido | Dónde está | Hash de instrucciones | Hash de definición | Evaluación |
|---|---|---|---|---|---|
| A | v8 + promoción original, con «neto» y «comunas de la RM» | `sales.v9.agent.json`, commit `2f12304`, publicado en el **PR #28** (abierto) | `1a5b7b284111` | `83060ff0dce4` | Sin modelo real |
| B | v8 + primer ajuste de la cláusula | Solo en `round1-*` de la evidencia J5 | No conservado | `e30d51b66f34` | 50 muestras; reemplazado |
| C | v8 + **cláusula final** | `sales.v9.agent.json` en el worktree `dev/r4-j5-shipping`, **sin commit** | `f0329dd55a85` | `2000603fe482` | 50 muestras con Shipping guionado, sin R7 |
| D | v8 + **bloque conversacional** | Sin archivo: `V9_BLOCK` en `scripts/experiments/j4r7-gsem/run.mjs` | `552edca82ff6` | No existe | Brazo B de G-sem, 174 llamadas, sin adjudicar. La solicitud decía versión 8 |

Además, `R4_J4_R7_DESIGN.md` usa «pack Sales v9 completo» para R7-4 (bloque, avisos y linaje). Es un quinto significado, sin texto escrito.

### 2.3 Diferencias entre instrucciones

La diferencia con v8 es de un solo punto en cada cambio:

| Cambio | Operación sobre v8 | Hash del fragmento | Tamaño |
|---|---|---|---|
| Promoción | Agrega una línea tras `- shipping.quote:` | `e9ba67260939` | 2.131 caracteres |
| Conversación | Reemplaza la frase «Complete the task…» | `f2c905407947` | 2.251 caracteres |

**Se pueden componer sin conflicto textual:** el orden no altera el resultado (`c1704f033548`, 12.624 caracteres) y deshacerlos devuelve v8 exacta. **Esa composición nunca se ha evaluado con el modelo.**

### 2.4 Ramas

| Rama | Commit | Respecto de `origin/main` | Publicada | Tiene v9 |
|---|---|---|---|---|
| `origin/main` | `d0bb7a7` | — | Sí | No |
| `feat/r4-j4-r7-2-turn-completion-guard` (producción: `0deaac6`) | `c1a9392` | +18, −0 | **No** | No; solo el bloque D |
| `feat/r4-j5-shipping-promotion-v9` | `2f12304` | +1, −14 | Sí, PR #28 | Sí: A en el commit, C en el worktree |
| `fix/r4-quote-a10-arithmetic` | `89942da` | +1, −0 | Sí | No |

Solo la rama J5 contiene `sales.v9.agent.json` y `profile-v9.ts`.

### 2.5 Estado de publicación

| Lugar | Definiciones | Verificación |
|---|---|---|
| Git | v9 A publicado en una rama, no en `main` | Verificado |
| 142 bases locales con registro | Ninguna con `sales` ≥ 9 | Verificado |
| Producción | v4, fijada por `@3`. El corte de R7 no corrió `production:sales:bootstrap` | **Lista exacta sin verificar** |
| Bases de canary en EC2 | El informe J5 dice que no hubo canary de `@9` | **Sin verificar** |

Este mandato no autoriza acceder a EC2. La comprobación es de solo lectura: `select version, content_hash from agent_definitions where agent_id = 'sales' order by version`.

## 3. Colisiones

| # | Colisión | Consecuencia |
|---|---|---|
| C-1 | **v9 A y v9 C:** mismo archivo y número, distinto contenido | Si A llega a registrarse, C hace fallar el bootstrap con `agent_definition_version_immutable` |
| C-2 | **v9 de Shipping y v9 de G-sem:** cambios sin relación | D2, el plan de adopción y G-sem aprueban o evalúan «v9» refiriéndose al bloque. PR #28 y J5 lo usan para la promoción |
| C-3 | **`@9`:** existe en el PR #28 con huella `f2858bcc0366`; el plan R7 propone otro `@9` con su propio gate | Una misma etiqueta nombraría perfiles distintos |
| C-4 | **v10:** el plan de adopción y `R4_J4_R7_3_SCOPE_PROPOSAL.md` lo reservan para R7-4 | Choca con esta propuesta; R7-4 pasa al siguiente número libre |
| C-5 | **Etiqueta inexistente en pruebas:** `main` y R7 usan `@9` como «no existe» en `sales-profile-v2`; el PR #28 lo cambia a `@10` | Al retirar `@9` la prueba sigue siendo válida. Cuando exista `@10`, ya usa otra etiqueta |

## 4. Numeración recomendada

### 4.1 Reglas

1. **Un número se asigna al crear el archivo, con el texto ya congelado.** Antes, los cambios se identifican por su hash.
2. **Un número retirado no vuelve a usarse,** aunque nunca se haya registrado.
3. **Los documentos históricos no se reescriben.** G-sem, D2 y el plan siguen diciendo «v9»; esta tabla da la equivalencia:

| Texto histórico | Significa |
|---|---|
| «v9» en G-sem, D2 y el plan de adopción | Bloque conversacional, instrucciones `552edca82ff6` |
| «v9» y «`@9`» en PR #28 y J5 | Promoción, contenido A o C según la fecha |
| «v10» o «v9 completo» en R7-4 | Siguiente número libre |

### 4.2 Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Fusionar el PR #28 tal como está | Fija «neto» y «comunas de la RM», contra la decisión 2 |
| Conservar v9 con la cláusula final | Contenido divergente: contra la decisión 7 |
| v10 = promoción, v11 = bloque, v12 = ambos | Pasar de v10 a v11 haría desaparecer la promoción |
| Una sola v10 con ambos cambios | La promoción quedaría esperando la adjudicación de G-sem. Si es adversa, no habría versión para ella |
| Definición derivada de v4 para `@3` | Exige un perfil transitorio: contra la decisión 6 |

### 4.3 Si la adjudicación de G-sem es adversa

v11 no se crea con este contenido. v10 sigue válida y el bloque queda como evidencia. El siguiente trabajo toma el número que siga libre.

## 5. Riesgos de compatibilidad

| # | Riesgo | Tratamiento |
|---|---|---|
| R-1 | **La promoción no llega pronto a producción.** `@3` usa v4 y la familia `@8` depende de Quote real, CIA e identidad. Mientras tanto, el agente puede seguir llamando «tarifa real» al $1 | Consecuencia de la decisión 6. **Debe resolverse antes de abrir `@3` a clientes** |
| R-2 | **Un archivo presente se congela al registrarse.** El bootstrap y el `init` del canary registran todo `*.agent.json` del directorio, lo use o no un perfil | Crear v10 solo con el texto final. La prueba §7 rechaza archivos no declarados |
| R-3 | **PR #28 abierto con términos rechazados.** Si se fusiona, entra el contenido A | El owner decidió no fusionarlo y mantenerlo abierto hasta que el sustituto esté verificado |
| R-4 | **Commit solo local.** La cláusula y la prueba quedan en un commit local, pero la evidencia y el arnés de J5 siguen sin confirmar, y la rama de producción no está publicada | Sigue abierto: el owner autorizó solo este commit, sin push |
| R-5 | **La composición no está evaluada.** G-sem no incluyó el $1 y J5 no tenía guard. La regla 9 del bloque dice que Quote, Checkout y aprobaciones deciden el despacho, mientras la cláusula dice que Shipping decide la elegibilidad | El owner exige resolver ese contrato semántico antes de v11. Si cambia un texto, deja de ser idéntico a lo evaluado y debe evaluarse de nuevo |
| R-6 | **Renumerar cambia la solicitud al modelo.** La versión viaja en el contexto (`agent:sales.vN`). G-sem envió 8 y J5 envió 9 | Las instrucciones siguen idénticas, pero no la solicitud completa. Riesgo bajo; lo cubre la evaluación previa a activar |
| R-7 | **La rama J5 parte de `09d6579`.** Le faltan R7, F-1 y EV-2, y mueve el registro de perfiles | Reconstruir sobre la rama integrada, sin hacer rebase de v9. Conservar sus pruebas y su arnés, con la nueva numeración |
| R-8 | **Las tasks quedan fijadas a su versión (EV-2).** Pasar de `@3` a otra familia no puede servir tasks de v4, porque las capacidades difieren | Tratar la transición de tasks en el mandato de activación. Entre v10 y v11 las capacidades coinciden, así que un perfil podría servir ambas |
| R-9 | **v11 requiere `enforce`.** El plan de adopción ya advierte que el bloque con `observe` no se evaluó y es peligroso | El rollback de v11 debe volver a v10. v10 no depende del guard |
| R-10 | **`getLatest` devuelve el número mayor.** Producción fija la versión, pero un llamador sin versión obtendría v10 u v11 | Sin cambio respecto de hoy, que ya devuelve v8. `SALES_AGENT_LATEST_VERSION` sigue en 4 |
| R-11 | **El texto base de v8 dice «real commercial incentive».** Permanece junto a la cláusula | En J5 no provocó atribuciones al transportista, pero persiste un residuo en 2 de 5 respuestas de E07 |

## 6. Plan de consolidación

| Etapa | Qué se hace | Condición | Estado |
|---|---|---|---|
| 0 | Inventario, fragmento de la cláusula, prueba de contrato e informe | Mandato de consolidación | **Hecho** |
| 1 | Aprobar la numeración y confirmar con commit local | Owner | **Hecho** |
| 2 | Verificaciones de D5: registro y versión activa en EC2, existencia histórica de v9 y `@9`, composición y perfiles autorizados | Autorización de acceso a EC2 | Pendiente |
| 3 | Preparar y verificar el sustituto del PR #28, y solo entonces cerrarlo. Devolver el worktree J5 a su commit tras verificar el fragmento | Etapa 2 y autorización | Pendiente |
| 4 | Integrar R7 en `main`, para que el código de producción deje de estar fuera | Autorización de push y merge | Pendiente |
| 5 | Crear v10: v8 + cláusula | Etapa 2 | Pendiente |
| 6 | Adjudicación humana de G-sem | Owner | Pendiente |
| 7 | Resolver el contrato semántico Shipping/Quote | Owner | Pendiente |
| 8 | Evaluar la composición con modelo real: escenarios J5 y G-sem, con `enforce` | Autorización. Costo estimado hasta US$1,30, según lo gastado por brazo | Pendiente |
| 9 | Crear v11 = v10 + bloque, `conversationSince = 11` | Condiciones de §8 | Pendiente |
| 10 | Perfil de la familia `@8` que sirva estas versiones, sin usar `@9` | Gates de `@8` y autorización de despliegue | Fuera de este mandato |

## 7. Pruebas

### 7.1 Preparadas

`tests/contract/sales-instruction-versioning.test.ts`, con la cláusula en `tests/contract/fixtures/sales-instruction-changes/shipping-promotion.txt`. El bloque se lee de su fuente en el arnés de G-sem, sin copiarlo. Ninguna de estas rutas está en `agents/`, así que no puede registrarse por accidente.

| Garantía | Comprobación |
|---|---|
| Ambos textos intactos | Hash de la cláusula y del bloque |
| Son lo evaluado | v8 + cada uno reproduce el hash de J5 y del brazo B |
| Son independientes | Anclas únicas, orden indiferente, y deshacerlos devuelve v8 |
| Decisiones 1 a 4 | Solo el rango confirmado; sin neto ni comunas; defiere a Shipping; ningún código nombra la promoción ni sus umbrales de Shipping y Quote |
| Inmutabilidad | Hashes de v3 a v8; todo archivo de definición está declarado; v9 y `@9` no existen |
| Ninguna función desaparece | Falla si una versión desde v10 pierde la promoción, si otra pierde el bloque cuando ya se adoptó, o si el bloque entra antes de autorizarse |

**Resultados:** 10 de 10, y el proyecto `contract` completo con 462 pruebas. También pasan `typecheck` y `lint` del archivo.

**Comprobé que puede fallar:** cambiar un byte de la cláusula rompe 4 pruebas, editar v8 rompe 4 y añadir un `sales.v9.agent.json` suelto rompe 1. Las tres alteraciones se revirtieron.

**Sobre la rama J5:** no la ejecuté allí. Debería fallar a propósito, porque esa rama tiene v9.

### 7.2 Necesarias más adelante

| Cuándo | Prueba |
|---|---|
| v10 | Identidad con v8 salvo versión, descripción y cláusula; actualizar inventarios (`production-bootstrap`, `agent-registry`, `api`, `loader`, `sales-profile-*`); portar `shipping-promotion.test.ts` |
| v11 | Identidad con v8 salvo los dos cambios; regresión de `turn-completion-guard`, `sales-autonomous-quote`, `sales-confirmed-intent-*` y `sales-deterministic-offer-*` |
| Composición | Modelo real con los escenarios de ambos, revisión humana y comparación contra v10 |
| Perfil | Paridad de capacidades y política con `@8`, sin `REQUIRE_APPROVAL` nuevo en cotizaciones ordinarias |
| Migración | Tasks fijadas a v4 durante el cambio de familia; rollback de v11 a v10 |
| Antes de v10 | Consulta de solo lectura al registro de producción y de canary (§2.5) |

## 8. Decisión del owner

Registrada en `R4_J4_R7_OWNER_DECISION_RECORD.md` §4, con su lectura operativa en §5.

- **Retiro:** v9 y `@9` salen de la planificación y no se reutilizan. Los registros históricos que pudieran existir no se tocan.
- **Secuencia:** v10 = v8 + cláusula; v11 = v10 + bloque; v12 en adelante según el roadmap.
- **Aprobación condicionada de «v9»:** pasa a referirse al bloque conversacional incorporado en v11.
- **v11 desplegable requiere:** adjudicación humana favorable de G-sem, resolución del contrato semántico Shipping/Quote, validación de la composición completa, pruebas contractuales y autorización de activación.
- **PR #28:** no se fusiona ni se cierra hasta que su sustituto esté preparado y verificado.
- **Antes de crear las definiciones finales:** consultar las definiciones registradas en producción, confirmar si v9 o `@9` existen históricamente, resolver la composición, confirmar la compatibilidad con los perfiles autorizados y verificar qué versión corre en EC2.
