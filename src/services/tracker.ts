import { config } from "../config";
import { Flight, SearchParams } from "../types";
import { searchWithApify } from "../apis/apify";
import { searchWithRapidAPI } from "../apis/rapidapi";
import { sendFlightAlert, sendDateRangeSummary, sendErrorAlert } from "./telegram";
import { appendHistory, getLastCheapestPrice, getRoutePriceHistory } from "./history";
import { withRetry } from "../utils/retry";
import { getAllActiveAlerts, UserAlert, deactivateAlert } from "./user";
import { formatBRL, getUSDtoBRL } from "./currency";
import { sendReply } from "./webhook";

/**
 * Retorna a primeira faixa (em ordem crescente) cujo valor máximo é >= o preço.
 * Retorna null se o preço ultrapassar TODAS as faixas configuradas (não alerta).
 */
function getPriceTier(
  price: number,
  tiers: { threshold: number; label: string }[] | undefined
): { threshold: number; label: string } | null {
  if (!tiers) return null;
  for (const tier of tiers) {
    if (price <= tier.threshold) return tier;
  }
  return null;
}

/** Soma N dias a uma data no formato "YYYY-MM-DD", devolvendo também "YYYY-MM-DD". */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTracker(): Promise<void> {
  console.log("[tracker] Iniciando rodada de verificação...");
  
  // 1. Coleta alertas individuais do banco
  const userAlerts = await getAllActiveAlerts();
  console.log(`[tracker] ${userAlerts.length} alerta(s) de usuários ativos encontrados.`);

  // 2. Adiciona as rotas globais do .env como alertas do admin (você)
  const allTasks: UserAlert[] = [...userAlerts];
  
  // Para manter compatibilidade com seu uso atual
  for (const origin of config.search.origins) {
    for (const destination of config.search.destinations) {
      if (origin === destination) continue;
      allTasks.push({
        chat_id: config.telegram.chatId,
        origin,
        destination,
        departure_date: config.search.departureDate, // usa a lógica de offset do config
        return_date: config.search.returnDate,
        trip_type: config.search.tripType,
        max_price_brl: config.search.maxPriceBRL,
        is_active: true
      });
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 3. Executa cada busca
  for (const alert of allTasks) {
    try {
      // Verifica se o alerta expirou (data de ida já passou)
      if (alert.id && new Date(alert.departure_date) < today) {
        await deactivateAlert(alert.id);
        await sendReply(
          alert.chat_id,
          `⏰ Alerta expirado e desativado automaticamente.\n\n` +
          `🛫 *${alert.origin} → ${alert.destination}*\n` +
          `📅 Data: ${alert.departure_date}\n\n` +
          `_Use /alerta para criar um novo._`
        );
        console.log(`[tracker] Alerta #${alert.id} expirado (${alert.departure_date}). Desativado.`);
        continue;
      }

      await processAlert(alert);
    } catch (err) {
      console.error(`[tracker] Erro no alerta ${alert.origin}→${alert.destination}:`, err);
    }
  }
  
  console.log("[tracker] Rodada de verificação finalizada.");
}

interface DateCheckResult {
  departureDate: string;
  returnDate?: string;
  flights: Flight[];
  currentCheapest: number | null;
  priceTier: { threshold: number; label: string } | null;
  isPriceError: boolean;
  priceErrorDetails?: { discountPct: number; averagePrice: number };
  willAlert: boolean;
  isNewPriceError: boolean;
}

async function processAlert(alert: UserAlert): Promise<void> {
  const route = `${alert.origin}→${alert.destination}`;

  // Quantos dias consecutivos verificar a partir de alert.departure_date (ida).
  const departureRangeDays = Math.max(1, config.search.dateRangeDays || 1);
  const candidateDepartureDates = Array.from({ length: departureRangeDays }, (_, i) => addDays(alert.departure_date, i));

  // O mesmo, mas pra data de volta — só se for round-trip (alert.return_date existir).
  const returnRangeDays = Math.max(1, config.search.returnDateRangeDays || 1);
  const candidateReturnDates: (string | undefined)[] = alert.return_date
    ? Array.from({ length: returnRangeDays }, (_, i) => addDays(alert.return_date!, i))
    : [undefined];

  const results: DateCheckResult[] = [];
  let isFirstCombo = true;

  for (const departureDate of candidateDepartureDates) {
    for (const returnDate of candidateReturnDates) {
      if (!isFirstCombo) await sleep(3000); // boa prática: não bombardear a API
      isFirstCombo = false;

      const dateLabel = returnDate ? `${departureDate} → ${returnDate}` : departureDate;
      console.log(`[tracker] Processando: ${route} em ${dateLabel} para Usuário ${alert.chat_id} (Limite: ${alert.max_price_brl})`);

      const result = await checkOneDate(alert, departureDate, returnDate, route);
      if (result) results.push(result);
    }
  }

  // Entre as combinações que qualificam pra alerta, escolhe a melhor:
  // 1º prioridade: erro de tarifa (urgente); 2º prioridade: menor preço.
  const qualifying = results.filter(r => r.willAlert);
  if (qualifying.length === 0) return;

  const errorAlerts = qualifying.filter(r => r.isNewPriceError);
  const pool = errorAlerts.length > 0 ? errorAlerts : qualifying;
  const best = pool.reduce((min, r) =>
    (r.currentCheapest ?? Infinity) < (min.currentCheapest ?? Infinity) ? r : min
  );

  if (results.length > 1) {
    const bestLabel = best.returnDate ? `${best.departureDate} → ${best.returnDate}` : best.departureDate;
    console.log(
      `[tracker] ${route}: melhor combinação entre as verificadas foi ${bestLabel} ` +
      `(R$ ${best.currentCheapest?.toFixed(2) ?? "N/A"}) — enviando alerta só dessa.`
    );
  }

  const bestFlight = best.flights.sort((a, b) => a.priceBRL - b.priceBRL)[0];

  // Detecta se o preço está em nível histórico baixo usando dados do Google Flights (Apify)
  let isHistoricLow = false;
  const insights = bestFlight.priceInsights;
  if (insights) {
    if (insights.priceLevel === "low") {
      isHistoricLow = true;
    } else if (insights.lowestPrice) {
      const usdToBRL = await getUSDtoBRL();
      isHistoricLow = bestFlight.priceBRL <= insights.lowestPrice * usdToBRL * 1.05;
    }
  }

  await sendFlightAlert(bestFlight, isHistoricLow, alert.chat_id, best.isPriceError, best.priceErrorDetails, best.priceTier?.label);
}

/** Executa a busca, aplica filtros, salva histórico e decide se ESSA combinação de datas qualifica pra alerta. */
async function checkOneDate(alert: UserAlert, departureDate: string, returnDate: string | undefined, route: string): Promise<DateCheckResult | null> {
  const params: SearchParams = {
    origin: alert.origin,
    destination: alert.destination,
    departureDate,
    returnDate,
    tripType: alert.trip_type as any
  };

  let flights: Flight[] = [];
  try {
    flights = await fetchFlights(params);
  } catch (err) {
    await sendErrorAlert(route, `Falha técnica ao buscar voos (${departureDate}).`, alert.chat_id);
    return null;
  }

  flights = applyAdvancedFilters(flights);

  const currentCheapest = flights.length > 0 ? Math.min(...flights.map(f => f.priceBRL)) : null;
  const lastPrice = currentCheapest !== null
    ? await getLastCheapestPrice(alert.origin, alert.destination, departureDate)
    : null;

  // Detector de erro de tarifa (Price Glitch Detector)
  let isPriceError = false;
  let priceErrorDetails: { discountPct: number; averagePrice: number } | undefined = undefined;

  if (currentCheapest !== null) {
    let priceData = await getRoutePriceHistory(alert.origin, alert.destination, departureDate);
    let isSpecificDateUsed = true;

    if (priceData.length < 3) {
      priceData = await getRoutePriceHistory(alert.origin, alert.destination);
      isSpecificDateUsed = false;
    }

    if (priceData.length >= 3) {
      const prices = priceData.map(([, price]) => price);
      const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      const thresholdPrice = avgPrice * (1 - config.search.priceErrorThreshold);

      if (currentCheapest <= thresholdPrice) {
        isPriceError = true;
        const discountPct = ((avgPrice - currentCheapest) / avgPrice) * 100;
        priceErrorDetails = { discountPct, averagePrice: avgPrice };
        console.log(`[tracker] 🚨 POSSÍVEL ERRO DE TARIFA DETECTADO: ${route} em ${departureDate}! Preço atual: ${currentCheapest} | Média (${isSpecificDateUsed ? "data" : "geral"}): ${avgPrice.toFixed(2)} | Queda: -${discountPct.toFixed(1)}%`);
      }
    }
  }

  await appendHistory({
    timestamp: new Date().toISOString(),
    origin: alert.origin,
    destination: alert.destination,
    departureDate,
    returnDate,
    totalFound: flights.length,
    cheapestPriceBRL: currentCheapest,
    flights: flights.map(f => ({
      airline: f.airline,
      flightNumber: f.flightNumber,
      airplane: f.airplane,
      price: f.price,
      currency: f.currency,
      priceBRL: f.priceBRL,
      departureTime: f.departureTime,
      stops: f.stops,
      durationMinutes: f.durationMinutes,
      link: f.link,
      source: f.source,
      priceInsights: f.priceInsights
    }))
  });

  const priceTier = currentCheapest !== null
    ? getPriceTier(currentCheapest, config.search.priceTiers)
    : null;

  const isWithinUserThreshold = (config.search.priceTiers?.length ?? 0) > 0
    ? priceTier !== null
    : (currentCheapest !== null && currentCheapest <= alert.max_price_brl);
  const isSignificantDrop = !lastPrice || (currentCheapest !== null && currentCheapest <= lastPrice * config.search.priceDropThreshold);
  const isNewPriceError = isPriceError && (!lastPrice || (currentCheapest !== null && currentCheapest < lastPrice));
  const willAlert = (isWithinUserThreshold && isSignificantDrop) || isNewPriceError;

  const dateLabel = returnDate ? `${departureDate} → ${returnDate}` : departureDate;
  console.log(
    `[tracker] ${route} em ${dateLabel}: menor preço R$ ${currentCheapest?.toFixed(2) ?? "N/A"} | ` +
    `faixa: ${priceTier?.label ?? "fora de todas as faixas (PRICE_TIERS)"} | ` +
    `preço anterior: ${lastPrice ? `R$ ${lastPrice.toFixed(2)}` : "sem registro anterior"} | ` +
    `queda significativa: ${isSignificantDrop ? "sim" : "não"} | ` +
    `vai alertar: ${willAlert ? "SIM" : "não"}`
  );

  return { departureDate, returnDate, flights, currentCheapest, priceTier, isPriceError, priceErrorDetails, willAlert, isNewPriceError };
}

async function fetchFlights(params: SearchParams): Promise<Flight[]> {
  try {
    return await withRetry(
      () => searchWithApify(params),
      2,
      2000
    );
  } catch {
    return await searchWithRapidAPI(params);
  }
}

function applyAdvancedFilters(flights: Flight[]): Flight[] {
  const { airlinesWhitelist, maxStops, maxDurationHours } = config.filters;
  let filtered = flights;

  if (airlinesWhitelist.length > 0) {
    filtered = filtered.filter(f => f.airline && airlinesWhitelist.some(a => f.airline!.includes(a)));
  }
  if (maxStops !== undefined) {
    filtered = filtered.filter(f => f.stops !== undefined && f.stops <= maxStops);
  }
  if (maxDurationHours !== undefined) {
    filtered = filtered.filter(f => f.durationMinutes !== undefined && f.durationMinutes <= (maxDurationHours * 60));
  }
  return filtered;
}
