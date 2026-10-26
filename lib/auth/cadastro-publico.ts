/**
 * O cadastro público está aberto nesta instalação?
 *
 * ─── Por que isto existe ────────────────────────────────────────────────────
 * `/signup` cria uma ORGANIZAÇÃO nova para qualquer pessoa que confirme um e-mail.
 * Numa instalação de uso próprio, ou onde cada empresa se cadastra sozinha, é o
 * que se quer. Numa instalação operada como serviço — uma VPS, um banco, vários
 * clientes, que entram por convite — é uma porta aberta: qualquer pessoa da
 * internet abre uma empresa dentro da instância, consome a cota de e-mail e de
 * IA, e pode conectar números de WhatsApp.
 *
 * ─── O padrão não muda nada para quem já instalou ───────────────────────────
 * Sem a variável, o cadastro continua aberto. Fechar é decisão de quem opera.
 *
 * ─── Falha FECHADA para valor que não se entende ────────────────────────────
 * Só `true` (ou vazio/ausente) abre. `false`, `0`, `nao`, e também um erro de
 * digitação como `falso` ou `False ` fecham. O contrário — fechar só em "false"
 * exato — deixaria o cadastro ABERTO, em silêncio, para quem tentou fechar e
 * errou a grafia; e esse é justamente o erro que ninguém percebe até aparecer
 * uma organização que ninguém convidou.
 *
 * ─── Quem entra mesmo com o cadastro fechado ────────────────────────────────
 * Quem traz um convite válido (token assinado, para o e-mail confirmado). O
 * convite é o caminho de entrada de todo cliente e de toda pessoa da equipe dele.
 */
import { env } from "@/lib/env";

/** Função pura: recebe o texto da variável. Fácil de provar sem montar o `env`. */
export function cadastroPublicoAberto(valor: string | null | undefined): boolean {
  const v = (valor ?? "").trim().toLowerCase();
  return v === "" || v === "true";
}

/** O que as telas e rotas chamam: lê da configuração validada da instalação. */
export function cadastroPublicoAbertoNaInstalacao(): boolean {
  return cadastroPublicoAberto(env.CADASTRO_PUBLICO);
}
