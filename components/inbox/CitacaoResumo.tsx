"use client";
import { useT } from "@/hooks/i18n/useT";
import { resumoDaCitacao, type IconeDaCitacao } from "@/lib/inbox/resumo-da-citacao";
import type { Message } from "@/lib/types/messaging";
import {
  FileText,
  ImageIcon,
  MapPin,
  Microphone,
  Paperclip,
  Smiley,
  UserCircle,
  VideoCamera,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const ICONES: Record<IconeDaCitacao, typeof Microphone> = {
  audio: Microphone,
  imagem: ImageIcon,
  video: VideoCamera,
  documento: FileText,
  figurinha: Smiley,
  contato: UserCircle,
  localizacao: MapPin,
  anexo: Paperclip,
};

/**
 * A mensagem citada, em uma linha: ícone do tipo + a legenda, ou o nome do tipo.
 *
 * Um só desenho para os dois lugares em que a citação aparece — a faixa acima do
 * campo de envio e o fio dentro da bolha —, porque os dois precisam dizer a mesma
 * coisa sobre a mesma mensagem (ver `resumoDaCitacao`).
 */
export function CitacaoResumo({
  mensagem,
  className,
}: {
  mensagem: Pick<Message, "type" | "body" | "revoked_at" | "media_url" | "media_storage_path">;
  className?: string;
}) {
  const t = useT();
  const r = resumoDaCitacao(mensagem);
  const Icone = r.icone ? ICONES[r.icone] : null;
  return (
    <span className={cn("flex min-w-0 items-start gap-1", r.apagada && "italic", className)}>
      {Icone && <Icone size={13} weight="fill" aria-hidden className="mt-px shrink-0" />}
      <span className="line-clamp-2 min-w-0 break-words">{r.trecho ?? t(r.rotulo ?? "(sem texto)")}</span>
    </span>
  );
}
