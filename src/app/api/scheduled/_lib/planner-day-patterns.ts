import { prisma } from "@/lib/prisma";
import { callGemini } from "@/app/api/business-assistant/_lib/gemini-wrapper";
import { getGeminiTextModel } from "@/app/api/business-assistant/_lib/gemini-client";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const PATTERN_WINDOW_WEEKS = 8;
const MIN_SALES_FOR_PATTERN = 14;

async function loadDayAverages(businessId: string): Promise<Record<string, number> | null> {
  const since = new Date();
  since.setDate(since.getDate() - PATTERN_WINDOW_WEEKS * 7);

  // Defensive cap: 8 weeks × 100 sales/day = 5600 typical; 10k allows for
  // outlier high-traffic franchises while preventing OOM if a tenant has runaway
  // sale records. Day-of-week aggregation kept in TS because it depends on
  // Argentina timezone classification (getArgentinaDateString). Source: debt audit C2.
  const sales = await prisma.sale.findMany({
    where: { businessId, date: { gte: since } },
    select: { date: true, totalAmount: true },
    take: 10000,
    orderBy: { date: "desc" },
  });

  if (sales.length < MIN_SALES_FOR_PATTERN) return null;

  const dayTotals = Array(7).fill(0) as number[];
  const dayCounts = Array(7).fill(0) as number[];
  for (const s of sales) {
    // Use Argentina day-of-week: getUTCDay() misclassifies sales near midnight ART.
    // DAYS_ES[0] = domingo (Sun) — Intl.getDay() returns 0=Sun, same as getUTCDay(),
    // but the date string is now in ART so the day boundary is correct.
    const dateAR = getArgentinaDateString(new Date(s.date).getTime());
    const [y, m, d] = dateAR.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    dayTotals[dow] += Number(s.totalAmount);
    dayCounts[dow]++;
  }

  return Object.fromEntries(
    DAYS_ES.map((label, i) => [label, dayCounts[i] > 0 ? Math.round(dayTotals[i] / dayCounts[i]) : 0]),
  );
}

export async function computeWeekPatternInsight(businessId: string): Promise<string | null> {
  const dayAverages = await loadDayAverages(businessId);
  if (!dayAverages) return null;

  const summaryJson = JSON.stringify(dayAverages);
  const prompt = `Dado este resumen de ventas promedio por día de la semana en pesos argentinos: ${summaryJson}\n\nEscribí UNA sola oración útil para el dueño del negocio (máximo 20 palabras). Destacá el mejor día y un consejo concreto. Español rioplatense, tono profesional. Sin saludos.`;

  const GEMINI_TIMEOUT_MS = 30_000;
  const geminiCall = async (): Promise<string> => {
    const model = getGeminiTextModel();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("Gemini timeout"), { name: "TimeoutError" })), GEMINI_TIMEOUT_MS),
    );
    const result = await Promise.race([
      model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      timeout,
    ]);
    return result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  };

  const { text } = await callGemini(geminiCall);
  return text.trim() || null;
}
