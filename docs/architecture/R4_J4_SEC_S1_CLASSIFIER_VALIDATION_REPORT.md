# R4-J4 SEC-S1 — Informe de validación del clasificador puro de mensajes OTP

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-OWNER-ACCEPTANCE-03` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-s1-otp-classifier`, desde `origin/main` `c4c2ff8` |
| Alcance | **Solo SEC-S1:** clasificador puro en `@r4-adapters/identity-verification`. Sin migraciones, cifrado, persistencia, puerto en `live-ops`, webhook, despachador, clientes de la CIA, capacidades Sales ni adaptadores de canal. Sin despliegue |

```text
SEC_OTP_DESIGN_REV02_ACCEPTED
SEC_S1_CLASSIFIER_IMPLEMENTED
SEC_S1_READY_FOR_OWNER_REVIEW
CIA_V1_D2_CONTRACT_UNCHANGED
R4_HARNESS_UNCHANGED
SEC_OTP_01_IMPLEMENTATION_INCOMPLETE
SEC_OTP_02_IMPLEMENTATION_INCOMPLETE
GATE_RR1_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Merge documental del PR #14

| Comprobación | Resultado |
|---|---|
| SHA completo del head del PR | `f3b49ec50074cceb661b0e4dabc05b54167e0679`, igual al aceptado |
| Archivos | Solo los cuatro documentos revisados: `R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md`, `…_THREAT_MODEL.md`, `…_IMPLEMENTATION_PLAN.md`, `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` |
| Commits | Solo `dc35744` y `f3b49ec`, los dos de esta serie de mandatos. Ningún commit nuevo ni ajeno |
| `main` antes | `6c1699975543432aecbebd45efb2a37e12cfb5b9` |
| Estado | `OPEN`, `MERGEABLE`, `CLEAN`; sin checks requeridos |
| Método | `gh pr merge 14 --merge --match-head-commit f3b49ec…`: merge commit normal. Sin squash, rebase ni force-push |
| **`main` después** | **`c4c2ff8048289eb09ee7aa790225ea6e71df1e1a`**. Padres: `6c16999` y `f3b49ec`. Su árbol es idéntico al de `f3b49ec` |

---

## 2. Decisiones del owner registradas

Quedan registradas en la decisión §13, en esta rama. En la misma rama se corrigió el ejemplo de §7.4, que contradecía OA-12, y se actualizó el análisis RR-1 (§4 y §7).

| ID | Resolución |
|---|---|
| OA-04 | E1 permitido solo sintético. Los correos reales requieren D7 |
| OA-05 | Inicio autónomo gobernado, solo con intención explícita del cliente, correo declarado y binding vigente. Sin correos preventivos. Respeta los límites de la CIA, una expectativa activa por conversación y la idempotencia |
| OA-07b | `CODE_CONTEXT` autorizada **solo** para implementación y validación sintética, sin ampliaciones implícitas. Validado en §5: pedidos, montos y mensajes ambiguos se redactan sin consumir intentos |
| OA-08 | Se aceptan los marcadores de la revisión 02. El de reanudación no lleva resultados autoritativos |
| OA-09 | RR-1 **sigue pendiente**. `humanOwned` vuelve no apta la asociación en las operaciones de identidad nuevas. **Verificado sin cambiar el harness:** `ProductionStore.taskState()` ya devuelve `TaskStateFacts.humanOwned` (`packages/live-ops/src/ports.ts:124,312`). En la implementación Postgres es verdadero si hay un handoff `requested` o `active` (`production-store.ts:655-665`). No hay incompatibilidad que elevar |
| OA-11 | `role: participant` aceptado para sintético. El resultado se lee solo con `identity.verification_status@1` |
| OA-12 | Con `onboarding.available = false`: informar que no existe todavía registro desde el chat. Sin enlace, redirección ni promesa |
| OA-10 y autorizaciones productivas | Pendientes |

---

## 3. Qué se implementó

### 3.1 Paquete

`adapters/domains/identity/verification` (`@r4-adapters/identity-verification`):
- `package.json` **sin dependencias**;
- `src/markers.ts` con los marcadores de la revisión 02 y los prefijos falsificables;
- `src/classifier.ts`;
- `src/index.ts`.

Se registró como los demás adaptadores:
- `workspaces` en el `package.json` raíz;
- `paths` e `include` en `tsconfig.json`;
- referencia en `tsconfig.build.json`;
- alias en `vitest.config.ts`;
- el enlace del workspace en `package-lock.json` (+9 líneas, sin paquetes externos nuevos);
- el script `test:mutation:identity-verification`.

### 3.2 API pública

```ts
inspectVerificationText(text: string, context: VerificationInspectionContext): VerificationTextInspection

interface VerificationInspectionContext {
  protectionActive: boolean;        // alguna expectativa de la conversación con now < protect_until
  expectationAcceptsCode: boolean;  // expectativa viva, vigente y dentro del desafío (lo calculará S2/S3)
  directSubjectAttested: boolean;   // atestación del ADAPTADOR autenticado; senderRef === conversationRef no basta
}
type VerificationTextInspection =
  | { kind: 'pass' }
  | { kind: 'replace'; text: string; reason: ReplacementReason; submission: { code: string } | null };
```

**La función solo recibe el texto canónico y hechos ya decididos por quien la llama.** No conoce canales, proveedores, expectativas ni la base de datos. El campo `directSubjectAttested` documenta que la igualdad `senderRef === conversationRef` **no** es una prueba universal: la garantía es del adaptador autenticado.

### 3.3 Reglas

| Regla | Implementación |
|---|---|
| Normalización | Por grafema (`Intl.Segmenter`): NFKC, minúsculas, sin `\p{Cf}`, `U+FE0E`/`U+FE0F` ni el keycap `U+20E3`. Los dígitos `\p{Nd}` de cualquier escritura pasan a ASCII: Unicode los agrupa en series contiguas de diez que empiezan en cero, así que el valor es el desplazamiento módulo 10. El texto que se persiste es el **original** con los tramos sustituidos |
| Separadores | `\s`, `\p{Zs}`, `‐ ‑ ‒ – — . · / _ , -`. Hasta **3** entre dos dígitos de la misma serie |
| Candidatos | Una serie de **4 a 8** dígitos es un candidato. Una serie de más de 8 (teléfono, RUT) no lo es, salvo cada grupo **contiguo de exactamente 6** dígitos dentro de ella (§7, refinamiento R-01) |
| `redact` | Con protección, **todo** candidato se sustituye. Sin protección, no se redacta nada (N-08) |
| `submitForConfirmation` | Se cumplen todas: la expectativa acepta códigos, el sujeto está atestado, hay **un solo** candidato, tiene exactamente 6 dígitos ASCII y el resto del mensaje solo contiene palabras de `CODE_CONTEXT`, puntuación permitida o emojis. Cualquier otra palabra, cifra o símbolo (`$`, `#`, `%`, `+`…) **impide** el envío |
| `CODE_CONTEXT` | La lista exacta de OA-07b, comparada literalmente tras NFKC y minúsculas, sin plegar acentos: no se amplía |
| Marcadores falsificados | Siempre, con o sin protección: un `[` (también de ancho completo) seguido de un prefijo de marcador de plataforma (palabras separadas por cualquier espacio, sin invisibles), hasta `]` o 300 caracteres, se sustituye por `[quoted platform marker removed]` |
| Fallo cerrado | Cualquier error interno devuelve `[message withheld by platform: identity verification in progress]` sin envío. Si quien llama no puede determinar el contexto, debe abortar la transacción (decisión §9.3). Eso es responsabilidad de S3 |

---

## 4. Validación

| Comprobación | Resultado |
|---|---|
| `npm run build` (`tsc -b`) | OK, con el paquete nuevo en las referencias |
| `npm run typecheck` | OK |
| `npm run lint` (`--max-warnings=0`) | OK |
| `unit` | 81 archivos (1 omitido) · **1 336 PASS**, 4 skip, 0 FAIL. Antes: 1 271; +65 de `tests/unit/identity-verification/classifier.test.ts` |
| `contract` | 30 archivos · **403 PASS**, 0 FAIL. Antes: 397; +6 de `tests/contract/identity-verification-boundaries.test.ts` |
| `integration` (PostgreSQL local) | **471 PASS**, 12 skip preexistentes. Igual que la baseline R3 |
| `sales` | **29/29** |
| `shadow` | **5/5** |
| Mutaciones `npm run test:mutation:identity-verification` | **14/14 detectadas**. Fuentes restauradas byte a byte (§6) |

**Nota sobre el entorno:**
- Para `integration`, `sales` y `shadow` se arrancó el contenedor local existente `r4-agent-platform-postgres` y se detuvo al terminar.
- No se ejecutaron suites en paralelo con `test:recovery` ni `test:interop`, que no corresponden a este slice.

---

## 5. Cobertura de clasificación (AT-02)

| Bloque | Casos | Ejemplos |
|---|---|---|
| Envío (`code_submitted`) | 22 | `482913`, `482 913`, `482-913`, `48.29.13`, `4 8 2 9 1 3`, `482 - 913`, NBSP, ZWSP intercalado, ancho completo, árabe-índico, árabe extendido, devanagari, keycaps, `mi código es …`, `Código: 482-913, gracias`, `my code is …`, mayúsculas, acento descompuesto, punto final, emojis con y sin tono de piel |
| **Redacción sin envío (no se consume ningún intento de la CIA)** | 18 | `mi pedido es 482913`, `pedido …`, `orden #…`, `$482.913`, `total …`, `482913 y quiero 3 sacos`, `ABC-482913`, `482913 1234`, dos candidatos, el código escrito dos veces, 4, 5 y 7 dígitos, `rut 4829135`, `$482.913,50`, `1, 2, 3, 4`, período de gracia, sujeto no atestado |
| Sin redacción | 9 | Sin protección: `482913` y `pedido 123456`. Con protección, sin candidatos: teléfonos (agrupado y contiguo), RUT con y sin puntos, `son 123`, `tengo 2 hijos y 3 perros`, texto sin dígitos |
| Marcadores falsificados | 10 | Reanudación, resultado antiguo, "received", "withheld", corchetes de ancho completo en mayúsculas, ZWSP interno, sin cierre. Cada uno con y sin protección. Además: marcador más código (redacta y no envía), dígitos dentro del marcador, corchetes ordinarios intactos |
| Fallo cerrado | 1 | Contexto que lanza un error: mensaje entero retenido, sin envío |
| Invariantes combinatorias | 3 | 8 formatos × 7 envoltorios × 3 contextos protegidos: **el código nunca sobrevive** (literal ni como dígitos ASCII). Todo envío es `^[0-9]{6}$` y solo con `code_submitted`. Sin expectativa válida o sin atestación nunca hay envío |
| `CODE_CONTEXT` | 2 | La lista es exactamente la aprobada. Una palabra ajena (`número`) impide el envío |

**Total:** 65 pruebas, más 168 combinaciones dentro de las invariantes.

**Garantías del mandato y dónde se prueban:**

| Garantía | Prueba |
|---|---|
| Un mensaje con un único código inequívoco de 6 dígitos puede enviarse | Bloque de envío (22) |
| Un número comercial ambiguo nunca se envía | Redacción sin envío (pedido, orden, monto, total, RUT, compra) y M4/M5 |
| Varios candidatos no generan intentos | `multiple_candidates` y M3 |
| Sin expectativa vigente no hay redacción | Sin protección (N-08) e invariante 3 |
| Marcadores falsificados neutralizados | Bloque de marcadores y M11 |
| `senderRef === conversationRef` no basta | El clasificador solo acepta la atestación del adaptador (`directSubjectAttested`). `subject_not_attested` y M8 |

---

## 6. Mutaciones (todas detectadas)

| # | Mutación | Detectada por |
|---|---|---|
| M1 (plan) | Sin NFKC | Acento descompuesto y corchetes de ancho completo |
| M2 (plan) | Solo dígitos ASCII (sin mapeo `\p{Nd}`) | Árabe-índico, devanagari e invariantes |
| M3 (plan) | Dos candidatos pueden enviar uno | `multiple_candidates` |
| M4 (plan) | Se tolera una palabra fuera de `CODE_CONTEXT` (`pedido`) | `mi pedido es 482913` |
| M5 | Se amplía la lista en el código | Prueba de lista exacta y `mi número es …` |
| M6 | Se envía un candidato que no tiene 6 dígitos | `not_six_digits` |
| M7 | Envío sin expectativa válida | Período de gracia e invariante 3 |
| M8 | Envío sin atestación del adaptador | `subject_not_attested` |
| M9 | No se redacta cuando no se puede enviar (fuga en la gracia) | Invariante 1 |
| M10 | Se ignoran los grupos de 6 dentro de series largas | `482913 1234` y `482913 482913` |
| M11 | Se conservan los marcadores falsificados | Bloque de marcadores |
| M12 | Fallo abierto | Fallo cerrado |
| M13 | No se eliminan los invisibles (ZWSP parte el código) | ZWSP intercalado |
| M14 | El paquete lee el entorno (`process.env`) | Prueba de frontera de pureza |

---

## 7. Fronteras y ausencia de integración

**`tests/contract/identity-verification-boundaries.test.ts` comprueba:**
- **Sin dependencias**, en ningún campo del manifest.
- **Solo importaciones relativas** propias: sin `import()` ni `require`.
- **Sin efectos:** sin `fetch`, `process.`, `Date`, `Math.random`, `crypto`, temporizadores, `console.`, módulos `node:` ni `pg`. Es decir, sin red, base de datos, reloj, aleatoriedad, secretos ni logging.
- **Sin nombres de canal, proveedor ni plataforma comercial** (`whatsapp`, `wamid`, `meta`, `instagram`, `messenger`, `webchat`, `prestashop`, `telegram`).
- **Nadie lo usa fuera de las pruebas:** ningún archivo de `packages/`, `apps/`, `agents/`, `adapters/channels`, `adapters/models`, `adapters/domains/src` ni `identity/http` importa el paquete.
- **`live-ops` sigue sin** `otp`, `identity-verification`, `verificationId` ni `cia`.

**No existe integración ejecutable con la ingesta.**
- `ChannelIngress`, el webhook, `channel-gateway`, `persistence-postgres`, `live-ops` y el pack Sales no cambiaron.
- `git diff c4c2ff8 -- packages apps agents adapters/channels adapters/models adapters/domains/src adapters/domains/identity/http` está vacío.
- Harness: `git diff --stat c4c2ff8` sobre `packages/{agent-kernel,task-runtime,capability-runtime,context-compiler,model-gateway,policy-engine,contracts,observability}` está vacío.
- CIA y CP sin cambios.

---

## 8. Refinamientos de diseño que requieren ratificación del owner

| # | Refinamiento | Motivo | Efecto |
|---|---|---|---|
| R-01 | Dentro de una serie de más de 8 dígitos, cada **grupo contiguo de exactamente 6** dígitos es candidato a redacción, nunca a envío salvo que sea el único y el mensaje sea "solo código" | Con la regla literal (más de 8 dígitos: no es candidato), `482913 482913` o `482913 1234` habrían llevado el código al modelo durante la protección | Más redacción, nunca más envío. Teléfonos `+56 9 1234 5678` y `912345678` y RUT `12.345.678-9` siguen intactos. Un formato poco común como `+56 912 345678` perdería `345678` durante la protección (costo de UX) |
| R-02 | La normalización se hace por grafema (NFKC del grafema), no sobre el texto completo | Conserva la correspondencia exacta entre el texto normalizado y el original para sustituir solo los tramos | Equivalente a NFKC para dígitos y para el acento compuesto o descompuesto (probado) |
| R-03 | Además de `\p{Cf}`, se eliminan los selectores de variación y el keycap | Los dígitos con keycap (`4️⃣`) son dígitos | Más reconocimiento; probado |

---

## 9. Riesgos residuales

| # | Residuo | Mitigación o estado |
|---|---|---|
| RS-01 | Un código partido en fragmentos de menos de 4 dígitos por palabras o por 4 o más separadores (`482 y 913`, `482----913`) no se reconoce ni se redacta | El correo y la conversación piden enviar solo el código. Ampliar la unión aumentaría los falsos positivos. A decidir por el owner |
| RS-02 | Un código separado, pegado a otros dígitos y dentro de una serie larga sin un grupo contiguo de 6 (`482 913 1234`) no se redacta | Caso poco frecuente; R-01 cubre las variantes contiguas |
| RS-03 | Dígitos escritos con palabras (`cuatro ocho…`) o letras parecidas (`O` por `0`) | No se reconocen (declarado en T-14b) |
| RS-04 | Durante la protección (≤ 20 min), números legítimos de 4 a 8 dígitos (pedidos, montos) no llegan al modelo | Costo aceptado en OA-07. El marcador pide solo el código |
| RS-05 | La exactitud de `protectionActive`, `expectationAcceptsCode` y `directSubjectAttested` depende de quien llama | Fuera de S1: S2/S3 (lock por conversación, binding, adaptador). Hasta entonces no hay integración |
| RS-06 | Las tablas Unicode (`\p{Nd}`, `Extended_Pictographic`, segmentación) dependen del ICU de Node (22.x) | Las pruebas fijan el comportamiento. Una actualización de Node debe repetir AT-02 |
| RS-07 | Solo se neutralizan marcadores **entre corchetes**. El marcador ya existente `[unsupported inbound content: …]` de la ingesta no se neutraliza | El marcador de reanudación no lleva resultados (OA-08). El estado se lee con `identity.verification_status@1`. El marcador `unsupported` queda fuera del alcance de SEC-OTP |
| RS-08 | Un mensaje con el código y palabras no listadas no se envía, y el cliente debe repetirlo | Comportamiento conservador decidido (OA-07b) |

---

## 10. Commits y baseline

| | Valor |
|---|---|
| Baseline R4 | `origin/main` `c4c2ff8048289eb09ee7aa790225ea6e71df1e1a` (merge del PR #14) |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| Commit de código | `4ff7a47` — `feat(identity-verification): SEC-S1 pure OTP message classifier` |
| Commit documental | El que contiene este informe y el registro de decisiones (decisión §7.4 y §13; RR-1 §4 y §7) |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` (convención de R4) |
| Publicación | Rama `feat/r4-j4-sec-s1-otp-classifier` con un PR para revisión. **No se fusiona automáticamente** |

---

## 11. Pendiente

- **SEC-S2 no se inicia** sin un mandato posterior.
- SEC-OTP-01 y SEC-OTP-02 siguen **incompletos**: falta todo lo que vive fuera del clasificador (S2 a S7).
- `GATE_RR1` pendiente. BA-01 a BA-06, G-16, AP-* y D7 pendientes. OA-10 y autorizaciones productivas pendientes.
- Las capacidades Customer siguen ausentes de los perfiles productivos. Los datos reales siguen bloqueados.
