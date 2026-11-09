/**
 * O ANÚNCIO DE ONDE O CONTATO VEIO, no vocabulário de quem atende.
 *
 * `contacts.source_metadata` guarda o que o estampador de atribuição gravou (`ad_*`) e, dentro de `ad_raw`, o
 * que o WhatsApp entregou no clique: o código do anúncio (`sourceId`), o app (`sourceApp`: instagram/facebook)
 * e o link. Puro: nada de banco, nada de relógio. Quem lê (rota do painel, relatório) só repassa o JSON.
 *
 * Duas armadilhas que este arquivo existe para não repetir:
 *  - `ad_source_id` guarda o ID DO CLIQUE (`ctwaClid`) quando ele existe — um valor por pessoa. Identificar o
 *    ANÚNCIO é `ad_raw.sourceId`, que é o mesmo para todo mundo que clicou no mesmo anúncio.
 *  - `ad_raw.thumbnail` é a miniatura inteira em base64: nunca sai daqui para a tela.
 */

export interface AnuncioDoContato {
  /** `meta_ads` / `google_ads`: o que o estampador gravou em `source`. */
  plataforma: string;
  /** Onde o cliente estava quando clicou. `null` quando o WhatsApp não disse. */
  app: "Instagram" | "Facebook" | null;
  titulo: string | null;
  texto: string | null;
  /** O link que o próprio anúncio publica (fb.me/…, instagram.com/p/…). Só `http(s)`. */
  url: string | null;
  /** O código do ANÚNCIO (igual para todos que clicaram nele). `null` se o formato não trouxe. */
  anuncioId: string | null;
  /** Quando o clique chegou (`ad_captured_at`). */
  clicadoEm: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Só `http`/`https`: o link vira `href` na tela, e `javascript:` vindo do payload de um terceiro não pode passar. */
function urlSegura(v: unknown): string | null {
  const bruto = texto(v);
  if (!bruto) return null;
  try {
    const u = new URL(bruto);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function appDoClique(v: unknown): "Instagram" | "Facebook" | null {
  switch (texto(v)?.toLowerCase()) {
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    default:
      return null;
  }
}

/** `null` quando o contato não veio de anúncio (ou o dado não é reconhecível). */
export function anuncioDoContato(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): AnuncioDoContato | null {
  const plataforma = texto(metadata?.ad_platform) ?? (source === "meta_ads" || source === "google_ads" ? source : null);
  if (plataforma !== "meta_ads" && plataforma !== "google_ads") return null;

  const bruto = objeto(metadata?.ad_raw);
  return {
    plataforma,
    app: appDoClique(bruto?.sourceApp),
    titulo: texto(metadata?.ad_title) ?? texto(bruto?.title),
    texto: texto(metadata?.ad_body) ?? texto(bruto?.body),
    url: urlSegura(metadata?.ad_source_url) ?? urlSegura(bruto?.sourceUrl),
    anuncioId: texto(bruto?.sourceId),
    clicadoEm: texto(metadata?.ad_captured_at),
  };
}
