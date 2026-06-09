"""Deploy Velora's Supervisor agent to Vertex Agent Engine.

Uses `vertexai.agent_engines.create` (the current API, which supports
`env_vars`) so the deployed agent can reach Velora's MCP server with
per-business HMAC auth. The older `reasoning_engines.ReasoningEngine.create`
has no env_vars parameter and is therefore not used here.

Run:
    cd agent-engine
    A2A_SECRET=$(gcloud secrets versions access latest --secret=A2A_SECRET \
        --project=my-gcp-project) \
      ./.venv/Scripts/python.exe deploy.py

Requires:
    - gcloud auth application-default login (once)
    - A staging GCS bucket: gs://<project>-agent-engine

Outputs the Agent Engine resource name. Persist it to the Cloud Run env
AGENT_ENGINE_RESOURCE_NAME if you want the TS app to forward traffic.
"""

from __future__ import annotations

import argparse
import os
import sys

from vertexai import agent_engines

from main import build_app, init

_REQUIREMENTS = [
    "google-cloud-aiplatform[adk,reasoningengines]>=1.94.0",
    "google-adk>=1.34.0,<2.0.0",
    "google-genai>=1.0.0",
]


def deploy(display_name: str = "velora-supervisor-mcp", description: str | None = None) -> str:
    init()
    app = build_app()

    # The agent reads A2A_SECRET + VELORA_BUSINESS_ID at runtime to derive the
    # per-business MCP key. Forward both into the Agent Engine runtime env.
    business_id = os.environ.get("VELORA_BUSINESS_ID", "demo-business-id")
    env_vars = {"VELORA_BUSINESS_ID": business_id}
    secret = os.environ.get("A2A_SECRET", "")
    if secret:
        env_vars["A2A_SECRET"] = secret

    print(f"Deploying AdkApp to Agent Engine as '{display_name}'...")
    print("Packages the agent, uploads to staging, registers the engine.")
    print("May take 5-15 min on first deploy.")

    remote = agent_engines.create(
        app,
        requirements=_REQUIREMENTS,
        display_name=display_name,
        description=description or (
            "Velora Supervisor — operates the business via Velora's MCP tools "
            "(catalog, sales, payments, fiscal) over the Model Context "
            "Protocol. Track 3 multi-agent system deployed on Agent Engine."
        ),
        env_vars=env_vars,
    )

    resource_name = remote.resource_name
    print()
    print("Deployed to Agent Engine")
    print(f"   Resource: {resource_name}")
    print()
    print("Next steps:")
    print(f"  1. (Optional) Cloud Run env AGENT_ENGINE_RESOURCE_NAME={resource_name}")
    print("  2. Smoke: POST {resource_name}:query with a real owner request")
    return resource_name


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--display-name", default="velora-supervisor-mcp")
    parser.add_argument("--description", default=None)
    args = parser.parse_args()
    try:
        deploy(args.display_name, args.description)
    except Exception as exc:  # noqa: BLE001 — top-level deploy script
        print(f"Deploy failed: {exc}", file=sys.stderr)
        sys.exit(1)
