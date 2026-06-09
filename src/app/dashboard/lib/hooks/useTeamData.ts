"use client";

// TanStack Query source: https://tanstack.com/query/latest/docs/framework/react/overview
// Team data is cached for staleTime (30s default from QueryClient) so revisiting
// the tab within that window is instant. Mutations call invalidateQueries to
// refresh the cache immediately after a write.

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { buildMutationHeaders, createMutationSignature } from "./utils";
import { freshPinKey } from "../storage-keys";

// Hook con state + handlers de TeamTab. Vive separado para mantener el
// componente principalmente JSX (eslint max-lines-per-function).
//
// Llama al endpoint /api/employees (lista) + /api/business/employees/activity
// (agregados de hoy) en paralelo. La identidad del empleado se cruza por id.

export interface EmployeeRecord {
  id: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
  failedPinAttempts: number;
}

export interface ActivityRow {
  id: string;
  name: string;
  role: string;
  active: boolean;
  salesCount: number;
  salesTotal: number;
  stockMovements: number;
  cashMovements: number;
  lastActivityAt: string | null;
}

interface CreateState {
  saving: boolean;
  error: string | null;
  notice: string | null;
  pin: string | null;
  employeeId: string | null;
}

const INITIAL_CREATE: CreateState = { saving: false, error: null, notice: null, pin: null, employeeId: null };

type T = (en: string, es: string) => string;

interface UseTeamDataResult {
  employees: EmployeeRecord[];
  activity: ActivityRow[];
  activityById: Map<string, ActivityRow>;
  loading: boolean;
  loadError: string | null;
  createState: CreateState;
  resetCreateState: () => void;
  reload: () => Promise<void>;
  handleCreate: (input: { name: string; pin: string }) => Promise<boolean>;
  handleRevoke: (employeeId: string, name: string) => Promise<void>;
  handleUnlock: (employeeId: string) => Promise<void>;
}

const TEAM_QUERY_KEY = ["team-data"] as const;

async function fetchTeamData(): Promise<{ employees: EmployeeRecord[]; activity: ActivityRow[] }> {
  const [empRes, actRes] = await Promise.all([
    fetch("/api/employees", { method: "GET" }),
    fetch("/api/business/employees/activity?period=today", { method: "GET" }),
  ]);
  if (!empRes.ok) throw new Error("employees fetch failed");
  if (!actRes.ok) throw new Error("activity fetch failed");
  const empData = (await empRes.json()) as { employees: EmployeeRecord[] };
  const actData = (await actRes.json()) as { employees: ActivityRow[] };
  return {
    employees: empData.employees ?? [],
    activity: actData.employees ?? [],
  };
}

export function useTeamData(t: T): UseTeamDataResult {
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [createState, setCreateState] = useState<CreateState>(INITIAL_CREATE);

  const { data, isLoading, error } = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchTeamData,
  });

  const employees = data?.employees ?? [];
  const activity = data?.activity ?? [];
  const loading = isLoading;
  const loadError = error instanceof Error
    ? t("Could not load the team. Try again.", "No se pudo cargar el equipo. Probá de nuevo.")
    : mutationError;

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
  }, [queryClient]);

  const handleCreate = useCallback(async (input: { name: string; pin: string }) => {
    setCreateState({ saving: true, error: null, notice: null, pin: null, employeeId: null });
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = (await res.json().catch(() => ({}))) as { employee?: { id?: string; name: string }; error?: string };
      if (!res.ok) {
        setCreateState({
          saving: false,
          error: payload.error ?? t("Could not create the employee.", "No se pudo crear el empleado."),
          notice: null,
          pin: null,
          employeeId: null,
        });
        return false;
      }
      const employeeId = payload.employee?.id ?? null;
      // Persist the PIN to sessionStorage so it can be revealed once more from
      // the employee list. sessionStorage is tab-scoped and never written to DB.
      if (employeeId) {
        try {
          sessionStorage.setItem(freshPinKey(employeeId), input.pin);
        } catch { /* private browsing or storage full — fail silently */ }
      }
      setCreateState({
        saving: false,
        error: null,
        notice: t(`Employee "${payload.employee?.name ?? input.name}" created.`, `Empleado "${payload.employee?.name ?? input.name}" creado.`),
        pin: input.pin,
        employeeId,
      });
      void queryClient.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
      return true;
    } catch {
      setCreateState({ saving: false, error: t("Network error. Try again.", "Error de red. Probá de nuevo."), notice: null, pin: null, employeeId: null });
      return false;
    }
  }, [queryClient, t]);

  const handleRevoke = useCallback(async (employeeId: string, _name: string) => {
    // Confirmation is handled inline by TeamEmployeeRow (confirmingRevoke state).
    // This hook receives the decision — it only executes.
    try {
      const sig = createMutationSignature("employee.revoke", { employeeId });
      const res = await fetch("/api/employees", {
        method: "DELETE",
        headers: buildMutationHeaders(sig),
        body: JSON.stringify({ employeeId }),
      });
      if (!res.ok) throw new Error();
      void queryClient.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
    } catch {
      setMutationError(t("Could not revoke the employee.", "No se pudo revocar el empleado."));
    }
  }, [queryClient, t]);

  const handleUnlock = useCallback(async (employeeId: string) => {
    try {
      const res = await fetch(`/api/employees/${employeeId}/unlock`, { method: "POST" });
      if (!res.ok) throw new Error();
      void queryClient.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
    } catch {
      setMutationError(t("Could not unlock the employee.", "No se pudo desbloquear el empleado."));
    }
  }, [queryClient, t]);

  const activityById = useMemo(() => {
    const m = new Map<string, ActivityRow>();
    for (const row of activity) m.set(row.id, row);
    return m;
  }, [activity]);

  const resetCreateState = useCallback(() => setCreateState(INITIAL_CREATE), []);

  return {
    employees,
    activity,
    activityById,
    loading,
    loadError,
    createState,
    resetCreateState,
    reload,
    handleCreate,
    handleRevoke,
    handleUnlock,
  };
}
