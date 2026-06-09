"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface InputContextValue {
  input: DashboardState["input"];
  setInput: DashboardState["setInput"];
}

export const InputContext = createContext<InputContextValue | null>(null);

export function useInputContext(): InputContextValue {
  const ctx = useContext(InputContext);
  if (!ctx) throw new Error("useInputContext must be used within DashboardProviders");
  return ctx;
}
