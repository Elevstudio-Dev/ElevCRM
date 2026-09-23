/**
 * UM SEGREDO NUMA COLUNA SÓ.
 *
 * O padrão desta base guarda AES-GCM em TRÊS colunas (`*_encrypted`, `*_iv`,
 * `*_tag`) — é o que `lib/ai/credenciais/guardar.ts` faz. Mas
 * `tenant_integrations` nasceu com UMA coluna `bytea` por segredo
 * (`oauth_access_token_encrypted`, `webhook_secret_encrypted`), e mudar o
 * formato dessa tabela obrigaria a migrar a integração Nuvemshop, que já a usa
 * em instalação de cliente — custo grande para uma escolha de empacotamento.
 *
 * Então o pacote é autocontido e o formato mora aqui, num lugar só:
 *
 *     [ iv 12 bytes | tag 16 bytes | cifra N bytes ]
 *
 * As duas pontas fixas vêm do próprio AES-GCM (o `lib/crypto/aes_gcm` usa
 * exatamente 12 e 16), então não há campo de tamanho a manter em dia.
 */
import { decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

const IV = 12;
const TAG = 16;

/** Cifra e devolve o pacote pronto para a coluna `bytea`. */
export function empacotarSegredo(texto: string): Buffer {
  const { ciphertext, iv, tag } = encryptKey(texto);
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Desempacota e decifra. Devolve `null` para pacote ausente ou curto demais
 * para ser um — nunca lança: quem chama está numa rota de integração, e um
 * throw aqui viraria 500 numa tela que só queria dizer "não conectado".
 */
export function desempacotarSegredo(pacote: Buffer | null | undefined): string | null {
  if (!pacote || pacote.length <= IV + TAG) return null;
  try {
    return decryptKey({
      iv: pacote.subarray(0, IV),
      tag: pacote.subarray(IV, IV + TAG),
      ciphertext: pacote.subarray(IV + TAG),
    });
  } catch {
    return null;
  }
}
