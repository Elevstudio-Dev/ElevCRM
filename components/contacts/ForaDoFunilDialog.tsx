"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  useCriarTipoForaDoFunil,
  useMarcarForaDoFunil,
  usePreviaDoMarcador,
  useTiposForaDoFunil,
} from "@/hooks/contatos/useForaDoFunil";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { formatCentsBRL } from "@/lib/money";
import type { PreviaDoMarcador } from "@/lib/schemas/fora-do-funil";

export interface ContatoDoDialogo {
  id: string;
  nome: string;
  /** Já marcado? Só serve para pré-selecionar o tipo quando é UM contato. */
  tipoId?: string | null;
}

/** O que a prévia diz, em frase de gente — fora do componente para o teste ler sem renderizar o diálogo inteiro. */
export function resumoDaPrevia(
  p: PreviaDoMarcador,
  marcar: boolean,
  t: (texto: string) => string,
): { frase: string; temVenda: boolean } {
  const { abertos, ganhos, perdidos, valor_ganho_cents } = p.negocios;
  const total = abertos + ganhos + perdidos;
  if (total === 0) {
    return {
      frase: marcar ? t("Nenhum negócio será afetado.") : t("Não há negócio escondido para devolver."),
      temVenda: false,
    };
  }
  const partes: string[] = [];
  if (abertos > 0) partes.push(`${abertos} ${abertos === 1 ? t("negócio aberto") : t("negócios abertos")}`);
  if (ganhos > 0) {
    partes.push(
      `${ganhos} ${ganhos === 1 ? t("venda ganha") : t("vendas ganhas")}${
        valor_ganho_cents > 0 ? ` (${formatCentsBRL(valor_ganho_cents)})` : ""
      }`,
    );
  }
  if (perdidos > 0) partes.push(`${perdidos} ${perdidos === 1 ? t("negócio perdido") : t("negócios perdidos")}`);
  const lista = partes.join(", ");
  const piso = p.aproximado ? `${t("mais de")} ` : "";
  return {
    frase: marcar
      ? `${t("Saem do funil e do relatório:")} ${piso}${lista}.`
      : `${t("Voltam ao funil e ao relatório:")} ${piso}${lista}.`,
    temVenda: ganhos > 0,
  };
}

/**
 * Marcar ou desmarcar contatos como "fora do funil" — equipe, prestador, parceiro: gente que não é cliente.
 *
 * Mostra ANTES de confirmar o que muda (a IA se cala, nenhum negócio nasce, os que existem saem do funil e do
 * relatório) e QUANTOS negócios saem, com destaque quando há venda ganha. Nada é apagado: desmarcar devolve tudo.
 * Gestor+ também cria um tipo na hora; atendente escolhe entre os que o dono cadastrou.
 */
export function ForaDoFunilDialog({
  contatos,
  marcar,
  open,
  onOpenChange,
  onConcluido,
}: {
  contatos: ContatoDoDialogo[];
  marcar: boolean;
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
  onConcluido?: () => void;
}) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const ids = contatos.map((c) => c.id);
  const um = contatos.length === 1;
  const previa = usePreviaDoMarcador(ids, marcar, open);
  const tipos = useTiposForaDoFunil({ enabled: open && marcar });
  const marcarMut = useMarcarForaDoFunil();
  const criarTipo = useCriarTipoForaDoFunil();
  const [tipoId, setTipoId] = useState<string>(contatos.length === 1 ? (contatos[0]?.tipoId ?? "") : "");
  const [novoTipo, setNovoTipo] = useState("");
  const podeCriarTipo =
    user.is_platform_admin || (!!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  const quem =
    contatos.length === 1 ? (contatos[0]?.nome ?? "") : `${contatos.length} ${t("contatos")}`;
  const resumo = previa.data ? resumoDaPrevia(previa.data, marcar, t) : null;
  const ocupado = marcarMut.isPending || criarTipo.isPending;

  const criar = async () => {
    const nome = novoTipo.trim();
    if (!nome) return;
    try {
      const criado = await criarTipo.mutateAsync(nome);
      setTipoId(criado.id);
      setNovoTipo("");
    } catch {
      // `onError` da mutação já mostrou o motivo (ex.: nome repetido).
    }
  };

  const confirmar = async () => {
    try {
      const r = await marcarMut.mutateAsync({
        contact_ids: ids,
        marcar,
        ...(marcar ? { tipo_id: tipoId === "" ? null : tipoId } : {}),
      });
      toast.success(
        marcar
          ? r.alterados === 1
            ? t("Contato marcado como fora do funil.")
            : t("Contatos marcados como fora do funil.")
          : r.alterados === 1
            ? t("Contato voltou ao funil.")
            : t("Contatos voltaram ao funil."),
      );
      onConcluido?.();
      onOpenChange(false);
    } catch {
      // `onError` da mutação já mostrou o motivo; o diálogo fica aberto.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialogo-fora-do-funil">
        <DialogHeader>
          <DialogTitle>{marcar ? t("Marcar como fora do funil") : t("Voltar ao funil")}</DialogTitle>
          <DialogDescription>{quem}</DialogDescription>
        </DialogHeader>

        <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
          {marcar ? (
            um ? (
              <>
                <li>{t("A IA para de atender e de enviar mensagens para esta pessoa.")}</li>
                <li>{t("Nenhum negócio novo é criado a partir das mensagens dela.")}</li>
                <li>
                  {t(
                    "Os negócios que ela já tinha saem do funil, do relatório e do Desempenho. O histórico fica guardado e volta se você desmarcar.",
                  )}
                </li>
                <li>{t("A conversa continua no Inbox para a equipe responder.")}</li>
              </>
            ) : (
              <>
                <li>{t("A IA para de atender e de enviar mensagens para estas pessoas.")}</li>
                <li>{t("Nenhum negócio novo é criado a partir das mensagens delas.")}</li>
                <li>
                  {t(
                    "Os negócios que elas já tinham saem do funil, do relatório e do Desempenho. O histórico fica guardado e volta se você desmarcar.",
                  )}
                </li>
                <li>{t("As conversas continuam no Inbox para a equipe responder.")}</li>
              </>
            )
          ) : (
            <>
              <li>{um ? t("A IA volta a poder atender esta pessoa.") : t("A IA volta a poder atender estas pessoas.")}</li>
              <li>{t("Os negócios que estavam escondidos voltam ao funil e ao relatório.")}</li>
            </>
          )}
        </ul>

        <div
          data-testid="previa-fora-do-funil"
          aria-live="polite"
          className="rounded-md bg-surface-elevated px-3 py-2 text-sm text-text"
        >
          {previa.isPending ? (
            <span className="text-text-muted">{t("Conferindo o que muda…")}</span>
          ) : previa.isError || !resumo ? (
            <span className="text-text-muted">{t("Não foi possível conferir o que muda. Você ainda pode confirmar.")}</span>
          ) : (
            <>
              <span>{resumo.frase}</span>
              {resumo.temVenda && marcar && (
                <span
                  role="alert"
                  data-testid="aviso-venda-ganha"
                  className="mt-2 block rounded-md bg-warning-bg px-2 py-1 text-warning-fg"
                >
                  {t("Atenção: a venda ganha também sai do relatório. Confirme só se esta pessoa não é cliente.")}
                </span>
              )}
            </>
          )}
        </div>

        {marcar && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fdf-tipo">{t("Tipo (opcional)")}</Label>
              <select
                id="fdf-tipo"
                value={tipoId}
                onChange={(e) => setTipoId(e.target.value)}
                className="flex h-11 w-full rounded-sm border border-border bg-bg px-3 text-sm text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-soft lg:h-10"
              >
                <option value="">{t("Sem tipo")}</option>
                {(tipos.data ?? []).map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.nome}
                  </option>
                ))}
              </select>
            </div>
            {podeCriarTipo && (
              <div className="flex items-end gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Label htmlFor="fdf-novo-tipo">{t("Novo tipo")}</Label>
                  <Input
                    id="fdf-novo-tipo"
                    value={novoTipo}
                    maxLength={40}
                    placeholder={t("Ex.: Equipe, Contador")}
                    onChange={(e) => setNovoTipo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void criar();
                      }
                    }}
                  />
                </div>
                <Button type="button" variant="outline" disabled={!novoTipo.trim() || ocupado} onClick={() => void criar()}>
                  {t("Criar tipo")}
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={marcarMut.isPending}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            data-testid="confirmar-fora-do-funil"
            onClick={() => void confirmar()}
            disabled={ocupado || contatos.length === 0}
          >
            {marcar ? t("Marcar como fora do funil") : t("Voltar ao funil")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
