import type { Lead } from "@/lib/types/leads";

/**
 * O QUE O CARD DO FUNIL SABE DO CLIENTE — e o que ele NÃO pode saber de quem pediu para ser esquecido.
 *
 * O card mostra o rosto do cliente (foto ou iniciais). A foto não viaja no quadro: viaja só o caminho
 * dela, para a tela saber SE existe foto, e a imagem vem de `/api/v1/contacts/{id}/avatar`, que assina
 * a URL. Esta função é o ponto em que a linha do banco vira o que a tela recebe.
 *
 * Contato ANONIMIZADO sai sem nome, sem telefone e sem caminho de foto. `AvatarDoContato` também
 * esconde o rosto dele, mas essa é a segunda cerca: a primeira é não entregar o dado. Apagar o nome e
 * manter a foto não anonimiza ninguém, e a resposta da rota é o último lugar em que isso ainda se
 * garante — depois dela, o dado já está no navegador.
 *
 * Pura: o quadro lê `contacts` sob a RLS do usuário e passa cada linha por aqui.
 */
export type ContatoDoCard = NonNullable<Lead["contato"]>;

export interface LinhaDeContato {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  avatar_storage_path: string | null;
  is_anonymized: boolean | null;
}

export function contatoDoCard(linha: LinhaDeContato): ContatoDoCard {
  // `=== true`, e não truthiness: `null` (coluna sem valor) não é "anonimizado", e tratar como se
  // fosse apagaria o nome de quem nunca pediu isso.
  const anonimizado = linha.is_anonymized === true;
  return {
    id: linha.id,
    display_name: anonimizado ? null : linha.display_name,
    name: anonimizado ? null : linha.name,
    phone_number: anonimizado ? null : linha.phone_number,
    avatar_storage_path: anonimizado ? null : linha.avatar_storage_path,
    is_anonymized: anonimizado,
  };
}
