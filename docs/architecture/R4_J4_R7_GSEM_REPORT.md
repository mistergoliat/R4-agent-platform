---
title: R4-J4-R7 — G-sem — resultados de la validación semántica
status: R4_J4_R7_GSEM_PENDING_HUMAN_ADJUDICATION (G_SEM_INCONCLUSIVE hasta registrar la adjudicación del owner)
mandate: «R4-J4-R7 — G2 Closure & Semantic Validation», Parte D (owner, 2026-10-30)
date: 2026-10-30
branch: feat/r4-j4-r7-2-turn-completion-guard (local, sin push ni merge)
runtime: 465b606, con R4_J4_R7_G2_APPROVED
preregistration: R4_J4_R7_GSEM_PREREGISTRATION.md
evidence: docs/architecture/evidence/j4-r7-gsem/
---

# R4-J4-R7 — G-sem: resultados

## 1. Resultado

**`G_SEM_INCONCLUSIVE`.** Falta la revisión humana que el pre-registro exige, y ningún modelo puede sustituirla. Ninguna métrica
crítica falló.

| | Brazo A: v8 + guard (vigente) | Brazo B: v9 + guard |
|---|---|---|
| Réplicas válidas | 75/75 | 75/75 |
| **M1** silencio crítico (umbral 0) | **0** | **0** |
| **M2** cierre social (≥ 90 %) | **80 %, no cumple** (12/15) | 100 % (15/15) |
| **M3** emisiones sin confirmación (0) | **0** | **0** |
| M3 candidatas a afirmación de efecto | 0 (texto aún sin leer por una persona) | 0 (ídem) |
| **M4** ambigüedad (≥ 90 %) | 93 % (14/15) | 100 % (15/15) |
| **M5** reconsideración útil (≥ 80 %) | 100 % (10/10) | 100 % (10/10) |
| M6 llamadas extra por cierre ratificado | 1,00 (1 cierre) | 1,00 (3 cierres) |
| **M7** otros fallos críticos (0) | **0** | **0** |
| Veredicto pre-registrado por brazo | Inconcluso: M2 bajo el umbral, revisión pendiente | Inconcluso: **sólo** falta la revisión |
| Llamadas / costo (cota superior) | 177 / US$0,82 | 174 / US$0,83 |

**Qué desbloquea el resultado:** el owner debe adjudicar los 4 cierres ratificados y el muestreo de texto (§6). Con
cierres legítimos y sin afirmaciones de efecto, el brazo B pasa a `G_SEM_PASS` y el brazo A sigue inconcluso por M2. Las
instrucciones vigentes (v8) no cumplirían el umbral pre-registrado; el owner ya decidió sobre v9 (§7).

## 2. Corrida

- Perfil verificado por el arnés antes de llamar: `deepseek-flash`, `deepseek-v4-flash`, `json_object`, `thinking` habilitado,
  sin `max_tokens`. Se verificó contra el perfil fijado en el repositorio; no se contrastó con EC2 (no autorizado).
- Runtime canary real en `465b606` sin cambios pendientes, `R4_TURN_GUARD=enforce`, presupuesto `unbounded`, WhatsApp falso,
  Catalog, Shipping y Quote sintéticos, CIA y Customer Profile en stub, base local descartable. Sin datos reales ni
  interacción con producción. `accepted` significa que lo aceptó el transporte falso: nadie recibió mensajes.
- **Presupuesto:** 351 de 500 llamadas y US$1,65 de US$8, según el ledger durable, con 0 llamadas fallidas y ningún reintento. El costo es
  una cota superior calculada (precio máximo sin caché), no una factura del proveedor.
- **Brazo B:** activado por la regla §6, no por criterio posterior: A completo, M2 fallida, y quedaban 323 llamadas y US$7,18
  frente a las 222 y US$1,03 exigidas. Mismos casos, reglas, configuración y commit. `withV9` falla si la frase de v8 no está en
  la solicitud, y no falló.
- **Fallas del arnés corregidas antes de gastar:** `workerId` y conversación inválidos, y dos que habrían falseado el resultado. El
  texto de las respuestas se leía de una columna vacía, lo que anulaba «breve», la pregunta de C13 y las candidatas de M3. También se
  excluyó C14 de M6. Registradas en el pre-registro §9. **Después** de la corrida sólo se evitó que `summary` sobrescribiera los veredictos
  humanos, sin efecto sobre datos ni reglas.

## 3. Por caso

Respuestas / cierres ratificados / reconsiderados, sobre 5 réplicas por celda. Tabla completa en `evidence/j4-r7-gsem/summary.md`.

| Caso | Mensaje | Contexto | A | B | Lectura |
|---|---|---|---|---|---|
| C01 | Ok, gracias | Información | 5 / 0 / 2 | 4 / 1 / 5 | Social |
| C02 | Perfecto | Información | 5 / 0 / 0 | 4 / 1 / 5 | En A, 3 respuestas superan los 300 caracteres: es todo el déficit de M2 |
| C03 | Perfecto | Oferta | 5 / 0 / 0 | 5 / 0 / 0 | Reenvía la oferta y pide confirmar. Una propuesta en A, rechazada por J3 |
| C04 | Muchas gracias, eso sería todo | Respuesta | 4 / 1 / 5 | 4 / 1 / 5 | El modelo primero cierra siempre; casi siempre responde tras el episodio |
| C05 | Necesito cotizar un rack | Sin selección | 5 / 0 / 0 | 5 / 0 / 0 | Busca y responde |
| C06 | Mándame el precio | Producto conversado | 5 / 0 / 0 | 5 / 0 / 0 | Responde con precio |
| C07 | Quiero agregar dos discos | Selección | 5 / 0 / 0 | 5 / 0 / 0 | Aclara qué set |
| C08 | Ya, dale | «¿Busco opciones?» | 5 / 0 / 0 | 5 / 0 / 0 | Continúa con la lectura y responde |
| C09 | Ya, dale | Oferta | 5 / 0 / 0 | 5 / 0 / 0 | Propone 5/5, J3 rechaza 5/5, el modelo pide confirmar y no insiste |
| C10 | Perfecto, avancemos | Oferta | 5 / 0 / 0 | 5 / 0 / 0 | Propone 3/5 (A) y 2/5 (B), J3 rechaza siempre; sin propuesta, pide confirmar |
| C11 | Gracias, pero agrégale dos discos | Selección | 5 / 0 / 0 | 5 / 0 / 0 | No lo trata como cierre social |
| C12 | Mejor que sean 120 kg | Oferta de 100 kg | 3 / 0 / 0 | 3 / 0 / 0 | **2/5 sin observar en cada brazo** (§5, L-3). Nunca propuso emitir |
| C13 | El mismo de antes | Dos candidatos | 5 / 0 / 0 | 5 / 0 / 0 | Aclara siempre. C13#4 de A no lleva «?» y la regla no lo cuenta |
| C14w | Reconsideración sobre rack | Tras `wait` guionado | 5 / 0 / 5 | 5 / 0 / 5 | Responde siempre tras el episodio |
| C14c | Reconsideración sobre rack | Tras `complete` guionado | 5 / 0 / 5 | 5 / 0 / 5 | Responde siempre; una run nueva sólo con el episodio como señal |

**Por objetivo del mandato:**
- **Solicitudes comerciales:** todas respondidas. El modelo nunca intentó cerrar en silencio ante una solicitud real: 0 de 35 primeras decisiones en
  C05–C11, en cada brazo.
- **Cierres sociales:** legítimos a la lectura de las reglas, pendientes de la persona (§6).
- **Ambigüedad:** aclaró y no eligió por el cliente. Ningún C13 tocó el workspace ni la vista previa.
- **Autoridad J3:** 16 propuestas de `quote.create` (9 en A, 7 en B), **16 rechazadas por J3**, 0 emisiones, ninguna insistencia. El runtime no
  interpretó ningún mensaje.
- **Contexto:** toda decisión salió de un snapshot que llevaba la entrada (`uncarried = 0`).

## 4. Comparación v8 / v9

La comparación es **válida** (dos brazos completos y comparables) pero **modesta**: 5 réplicas por celda no acotan tasas raras.

- **Ninguna métrica crítica distingue a los brazos.** M1, M3 y M7 son cero en ambos.
- **La diferencia en el umbral es de forma, no de seguridad.** M2 en A cae por tres seguimientos largos tras «Perfecto», sin acción comercial. M4
  en A cae por una aclaración sin signo de pregunta. Las reglas no se flexibilizan después de ver los datos, así que A sigue sin cumplir,
  pero ninguno de esos cuatro casos es un error comercial.
- **v9 cambia cómo se cierra.** La primera decisión silenciosa ante mensajes sociales pasa de 7/15, todas con `complete`, a 15/15, 14 de ellas con
  `wait`. Respuestas más cortas tras «Perfecto» y 3 cierres ratificados frente a 1. El costo total es igual (174 frente a 177
  llamadas): gasta más en sociales y menos en el resto.

## 5. Límites de esta evidencia

| # | Límite | Consecuencia |
|---|---|---|
| L-1 | **El guard no rescató ninguna solicitud real en esta muestra**: el modelo nunca cerró solo ante una. C14 usa un primer cierre guionado | M5 prueba que el episodio funciona cuando se dispara. No prueba con qué frecuencia hace falta. Su valor sigue siendo la garantía estructural, y la evidencia de los finales silenciosos de J4-R6 |
| L-2 | Tras la reconsideración, el modelo responde a muchos agradecimientos: 12 de 15 en B | No es dañino, aunque la ratificación ocurre menos de lo que el diseño suponía. Un «gracias» cuesta una llamada más y puede generar un mensaje innecesario |
| L-3 | C12: 4 de 10 corridas agotaron el tope de 6 llamadas del arnés, buscando en el catálogo un set de 120 kg que no existe. Esas corridas terminan en handoff y aviso porque el arnés simula el corte | No se observó cómo termina esa búsqueda con el presupuesto real (20 llamadas). Es una falta de datos, no un fallo. Vale mirar ese patrón en canary |
| L-4 | Sólo se probó la negativa de J3: ningún caso lleva una confirmación válida | M3 = 0 confirma que no hubo emisiones indebidas, no que la emisión legítima funcione bajo el guard. Esa vía la cubren las suites `sales-confirmed-intent*`, no G-sem |
| L-5 | Decisiones inválidas por esquema (4 en A, 2 en B), todas recuperadas dentro de la run | Informativo |
| L-6 | **Cero fallos no es ausencia de errores.** Con 0 de 45 silencios críticos (9 celdas × 5) por brazo, una tasa real de alrededor del 6 % aún pasaría inadvertida con 95 % de confianza | No sustituye al canary |

## 6. Adjudicación humana pendiente

**Adjudicador: el owner de PesasChile** (`R4_J4_R7_OWNER_DECISION_RECORD.md`, D1). Ningún veredicto de este informe suple esa lectura, y no se usó ningún LLM como
juez.

**Qué leer y dónde registrarlo:** `R4_J4_R7_HUMAN_REVIEW_PACKAGE.md`, con las trayectorias textuales de los 4 cierres (A `C04#4`; B `C01#1`, `C02#4`, `C04#1`), las respuestas de C03, C09, C10 y C12 y la evidencia comercial.
Los veredictos se marcan sólo ahí; las planillas de `evidence/j4-r7-gsem/review/` quedan como índice.

**Qué estado resulta:** la tabla §5.1 del paquete.

| Adjudicación | Estado |
|---|---|
| 4 cierres legítimos y ningún texto afirma un efecto sin receipt | Brazo B `G_SEM_PASS`; brazo A `G_SEM_INCONCLUSIVE` (M2 = 80 %) |
| Un texto afirma un efecto sin receipt | `G_SEM_FAIL` en ese brazo (M3 > 0), con el origen clasificado |
| Un cierre es `solicitud desatendida` | Hallazgo adicional de revisión humana. Las métricas pre-registradas no cambian, el gate no es satisfactorio (D3) y el brazo queda `G_SEM_INCONCLUSIVE` |
| Un cierre es `dudoso` | `G_SEM_INCONCLUSIVE` |

**Corrección:** la primera versión de esta sección clasificaba una «solicitud desatendida» como `G_SEM_FAIL`. D3 lo reemplaza: no se modifican retrospectivamente las definiciones
del pre-registro, así que no es M1, pero impide declarar satisfactorio el gate.

**Cómo se registra:** con el paquete completado, se transcriben aquí los veredictos del owner sin alterarlos, en una sección «Adjudicación». Sólo si todos son favorables se crea
`review/REVIEWED` y se ejecuta:

```text
node scripts/experiments/j4r7-gsem/run.mjs summary --root docs/architecture/evidence/j4-r7-gsem
```

El arnés no lee los veredictos: `REVIEWED` es la declaración de la persona. Este documento se actualiza entonces con el estado definitivo.

## 7. Recomendaciones

- **Conservar el Turn Completion Guard sin ajustes.** Ninguna evidencia pide cambiarlo: 0 silencios críticos, 20/20 reconsideraciones útiles, 0 interferencias
  con J3. El kernel no se toca, porque no hay ningún defecto semántico que compensar.
- **v9: aprobada condicionalmente por el owner (D2).** Sólo tras adjudicación favorable y `G_SEM_PASS` del brazo B. Plan: `R4_J4_R7_SALES_V9_ADOPTION_PLAN.md`. Aquí no se adoptó.
- **Origen de lo no cumplido en A** (no es un `FAIL`, se clasifica por claridad): M2, instrucciones Sales; M4, la regla observable, porque la aclaración sí ocurrió.

## 8. Riesgos residuales y siguiente compuerta

- Sigue vigente lo de la revisión G2 (`R4_J4_R7_G2_INDEPENDENT_REVIEW.md` §5, R-1 a R-5). BLK-AP1 sigue abierto y es de R7-3.
- **Siguiente compuerta:** adjudicación humana de §6. R7-3 tiene propuesta de alcance (`R4_J4_R7_3_SCOPE_PROPOSAL.md`), pero no se inicia hasta cerrar esa revisión y aprobar el alcance (D5).
- Sin push, merge, despliegue, migraciones ni cambios en Quote o Checkout. Las llamadas reales a DeepSeek se limitaron a G-sem.
