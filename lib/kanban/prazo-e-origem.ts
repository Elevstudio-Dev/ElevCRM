/**
 * O PRAZO E A ORIGEM DO NEGÓCIO, DECIDIDOS FORA DO CARD.
 *
 * Duas coisas que o vendedor procura no quadro e que o card não dizia: "isso vence quando?" e "de onde
 * veio esse cliente?". Os dois dados já existem no lead (`expected_close_date`, `source`) — faltava
 * dizê-los em palavras que a pessoa já usa, e na cor certa quando o prazo passou.
 *
 * Tudo puro: o relógio e a tradução entram por argumento, e o teste não depende do dia em que roda.
 */
import { differenceInCalendarDays, isValid, parseISO } from "date-fns";

export type FaixaDoPrazo = "atrasado" | "hoje" | "proximo" | "folga";

export interface PrazoDoCard {
  faixa: FaixaDoPrazo;
  /** Dias de calendário até o prazo: negativo = já passou. */
  dias: number;
  texto: string;
}

/** Até quantos dias o prazo conta como "perto" (âmbar). Mais longe que isso, é só informação. */
const DIAS_PERTO = 3;

/**
 * "Fecha em 3 dias" / "Fecha hoje" / "Atrasado há 2 dias".
 *
 * Conta DIAS DE CALENDÁRIO, não horas: `expected_close_date` é uma data sem hora, e "fecha amanhã" às
 * 23h de hoje ainda é amanhã. `parseISO` lê "2026-11-02" como dia LOCAL — `new Date("2026-11-02")`
 * seria meia-noite UTC e, no Brasil, ainda o dia anterior.
 *
 * `null` quando não há prazo (ou ele é inválido): sem prazo o card não diz nada, em vez de pôr um
 * "sem prazo" cinza em metade das colunas.
 */
export function prazoDoCard(
  data: string | null | undefined,
  agora: Date,
  t: (texto: string) => string = (texto) => texto,
): PrazoDoCard | null {
  if (!data) return null;
  const alvo = parseISO(data);
  if (!isValid(alvo)) return null;

  const dias = differenceInCalendarDays(alvo, agora);
  const unidade = (n: number) => (Math.abs(n) === 1 ? t("dia") : t("dias"));

  if (dias < 0) {
    const n = Math.abs(dias);
    return { faixa: "atrasado", dias, texto: `${t("Atrasado há")} ${n} ${unidade(n)}` };
  }
  if (dias === 0) return { faixa: "hoje", dias, texto: t("Fecha hoje") };
  if (dias === 1) return { faixa: "proximo", dias, texto: t("Fecha amanhã") };
  return {
    faixa: dias <= DIAS_PERTO ? "proximo" : "folga",
    dias,
    texto: `${t("Fecha em")} ${dias} ${unidade(dias)}`,
  };
}

export type IconeDaOrigem = "manual" | "whatsapp" | "automatica" | "importada" | "agente" | "qr" | "anuncio" | "outra";

export interface OrigemDoLead {
  icone: IconeDaOrigem;
  rotulo: string;
}

/**
 * De onde o negócio veio. `crm_leads.source` é TEXTO LIVRE (cada integração escreve o que quer), então
 * o mapa cobre os valores que o produto mesmo grava e o resto cai no próprio texto, legível: melhor
 * mostrar "Landing page" do que esconder uma origem que a função não conhece.
 */
export function origemDoLead(
  source: string | null | undefined,
  t: (texto: string) => string = (texto) => texto,
  /** `crm_leads.source_metadata`: dá o NOME do QR e o TÍTULO do anúncio, que a origem sozinha não sabe. */
  metadata?: Record<string, unknown> | null,
): OrigemDoLead | null {
  const bruto = source?.trim();
  if (!bruto) return null;
  const chave = bruto.toLowerCase();
  const texto = (campo: string): string | null => {
    const v = metadata?.[campo];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  switch (chave) {
    case "qr_code": {
      // O nome é do usuário (ele batizou o QR): vai como está, sem tradução.
      const nome = texto("qr_code_nome");
      return { icone: "qr", rotulo: nome ? `${t("QR:")} ${nome}` : t("QR code") };
    }
    case "meta_ads":
    case "google_ads": {
      const titulo = texto("ad_title");
      return { icone: "anuncio", rotulo: titulo ? `${t("Anúncio:")} ${titulo}` : t("Anúncio") };
    }
    case "manual":
      return { icone: "manual", rotulo: t("Manual") };
    case "whatsapp":
      return { icone: "whatsapp", rotulo: "WhatsApp" };
    case "webhook":
    case "lead_capture":
    case "lead-capture":
      return { icone: "automatica", rotulo: t("Formulário ou integração") };
    case "import":
    case "importacao":
    case "csv":
    case "planilha":
      return { icone: "importada", rotulo: t("Importado") };
    case "agent":
    case "ai_agent":
      return { icone: "agente", rotulo: t("Agente de IA") };
    case "reactivation":
      return { icone: "agente", rotulo: t("Retomada") };
    default: {
      // "landing_page" → "Landing page": o texto livre vira legível sem virar tradução inventada.
      const legivel = bruto.replace(/[_-]+/g, " ");
      return { icone: "outra", rotulo: legivel.charAt(0).toUpperCase() + legivel.slice(1) };
    }
  }
}
