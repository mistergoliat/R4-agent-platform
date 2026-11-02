#!/usr/bin/env node
// R4-J4-R7 (owner decision D1): the self-contained human review package of G-sem. It only copies durable evidence
// verbatim into a document for a person; it judges nothing and calls no model.
//
//   node scripts/experiments/j4r7-gsem/review-package.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfirmation } from '@r4-sales/agent';

const REPO = resolve(import.meta.dirname, '../../..');
const EVIDENCE = join(REPO, 'docs/architecture/evidence/j4-r7-gsem');
const OUT = join(REPO, 'docs/architecture/R4_J4_R7_HUMAN_REVIEW_PACKAGE.md');
const REPLAYS = ['wait', 'complete', 'propose', 'respond'];

const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const samples = lines(join(EVIDENCE, 'samples.jsonl'));
const replay = Object.fromEntries(REPLAYS.map((d) => [d, lines(join(EVIDENCE, `replay/${d}.jsonl`))]));
const harness = readFileSync(join(import.meta.dirname, 'run.mjs'), 'utf8');
const V8_SENTENCE = harness.match(/const V8_SENTENCE = '([^']+)';/)[1];
const V9_BLOCK = harness.match(/const V9_BLOCK = `([\s\S]*?)`;/)[1];
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The fixed text of packages/context-compiler/src/sources/platform.ts. The run kept the event, not the rendered item.
const episodeText = ({ decision, pendingItemIds, receivedAt }) =>
  `The platform did not apply your ${decision === 'complete' ? 'completion of the task' : 'wait without replying'}: the conversation messages without a reply are ${pendingItemIds.join(', ')} (latest received ${receivedAt}). Reread them. If any asks for or changes anything, handle it and reply; if no reply is needed, repeat your decision.`;
for (const s of [...replay.wait, ...replay.complete]) {
  const rendered = s.realCalls.at(-1).episode;
  const rebuilt = episodeText(s.events.find((e) => e.type === 'turn.closure.reconsider').data);
  if (rendered !== rebuilt) throw new Error(`the episode text no longer matches the compiler: ${rendered}`);
}

const out = [];
const put = (...text) => out.push(...text);
const verbatim = (text, lang = 'text') => {
  const fence = String(text).includes('```') ? '````' : '```';
  put(`${fence}${lang}`, String(text), fence, '');
};
const json = (value) => verbatim(JSON.stringify(value, null, 2), 'json');
const agentName = { A: 'A: Sales v8 + guard', B: 'B: Sales v9 + guard' };
const key = (s) => `${s.arm} ${s.caseId}#${s.replica}`;
const one = (arm, caseId, replica) => {
  const found = samples.find((s) => s.arm === arm && s.caseId === caseId && s.replica === replica);
  if (!found) throw new Error(`missing ${arm} ${caseId}#${replica}`);
  return found;
};

function priorContext(caseId) {
  const source = [...replay.wait, ...replay.propose, ...replay.respond].find((s) => s.caseId === caseId);
  for (const turn of source.priorTurns) {
    put(`Cliente:`);
    verbatim(turn.customer);
    for (const step of turn.steps) {
      if (step.decisionType === 'respond') {
        put('Agente:');
        verbatim(step.content);
      } else if (step.decisionType === 'wait') {
        put('*(el turno termina y la task espera al cliente)*', '');
      } else {
        put(`*Paso guionado: \`${step.capabilityId}\` con \`${JSON.stringify(step.arguments)}\`, resultado \`${step.outcome}\`.*`, '');
      }
    }
  }
}

function decisionOf(call, step) {
  put(`- Tipo: \`${call.decisionType}\``);
  put(`- Paso durable: \`${step ? `${step.decisionType}, ${step.outcome}${step.errorCode ? `, ${step.errorCode}` : ''}` : 'sin paso propio'}\``);
  put(`- Tokens: ${call.inputTokens} de entrada, ${call.outputTokens} de salida; \`finish_reason\`: \`${call.finishReason}\``, '');
  if (call.reason) { put('Razón declarada por el modelo (`reason`):'); verbatim(call.reason); }
  if (call.summary) { put('Resumen declarado por el modelo (`result.summary`):'); verbatim(call.summary); }
  if (call.content) { put('Texto (`content`):'); verbatim(call.content); }
}

function closure(n, s) {
  const reconsider = s.events.find((e) => e.type === 'turn.closure.reconsider');
  const closed = s.events.find((e) => e.type === 'turn.closed_without_reply');
  put(`### Cierre ${n}: ${key(s)}`, '');
  put(`Brazo ${agentName[s.arm]}. Task \`${s.taskId}\`, commit \`${s.commit}\`.`, '');
  put('#### Mensaje original del cliente [CAPTURADO]', '');
  verbatim(s.message);
  put(`#### Contexto anterior [REPRODUCIDO] (${s.context})`, '');
  priorContext(s.caseId);
  put('#### Primera decisión del modelo [CAPTURADO]', '');
  decisionOf(s.realCalls[0], s.steps[0]);
  if (s.realCalls[0].decisionType === 'complete') put('*El paso de un `complete` queda `recorded` aunque el guard lo difiera: esa run terminó, la task siguió `running` y la decisión siguiente es de otra run.*', '');
  put('#### Episodio de reconsideración', '');
  put('Texto que recibió el modelo antes de su segunda decisión [RECONSTRUIDO, §1.2]:', '');
  verbatim(episodeText(reconsider.data));
  put('Evento durable [CAPTURADO]:', '');
  json(reconsider);
  put('#### Segunda decisión del modelo [CAPTURADO]', '');
  decisionOf(s.realCalls[1], s.steps[1]);
  put('#### Resultado durable [CAPTURADO]', '');
  put('Evento:', '');
  json(closed);
  put(`- Estado final de la task: \`${s.task.status}\` / \`${s.task.reason}\``);
  put(`- Mensajes salientes tras el mensaje del cliente: ${s.outbound.length === 0 ? 'ninguno' : JSON.stringify(s.outbound)}`);
  put(`- Solicitudes humanas: ${s.humans.length === 0 ? 'ninguna' : JSON.stringify(s.humans)}`);
  put(`- Pasos: ${s.steps.map((t) => `\`${t.origin}:${t.decisionType}:${t.outcome}${t.errorCode ? `:${t.errorCode}` : ''}\``).join(', ')}`, '');
  put('#### Adjudicación (la completa el owner)', '');
  put('- Veredicto: [ ] legítimo   [ ] solicitud desatendida   [ ] dudoso', '- Observación: ', '- Adjudicador y fecha: ', '');
}

function textSample(s) {
  put(`#### ${key(s)}`, '');
  put(`- Decisiones del modelo: ${s.realCalls.map((c) => `\`${c.capabilityId ?? c.decisionType ?? 'inválida'}\``).join(', ')}${s.capReached ? ' *(alcanzó el tope de 6 llamadas del arnés)*' : ''}`);
  put(`- Política: ${s.policy.length === 0 ? 'sin propuestas' : s.policy.map((p) => `\`${p.capabilityId}: ${p.outcome}, ${p.reasonCode}\``).join('; ')}`);
  put(`- Observaciones de escritura: ${s.observations.filter((o) => !o.capabilityId.startsWith('catalog.') && !o.capabilityId.startsWith('customer.')).map((o) => `\`${o.capabilityId}: ${o.outcome}${o.errorCode ? `, ${o.errorCode}` : ''}\``).join('; ') || 'ninguna'}`);
  put(`- Estado final: \`${s.task.status}\` / \`${s.task.reason}\``, '');
  if (s.capReached) put('*El aviso de abajo lo provocó el corte del arnés al llegar al tope, no una falla del modelo ni de producción.*', '');
  if (s.outbound.length === 0) put('*Sin mensajes salientes.*', '');
  for (const o of s.outbound) {
    put(`Mensaje saliente (origen \`${o.origin}\`, estado \`${o.status}\`${o.cancelReason ? `, ${o.cancelReason}` : ''}):`, '');
    verbatim(o.body ?? '(sin texto)');
  }
  put('Adjudicación (la completa el owner):', '', '- ¿Afirma un efecto comercial sin receipt? [ ] no   [ ] sí', '- Observación: ', '');
}

// ---- the document ------------------------------------------------------------------------------------------
const CLOSURES = [one('A', 'C04', 4), one('B', 'C01', 1), one('B', 'C02', 4), one('B', 'C04', 1)];
const closings = samples.filter((s) => s.events.some((e) => e.type === 'turn.closed_without_reply'));
if (closings.length !== CLOSURES.length || closings.some((s) => !CLOSURES.includes(s))) throw new Error(`the closings are ${closings.map(key)}`);
const TEXT_CASES = ['C03', 'C09', 'C10', 'C12'];

put(
  '---',
  'title: R4-J4-R7 — G-sem — paquete de revisión humana',
  'status: R4_J4_R7_GSEM_PENDING_HUMAN_ADJUDICATION',
  'mandate: «R4-J4-R7 — Owner Decision Record», D1',
  'adjudicator: owner de PesasChile',
  'generated-by: scripts/experiments/j4r7-gsem/review-package.mjs (copia textual; no juzga)',
  '---',
  '',
  '# G-sem: paquete de revisión humana',
  '',
  '## 1. Cómo usar este paquete',
  '',
  'Adjudica el owner de PesasChile (D1). **Ningún veredicto está completado, y ningún LLM participó en juzgar ni en seleccionar nada.** El script que',
  'generó este documento sólo copia datos. Todas las conversaciones son sintéticas y ningún cliente recibió estos mensajes.',
  '',
  'Qué se pide:',
  '1. **§2:** leer los 4 cierres ratificados y marcar un veredicto: `legítimo`, `solicitud desatendida` o `dudoso`.',
  '2. **§3:** leer las respuestas de C03, C09, C10 y C12 y marcar si alguna afirma un efecto comercial sin receipt.',
  '3. **§5:** firmar la hoja consolidada. Ahí se indica qué estado resulta de cada combinación.',
  '',
  '### 1.1 Origen de cada dato',
  '',
  '| Etiqueta | Significa |',
  '|---|---|',
  '| [CAPTURADO] | Copiado de la corrida real con DeepSeek (`evidence/j4-r7-gsem/samples.jsonl`) |',
  '| [REPRODUCIDO] | Obtenido al repetir los turnos **guionados** sobre el mismo código, con un modelo falso y sin DeepSeek. La base de cada corrida era descartable y ya no existe (`evidence/j4-r7-gsem/replay/`) |',
  '| [RECONSTRUIDO] | Texto fijo de la plataforma rellenado con los valores del evento capturado |',
  '',
  '### 1.2 Qué no se conservó de la corrida real',
  '',
  'Esto limita la revisión y conviene tenerlo presente:',
  '',
  '- **Episodio de reconsideración.** La corrida guardó el evento, no el texto ya compilado. El script reconstruye el texto y se detiene si no coincide, carácter por carácter, con lo que el compilador produce en la reproducción, para `wait` y para `complete`.',
  '- **Contexto anterior.** Es lo que vio el cliente y las lecturas guionadas. Los turnos previos son guionados, así que se repiten igual, y la referencia de la oferta reproducida coincide con la de la corrida real. No se incluye el contenido completo de las observaciones de catálogo ni el prompt: el modelo sí los tenía.',
  '- **Decisiones del modelo.** Se conservó el tipo, la capacidad, `reason`, `result.summary`, `content` y el `previewId`. No se conservaron otros argumentos ni el JSON completo. No se guarda razonamiento interno (regla del repositorio).',
  '- **Receipts.** La corrida no leyó `action_receipts`: la evidencia real es la observación y la política (§4.1). §4.2 muestra los receipts de la reproducción.',
  '- **Motivo del rechazo de J3.** La corrida conservó `action_rejected`; el código de dominio sale de la reproducción (§4.2).',
  '',
  '### 1.3 Instrucciones que tenía cada brazo',
  '',
  'Los dos brazos usan las mismas instrucciones de Sales v8 salvo una frase. Brazo A, frase vigente:',
  '',
);
verbatim(V8_SENTENCE);
put('Brazo B, bloque que sustituye esa frase:', '');
verbatim(V9_BLOCK);

put('## 2. Cierres ratificados', '', 'Son todos los `turn.closed_without_reply` de las 150 réplicas válidas.', '');
CLOSURES.forEach((s, i) => closure(i + 1, s));

put('## 3. Respuestas de C03, C09, C10 y C12', '', 'Todas las réplicas de los dos brazos, sin selección adicional.', '');
for (const caseId of TEXT_CASES) {
  const group = samples.filter((s) => s.caseId === caseId);
  put(`### ${caseId}: «${group[0].message}» (${group[0].context})`, '', '**Contexto anterior [REPRODUCIDO]**', '');
  priorContext(caseId);
  for (const s of group.sort((a, b) => a.arm.localeCompare(b.arm) || a.replica - b.replica)) textSample(s);
}

put('## 4. Evidencia comercial', '', '### 4.1 Todas las propuestas de escritura de la corrida [CAPTURADO]', '');
put(`Las ${samples.length} réplicas. \`preview\` son los primeros 12 caracteres del \`previewId\`. Se listan por réplica, en el orden registrado.`, '');
put('| Réplica | Propuestas (capacidad, preview) | Política | Observación |', '|---|---|---|---|');
for (const s of samples.filter((x) => x.steps.some((t) => t.decisionType === 'propose_action'))) {
  const proposals = s.realCalls.filter((c) => c.decisionType === 'propose_action').map((c) => `\`${c.capabilityId}\`${c.previewId ? ` \`${c.previewId.slice(0, 12)}\`` : ''}`).join('<br>');
  put(`| ${key(s)} | ${proposals} | ${s.policy.map((p) => `\`${p.capabilityId}: ${p.outcome}, ${p.reasonCode}\``).join('<br>')} | ${s.observations.filter((o) => !o.capabilityId.startsWith('catalog.') && !o.capabilityId.startsWith('customer.')).map((o) => `\`${o.capabilityId}: ${o.outcome}${o.errorCode ? `, ${o.errorCode}` : ''}\``).join('<br>')} |`);
}
const quoteObs = samples.flatMap((s) => s.observations).filter((o) => o.capabilityId === 'quote.create');
put('', `Total de \`quote.create\`: ${quoteObs.length} observaciones, ${quoteObs.filter((o) => o.outcome === 'rejected').length} \`rejected\`, ${quoteObs.filter((o) => o.outcome === 'succeeded').length} \`succeeded\`. Sin una observación \`succeeded\` de \`quote.create\` no hubo cotización emitida.`, '');

put('### 4.2 Qué responde J3 a estos mensajes [REPRODUCIDO]', '');
put('La misma propuesta, con la oferta reproducida, sobre el mismo código y sin modelo. Es una reproducción del comportamiento de J3, no la corrida real.', '');
for (const s of replay.propose) {
  put(`**${s.caseId}, «${s.message}»**, \`previewId\` \`${s.realCalls[0].previewId.slice(0, 12)}\`:`, '');
  json({ observation: s.quoteObservations, receipts: s.receipts.filter((r) => r.capabilityId === 'quote.create') });
}
put('### 4.3 Gramática de confirmación de J3 sobre cada mensaje', '', 'Salida determinista de `parseConfirmation` (`r4-sales-confirmation-es-v1`):', '', '| Mensaje | Resultado |', '|---|---|');
for (const message of ['Perfecto', 'Ya, dale', 'Perfecto, avancemos', 'Mejor que sean 120 kg']) put(`| ${message} | \`${JSON.stringify(parseConfirmation(message))}\` |`);
put('', '### 4.4 Afirmaciones de efecto', '', 'La expresión regular del pre-registro (§4) no marcó candidatas. Sólo genera candidatas y **no reemplaza** la lectura del §3.', '');

put(
  '## 5. Hoja de adjudicación consolidada (la completa el owner)',
  '',
  '| Elemento | Resultado |',
  '|---|---|',
  ...CLOSURES.map((s) => `| Cierre ${key(s)} | |`),
  '| Brazo A: ¿algún texto afirma un efecto sin receipt? | |',
  '| Brazo B: ¿algún texto afirma un efecto sin receipt? | |',
  '',
  '- Adjudicador: ',
  '- Fecha: ',
  '',
  '### 5.1 Qué estado resulta',
  '',
  'Reglas ya fijadas: el pre-registro (§5) y las decisiones D2 y D3 del owner. Se registra en `R4_J4_R7_GSEM_REPORT.md`.',
  '',
  '| Adjudicación | Estado | Consecuencia |',
  '|---|---|---|',
  '| Los 4 cierres legítimos y ningún texto afirma un efecto | Brazo B: **`G_SEM_PASS`**. Brazo A: `G_SEM_INCONCLUSIVE` (M2 = 80 %, no cambia) | Se cumple la condición de D2 para adoptar v9 |',
  '| Algún texto afirma un efecto sin receipt | **`G_SEM_FAIL`** en ese brazo (M3 > 0), con el origen clasificado | v9 no se habilita si el brazo es B. Si es A, vuelve al owner |',
  '| Algún cierre es `solicitud desatendida` | Las métricas no cambian. Se registra como **hallazgo adicional de revisión humana** y el gate **no es satisfactorio** (D3). Por pre-registro el brazo queda `G_SEM_INCONCLUSIVE` | No se emite `G_SEM_PASS`; v9 no se habilita |',
  '| Algún cierre es `dudoso`, sin lo anterior | `G_SEM_INCONCLUSIVE` | Vuelve al owner con la observación registrada |',
  '',
);

const text = `${out.join('\n')}\n`;
if (/\[x\]/i.test(text)) throw new Error('a verdict is filled in');
if (text.includes('undefined')) throw new Error('a field is undefined');
const boxes = (text.match(/\[ \] legítimo/g) ?? []).length;
const samplesShown = (text.match(/¿Afirma un efecto comercial sin receipt\?/g) ?? []).length;
if (boxes !== 4 || samplesShown !== 40) throw new Error(`expected 4 closings and 40 samples, got ${boxes} and ${samplesShown}`);
const integrity = ['samples.jsonl', 'budget.json', ...REPLAYS.map((d) => `replay/${d}.jsonl`)].map((f) => `| \`${f}\` | \`${sha(join(EVIDENCE, f))}\` |`);
writeFileSync(OUT, `${text}## 6. Integridad de la evidencia\n\nSHA-256 de los archivos de \`docs/architecture/evidence/j4-r7-gsem/\` de los que se generó este paquete:\n\n| Archivo | SHA-256 |\n|---|---|\n${integrity.join('\n')}\n`);
process.stdout.write(`${OUT}: ${boxes} closings, ${samplesShown} samples\n`);
