// STUB — intentionally unimplemented so RED tests fail for the right
// (behavioral) reason instead of a module-not-found error. Filled in on the
// green commit.

export function parseSessionCost(_jsonlText) {
  return { totalCost: -1, turns: -1 };
}

export function computeTotals(_taskResults) {
  return { tasks_passed: -1, total_cost_usd: -1 };
}

export function budgetExceeded(_spent, _cap) {
  return false;
}

export function parseReward(_text) {
  return false;
}

export function shQuote(_value) {
  return "";
}

export function buildPiCommand(_opts) {
  return "";
}
