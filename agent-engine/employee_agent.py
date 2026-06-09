"""Employee Agent — Gemini 2.5 Flash via Vertex AI / ADK Python SDK.

Mirrors src/lib/adk/employee-agent.ts. Same model, same voice, same
slot-filling discipline. Source of truth for the system prompt is in
`prompts/employee_es_AR.md` to avoid drift from the TS counterpart in
src/app/api/business-assistant/_lib/employee-system-prompt.ts.

For the contest, this Python build runs INSIDE Agent Engine, while the
TS build runs INSIDE Cloud Run. The two paths are kept in sync via a
shared prompt file (single source of truth) checked into the repo.
"""

from __future__ import annotations

from pathlib import Path

from google.adk.agents import Agent
from google.adk.models import Gemini


_PROMPT_PATH = Path(__file__).parent / "prompts" / "employee_es_AR.md"


def _load_prompt() -> str:
    if _PROMPT_PATH.exists():
        return _PROMPT_PATH.read_text(encoding="utf-8")
    # Fallback inline prompt — keeps the deploy unblocked if the prompt
    # file is missing in a particular build context.
    return (
        "Sos el agente Empleado de Velora. Hablás como un compañero de turno: "
        "cálido, conciso, en español argentino. Resolvés ventas, consultas de "
        "stock y altas de clientes con slot-filling. Si te falta info, preguntá "
        "una sola cosa por turno. Nunca inventás productos: si no encontrás un "
        "match, pedí confirmación al cajero."
    )


def build_employee_agent() -> Agent:
    """Construct the Employee Agent for Agent Engine deployment."""
    return Agent(
        name="velora_employee",
        model=Gemini(model_name="gemini-2.5-flash"),
        instruction=_load_prompt(),
        description=(
            "Velora's Employee Agent — Spanish-speaking shift partner that "
            "handles cashier-side intents: register_sale, check_stock, "
            "create_customer, business_query."
        ),
    )
