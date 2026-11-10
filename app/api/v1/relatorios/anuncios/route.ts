/**
 * GET /api/v1/relatorios/anuncios?de&ate&fuso — o desempenho de cada anúncio: contatos, vendas, gasto, custo e retorno
 * (gestor+).
 *
 * Mesma cerca de `/relatorios/origens`: `requireRole("manager")`, e a função do banco é `security invoker`, então a
 * RLS vale ATRAVÉS dela. O gasto vem de `meta_ads_gasto_diario` (SELECT para gestor+). Para a tela decidir entre
 * "conecte sua conta" e "ainda sem dados", o estado da conexão vem junto — lido pelo cliente administrativo (a
 * tabela da chave não é legível pela sessão) e só com colunas públicas, NUNCA a chave.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { montarAnuncios, type LinhaDeAnuncio } from "@/lib/relatorios/anuncios";
import { COLUNAS_PUBLICAS_DA_CONEXAO, SEM_CONEXAO, type EstadoDaConexaoMeta } from "@/lib/schemas/meta-ads";
import { periodoSchema } from "@/lib/schemas/relatorios";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** As colunas de `fn_relatorio_de_anuncios`; os contadores são `bigint` e chegam como número ou como texto. */
interface LinhaBruta {
  ad_id: string | null;
  titulo: string | null;
  campanha: string | null;
  conjunto: string | null;
  anuncio: string | null;
  leads: number | string;
  abertos: number | string;
  ganhos: number | string;
  perdidos: number | string;
  valor_ganho_cents: number | string;
  gasto_cents: number | string;
  impressoes: number | string;
  cliques: number | string;
  conversas: number | string;
  moeda: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "relatorios", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const q = new URL(req.url).searchParams;
  const parsed = periodoSchema.safeParse({
    de: q.get("de"),
    ate: q.get("ate"),
    ...(q.get("fuso") ? { fuso: q.get("fuso") } : {}),
  });
  if (!parsed.success) {
    return fail("validation_failed", "Período inválido.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { de, ate, fuso } = parsed.data;

  const supabase = await createClient();
  const admin = createAdminClient();
  const [linhas, conexao] = await Promise.all([
    supabase.rpc("fn_relatorio_de_anuncios", {
      p_org: orgId,
      p_de: de.toISOString(),
      p_ate: ate.toISOString(),
      p_fuso: fuso,
    }),
    admin.from("meta_ads_conexoes").select(COLUNAS_PUBLICAS_DA_CONEXAO).eq("organization_id", orgId).maybeSingle(),
  ]);
  const erro = linhas.error ?? conexao.error;
  if (erro) return fail("internal_error", erro.message, 500, { requestId });

  const lista: LinhaDeAnuncio[] = ((linhas.data ?? []) as LinhaBruta[]).map((l) => ({
    ad_id: l.ad_id,
    titulo: l.titulo,
    campanha: l.campanha,
    conjunto: l.conjunto,
    anuncio: l.anuncio,
    leads: Number(l.leads),
    abertos: Number(l.abertos),
    ganhos: Number(l.ganhos),
    perdidos: Number(l.perdidos),
    valor_ganho_cents: Number(l.valor_ganho_cents),
    gasto_cents: Number(l.gasto_cents),
    impressoes: Number(l.impressoes),
    cliques: Number(l.cliques),
    conversas: Number(l.conversas ?? 0),
    moeda: l.moeda,
  }));

  const estado: EstadoDaConexaoMeta = conexao.data
    ? { conectada: true, ...(conexao.data as Omit<EstadoDaConexaoMeta, "conectada">) }
    : SEM_CONEXAO;

  return ok({ ...montarAnuncios(lista), conexao: estado }, { requestId });
}
