"use client";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { PainelDoChat } from "@/components/chat-interno/PainelDoChat";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useCanaisDaEquipe, useChatInternoRealtime, type MensagemRecebida } from "@/hooks/chat-interno/useChatInterno";
import { useT } from "@/hooks/i18n/useT";
import { roleAtLeast } from "@/lib/auth/types";
import { chatMarcaUsuario } from "@/lib/mencoes/atinge";
import { ChatsCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O ícone do chat na barra superior, com o contador de não lidas — e a
 * assinatura de tempo real que vive aqui porque a barra está em toda tela.
 *
 * Com o painel fechado, mensagem nova vira um aviso (toast) com o nome de
 * quem escreveu; aberto, ela simplesmente aparece no fio. Só para `agent+`:
 * viewer lê o CRM, não conversa com a equipe (a API recusaria, e um botão que
 * abre um 403 é pior que botão nenhum).
 */
export function BotaoDoChat() {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [aberto, setAberto] = useState(false);
  const [canalInicial, setCanalInicial] = useState<string | null>(null);

  const participa = !!activeOrg && (user.is_platform_admin || roleAtLeast(activeOrg.role, "agent"));
  const canais = useCanaisDaEquipe({ enabled: participa });
  const naoLidas = (canais.data ?? []).reduce((n, c) => n + c.unread, 0);

  const aoReceber = useCallback(
    (m: MensagemRecebida) => {
      if (m.sender_user_id === user.id || aberto) return;
      // Quem foi marcado (pelo nome ou pelo @todos) fica sabendo POR QUE o aviso é
      // dele: "Ana marcou você" diz mais que "Ana" + um texto que talvez nem cite o nome.
      const marcou = chatMarcaUsuario(m.mentions, user.id);
      const autor = m.sender_name ?? t("Equipe");
      toast(marcou ? `${autor} ${t("marcou você")}` : autor, {
        description: m.body.length > 120 ? `${m.body.slice(0, 117)}…` : m.body,
        action: {
          label: t("Abrir"),
          onClick: () => {
            setCanalInicial(m.channel_id);
            setAberto(true);
          },
        },
      });
    },
    [user.id, aberto, t],
  );
  useChatInternoRealtime(participa ? (activeOrg?.orgId ?? null) : null, aoReceber);

  if (!participa) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        aria-label={naoLidas > 0 ? `${t("Chat da equipe")} — ${naoLidas} ${t("não lidas")}` : t("Chat da equipe")}
        title={t("Chat da equipe")}
        data-testid="botao-do-chat"
        className={cn(
          "relative inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          aberto && "bg-accent text-accent-foreground",
        )}
      >
        <ChatsCircle size={18} weight={aberto ? "fill" : "regular"} aria-hidden />
        {naoLidas > 0 && (
          <span
            data-testid="chat-nao-lidas"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
          >
            {naoLidas > 99 ? "99+" : naoLidas}
          </span>
        )}
      </button>
      {aberto && (
        <PainelDoChat
          open={aberto}
          onOpenChange={(v) => {
            setAberto(v);
            if (!v) setCanalInicial(null);
          }}
          canalInicial={canalInicial}
        />
      )}
    </>
  );
}
