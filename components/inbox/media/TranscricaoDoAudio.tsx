"use client";
import { useId, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { estadoDaTranscricao } from "@/lib/messaging/media/transcricao-na-conversa";
import { CaretDown, CaretUp } from "@/lib/ui/icons";
import type { Message } from "@/lib/types/messaging";

/**
 * O texto do áudio do cliente, embaixo do player.
 *
 * Fechado por padrão: o áudio continua sendo o que se vê, e o texto é um
 * atalho para quem não pode ouvir agora. Aberto, vira texto comum — dá para
 * selecionar e copiar. Quem decide o que mostrar é `estadoDaTranscricao`; aqui
 * só se desenha o resultado.
 */
export function TranscricaoDoAudio({ message }: { message: Message }) {
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const idDoTexto = useId();
  const estado = estadoDaTranscricao(message);

  if (estado.tipo === "nenhuma") return null;

  if (estado.tipo === "em_andamento") {
    return (
      <p role="status" className="w-60 pt-1 text-xs text-muted-foreground">
        {t("Transcrevendo…")}
      </p>
    );
  }
  if (estado.tipo === "indisponivel") {
    return (
      <p className="w-60 pt-1 text-xs text-muted-foreground">
        {t("Não foi possível transcrever este áudio.")}
      </p>
    );
  }
  if (estado.tipo === "sem_fala") {
    return (
      <p className="w-60 pt-1 text-xs text-muted-foreground">
        {t("Não identifiquei fala neste áudio.")}
      </p>
    );
  }

  const Seta = aberta ? CaretUp : CaretDown;
  return (
    <div className="w-60 pt-1">
      <button
        type="button"
        aria-expanded={aberta}
        aria-controls={idDoTexto}
        onClick={() => setAberta((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {aberta ? t("Ocultar texto") : t("Ver texto")}
        <Seta size={12} weight="bold" aria-hidden />
      </button>
      {aberta && (
        <p
          id={idDoTexto}
          className="mt-1 max-h-48 select-text overflow-y-auto whitespace-pre-wrap break-words text-sm leading-snug"
        >
          {estado.texto}
        </p>
      )}
    </div>
  );
}
