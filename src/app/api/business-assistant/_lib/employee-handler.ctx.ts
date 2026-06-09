import type { NextResponse } from "next/server";
import type { runBusinessAssistantModel } from "./model";
import type { EmployeeTurnParams } from "./employee-handler";

export interface EmployeePipelineCtx {
  params: EmployeeTurnParams;
  onboardingPrefix: string;
  modelResult: Awaited<ReturnType<typeof runBusinessAssistantModel>> | null;
  parsed: Awaited<ReturnType<typeof runBusinessAssistantModel>>["parsed"];
  safeIntent: Awaited<ReturnType<typeof runBusinessAssistantModel>>["safeIntent"] | null;
  answer: string | null;
}

export interface PipelineStage {
  name: string;
  run: (ctx: EmployeePipelineCtx) => Promise<NextResponse | null>;
}

export const bg = (p: Promise<unknown>): void => {
  void p.catch(() => {});
};
