/**
 * AS COSTURAS DO ESPELHO DA ÚLTIMA MENSAGEM (migration 0219) — o que cada peça sozinha não prova.
 *
 * A linha da lista (tiques, "Você:", ícone do áudio) depende de quatro pontos que moram em arquivos
 * diferentes e que nenhum teste de uma peça só enxerga quando UM deles some:
 *
 *   banco (função + trigger) → a rota que lista (SELECT) → o tipo → a linha que desenha
 *                            ↘ o envio pelo CRM, que carimba a conversa à mão
 *
 * O componente pode estar perfeito e o tique nunca aparecer, porque a coluna não sai no SELECT — é a
 * mesma família do `channel_sessions` que o SELECT precisa trazer para o selo do número aparecer
 * (`inbox-por-onde-entrou.test.tsx`). O e2e pega, minutos depois; estes casos pegam em milissegundos.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (...partes: string[]) => readFileSync(join(process.cwd(), ...partes), "utf8");

const COLUNAS = [
  "last_message_direction",
  "last_message_type",
  "last_message_status",
] as const;

describe("o SELECT da rota que lista traz o espelho", () => {
  const fonte = ler("app", "api", "v1", "conversations", "_handler.ts");
  const select = /const SELECT_COLS = `([\s\S]*?)`;/.exec(fonte)?.[1] ?? "";

  it("(guarda de vacuidade) o SELECT foi encontrado", () => {
    expect(select).toContain("last_message_preview");
  });

  it.each(COLUNAS)("traz %s — sem isso a linha nunca sabe quem falou, o tipo nem o tique", (coluna) => {
    expect(select).toContain(coluna);
  });
});

describe("o envio pelo CRM carimba o espelho junto com a conversa", () => {
  const fonte = ler("app", "api", "v1", "messages", "_handler.ts");
  const bloco = /const conversationUpdate: \{[\s\S]*?await supabase\.from\("conversations"\)\.update\(conversationUpdate\)/.exec(
    fonte,
  )?.[0];

  it("(guarda de vacuidade) o bloco foi encontrado", () => {
    expect(bloco).toBeDefined();
  });

  it.each(["last_message_id", ...COLUNAS])(
    "grava %s — esse caminho NÃO passa por fn_mark_conversation_message",
    (coluna) => {
      // Duas ocorrências: a do tipo e a do valor. Só a do tipo seria um campo declarado e nunca escrito.
      const ocorrencias = (bloco ?? "").split(coluna).length - 1;
      expect(ocorrencias, `${coluna} precisa ser declarado E atribuído`).toBeGreaterThanOrEqual(2);
    },
  );

  it("grava a direção como 'outbound' — a resposta do CRM é sempre nossa", () => {
    expect(bloco).toMatch(/last_message_direction: "outbound"/);
  });
});

describe("a lista entrega a cor das tags para a linha", () => {
  it("ConversationList passa `coresDasTags` a cada ConversationListItem", () => {
    const fonte = ler("components", "inbox", "ConversationList.tsx");
    expect(fonte).toContain("useConversationTagVocabulary");
    expect(fonte).toMatch(/coresDasTags=\{coresDasTags\}/);
  });
});

describe("o tipo da conversa conhece o espelho", () => {
  it("lib/types/messaging.ts declara as três colunas", () => {
    const fonte = ler("lib", "types", "messaging.ts");
    for (const coluna of COLUNAS) expect(fonte).toContain(coluna);
  });

  it("lib/database.types.ts declara as quatro, em Row, Insert e Update", () => {
    const fonte = ler("lib", "database.types.ts");
    for (const coluna of ["last_message_id", ...COLUNAS]) {
      // Row/Returns (sem `?`) e Insert/Update (com `?`): 2 de cada.
      expect(fonte.split(`${coluna}: string | null`).length - 1, `${coluna} sem ?`).toBeGreaterThanOrEqual(2);
      expect(fonte.split(`${coluna}?: string | null`).length - 1, `${coluna} com ?`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("a migration e o apêndice do baseline são o MESMO SQL", () => {
  // O Supabase CLI aplica a migration; o `update.sh` do kit aplica o baseline. Os dois têm de fazer
  // exatamente a mesma coisa — e como o apêndice é uma cópia, ela diverge no primeiro ajuste feito
  // só de um lado. O invariante de banco roda o BASELINE; sem este caso, a migration (que o
  // desenvolvedor aplica) poderia ficar diferente do que a produção roda, sem nada ficar vermelho.
  const semComentario = (sql: string) =>
    sql
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();

  it("todo o SQL executável da migration aparece, igual, no baseline", () => {
    const migration = semComentario(
      ler("supabase", "migrations", "20261028120000_0219_a_lista_sabe_o_que_a_ultima_mensagem_e.sql"),
    );
    const baseline = semComentario(ler("supabase", "baseline.sql"));
    expect(migration.length).toBeGreaterThan(1000); // vacuidade
    expect(baseline).toContain(migration);
  });

  it("o apêndice entra ANTES da varredura de anon (a regra do último bloco)", () => {
    const baseline = ler("supabase", "baseline.sql");
    const apendice = baseline.indexOf("-- ---- a lista sabe o que a última mensagem é");
    const varredura = baseline.indexOf("-- ---- VARREDURA anon:");
    expect(apendice).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(apendice);
  });

  it("a migration está no MANIFEST", () => {
    expect(ler("supabase", "migrations", "MANIFEST.md")).toContain("0219_a_lista_sabe_o_que_a_ultima_mensagem_e");
  });
});
