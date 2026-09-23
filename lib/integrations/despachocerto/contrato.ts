/**
 * O CONTRATO ENTRE O ELEV CRM E O DESPACHO CERTO.
 *
 * Este arquivo é a fronteira: ele descreve o que um lado manda e o que o outro
 * devolve, e nada mais. Os dois sistemas são feitos por agentes diferentes, em
 * repositórios diferentes — se o contrato mora só na cabeça de quem escreveu,
 * a integração quebra na primeira mudança de campo e ninguém descobre até um
 * cliente clicar.
 *
 * ─── As duas direções ───────────────────────────────────────────────────────
 *
 * 1. **Elev CRM → Despacho Certo (síncrono, HTTP).** O botão "Cadastrar" do
 *    inbox procura o cliente pelo telefone/documento e, se não existir, cria.
 *    Autenticação: `Authorization: Bearer <chave da integração>`.
 *
 * 2. **Despacho Certo → Elev CRM (assíncrono, webhook).** Quando uma OS é
 *    aberta (ou tem o cliente/placa alterados), o Despacho Certo avisa, e o
 *    Elev CRM marca a conversa e o contato com as tags da OS e da placa.
 *    Autenticação: token no caminho + assinatura HMAC-SHA256 do corpo.
 *
 * ─── Por que o CRM procura antes de criar ───────────────────────────────────
 *
 * Decisão do dono (2026-09-22): telefone ou documento que já é cliente lá deve
 * VINCULAR ao cadastro existente, não criar um segundo. Cadastro duplicado no
 * Despacho Certo faria a OS cair num dos dois, sorteado, e a tag apareceria na
 * conversa errada — um defeito que só se descobre com o cliente na frente.
 */
import { z } from "zod";

/** O provedor, como ele aparece em `tenant_integrations.provider`. */
export const PROVEDOR = "despachocerto" as const;

// ── 1. Elev CRM → Despacho Certo ───────────────────────────────────────────

/**
 * Os campos do cadastro de cliente do Despacho Certo, como ele os pede hoje
 * (`app/clients/actions.ts`, `createClientSchema`). O diálogo do inbox mostra
 * exatamente estes — a promessa ao dono foi "os mesmos dados que pede lá".
 */
export const clienteParaCadastrarSchema = z.object({
  name: z.string().trim().min(2, "O nome precisa de ao menos 2 letras."),
  phone: z.string().trim().min(8, "O telefone precisa de ao menos 8 dígitos."),
  document: z.string().trim().optional(),
  email: z.string().trim().email("E-mail inválido.").optional().or(z.literal("")),
  notes: z.string().trim().optional(),
  /** Placa do veículo. Opcional lá, e aqui é o que antecipa a tag da placa. */
  plate: z.string().trim().optional(),
  type: z.enum(["pessoa_fisica", "pessoa_juridica"]).default("pessoa_fisica"),
});
export type ClienteParaCadastrar = z.infer<typeof clienteParaCadastrarSchema>;

/** O cadastro como o Despacho Certo o devolve. */
export const clienteDoDespachoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phone: z.string().nullable().optional(),
  document: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  /** Placas já ligadas a este cliente. Viram tag junto com a da OS. */
  plates: z.array(z.string()).default([]),
  /** Endereço da ficha, para a tela do CRM oferecer "abrir lá". */
  url: z.string().url().nullable().optional(),
});
export type ClienteDoDespacho = z.infer<typeof clienteDoDespachoSchema>;

/**
 * A resposta de `POST /clients`: o cadastro, e se ele JÁ existia.
 *
 * `existente: true` é o que faz o diálogo dizer "este telefone já é cliente:
 * Fulano" em vez de fingir que criou algo.
 */
export const respostaDeCadastroSchema = z.object({
  cliente: clienteDoDespachoSchema,
  existente: z.boolean().default(false),
});
export type RespostaDeCadastro = z.infer<typeof respostaDeCadastroSchema>;

/** A resposta de `GET /clients/lookup`: o cadastro, ou nada. */
export const respostaDeBuscaSchema = z.object({
  cliente: clienteDoDespachoSchema.nullable(),
});

// ── 2. Despacho Certo → Elev CRM ───────────────────────────────────────────

/**
 * O evento de OS.
 *
 * `client_id` é o id do cadastro LÁ — é por ele que o CRM acha o contato, pelo
 * vínculo de `integration_contact_links`. Casar por telefone seria frágil: o
 * mesmo cliente pode ter o número trocado num dos dois lados.
 */
export const eventoDeOsSchema = z.object({
  event: z.enum(["work_order.created", "work_order.updated"]),
  work_order: z.object({
    id: z.string().min(1),
    /** O número que a equipe usa para falar da OS. É ele que vira tag. */
    number: z.string().min(1),
    client_id: z.string().min(1),
    /** A placa principal. */
    plate: z.string().nullable().optional(),
    /** Outras placas da mesma OS, quando houver. */
    additional_plates: z.array(z.string()).default([]),
    status: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
});
export type EventoDeOs = z.infer<typeof eventoDeOsSchema>;

/** O que o CRM responde ao webhook — o outro lado loga isto. */
export interface ResultadoDoEvento {
  /** Contato encontrado pelo vínculo? Falso = o cliente não veio do CRM. */
  vinculado: boolean;
  /** Tags realmente acrescentadas nesta chamada (vazio = já estavam lá). */
  tags_novas: string[];
  conversas_marcadas: number;
}
