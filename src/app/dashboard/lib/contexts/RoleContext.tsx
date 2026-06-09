"use client";

import { createContext, useContext } from "react";
import type { ActorRole } from "@/domain";

export type { ActorRole };

const RoleContext = createContext<ActorRole>("owner");

export function RoleProvider({ role, children }: { role: ActorRole; children: React.ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): ActorRole {
  return useContext(RoleContext);
}
