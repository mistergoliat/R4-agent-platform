-- R4-J1E-R2 / ADR-031 — platform steps beyond revalidation READs.
-- Besides the token-free READ that revalidates a proposed response, the
-- platform (never a model call, never tokens) may record:
--   * the WAIT_UNTIL that defers a draft until its owner evidence can yield a
--     new validity window (durable wait/wake, ADR-021);
--   * a deferred draft recorded (or refused) once revalidated;
--   * the run's one safe degradation.
alter table agent_run_steps drop constraint agent_run_steps_platform_origin_is_read;
alter table agent_run_steps
  add constraint agent_run_steps_platform_origin_decisions
  check (origin = 'model' or (decision_type in ('read_capability', 'respond', 'wait') and input_tokens = 0 and output_tokens = 0));
