# Employee-removal follow-ups (needs a decision, not autonomous action)

Stages 1–3 of the employee-concept removal are complete and deployed (commits
0323895, 81ecd89, e90cbb9). Two related items remain, deliberately not acted on:

## 1. Equipo agent (`src/app/api/agents/equipo/**`) — delete or keep?

Its tools are literally PIN-login employee management (`create_employee`,
`reset_employee_pin`, `get_employee_credentials`, `broadcast_employees`). The
Supervisor already shelved calling it on 2026-05-25 (excluded from its tool
list, materialization pipeline removed) — it has zero live callers today.

This is a product decision (delete the dead route entirely, or keep the code
around in case employee management gets revived later), not a technical one —
left untouched pending that call.

## 2. Companion agent "employee" naming (`role-contract.ts`,
`rbac-policy.ts`, `src/lib/adk/employee-agent*.ts`) — rename or leave?

Unlike Equipo, the Companion agent is genuinely live (called directly by the
owner's own NLU dispatcher, not just its A2A endpoint). Its internal actor-kind
is still literally the string `"employee"` — legacy naming from before the
PIN-login concept was removed, not load-bearing behavior. Renaming to
something accurate (e.g. `"companion"`) is confirmed safe / zero behavior
change, but cascades into ~1500 lines of existing passing unit tests built
around the `"employee"` naming (e.g. `tests/unit/rbac-policy.test.cjs`, ~40
assertions).

Left untouched: it's a live, external-facing A2A feature, and a purely
cosmetic rename touching that much passing test surface deserves a real
review pass, not an autonomous edit. The public agent-card metadata (skill id
`assist.employee.turn`) was also left alone since it's live A2A protocol
surface an external caller may already parse.
