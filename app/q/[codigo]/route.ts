/**
 * GET /q/<código> — a porta de entrada do QR impresso.
 *
 * Conta a leitura e manda a pessoa para o WhatsApp com a mensagem pronta (+ `#código`, que é o que liga a
 * conversa ao QR quando ela chega). Pública de propósito (`lib/auth/public-paths.ts`) e fora de `/api`: o
 * endereço curto deixa o QR menos denso, e ele precisa ser lido impresso pequeno.
 *
 * O que NÃO bloqueia a pessoa: robô, limite e erro de gravação só deixam de CONTAR — o redirecionamento sai
 * igual. Quem perde é o número do relatório, nunca o cliente que queria falar com a empresa.
 *
 * Nada pessoal é gravado (sem IP, sem user-agent): o IP só alimenta o limitador em memória/Redis.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { normalizarCodigo } from "@/lib/qr-codes/codigo";
import { dispositivoDoAgente, ehLeituraDeRobo } from "@/lib/qr-codes/leitura";
import { linkDoWhatsApp } from "@/lib/qr-codes/link-do-whatsapp";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Leituras contadas por QR e por IP, por minuto. Acima disso a pessoa segue, a contagem não. */
const LEITURAS_POR_MINUTO = 10;

const SEM_CACHE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** Página mínima e SEM marca (quem lê o QR pode nem saber qual CRM está por trás — e não precisa). */
function pagina(status: number, titulo: string, texto: string): Response {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f6f7;color:#1f1f23}main{max-width:22rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#55555f;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#141417;color:#ececf1}p{color:#a5a5b0}}</style></head><body><main><h1>${titulo}</h1><p>${texto}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SEM_CACHE } });
}

interface QrDaRota {
  id: string;
  organization_id: string;
  codigo: string;
  mensagem: string;
  arquivado_em: string | null;
  channel_session_id: string | null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ codigo: string }> }): Promise<Response> {
  const { codigo: bruto } = await ctx.params;
  const codigo = normalizarCodigo(bruto);
  const inativo = () =>
    pagina(404, "QR code não encontrado", "Este QR code não existe. Confira se o código foi digitado certo.");
  if (!codigo) return inativo();

  const admin = createAdminClient();
  const { data: qrBruto } = await admin
    .from("qr_codes")
    .select("id, organization_id, codigo, mensagem, arquivado_em, channel_session_id")
    .eq("codigo", codigo)
    .maybeSingle();
  const qr = qrBruto as QrDaRota | null;
  if (!qr) return inativo();
  if (qr.arquivado_em) {
    return pagina(410, "QR code desativado", "Este QR code não está mais ativo.");
  }

  // O número: o do canal escolhido no QR; se ele sumiu ou não tem telefone, o primeiro canal da MESMA
  // organização que esteja conectado e tenha número.
  let telefone: string | null = null;
  if (qr.channel_session_id) {
    const { data } = await admin
      .from("channel_sessions")
      .select("phone_number")
      .eq("organization_id", qr.organization_id)
      .eq("id", qr.channel_session_id)
      .maybeSingle();
    telefone = (data as { phone_number: string | null } | null)?.phone_number ?? null;
  }
  if (!telefone) {
    const { data } = await admin
      .from("channel_sessions")
      .select("phone_number")
      .eq("organization_id", qr.organization_id)
      .eq("status", "WORKING")
      .not("phone_number", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    telefone = (data as { phone_number: string | null } | null)?.phone_number ?? null;
  }
  const destino = linkDoWhatsApp(telefone, qr.mensagem, qr.codigo);
  if (!destino) {
    return pagina(
      503,
      "QR code sem número",
      "Este QR code ainda não está ligado a um número de WhatsApp. Avise a empresa que o divulgou.",
    );
  }

  const ua = req.headers.get("user-agent");
  if (!ehLeituraDeRobo(ua)) {
    const ip = ipDoCliente(req.headers) ?? "sem-ip";
    const limite = await checkRateLimit(`qr_leitura:${qr.id}:${ip}`, LEITURAS_POR_MINUTO, 60);
    if (limite.allowed) {
      const { error } = await admin.from("qr_code_leituras").insert({
        organization_id: qr.organization_id,
        qr_code_id: qr.id,
        dispositivo: dispositivoDoAgente(ua),
      });
      if (error) {
        logger.warn("qr: leitura não gravada (a pessoa segue para o WhatsApp)", {
          qr_code_id: qr.id,
          detail: error.message.slice(0, 160),
        });
      }
    }
  }

  return NextResponse.redirect(destino, { status: 302, headers: SEM_CACHE });
}
