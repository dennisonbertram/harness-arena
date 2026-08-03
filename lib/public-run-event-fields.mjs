export const PUBLIC_RUN_EVENT_FIELDS = Object.freeze({
  "task.started": Object.freeze(["task_id", "index"]),
  "task.agent_finished": Object.freeze(["task_id", "turns", "output_tokens", "cost_usd", "duration_s"]),
  "task.verify_started": Object.freeze(["task_id"]),
  "task.verified": Object.freeze(["task_id", "passed", "reward", "duration_s"]),
  "task.failed": Object.freeze(["task_id", "stage", "duration_s"]),
  "task.trace_uploaded": Object.freeze(["task_id"]),
  "task.cost_tamper_signal": Object.freeze(["task_id", "reason", "negative_cost_count"]),
  "run.budget_exceeded": Object.freeze(["spent_usd", "cap_usd", "tasks_completed"]),
  "run.completed": Object.freeze(["tasks_passed", "total_cost_usd", "duration_s"]),
  "run.failed": Object.freeze(["stage"]),
});
