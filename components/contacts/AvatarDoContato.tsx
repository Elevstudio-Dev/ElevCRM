"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * O ROSTO DO CONTATO — um componente para as três telas que o mostram.
 *
 * A lista de conversas, o cabeçalho da conversa e a lista de contatos exibem a
 * mesma coisa, e até 2026-09-22 cada uma tinha a sua cópia: duas do markup
 * (`<Avatar>` + `<AvatarImage>` condicional + iniciais) e TRÊS da função de
 * iniciais, uma delas em `UserMenu` com outra assinatura. A lista de contatos
 * simplesmente não tinha rosto nenhum — a API nem devolvia o campo.
 *
 * Duas regras moram aqui, e é por elas que isto é componente e não trecho
 * copiado:
 *
 *   1. **A `<img>` só nasce quando existe arquivo.** Sem isso o navegador
 *      pediria `/api/v1/contacts/<id>/avatar` para TODO contato da lista e
 *      levaria 404 em cada um sem foto — que é a maioria (medido em
 *      2026-09-22: 5 de 173). O `AvatarFallback` do Radix ainda cobre a imagem
 *      que falha ao carregar, então as iniciais nunca somem.
 *   2. **Contato anonimizado não mostra rosto.** É gate de LGPD, não estética:
 *      apagar o nome e manter a foto não anonimiza ninguém.
 */
export interface ContatoComRosto {
  id: string;
  display_name?: string | null;
  name?: string | null;
  avatar_storage_path?: string | null;
  is_anonymized?: boolean | null;
}

/**
 * Iniciais de um nome, com reserva para quem não tem nome nenhum (o telefone,
 * em geral). Uma palavra → duas primeiras letras; duas ou mais → primeira da
 * primeira e primeira da última.
 */
export function iniciaisDoNome(nome: string | null | undefined, reserva: string): string {
  const v = (nome ?? "").trim();
  const partes = v.split(/\s+/).filter(Boolean);
  if (partes.length === 0) return reserva.slice(0, 2).toUpperCase();
  if (partes.length === 1) return (partes[0] ?? "").slice(0, 2).toUpperCase();
  const primeira = partes[0]?.[0] ?? "";
  const ultima = partes[partes.length - 1]?.[0] ?? "";
  return (primeira + ultima).toUpperCase();
}

export function AvatarDoContato({
  contato,
  nome,
  reserva,
  className,
  classNameIniciais,
}: {
  contato: ContatoComRosto | null | undefined;
  /** O nome já resolvido pela tela (ela sabe se usa apelido, empresa etc.). */
  nome: string | null | undefined;
  /** O que vira iniciais quando não há nome: telefone, e-mail, "?". */
  reserva: string;
  className?: string;
  classNameIniciais?: string;
}) {
  const temFoto = Boolean(contato?.avatar_storage_path) && !contato?.is_anonymized;
  return (
    <Avatar className={cn("h-8 w-8 shrink-0", className)}>
      {temFoto && contato ? (
        <AvatarImage src={`/api/v1/contacts/${contato.id}/avatar`} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className={cn("text-xs", classNameIniciais)}>
        {iniciaisDoNome(nome, reserva)}
      </AvatarFallback>
    </Avatar>
  );
}
