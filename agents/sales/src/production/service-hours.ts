/**
 * (Owner decision 2026-11-12) The Sales team's service hours: business days (Monday to Friday) from 10:00 to 17:00,
 * Chile time (America/Santiago). Outside them, every platform message that promises a person says so: "nuestro equipo
 * está entrenando" and when they will answer. Pure: the instant is always passed in (the composition owns the clock).
 *
 * ponytail: Chilean public holidays are not modelled (a holiday counts as a business day); add a holiday list when the
 * owner provides one.
 */

export const SALES_SERVICE_HOURS = Object.freeze({ timeZone: 'America/Santiago', opens: 10, closes: 17 });

export interface ServiceWindow {
  /** A person can answer now. */
  readonly open: boolean;
  /** When closed: whether people answer later today (before opening on a business day) or on the next business day. */
  readonly reopens: 'today' | 'next_business_day' | null;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const CHILE = new Intl.DateTimeFormat('en-US', { timeZone: SALES_SERVICE_HOURS.timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });

export function salesServiceWindow(at: Date): ServiceWindow {
  const parts = Object.fromEntries(CHILE.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = WEEKDAYS[parts.weekday ?? ''] ?? 1;
  const hour = Number(parts.hour);
  const businessDay = weekday <= 5;
  if (businessDay && hour >= SALES_SERVICE_HOURS.opens && hour < SALES_SERVICE_HOURS.closes) return { open: true, reopens: null };
  return { open: false, reopens: businessDay && hour < SALES_SERVICE_HOURS.opens ? 'today' : 'next_business_day' };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long the team has to answer a consultation, inside service hours. */
export const SALES_CONSULTATION_ANSWER_MS = 30 * MINUTE;
/** WhatsApp lets the agent write freely for 24 h after the customer's last message; it wakes this much before that. */
export const SALES_CUSTOMER_WINDOW_MARGIN_MS = 30 * MINUTE;

/** The next instant service opens, strictly after `at` (Chile changes offset by whole hours, so whole UTC hours align). */
function nextOpening(at: Date): Date {
  let t = Math.ceil((at.getTime() + 1) / HOUR) * HOUR;
  for (let i = 0; i < 24 * 10; i++, t += HOUR) if (salesServiceWindow(new Date(t)).open) return new Date(t);
  return new Date(at.getTime() + 24 * HOUR); // unreachable with business days in every week
}

/**
 * (Owner decision 2026-11-23) When a consultation of the team expires: 30 min if the team can answer within service
 * hours; otherwise the next opening + 30 min; never later than the customer's 24 h window (latest input + 24 h, minus a
 * margin), so the agent can still write when it wakes; never earlier than a minute from now.
 */
export function salesConsultationExpiry({ now, latestInputAt }: { readonly now: string; readonly latestInputAt: string | null }): string {
  const at = new Date(now);
  const soon = new Date(at.getTime() + SALES_CONSULTATION_ANSWER_MS);
  const inHours = salesServiceWindow(at).open && salesServiceWindow(new Date(soon.getTime() - 1)).open;
  const rule = inHours ? soon : new Date(nextOpening(at).getTime() + SALES_CONSULTATION_ANSWER_MS);
  const window = Date.parse(latestInputAt ?? now) + 24 * HOUR - SALES_CUSTOMER_WINDOW_MARGIN_MS;
  return new Date(Math.max(at.getTime() + MINUTE, Math.min(rule.getTime(), window))).toISOString();
}

/** "Nuestro equipo está entrenando…" with when they answer; only meaningful when the window is closed. */
export function salesTeamTrainingSentence(w: ServiceWindow): string {
  return `Nuestro equipo está entrenando 💪 y te responderá ${w.reopens === 'today' ? 'hoy' : 'el siguiente día hábil'}, entre las 10:00 y las 17:00.`;
}

/**
 * What the customer is told when the bot could not see or process what they sent (and the conversation continues: no
 * hand-off). In hours: the problem, a retry, and the offer of a trainer. Outside hours: the same, and when the team answers.
 */
export function salesUnprocessableSentence(at: Date, sense: 'ver' | 'escuchar' = 'ver'): string {
  const w = salesServiceWindow(at);
  const ask = `Tuve un problema para ${sense} lo que me enviaste y estoy intentando solucionarlo. ¿Me lo puedes enviar de nuevo o escribirme qué necesitas?`;
  return w.open ? `${ask} Si prefieres, te derivo con un entrenador de nuestro equipo.` : `${ask} Si prefieres hablar con un entrenador: ${salesTeamTrainingSentence(w)}`;
}

/** The platform's notice when a run failure hands the conversation to a person (a person really reviews it). */
export function salesRunFailureNotice(at: Date): string {
  const w = salesServiceWindow(at);
  return w.open
    ? 'Tuve un problema con tu mensaje y estoy intentando solucionarlo: ya le avisé a un asesor de nuestro equipo, que te responderá por este mismo chat. No hace falta que repitas lo que escribiste.'
    : `Tuve un problema con tu mensaje y se lo dejé a nuestro equipo. ${salesTeamTrainingSentence(w)} No hace falta que repitas lo que escribiste.`;
}

/** The platform's notice when the agent opened a human request (consultation or hand-off) without replying. */
export function salesHumanRequestNotice(at: Date): string {
  const w = salesServiceWindow(at);
  return w.open
    ? 'Gracias por tu mensaje. Lo estoy consultando con un asesor de nuestro equipo de PesasChile; la respuesta llegará por este mismo chat. No hace falta que repitas lo que escribiste.'
    : `Gracias por tu mensaje. ${salesTeamTrainingSentence(w)} La respuesta llegará por este mismo chat; no hace falta que repitas lo que escribiste.`;
}
