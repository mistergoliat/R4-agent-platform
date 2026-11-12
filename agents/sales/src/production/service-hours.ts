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

export function salesServiceWindow(at: Date): ServiceWindow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: SALES_SERVICE_HOURS.timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const weekday = WEEKDAYS[parts.weekday ?? ''] ?? 1;
  const hour = Number(parts.hour);
  const businessDay = weekday <= 5;
  if (businessDay && hour >= SALES_SERVICE_HOURS.opens && hour < SALES_SERVICE_HOURS.closes) return { open: true, reopens: null };
  return { open: false, reopens: businessDay && hour < SALES_SERVICE_HOURS.opens ? 'today' : 'next_business_day' };
}

/** "Nuestro equipo está entrenando…" with when they answer; only meaningful when the window is closed. */
export function salesTeamTrainingSentence(w: ServiceWindow): string {
  return `Nuestro equipo está entrenando 💪 y te responderá ${w.reopens === 'today' ? 'hoy' : 'el siguiente día hábil'}, entre las 10:00 y las 17:00.`;
}

/**
 * What the customer is told when the bot could not see or process what they sent (and the conversation continues: no
 * hand-off). In hours: the problem, a retry, and the offer of a trainer. Outside hours: the same, and when the team answers.
 */
export function salesUnprocessableSentence(at: Date): string {
  const w = salesServiceWindow(at);
  const ask = 'Tuve un problema para ver lo que me enviaste y estoy intentando solucionarlo. ¿Me lo puedes enviar de nuevo o escribirme qué necesitas?';
  return w.open ? `${ask} Si prefieres, te derivo con un entrenador de nuestro equipo.` : `${ask} Si prefieres hablar con un entrenador: ${salesTeamTrainingSentence(w)}`;
}

/** The platform's notice when a run failure hands the conversation to a person (a person really reviews it). */
export function salesRunFailureNotice(at: Date): string {
  const w = salesServiceWindow(at);
  return w.open
    ? 'Tuve un problema con tu mensaje y estoy intentando solucionarlo: ya lo estoy consultando con un asesor de nuestro equipo, que te responderá por este mismo chat. No hace falta que repitas lo que escribiste.'
    : `Tuve un problema con tu mensaje y se lo dejé a nuestro equipo. ${salesTeamTrainingSentence(w)} No hace falta que repitas lo que escribiste.`;
}

/** The platform's notice when the agent opened a human request (consultation or hand-off) without replying. */
export function salesHumanRequestNotice(at: Date): string {
  const w = salesServiceWindow(at);
  return w.open
    ? 'Gracias por tu mensaje. Lo estoy consultando con un asesor de nuestro equipo de PesasChile; la respuesta llegará por este mismo chat. No hace falta que repitas lo que escribiste.'
    : `Gracias por tu mensaje. ${salesTeamTrainingSentence(w)} La respuesta llegará por este mismo chat; no hace falta que repitas lo que escribiste.`;
}
