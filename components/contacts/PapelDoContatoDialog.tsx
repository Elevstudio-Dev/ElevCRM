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
import { useDefinirPapelInterno } from "@/hooks/contatos/useDefinirPapelInterno";
import { useT } from "@/hooks/i18n/useT";
import { ehPapelInterno, type PapelInterno } from "@/lib/bastidor/papeis";

/**
 * Define o papel de um contato da equipe: Secretaria, Marketing ou nenhum.
 *
 * Quem tem papel fica "fora do funil" (o servidor faz isso junto) e passa a conversar com o assistente de bastidor
 * da IA — nunca com a IA de vendas. O diálogo diz isso ANTES de a pessoa escolher, porque a consequência é
 * invisível na tela depois (a conversa continua parecida): o papel muda quem responde do outro lado.
 */
export function PapelDoContatoDialog({
  contactId,
  nome,
  papelAtual,
  open,
  onOpenChange,
}: {
  contactId: string;
  nome: string;
  papelAtual: string | null | undefined;
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
}) {
  const t = useT();
  const definir = useDefinirPapelInterno();
  const [escolha, setEscolha] = useState<PapelInterno | "">(ehPapelInterno(papelAtual) ? papelAtual : "");
  const mudou = escolha !== (ehPapelInterno(papelAtual) ? papelAtual : "");

  const salvar = async () => {
    try {
      await definir.mutateAsync({ contactId, papel: escolha === "" ? null : escolha });
      toast.success(escolha === "" ? t("Papel removido.") : t("Papel atualizado."));
      onOpenChange(false);
    } catch {
      // `onError` da mutação já mostrou o motivo; o diálogo fica aberto.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialogo-papel-interno">
        <DialogHeader>
          <DialogTitle>{t("Papel na equipe")}</DialogTitle>
          <DialogDescription>{nome}</DialogDescription>
        </DialogHeader>

        <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
          <li>{t("A pessoa fica fora do funil: não vira cliente nem entra nos relatórios de vendas.")}</li>
          <li>
            {t("A IA de vendas nunca escreve para ela. Quem escreve é o assistente de bastidor, só sobre o papel dela.")}
          </li>
        </ul>

        <fieldset className="space-y-2" disabled={definir.isPending}>
          <legend className="sr-only">{t("Papel na equipe")}</legend>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm">
            <input
              type="radio"
              name="papel-interno"
              value=""
              checked={escolha === ""}
              onChange={() => setEscolha("")}
              data-testid="papel-nenhum"
              className="mt-1"
            />
            <span className="font-medium">{t("Nenhum papel")}</span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm">
            <input
              type="radio"
              name="papel-interno"
              value="secretaria"
              checked={escolha === "secretaria"}
              onChange={() => setEscolha("secretaria")}
              data-testid="papel-secretaria"
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{t("Secretaria")}</span>
              <span className="block text-text-muted">
                {t("A IA pergunta a ela como está a agenda, confirma horários antes de marcar e avisa o que foi agendado.")}
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm">
            <input
              type="radio"
              name="papel-interno"
              value="marketing"
              checked={escolha === "marketing"}
              onChange={() => setEscolha("marketing")}
              data-testid="papel-marketing"
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{t("Marketing")}</span>
              <span className="block text-text-muted">
                {t("Ela manda a ideia e as fotos de uma campanha; a IA cria as variações, mostra a prévia e envia aos poucos.")}
              </span>
            </span>
          </label>
        </fieldset>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={definir.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void salvar()} disabled={!mudou || definir.isPending} data-testid="salvar-papel">
            {t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
