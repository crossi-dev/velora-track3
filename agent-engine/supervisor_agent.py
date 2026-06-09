"""Supervisor Agent — Gemini 2.5 Pro via Vertex AI / ADK Python SDK.

Operates the owner's business through natural language by calling Velora's
existing MCP tools (catalog, sales, payments, fiscal) over the Model Context
Protocol — the same tool server the Cloud Run app exposes. The agent reuses
those tools instead of re-implementing them in Python, so the Agent Engine
runtime executes real commerce actions (register a sale, create a payment
link, emit an ARCA invoice), not just chat.

System prompt source of truth: prompts/supervisor_es_AR.md (falls back to an
inline operational prompt when the file is absent).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from pathlib import Path

from google.adk.agents import Agent
from google.adk.models import Gemini
from google.adk.tools.mcp_tool.mcp_toolset import (
    MCPToolset,
    StreamableHTTPConnectionParams,
)


_PROMPT_PATH = Path(__file__).parent / "prompts" / "supervisor_es_AR.md"

# Velora MCP server — reuse the existing tools instead of porting them to
# Python. The pack filter loads only the commerce tools the owner flow needs:
# catalog lookup -> sale -> payment link -> invoice, plus a connection check.
_MCP_URL = (
    "https://tools.somosvelora.com/api/mcp"
    "?packs=ventas,sales,payments,fiscal,connection"
)
_DEFAULT_BUSINESS_ID = "demo-business-id"

# Load only the commerce tools the owner demo needs. Excludes emit_nota, whose
# AFIP comprobante-type enum uses numeric values (1/6/11) that Gemini on Vertex
# rejects as a schema violation; the credit-note flow isn't part of the
# catalog -> sale -> payment -> invoice demo path.
_DEMO_TOOLS = [
    "query_catalog",
    "register_sale",
    "create_tracked_payment_link",
    "emit_invoice",
    "connection_status",
]


def _load_prompt() -> str:
    if _PROMPT_PATH.exists():
        return _PROMPT_PATH.read_text(encoding="utf-8")
    return (
        "Sos el Supervisor de Velora, el asistente operativo del dueno del "
        "negocio. Operas el negocio por lenguaje natural usando las "
        "herramientas disponibles: busca productos (query_catalog), registra "
        "ventas (register_sale), crea links de cobro de MercadoPago "
        "(create_tracked_payment_link), emiti facturas de ARCA (emit_invoice) "
        "y consulta el estado de las integraciones (connection_status). Cuando "
        "el dueno pide una accion, usa la herramienta correspondiente y "
        "confirma el resultado con los datos reales que devuelve. Las "
        "operaciones de plata y legales son reales e irreversibles: mostra un "
        "resumen y confirma antes de ejecutarlas. Hablas en espanol "
        "rioplatense, claro y directo."
    )


def _derive_a2a_key(secret: str, business_id: str) -> str:
    """HMAC-SHA256(secret, "v1:"+businessId) -> base64url. Mirrors the TS
    derivation in src/app/api/a2a/jsonrpc/_lib/handle-rpc.ts so the MCP server
    accepts the agent with the same per-tenant key the rest of Velora uses."""
    digest = hmac.new(
        secret.encode(), f"v1:{business_id}".encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _build_mcp_toolset() -> MCPToolset | None:
    """Connect to Velora's MCP server with per-business HMAC auth. Returns None
    when A2A_SECRET is absent so the agent still constructs (chat-only) instead
    of failing to build at deploy time."""
    secret = os.environ.get("A2A_SECRET", "")
    if not secret:
        return None
    business_id = os.environ.get("VELORA_BUSINESS_ID", _DEFAULT_BUSINESS_ID)
    return MCPToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=_MCP_URL,
            headers={
                "X-API-Key": _derive_a2a_key(secret, business_id),
                "X-Business-Id": business_id,
            },
        ),
        tool_filter=_DEMO_TOOLS,
    )


def build_supervisor_agent() -> Agent:
    """Construct the Supervisor Agent for Agent Engine deployment."""
    tools = [t for t in (_build_mcp_toolset(),) if t is not None]
    return Agent(
        name="velora_supervisor",
        model=Gemini(model_name="gemini-2.5-pro"),
        instruction=_load_prompt(),
        tools=tools,
        description=(
            "Velora's Supervisor Agent — operates the business on the owner's "
            "behalf via Velora's MCP tools (catalog, sales, payments, fiscal) "
            "over the Model Context Protocol. Executes real commerce actions, "
            "not just chat."
        ),
    )
