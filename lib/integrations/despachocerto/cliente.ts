/**
 * O CLIENTE HTTP que fala com o Despacho Certo.
 *
 * Duas chamadas, e só: procurar um cliente e criar um. É o que o botão
 * "Cadastrar" do inbox precisa, e nada além disso entra aqui enquanto ninguém
 * pedir — integração cresce por rota, e cada rota a mais é um contrato a mais
 * para manter alinhado entre dois repositórios.
 *
 * ─── Teto de tempo, e por quê ───────────────────────────────────────────────
 *
 * 8 segundos. Esta chamada acontece com o atendente olhando o diálogo: um
 * `fetch` sem teto deixaria o botão girando até o navegador desistir, sem dizer
 * nada. Estourou, a tela diz que o outro sistema não respondeu — que é a
 * verdade, e é acionável (o operador tenta de novo ou avisa alguém).
 */
import {
  clienteDoDespachoSchema,
  respostaDeBuscaSchema,
  respostaDeCadastroSchema,
  type ClienteDoDespacho,
  type ClienteParaCadastrar,
  type RespostaDeCadastro,
} from "./contrato";

const TETO_MS = 8_000;

export class FalhaDoDespachoCerto extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "FalhaDoDespachoCerto";
  }
}

async function chamar(
  cred: { baseUrl: string; chave: string },
  caminho: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controle = new AbortController();
  const corta = setTimeout(() => controle.abort(), TETO_MS);
  let res: Response;
  try {
    res = await fetch(`${cred.baseUrl}${caminho}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${cred.chave}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controle.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `abort` tem mensagem técnica ("This operation was aborted"); o operador
    // precisa da causa, não do jargão.
    throw new FalhaDoDespachoCerto(
      controle.signal.aborted ? "o Despacho Certo não respondeu a tempo" : msg,
      null,
    );
  } finally {
    clearTimeout(corta);
  }

  const texto = await res.text();
  if (!res.ok) {
    // 401/403 é chave errada — não é transitório, e dizer isso poupa o
    // operador de tentar de novo dez vezes.
    const motivo =
      res.status === 401 || res.status === 403
        ? "o Despacho Certo recusou a chave de integração"
        : `o Despacho Certo respondeu ${res.status}`;
    throw new FalhaDoDespachoCerto(`${motivo}: ${texto.slice(0, 200)}`, res.status);
  }
  try {
    return texto ? JSON.parse(texto) : {};
  } catch {
    throw new FalhaDoDespachoCerto("o Despacho Certo respondeu algo que não é JSON", res.status);
  }
}

/**
 * Procura um cliente por telefone (e, quando houver, por documento).
 *
 * Devolve `null` quando não existe — não é erro: é o caminho normal do
 * primeiro contato de alguém.
 */
export async function buscarCliente(
  cred: { baseUrl: string; chave: string },
  chaves: { phone?: string; document?: string },
): Promise<ClienteDoDespacho | null> {
  const qs = new URLSearchParams();
  if (chaves.phone) qs.set("phone", chaves.phone);
  if (chaves.document) qs.set("document", chaves.document);
  if ([...qs.keys()].length === 0) return null;
  const cru = await chamar(cred, `/api/integrations/elevcrm/clients/lookup?${qs.toString()}`);
  const parsed = respostaDeBuscaSchema.safeParse(cru);
  if (!parsed.success) {
    throw new FalhaDoDespachoCerto("a busca devolveu um formato que não reconheço", null);
  }
  return parsed.data.cliente;
}

/**
 * Cria o cliente lá — ou devolve o que já existe, com `existente: true`.
 *
 * A idempotência é responsabilidade do OUTRO lado, e de propósito: só ele sabe
 * o que conta como "o mesmo cliente" no negócio dele (documento? telefone?
 * empresa?), e duas requisições simultâneas daqui não podem virar dois
 * cadastros por o CRM ter perguntado antes.
 */
export async function criarCliente(
  cred: { baseUrl: string; chave: string },
  dados: ClienteParaCadastrar,
): Promise<RespostaDeCadastro> {
  const cru = await chamar(cred, "/api/integrations/elevcrm/clients", {
    method: "POST",
    body: JSON.stringify(dados),
  });
  const parsed = respostaDeCadastroSchema.safeParse(cru);
  if (!parsed.success) {
    // Tolerância a um formato mais simples: o outro lado pode devolver só o
    // cliente. Aceitar isso evita que a demonstração morra por um envelope.
    const soCliente = clienteDoDespachoSchema.safeParse(cru);
    if (soCliente.success) return { cliente: soCliente.data, existente: false };
    throw new FalhaDoDespachoCerto("o cadastro devolveu um formato que não reconheço", null);
  }
  return parsed.data;
}
