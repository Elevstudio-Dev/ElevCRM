import type { GroupParticipant } from "@/lib/channels/types";

import { digitosDoJid, type ParticipanteDoGrupo } from "./grupo";

/**
 * Quem está num grupo, COM nome — a lista que a atendente vê ao digitar `@`.
 *
 * O canal só sabe o ENDEREÇO de cada participante (um número ou um identificador oculto). O nome que a
 * atendente reconhece é o que a pessoa usa no WhatsApp, e o CRM o conhece de um lugar só: as mensagens
 * dela no grupo (`metadata.grupo_participante_nome`, gravado pela ingestão). Quem nunca escreveu no
 * grupo aparece pelo telefone — e, se nem o telefone o canal diz, por um número curto que o distingue.
 */

/** Um nome vindo do WhatsApp é texto de TERCEIRO: sem quebra de linha, sem `@` na frente, e curto. */
export function limparNomeDeParticipante(nome: unknown): string | null {
  if (typeof nome !== "string") return null;
  const limpo = nome
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .slice(0, 40)
    .trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * O que se sabe de cada participante pelas mensagens do grupo: `dígitos do endereço → nome`. Recebe as
 * linhas da MAIS NOVA para a mais antiga, e o nome mais recente vence (a pessoa troca de nome).
 */
export function nomesDasMensagens(
  metadatas: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const m of metadatas) {
    const jid = typeof m?.grupo_participante === "string" ? m.grupo_participante : null;
    const nome = limparNomeDeParticipante(m?.grupo_participante_nome);
    if (!jid || !nome) continue;
    const digitos = digitosDoJid(jid);
    if (digitos && !nomes.has(digitos)) nomes.set(digitos, nome);
  }
  return nomes;
}

/**
 * Da lista do canal à lista da tela.
 *
 * O texto que a atendente escreve leva o RÓTULO depois do `@` e é por ele que a marcação é achada de
 * volta — então dois participantes não podem ter o mesmo rótulo. Duas "Maria" ganham os últimos dígitos
 * do endereço ao lado; sem isso a segunda marcação seria lida como a primeira.
 */
export function participantesParaATela(
  participantes: ReadonlyArray<GroupParticipant>,
  nomes: ReadonlyMap<string, string>,
): ParticipanteDoGrupo[] {
  const base = participantes.map((p) => {
    const digitos = digitosDoJid(p.jid);
    const conhecido = nomes.get(digitos) ?? (p.phone ? nomes.get(p.phone) : undefined);
    const nome = conhecido ?? (p.phone ? `+${p.phone}` : `Participante ${digitos.slice(-6)}`);
    return { jid: p.jid, nome, telefone: p.phone, admin: p.admin, conhecido: conhecido !== undefined, digitos };
  });

  const contagem = new Map<string, number>();
  for (const b of base) contagem.set(b.nome.toLowerCase(), (contagem.get(b.nome.toLowerCase()) ?? 0) + 1);

  const lista = base.map((b) => ({
    jid: b.jid,
    nome: (contagem.get(b.nome.toLowerCase()) ?? 0) > 1 ? `${b.nome} ·${b.digitos.slice(-4)}` : b.nome,
    telefone: b.telefone,
    admin: b.admin,
    conhecido: b.conhecido,
  }));

  // Quem tem nome conhecido primeiro (em ordem alfabética); o resto depois, pelo telefone.
  return lista.sort((a, b) => {
    const aNome = !a.nome.startsWith("+") && !a.nome.startsWith("Participante ");
    const bNome = !b.nome.startsWith("+") && !b.nome.startsWith("Participante ");
    if (aNome !== bNome) return aNome ? -1 : 1;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });
}
