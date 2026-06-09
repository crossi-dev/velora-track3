"""Velora multi-agent system — Vertex Agent Engine entry point.

This module is deployed to Vertex AI Agent Engine via `deploy.py`, which calls
`vertexai.agent_engines.create(AdkApp(...))` (the stable `agent_engines` API).
It wraps the same Employee + Supervisor agents that run on Cloud Run (TypeScript),
expressed in the ADK Python SDK so they can run in Agent Engine's managed runtime.

Why a parallel Python implementation:
- Cloud Run hosts the user-facing Velora app (Next.js TS) — that's where
  the cashier types and the dashboard renders. It will not move.
- Vertex Agent Engine is the managed runtime for the *agent system*. We
  deploy the same multi-agent pattern (Employee + Supervisor + A2A) here
  so the contest mandate "Focus on the deployment of your multi-agent
  system on Agent Engine" is satisfied with a real, callable runtime.
- The Python ADK SDK has first-class Agent Engine support via the stable
  `vertexai.agent_engines` module; the TypeScript ADK SDK does not yet.

Behavior parity with TS:
- Employee agent uses Gemini 2.5 Flash, warm voice, slot-filling.
- Supervisor agent uses Gemini 2.5 Pro, cold/analytical, info-only filter.
- A2A bus translation: Agent Engine endpoint receives `EmployeeEvent` v1
  contract from Pub/Sub or HTTP and emits `SupervisorNotification` v1.

The Cloud Run app may forward chat traffic to this Agent Engine endpoint
when the env flag `USE_AGENT_ENGINE=true` is set; otherwise it uses the
local TS ADK path (the default for low-latency interactive UX).
"""

from __future__ import annotations

import os

import vertexai
# Use the stable agent_engines module (not vertexai.preview.reasoning_engines,
# which is deprecated — agent_engines is the current API per Vertex AI SDK 1.94+).
from vertexai.agent_engines import AdkApp

from employee_agent import build_employee_agent
from supervisor_agent import build_supervisor_agent

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "my-gcp-project")
LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
STAGING_BUCKET = os.environ.get("AGENT_ENGINE_STAGING_BUCKET", f"gs://{PROJECT_ID}-agent-engine")


def init() -> None:
    """Initialize Vertex AI with project + location + staging bucket."""
    vertexai.init(
        project=PROJECT_ID,
        location=LOCATION,
        staging_bucket=STAGING_BUCKET,
    )


def build_app() -> AdkApp:
    """Construct the AdkApp wrapping both agents.

    AdkApp accepts a single root agent. The Supervisor is root and the
    Employee is registered as a sub-agent on the Supervisor itself
    (ADK's native sub_agents pattern). The Supervisor can `transfer` to
    the Employee for cashier-side intents and `transfer_to_parent` is
    disabled on the Employee to keep the conversation flow predictable.
    """
    employee = build_employee_agent()
    supervisor = build_supervisor_agent()
    supervisor.sub_agents = [employee]

    return AdkApp(
        agent=supervisor,
        enable_tracing=True,
    )


if __name__ == "__main__":
    # Local smoke test — does not deploy.
    init()
    app = build_app()
    print(f"App constructed: {app}")
    print(f"Project: {PROJECT_ID}, Location: {LOCATION}")
    print("To deploy: bash ../scripts/deploy-agent-engine.sh")
