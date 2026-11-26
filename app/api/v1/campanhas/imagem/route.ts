/**
 * POST /api/v1/campanhas/imagem — guarda a arte da campanha (manager+).
 *
 * multipart com o campo `arquivo`. A imagem é preparada no servidor (WEBP vira
 * JPG, reduzida a 1600 px, sem metadados) e guardada em
 * `{org}/campanhas/{uuid}.{ext}` no bucket privado `whatsapp-media`. Devolve o
 * caminho, que a criação da campanha confere de novo, e um link de 10 min para
 * a tela mostrar a prévia.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { prepararImagem } from "@/lib/campanhas/imagem";
import { BUCKET_DA_IMAGEM, pastaDeImagens } from "@/lib/campanhas/servico";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeErro } from "../_comum";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;

  let arquivo: File | null = null;
  try {
    const form = await req.formData();
    const campo = form.get("arquivo");
    arquivo = campo instanceof File ? campo : null;
  } catch {
    return fail("invalid_request", "Envie a imagem no campo «arquivo».", 400, { requestId });
  }
  if (!arquivo) return fail("invalid_request", "Envie a imagem no campo «arquivo».", 400, { requestId });

  try {
    const preparada = await prepararImagem(Buffer.from(await arquivo.arrayBuffer()), arquivo.type);
    if (!preparada.ok) return fail("imagem_invalida", preparada.motivo, 422, { requestId });

    const admin = createAdminClient();
    const caminho = `${pastaDeImagens(authz.org.orgId)}${randomUUID()}.${preparada.ext}`;
    const { error } = await admin.storage
      .from(BUCKET_DA_IMAGEM)
      .upload(caminho, preparada.bytes, { contentType: preparada.mime, upsert: false });
    if (error) throw new Error(error.message);
    const { data: link } = await admin.storage.from(BUCKET_DA_IMAGEM).createSignedUrl(caminho, 600);

    return ok(
      { storage_path: caminho, mime: preparada.mime, previa_url: link?.signedUrl ?? null, bytes: preparada.bytes.length },
      { requestId, status: 201 },
    );
  } catch (err) {
    return respostaDeErro(err, requestId, "imagem");
  }
}
