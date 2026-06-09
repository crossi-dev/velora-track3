"use client";

// TanStack Query client provider for the dashboard.
// Source: https://tanstack.com/query/latest/docs/framework/react/quick-start
//
// Settings rationale:
//   staleTime 30s   — tab data is fresh for 30s; revisiting a tab within that
//                     window uses the cache instead of re-fetching.
//   gcTime 5min     — unused query data is kept in memory for 5 minutes so
//                     quick re-visits never show an empty state.
//   refetchOnWindowFocus false — Velora already handles re-fetch via the
//                     visibilitychange listener in DashboardPage; TanStack's
//                     own focus re-fetch would double-fire on tab-switch.

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export function DashboardQueryClientProvider({ children }: { children: ReactNode }) {
  // Stable QueryClient per component lifecycle: useState guarantees one client
  // is created on first render and reused for every subsequent render.
  // Pattern from TanStack docs: https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr
  const [queryClient] = useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
