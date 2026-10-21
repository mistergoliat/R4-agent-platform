# R4-J4 SEC-S1 — Informe de validación del clasificador puro de mensajes OTP

| Campo | Valor |
|---|---|
| Mandatos | `R4-J4-SEC-OTP-OWNER-ACCEPTANCE-03` (implementación) · `R4-J4-SEC-S1-OWNER-CLOSE-04` (ratificación de R-01/R-02/R-03 y fragmentos numéricos) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-s1-otp-classifier` (PR #15), desde `origin/main` `c4c2ff8` |
| Alcance | **Solo SEC-S1:** clasificador puro en `@r4-adapters/identity-verification`. Sin migraciones, cifrado, persistencia, puerto en `live-ops`, webhook, despachador, clientes de la CIA, capacidades Sales ni adaptadores de canal. Sin despliegue |

```text
SEC_S1_R01_R02_R03_RATIFIED
SEC_S1_NUMERIC_FRAGMENT_PROTECTION_PASS
SEC_S1_NO_AMBIGUOUS_CONFIRMATION_PASS
SEC_S1_REGRESSION_PASS
SEC_S1_READY_FOR_MERGE_REVIEW
CIA_V1_D2_CONTRACT_UNCHANGED
R4_HARNESS_UNCHANGED
SEC_S2_NOT_STARTED
SEC_OTP_01_IMPLEMENTATION_INCOMPLETE
SEC_OTP_02_IMPLEMENTATION_INCOMPLETE
GATE_RR1_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Merge documental del PR #14 (ACCEPTANCE-03)

| Comprobación | Resultado |
|---|---|
| SHA completo del head del PR | `f3b49ec50074cceb661b0e4dabc05b54167e0679`, igual al aceptado |
| Archivos | Solo los cuatro documentos revisados |
| Commits | Solo `dc35744` y `f3b49ec`. Ningún commit nuevo ni ajeno |
| Método | `gh pr merge 14 --merge --match-head-commit f3b49ec…`: merge commit normal. Sin squash, rebase ni force-push |
| **`main` después** | **`c4c2ff8048289eb09ee7aa790225ea6e71df1e1a`**. Padres: `6c16999` y `f3b49ec`. Su árbol es idéntico al de `f3b49ec` |

---

## 2. Decisiones del owner registradas

| ID | Resolución | Mandato |
|---|---|---|
| OA-04 | E1 solo sintético. Los correos reales requieren D7 | ACCEPTANCE-03 |
| OA-05 | Inicio autónomo gobernado, solo con intención explícita del cliente, correo declarado y binding vigente. Sin correos preventivos | ACCEPTANCE-03 |
| OA-07b | `CODE_CONTEXT` solo para implementación y validación sintética, sin ampliaciones implícitas | ACCEPTANCE-03 |
| OA-08 | Se aceptan los marcadores de la revisión 02 | ACCEPTANCE-03 |
| OA-09 | RR-1 pendiente. `humanOwned` vuelve no apta la asociación. Disponible sin cambios en el harness (`TaskStateFacts.humanOwned`, `ports.ts:124,312`) | ACCEPTANCE-03 |
| OA-11 / OA-12 | `role: participant` para sintético. Sin landing: informar sin enlace, redirección ni promesa | ACCEPTANCE-03 |
| **R-01, R-02, R-03** | **Ratificados** | CLOSE-04 |

Las decisiones de ACCEPTANCE-03 están en la decisión §13, con §7.4 alineado a OA-12, y en RR-1 §4 y §7. OA-10 y las autorizaciones productivas siguen pendientes.

---

## 3. Implementación

### 3.1 Paquete y API

El paquete es `adapters/domains/identity/verification` (`@r4-adapters/identity-verification`). **No tiene dependencias.** Lo forman `src/markers.ts`, `src/classifier.ts` y `src/index.ts`.

Está registrado en:
- `workspaces`;
- `tsconfig.json`;
- `tsconfig.build.json`;
- `vitest.config.ts`;
- `package-lock.json` (solo el enlace del workspace);
- el script `test:mutation:identity-verification`.

```ts
inspectVerificationText(text, { protectionActive, expectationAcceptsCode, directSubjectAttested }): VerificationTextInspection
// { kind: 'pass' } | { kind: 'replace'; text; reason; submission: { code } | null }
```

**Qué decide quien llama.** La función no sabe nada de canales, proveedores, expectativas ni la base de datos. Los tres hechos del contexto los decide quien la llama. `directSubjectAttested` es la atestación del **adaptador autenticado**; la igualdad `senderRef === conversationRef` no basta.

### 3.2 Reglas vigentes (tras CLOSE-04)

| Regla | Implementación |
|---|---|
| Normalización (R-02, R-03) | **Por grafema:** NFKC, minúsculas, sin `\p{Cf}`, sin selectores de variación ni keycap. Los dígitos `\p{Nd}` de cualquier escritura pasan a ASCII. Se persiste el texto **original** con solo los tramos redactados sustituidos |
| Grupos y enlaces | Un **grupo** es una secuencia contigua de dígitos. Dos grupos consecutivos tienen un enlace: <br>• **fuerte:** 1 a 3 separadores (`\s`, `\p{Zs}`, `‐ ‑ ‒ – — . · / _ , -`); <br>• **débil:** hasta 8 caracteres de conexión sin letras, o con **una** palabra de 3 letras como máximo (`y`, `e`, `o`…); <br>• **ninguno:** el resto |
| Regla 1: candidato estricto | Una serie de enlaces **fuertes** con 4 a 8 dígitos. **Es la única regla que puede producir un envío** |
| Regla 2: clúster débil (CLOSE-04) | Una serie de enlaces fuertes o débiles, con al menos un enlace débil y 4 a 8 dígitos, se **redacta entera** sin envío: `482 y 913`, `482----913`, `482    913`, `482 🙏 913` |
| Regla 3: ventanas de 6 (R-01 ampliada en CLOSE-04) | En una serie o un clúster de más de 8 dígitos, se redacta cada ventana de grupos consecutivos que sume **exactamente 6** dígitos, sin envío: `482913 1234`, `482 913 1234`, `48 2913 1234` |
| Unión | Los tramos que se solapan se fusionan, y un tramo fusionado **nunca** se envía. Así, un candidato estricto pegado a otros dígitos por un enlace débil (`482913 y 12`) se vuelve ambiguo |
| `submitForConfirmation` | Se cumplen todas: <br>• la expectativa acepta códigos; <br>• el sujeto está atestado; <br>• hay un **único** tramo; <br>• ese tramo es un candidato estricto (no ambiguo); <br>• tiene exactamente 6 dígitos ASCII; <br>• el resto del mensaje es "solo código" (`CODE_CONTEXT`, puntuación permitida, emojis) |
| Motivos sin envío | `expectation_not_accepting`, `subject_not_attested`, `multiple_candidates`, **`ambiguous_digits`** (nuevo), `not_six_digits` y `context_not_allowed` |
| Sin protección | Comportamiento sin cambios: nada se redacta (solo se neutralizan los marcadores falsificados) |
| Marcadores falsificados y fallo cerrado | Sin cambios respecto a ACCEPTANCE-03 |

---

## 4. Antes y después (CLOSE-04)

Todos los casos se evalúan con protección vigente y expectativa válida. `[W]` es el marcador `[number withheld …]`.

| Texto | Antes (`3cb5686`) | Después |
|---|---|---|
| `482 y 913` | Sin cambios: **el código llegaba al modelo** | `[W]` · `ambiguous_digits` |
| `482 913 1234` | Sin cambios: **fuga** | `[W] 1234` · `ambiguous_digits` |
| `48 2913 1234` | Sin cambios: **fuga** | `[W] 1234` · `ambiguous_digits` |
| `482----913`, `482    913`, `482      913`, `482 -- 913`, `482 . . . 913` | Sin cambios: **fuga** | `[W]` · `ambiguous_digits` |
| `482 🙏 913` | Sin cambios: **fuga** | `[W]` · `ambiguous_digits` |
| `٤٨٢ ٩١٣ ١٢٣٤` | Sin cambios: **fuga** | `[W] ١٢٣٤` · `ambiguous_digits` |
| `482913 1234` | `[W] 1234` · `context_not_allowed` | `[W] 1234` · `ambiguous_digits`. Igual protección; motivo más preciso |
| `482913 y 12`, `48 29 13 y 77` | Solo los 6 dígitos · `context_not_allowed` | **Todo el fragmento** `[W]` · `ambiguous_digits` |
| `pedido 1234 y 5678` | `pedido [W] y [W]` · `multiple_candidates` | `pedido [W]` · `ambiguous_digits` |
| `ｈｏｌａ ４８２９１３ y 7 sacos` | `ｈｏｌａ [W] y 7 sacos` | `ｈｏｌａ [W] sacos`: el `7` queda dentro del clúster débil |
| `12.345.678-9` (RUT con puntos) | Sin cambios | `12.[W]-9` · **costo declarado** (§9) |
| `+56 912 345 678` | Sin cambios | `+56 [W]` · **costo declarado** |
| `+56 9 1234 5678`, `912345678`, `12345678-9` | Sin cambios | Sin cambios: ninguna ventana suma 6 |
| Sin protección (cualquiera de los anteriores) | Sin cambios | Sin cambios (prueba explícita) |
| Envíos válidos (`482913`, `482 913`, `mi código es 482913`, keycaps…) | Enviados | Enviados (sin regresión) |

---

## 5. Validación

| Comprobación | ACCEPTANCE-03 (`4ff7a47`) | CLOSE-04 (este commit) |
|---|---|---|
| `npm run build` (`tsc -b`) | OK | OK |
| `npm run typecheck` | OK | OK |
| `npm run lint` (`--max-warnings=0`) | OK | OK |
| `unit` | 1 336 PASS, 4 skip | **1 399 PASS**, 4 skip, 0 FAIL (clasificador: 65 → **128**) |
| `contract` | 403 PASS | **403 PASS**, 0 FAIL |
| `integration` (PostgreSQL local) | 471 PASS, 12 skip | **471 PASS**, 12 skip, 0 FAIL |
| `sales` | 29/29 | **29/29** |
| `shadow` | 5/5 | **5/5** |
| Mutaciones SEC-S1 | 14/14 | **23/23 detectadas**, fuentes restauradas byte a byte |

Para `integration`, `sales` y `shadow` se arrancó el contenedor local `r4-agent-platform-postgres` y se detuvo al terminar.

**Comprobación de caracteres.** Las fuentes y las pruebas no contienen caracteres invisibles literales: se escriben como secuencias de escape. Se verificó por escaneo.

---

## 6. Cobertura de clasificación (AT-02 + CLOSE-04): 128 pruebas

| Bloque | Pruebas | Contenido |
|---|---|---|
| Envío (`code_submitted`) | 22 | Formatos ASCII, separados, NBSP, ZWSP, ancho completo, árabe-índico, árabe extendido, devanagari, keycaps, frases permitidas, mayúsculas, acento descompuesto, emojis |
| Redacción sin envío | 18 | Pedido, orden, monto, total, compra, letras pegadas, código junto a otros dígitos, dos candidatos, longitudes 4, 5, 7 y 8, período de gracia, sujeto no atestado |
| Sin redacción | 8 | Sin protección: `482913` y `pedido 123456`. Con protección: teléfonos, RUT sin puntos, 3 dígitos, dígitos separados por palabras, texto sin dígitos |
| **Fragmentos numéricos (CLOSE-04)** | 54 | 18 fragmentos × 3 aserciones: <br>• con protección: redactados y nunca enviados; <br>• **sin protección: sin cambios**; <br>• en gracia: igual redacción |
| **Posiciones Unicode (CLOSE-04)** | 5 | Keycaps entre emojis con tono de piel; acentos descompuestos alrededor; emoji con ZWJ; texto de ancho completo; marca combinante sobre un dígito. **El texto fuera del tramo se conserva exacto** |
| **Límites documentados (CLOSE-04)** | 4 | `482 luego 913`, `482 y también 913`, `4829131234`, dígitos escritos con palabras: **no** se redactan (§9) |
| Marcadores falsificados | 10 | Sin cambios |
| Fallo cerrado | 1 | Sin cambios |
| Invariantes combinatorias | 4 | 15 formatos (incluidos 7 fragmentos) × 7 envoltorios × 3 contextos: <br>• el código nunca sobrevive; <br>• todo envío es `^[0-9]{6}$` con `code_submitted`; <br>• **un fragmento dividido o mixto nunca se envía, sea cual sea el envoltorio**; <br>• sin expectativa o sin atestación no hay envío |
| `CODE_CONTEXT` | 2 | Lista exacta; una palabra ajena impide el envío |

---

## 7. Mutaciones (23/23 detectadas)

| # | Mutación |
|---|---|
| M1–M4 (plan) | Sin NFKC; solo dígitos ASCII; dos candidatos envían; se tolera una palabra fuera de `CODE_CONTEXT` |
| M5–M9 | Lista ampliada; envío sin 6 dígitos; envío sin expectativa; envío sin atestación; sin redacción en la gracia |
| M10 | Sin ventanas de 6 en series fuertes largas (anclaje actualizado a la regla 3) |
| M11–M14 | Marcadores falsificados conservados; fallo abierto; invisibles conservados; el paquete lee el entorno |
| **M15** | Sin enlaces débiles |
| **M16** | Una palabra corta no enlaza (`482 y 913`) |
| **M17** | No se unen huecos largos de separadores (`482----913`) |
| **M18** | No se redactan los clústeres débiles |
| **M19** | Sin ventanas de 6 en clústeres débiles largos |
| **M20** | Se envía un tramo ambiguo |
| **M21** | Un clúster débil se marca como enviable |
| **M22** | No se fusionan los tramos solapados |
| **M23** | Un tramo redactado termina un grafema antes (posiciones) |

---

## 8. Fronteras y ausencia de integración

**`tests/contract/identity-verification-boundaries.test.ts` comprueba:**
- sin dependencias ni importaciones externas;
- sin red, base de datos, entorno, reloj, aleatoriedad, temporizadores ni logging;
- sin nombres de canal, proveedor ni plataforma;
- ningún archivo fuera de las pruebas usa el paquete;
- `live-ops` no contiene conceptos OTP.

**Diffs vacíos** (verificado):
- `git diff c4c2ff8 -- packages apps agents adapters/channels adapters/models adapters/domains/src adapters/domains/identity/http` está vacío;
- el diff de los ocho paquetes del harness también está vacío.

**No existe integración ejecutable con la ingesta.** CIA y CP sin cambios.

---

## 9. Formatos imposibles de detectar sin ambigüedad (riesgos residuales)

**No se afirma cobertura universal de toda representación textual.**

| # | Formato | Por qué no se detecta | Estado |
|---|---|---|---|
| RS-01 | Mitades separadas por una palabra de más de 3 letras o por dos o más palabras (`482 luego 913`, `482 y también 913`) | Unir grupos a través de texto arbitrario convertiría cualquier par de números de una conversación en un "código" | Probado como límite. El correo y la conversación piden enviar solo el código |
| RS-02 | Código pegado a otros dígitos sin separador (`4829131234`) | Un grupo contiguo de más de 8 dígitos no se distingue de un número legítimo (teléfono, documento) | Probado como límite |
| RS-03 | Código partido dentro de un grupo mezclado con otros dígitos (`482 9131 234`) | Ningún grupo ni ventana suma 6 en los límites del código | Límite declarado |
| RS-04 | Dígitos escritos con palabras o letras parecidas (`cuatro ocho…`, `O` por `0`) | No son dígitos | Límite declarado (T-14b) |
| RS-05 | Dígitos dentro de una imagen o de un tipo no textual | No es texto: marcador `unsupported` + `handoff` | Fuera de SEC-S1 |
| RS-06 | **Costo de UX:** durante la protección (≤ 20 min) no llegan al modelo los números de 4 a 8 dígitos, los fragmentos débilmente enlazados ni las ventanas de 6 dentro de números largos. Afecta, por ejemplo, a un RUT con puntos (`12.[W]-9`) y a teléfonos en grupos de tres | Protección amplia decidida (OA-07, CLOSE-04) | Aceptado. El marcador pide solo el código |
| RS-07 | La exactitud de `protectionActive`, `expectationAcceptsCode` y `directSubjectAttested` depende de quien llama | S2/S3 | Sin integración hasta entonces |
| RS-08 | Las tablas Unicode dependen del ICU de Node 22 | Las pruebas fijan el comportamiento | Repetir AT-02 al actualizar Node |
| RS-09 | Solo se neutralizan marcadores entre corchetes; el marcador `unsupported` de la ingesta no se neutraliza | El de reanudación no lleva resultados (OA-08) | Sin cambios |

---

## 10. Commits y baseline

| | Valor |
|---|---|
| Baseline R4 | `origin/main` `c4c2ff8048289eb09ee7aa790225ea6e71df1e1a` |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| `4ff7a47` | `feat(identity-verification): SEC-S1 pure OTP message classifier` |
| `3cb5686` | `docs(r4): SEC-S1 classifier validation report and owner decisions of ACCEPTANCE-03` |
| CLOSE-04 | Commit incremental con los fragmentos numéricos, las pruebas, las mutaciones y este informe. Sin reescribir historia |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
| Publicación | PR #15 abierto. **Sin merge** hasta la revisión del owner |

---

## 11. Pendiente

- SEC-S2 **no se inicia** sin mandato.
- SEC-OTP-01/02 incompletos (S2 a S7).
- `GATE_RR1` pendiente. BA-01 a BA-06, G-16, AP-* y D7 pendientes. OA-10 y autorizaciones productivas pendientes.
- Datos reales **bloqueados**.
