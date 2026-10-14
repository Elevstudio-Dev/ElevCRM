import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * O GRUPO ENTRA NA VARREDURA DE FOTOS — a cerca de uma ausência.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * Em 14/10, numa instalação real: **12 conversas de grupo, 0 com foto**, com o
 * transporte servindo a imagem desses mesmos grupos normalmente quando
 * perguntado direto (4 de 6 devolveram URL na medição de 23/09). Grupo não tem
 * a restrição de privacidade que esconde a foto de pessoa — a imagem estava
 * disponível o tempo todo.
 *
 * A causa: a varredura montava os candidatos com
 * `.not("wa_identity", "is", null)`, e grupo **não tem `wa_identity`**. O
 * identificador dele vive em `conversations.group_chat_id`. Nenhum grupo jamais
 * foi varrido, e nada ficou vermelho — a rota respondia `scanned: N` com os
 * contatos de sempre.
 *
 * ─── Por que uma cerca de TEXTO e não de comportamento ──────────────────────
 *
 * O caminho de verdade (baixar, validar tamanho, subir no bucket, carimbar)
 * precisa de Supabase e de transporte; exercitá-lo aqui exigiria dublar os dois
 * e o teste passaria a medir os dublês. O que esta cerca prende é a DECISÃO de
 * desenho que o defeito violou: que a rota consulta `conversations` pelo
 * `group_chat_id`, e que o chatId é resolvido ao montar a lista — não dentro do
 * laço, onde só a identidade de pessoa existia.
 *
 * Quem remover a busca de grupo cai aqui. Quem reescrever o mecanismo mantendo
 * as duas fontes também cai — e aí a cerca é atualizada junto, de propósito.
 */

const ROTA = resolve(
  process.cwd(),
  "app/api/v1/cron/contact-avatars/route.ts",
);
const fonte = readFileSync(ROTA, "utf8");

describe("a varredura de fotos enxerga grupo", () => {
  it("consulta conversations pelo identificador de grupo", () => {
    expect(
      fonte.includes('.from("conversations")') && fonte.includes("group_chat_id"),
      "a rota não busca mais o grupo pela conversa — nenhum grupo terá foto, e " +
        "nada vai ficar vermelho além deste teste",
    ).toBe(true);
  });

  it("os candidatos de grupo entram no MESMO lote das pessoas", () => {
    expect(
      fonte.includes("candidatosDeGrupo"),
      "sumiu a fonte de candidatos de grupo",
    ).toBe(true);
    expect(
      /const rows: ContactRow\[\] = \[\.\.\.pessoas, \.\.\.grupos\]/.test(fonte),
      "pessoas e grupos precisam ir ao mesmo laço: duplicar o caminho de " +
        "download/upload é o que faz um dos dois envelhecer sozinho",
    ).toBe(true);
  });

  it("o chatId é resolvido ao montar a lista, não dentro do laço", () => {
    expect(
      /chatId: string \| null/.test(fonte),
      "o candidato precisa carregar o chatId já resolvido — é o que permite " +
        "pessoa e grupo compartilharem o mesmo laço",
    ).toBe(true);
    expect(
      fonte.includes("const chatId = c.chatId;"),
      "o laço voltou a derivar o chatId da identidade, e grupo não tem uma",
    ).toBe(true);
  });

  it("a busca de grupo respeita anonimização e a janela de revisita", () => {
    const bloco = fonte.slice(
      fonte.indexOf("async function candidatosDeGrupo"),
      fonte.indexOf("async function handle"),
    );
    expect(bloco.includes('.eq("is_anonymized", false)')).toBe(true);
    expect(bloco.includes("avatar_updated_at.is.null")).toBe(true);
  });

  it("deduplica por contato: duas conversas do mesmo grupo não comem duas vagas", () => {
    const bloco = fonte.slice(
      fonte.indexOf("async function candidatosDeGrupo"),
      fonte.indexOf("async function handle"),
    );
    expect(
      bloco.includes("chatPorContato"),
      "sem deduplicar, um grupo com duas conversas empurra outro grupo para " +
        "a rodada seguinte — e, com conversas suficientes, para sempre",
    ).toBe(true);
  });
});
