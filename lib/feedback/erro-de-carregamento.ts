/**
 * "O sistema foi atualizado com a aba aberta" — reconhecer esse erro pelo nome.
 *
 * Toda atualização troca os nomes dos pedaços de código (`/_next/static/chunks/
 * <hash>.js`). Uma aba que ficou aberta desde antes ainda tem a lista antiga:
 * na próxima navegação ela pede um pedaço que não existe mais, o navegador
 * responde 404, e o React derruba a árvore com `ChunkLoadError` (webpack) ou
 * "Failed to fetch dynamically imported module" (ESM/Turbopack). Cai na tela
 * de erro genérica — "Algo deu errado", com um ID de Sentry que, numa
 * instalação sem Sentry, não leva a nada — e "Tentar de novo" não resolve,
 * porque a lista antiga continua na memória da aba. Só recarregar resolve.
 *
 * Medido em 2026-09-14: o servidor de teste foi rebuildado e reiniciado com a
 * aba do dono aberta; o próximo clique deu essa tela. Não é defeito do produto,
 * é o ciclo de vida de qualquer SPA — mas a tela tem que DIZER isso e oferecer
 * a saída certa, em vez de mandar contatar o suporte com um ID vazio.
 */

const SINAIS = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to load chunk/i,
];

export function ehErroDeCarregamento(erro: { name?: string; message?: string } | null | undefined): boolean {
  if (!erro) return false;
  const texto = `${erro.name ?? ""} ${erro.message ?? ""}`;
  return SINAIS.some((re) => re.test(texto));
}

/** Chave de sessão que impede o recarregamento automático de entrar em laço. */
export const CHAVE_RECARREGOU = "elev:recarregou-apos-atualizacao";

/** Dois recarregamentos automáticos em menos disto é laço, não atualização. */
export const INTERVALO_MINIMO_MS = 60_000;

/**
 * Recarrega a aba sozinho, no máximo uma vez por minuto. Na primeira
 * ocorrência marca a hora e recarrega — o usuário nem vê a tela. Se o erro
 * voltar logo depois (o problema não era a lista de pedaços), devolve `false`
 * e a tela explica e oferece o botão. O intervalo, e não uma marca fixa,
 * deixa a MESMA aba se recuperar sozinha de novo na atualização da semana que
 * vem. Sem `sessionStorage` (janela privada com bloqueio), não recarrega
 * sozinho: a tela ainda serve.
 */
export function recarregarUmaVez(
  armazenamento: Pick<Storage, "getItem" | "setItem"> | null,
  recarregar: () => void,
  agora: number = Date.now(),
): boolean {
  if (!armazenamento) return false;
  try {
    const ultimo = Number(armazenamento.getItem(CHAVE_RECARREGOU) ?? 0);
    if (Number.isFinite(ultimo) && ultimo > 0 && agora - ultimo < INTERVALO_MINIMO_MS) return false;
    armazenamento.setItem(CHAVE_RECARREGOU, String(agora));
  } catch {
    return false;
  }
  recarregar();
  return true;
}
