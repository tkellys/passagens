import axios from "axios";
import { config } from "../config";
import { Flight } from "../types";
import { formatBRL } from "./currency";

const BASE_URL = `https://api.telegram.org/bot${config.telegram.botToken}`;
const TIMEOUT_MS = 15_000;

/** Envia mensagem genérica via Telegram */
export async function sendMessage(text: string, targetChatId?: string | number): Promise<void> {
  const chatId = targetChatId || config.telegram.chatId;
  await axios.post(`${BASE_URL}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  }, { timeout: TIMEOUT_MS });
}

/** Confirmação de que o rastreador está funcionando */
export async function sendHealthCheck(targetChatId?: string | number): Promise<void> {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  await sendMessage(`💚 *Tracker ativo* — ${now}`, targetChatId);
}

/** Alerta de uma passagem específica encontrada */
export async function sendFlightAlert(
  flight: Flight,
  isHistoricLow = false,
  targetChatId?: string | number,
  isPriceError = false,
  priceErrorDetails?: { discountPct: number; averagePrice: number },
  tierLabel?: string
): Promise<void> {
  let emoji = isHistoricLow ? "🔥" : "✈️";
  let title = isHistoricLow ? "*Nível de preço histórico BAIXO!*" : "*Passagem barata encontrada!*";

  // Se a faixa de preço (PRICE_TIERS) tiver um selo próprio, ele substitui o título padrão.
  if (tierLabel) {
    title = `*${tierLabel}*`;
  }

  if (isPriceError) {
    emoji = "🚨";
    title = "*URGENTE: POSSÍVEL ERRO DE TARIFA!*";
  }

  const lines = [
    `${emoji} ${title}`,
    "",
    `🛫 *${flight.origin} → ${flight.destination}*`,
    `🏷️ ${flight.tripType === "round-trip" ? "🔄 Ida e Volta" : "✈️ Somente Ida"}`,
    `📅 Ida: ${flight.departureDate}`,
    flight.returnDate ? `📅 Volta: ${flight.returnDate}` : "",
    flight.airline ? `🏢 ${flight.airline}` : "",
    isPriceError && priceErrorDetails
      ? `💰 *${formatBRL(flight.priceBRL)}* (📉 *-${priceErrorDetails.discountPct.toFixed(0)}%* em relação à média recente de ${formatBRL(priceErrorDetails.averagePrice)})`
      : `💰 *${formatBRL(flight.priceBRL)}*`,
    "",
    isPriceError ? "⚠️ *Atenção:* Tarifas com erro podem ser canceladas pelas companhias ou se esgotam em minutos. Compre o mais rápido possível!" : "",
    isPriceError ? "" : "", // adiciona espaçamento no erro
    `🔗 [Ver passagem](${flight.link})`,
    `_Fonte: ${flight.source}_`,
  ].filter(Boolean);

  await sendMessage(lines.join("\n"), targetChatId);
}

export async function sendSummary(belowThreshold: number, total: number, route: string, targetChatId?: string | number): Promise<void> {
  // Opcional: resumo silencioso ou apenas logs
  console.log(`[telegram] Resumo ${route}: ${belowThreshold} de ${total} voos abaixo do threshold.`);
}

export async function sendDateRangeSummary(
  route: string, 
  daysChecked: number, 
  bestFlight: Flight | null, 
  threshold: number,
  tripType: string,
  start: string,
  end: string,
  targetChatId?: string | number
): Promise<void> {
  if (!bestFlight) return;

  const lines = [
    `🗓️ *${route}* (${tripType === "round-trip" ? "🔄 Ida e Volta" : "✈️ Somente Ida"})`,
    `Período: ${start} até ${end}`,
    `${daysChecked} data(s) verificada(s).`,
    "",
    bestFlight.priceBRL <= threshold
      ? `✅ Melhor preço: *${formatBRL(bestFlight.priceBRL)}* em ${bestFlight.departureDate}`
      : `ℹ️ Mínimo encontrado: ${formatBRL(bestFlight.priceBRL)} em ${bestFlight.departureDate} (acima de ${formatBRL(threshold)})`,
  ];

  await sendMessage(lines.join("\n"), targetChatId);
}

export async function sendErrorAlert(route: string, message: string, targetChatId?: string | number): Promise<void> {
  await sendMessage(`❌ *Erro no Tracker (${route})*\n${message}`, targetChatId);
}

export async function sendAntiSpamNotice(route: string, current: number, previous: number, targetChatId?: string | number): Promise<void> {
  // Ativado apenas em debug se quiser ver por que não notificou
  console.log(`[anti-spam] ${route}: ${formatBRL(current)} não é ≥5% menor que ${formatBRL(previous)}`);
}

export async function sendWeeklyReport(summaries: any[], targetChatId?: string | number): Promise<void> {
  const lines = [
    "📊 *Relatório Semanal de Passagens*",
    `📅 ${new Date().toLocaleString("pt-BR")}`,
    "",
  ];

  for (const s of summaries) {
    const trendEmoji = s.trend === "down" ? "📉" : s.trend === "up" ? "📈" : "➡️";
    lines.push(`✈️ *${s.route}*`);
    lines.push(`💰 Min esta semana: ${s.currentWeekMin ? formatBRL(s.currentWeekMin) : "sem dados"}`);
    lines.push(`📊 Semana anterior: ${s.previousWeekMin ? formatBRL(s.previousWeekMin) : "sem dados"}`);
    if (s.currentWeekMin && s.previousWeekMin) {
      const diff = s.currentWeekMin - s.previousWeekMin;
      const pct = (diff / s.previousWeekMin) * 100;
      lines.push(`${trendEmoji} Variação: ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% (${formatBRL(diff)})`);
    } else {
      lines.push(`${trendEmoji} Tendência: estável ou sem dados.`);
    }
    lines.push("");
  }

  lines.push(`_${summaries.length} rota(s) monitorada(s)_`);
  await sendMessage(lines.join("\n"), targetChatId);
}

/** Envia foto (gráfico/imagem) via Telegram */
export async function sendPhoto(
  photoUrl: string,
  caption?: string,
  targetChatId?: string | number
): Promise<void> {
  const chatId = targetChatId || config.telegram.chatId;
  await axios.post(
    `${BASE_URL}/sendPhoto`,
    {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: "Markdown",
    },
    { timeout: TIMEOUT_MS }
  );
}