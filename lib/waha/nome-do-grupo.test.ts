/**
 * O GRUPO PUXA O PRÓPRIO NOME — sem ninguém precisar apertar "Importar grupos".
 *
 * O defeito: todo grupo que chegava por MENSAGEM era criado sem nome (o payload traz o nome de QUEM
 * ESCREVEU, não o assunto do grupo) e ficava "Sem nome" até alguém lembrar de importar os grupos. Quem
 * liga a função e vê sete grupos "Sem nome" conclui que ela não funciona.
 *
 * Aqui se mede o que a ingestão passa a fazer: ao ver mensagem de um grupo sem nome, pergunta o assunto
 * ao canal UMA vez a cada tantos minutos — nunca a cada mensagem, porque o canal limita essa consulta
 * (`rate-overlimit` no engine padrão) —, e só grava quando o canal respondeu um nome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerTentativasDeNome, nomearGrupoSeFaltar } from "@/lib/waha/nome-do-grupo";

const ORG = "org-1";
const CONTATO = "contato-grupo-1";
const CHAT = "120363000000000001@g.us";

/** Um admin de mentira: devolve a linha do contato e registra as chamadas à RPC. */
function adminCom(linha: { name: string | null; display_name: string | null } | null, rpcErro?: string) {
  const rpc = vi.fn(async () => ({ data: CONTATO, error: rpcErro ? { message: rpcErro } : null }));
  const maybeSingle = vi.fn(async () => ({ data: linha, error: null }));
  const encadeado = { eq: vi.fn(() => encadeado), maybeSingle };
  const admin = { from: vi.fn(() => ({ select: vi.fn(() => encadeado) })), rpc };
  return { admin: admin as never, rpc, maybeSingle };
}

function canalCom(assunto: string | null | Error) {
  return {
    getGroupSubject: vi.fn(async () => {
      if (assunto instanceof Error) throw assunto;
      return assunto;
    }),
  };
}

const base = { organizationId: ORG, contactId: CONTATO, chatId: CHAT, sessionName: "sessao-1" };

beforeEach(() => esquecerTentativasDeNome());

describe("nomearGrupoSeFaltar", () => {
  it("grupo sem nome + canal responde o assunto: grava e devolve 'nomeado'", async () => {
    const { admin, rpc } = adminCom({ name: null, display_name: null });
    const canal = canalCom("Time comercial");

    const r = await nomearGrupoSeFaltar({ ...base, admin, canal });

    expect(r).toBe("nomeado");
    expect(canal.getGroupSubject).toHaveBeenCalledWith("sessao-1", CHAT);
    expect(rpc).toHaveBeenCalledWith("fn_upsert_wa_group_contact", {
      p_org: ORG,
      p_group_chat_id: CHAT,
      p_subject: "Time comercial",
    });
  });

  it("grupo que JÁ tem nome: não pergunta nada ao canal e não grava", async () => {
    const { admin, rpc } = adminCom({ name: "Time comercial", display_name: "Time comercial" });
    const canal = canalCom("Outro nome");

    expect(await nomearGrupoSeFaltar({ ...base, admin, canal })).toBe("ja_tem_nome");
    expect(canal.getGroupSubject).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("o apelido que uma PESSOA deu (só display_name) conta como nome — não se pergunta de novo", async () => {
    const { admin } = adminCom({ name: null, display_name: "Grupo do João" });
    const canal = canalCom("Time comercial");
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal })).toBe("ja_tem_nome");
    expect(canal.getGroupSubject).not.toHaveBeenCalled();
  });

  it("um identificador técnico (o próprio chatId) NÃO é nome: pergunta ao canal", async () => {
    const { admin, rpc } = adminCom({ name: CHAT, display_name: CHAT });
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: canalCom("Time comercial") })).toBe("nomeado");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("canal sem assunto para o grupo: não grava (id é melhor que nome errado)", async () => {
    const { admin, rpc } = adminCom({ name: null, display_name: null });
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: canalCom(null) })).toBe("sem_nome_no_canal");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sem canal (transporte não configurado) ou sem nome de sessão: não faz nada", async () => {
    const { admin, maybeSingle } = adminCom({ name: null, display_name: null });
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: null })).toBe("sem_canal");
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: canalCom("X"), sessionName: null })).toBe("sem_canal");
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("o canal estourar não derruba a ingestão: devolve 'erro'", async () => {
    const { admin, rpc } = adminCom({ name: null, display_name: null });
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: canalCom(new Error("waha_429")) })).toBe("erro");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a RPC falhar também devolve 'erro', sem lançar", async () => {
    const { admin } = adminCom({ name: null, display_name: null }, "boom");
    expect(await nomearGrupoSeFaltar({ ...base, admin, canal: canalCom("Time") })).toBe("erro");
  });
});

describe("nomearGrupoSeFaltar — a conta-gotas (o canal limita esta consulta)", () => {
  it("segunda mensagem do mesmo grupo sem nome, logo depois: NÃO pergunta de novo", async () => {
    const { admin } = adminCom({ name: null, display_name: null });
    const canal = canalCom(null);
    let agora = 1_000_000;
    const deps = { ...base, admin, canal, agora: () => agora };

    expect(await nomearGrupoSeFaltar(deps)).toBe("sem_nome_no_canal");
    agora += 60_000; // 1 min depois
    expect(await nomearGrupoSeFaltar(deps)).toBe("esperando");
    expect(canal.getGroupSubject).toHaveBeenCalledTimes(1);
  });

  it("passado o intervalo, tenta de novo", async () => {
    const { admin } = adminCom({ name: null, display_name: null });
    const canal = canalCom(null);
    let agora = 1_000_000;
    const deps = { ...base, admin, canal, agora: () => agora };

    await nomearGrupoSeFaltar(deps);
    agora += 11 * 60_000; // 11 min depois
    expect(await nomearGrupoSeFaltar(deps)).toBe("sem_nome_no_canal");
    expect(canal.getGroupSubject).toHaveBeenCalledTimes(2);
  });

  it("grupo com nome: a próxima mensagem nem lê o banco (o grupo é conferido de hora em hora)", async () => {
    const { admin, maybeSingle } = adminCom({ name: "Time", display_name: "Time" });
    let agora = 1_000_000;
    const deps = { ...base, admin, canal: canalCom("Time"), agora: () => agora };

    expect(await nomearGrupoSeFaltar(deps)).toBe("ja_tem_nome");
    agora += 30 * 60_000;
    expect(await nomearGrupoSeFaltar(deps)).toBe("esperando");
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("o intervalo é por grupo E por organização — outro grupo não espera pelo primeiro", async () => {
    const { admin } = adminCom({ name: null, display_name: null });
    const canal = canalCom(null);
    const agora = () => 1_000_000;
    await nomearGrupoSeFaltar({ ...base, admin, canal, agora });
    await nomearGrupoSeFaltar({ ...base, chatId: "120363000000000002@g.us", admin, canal, agora });
    await nomearGrupoSeFaltar({ ...base, organizationId: "org-2", admin, canal, agora });
    expect(canal.getGroupSubject).toHaveBeenCalledTimes(3);
  });
});
