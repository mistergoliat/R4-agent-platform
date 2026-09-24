/** The root goal of every Sales conversation task (requester intention; the agent may refine it with sub-goals). */
export const SALES_ROOT_GOAL = {
  description: 'Help this customer reach a purchase decision that fits their real objective and constraints, and a governed quote when they want one.',
  successCriteria: ['the customer objective and constraints are understood and kept', 'any proposed solution is grounded in current catalog evidence', 'a quote is claimed only from a receipt-backed observation'],
};
