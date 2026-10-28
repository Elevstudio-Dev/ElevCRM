import { mensagemComCodigo } from "./codigo";

/** Só os dígitos, e só se parecer telefone internacional (10 a 15 dígitos — E.164). */
export function digitosDoTelefone(telefone: string | null | undefined): string | null {
  const d = (telefone ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** O link que abre o WhatsApp do cliente com a mensagem pronta. `null` sem telefone válido. */
export function linkDoWhatsApp(telefone: string | null | undefined, mensagem: string, codigo: string): string | null {
  const digitos = digitosDoTelefone(telefone);
  if (!digitos) return null;
  return `https://wa.me/${digitos}?text=${encodeURIComponent(mensagemComCodigo(mensagem, codigo))}`;
}

/** O endereço que vai DENTRO do QR: a rota do próprio CRM que conta a leitura. */
export function linkPublicoDoQr(origem: string, codigo: string): string {
  return `${origem.replace(/\/+$/, "")}/q/${codigo}`;
}
