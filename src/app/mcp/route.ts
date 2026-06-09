// src/app/mcp/route.ts — compatibility alias for hosted MCP clients.
//
// Canonical endpoint remains /api/mcp, but some clients/operators may configure
// the shorter /mcp path. Re-export the same handlers so both URLs reach the
// identical dual-auth MCP transport without duplicating logic.

export { GET, POST, DELETE } from "@/app/api/mcp/route";
