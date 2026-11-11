"use client";
import { format } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  retornoVivo,
  useAgendarRetorno,
  useDesmarcarRetorno,
  useRetornosDoContato,
  type RetornoDoContato,
} from "@/hooks/followup/useRetornosDoContato";
import { diaDaquiA, diaLocal, HORA_PADRAO_DO_RETORNO, instanteDoRetorno } from "@/lib/followup/instante-do-retorno";
import { CalendarPlus } from "@/lib/ui/icons";

const ATALHOS: Array<{ dias: number; rotulo: string }> = [
  { dias: 1, rotulo: "Amanhã" },
  { dias: 3, rotulo: "Em 3 dias" },
  { dias: 7, rotulo: "Em 1 semana" },
  { dias: 15, rotulo: "Em 15 dias" },
];

function quandoLegivel(iso: string, locale: ReturnType<typeof useLocaleDeData>): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : format(d, "dd/MM/yyyy HH:mm", { locale });
}

interface DialogProps {
  contactId: string;
  nomeDoContato: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * MARCAR UM DIA PARA A IA VOLTAR A FALAR COM O CLIENTE.
 *
 * A pessoa escolhe o dia e a hora e escreve o que a IA deve fazer; nesse dia o agente retoma a conversa seguindo a
 * instrução. É a mesma máquina do retorno que o próprio agente marca ("me chama em 3 dias"): um por cliente. Se já
 * existe um, o diálogo o mostra e oferece desmarcar — em vez de um formulário que o servidor recusaria.
 */
export function AgendarFollowupDialog({ contactId, nomeDoContato, open, onOpenChange }: DialogProps) {
  const t = useT();
  const locale = useLocaleDeData();
  const retornos = useRetornosDoContato(open ? contactId : null);
  const agendar = useAgendarRetorno(contactId);
  const desmarcar = useDesmarcarRetorno(contactId);

  const [dia, setDia] = useState("");
  const [hora, setHora] = useState(HORA_PADRAO_DO_RETORNO);
  const [instrucao, setInstrucao] = useState("");
  // O "agora" de quando o diálogo abriu: ler o relógio durante a renderização é impuro. O diálogo vive minutos, e o
  // servidor confere a janela de novo ao agendar — aqui é só para avisar cedo que o horário já passou.
  const [abertoEm] = useState(() => Date.now());

  const vivo: RetornoDoContato | null = retornoVivo(retornos.data);
  const instante = instanteDoRetorno(dia, hora);
  const noPassado = instante !== null && instante.getTime() <= abertoEm;
  const podeAgendar = instante !== null && !noPassado && instrucao.trim() !== "" && !agendar.isPending;

  function fechar(v: boolean) {
    if (!v) {
      setDia("");
      setHora(HORA_PADRAO_DO_RETORNO);
      setInstrucao("");
    }
    onOpenChange(v);
  }

  function confirmar() {
    if (!instante) return;
    agendar.mutate(
      { quando: instante.toISOString(), instrucao: instrucao.trim() },
      {
        onSuccess: (r) => {
          fechar(false);
          toast.success(`${t("Follow-up marcado para")} ${quandoLegivel(r.quando, locale)}.`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md" data-testid="agendar-followup-dialog">
        <DialogHeader>
          <DialogTitle>{t("Agendar follow-up")}</DialogTitle>
          <DialogDescription>
            {`${t("No dia escolhido, a IA retoma a conversa com")} ${nomeDoContato} ${t("e faz o que você pedir.")}`}
          </DialogDescription>
        </DialogHeader>

        {retornos.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : vivo ? (
          <div className="space-y-3" data-testid="followup-ja-marcado">
            <p className="text-sm">
              {t("Já há um follow-up marcado para")} <strong>{quandoLegivel(vivo.quando, locale)}</strong>.
            </p>
            <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm text-text-muted">
              {vivo.instrucao ?? vivo.motivo}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("Cada cliente tem um follow-up marcado por vez. Desmarque este para marcar outro.")}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => fechar(false)}>
                {t("Fechar")}
              </Button>
              <Button variant="outline" disabled={desmarcar.isPending} onClick={() => desmarcar.mutate(vivo.id)}>
                {desmarcar.isPending ? t("Desmarcando…") : t("Desmarcar")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="followup-dia">{t("Dia e hora")}</Label>
              <div className="flex gap-2">
                <Input
                  id="followup-dia"
                  type="date"
                  value={dia}
                  min={diaLocal(new Date(abertoEm))}
                  onChange={(e) => setDia(e.target.value)}
                  aria-invalid={noPassado}
                />
                <Input
                  id="followup-hora"
                  type="time"
                  aria-label={t("Hora")}
                  value={hora}
                  onChange={(e) => setHora(e.target.value)}
                  className="w-32"
                />
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {ATALHOS.map((a) => (
                  <Button
                    key={a.dias}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => setDia(diaDaquiA(new Date(abertoEm), a.dias))}
                  >
                    {t(a.rotulo)}
                  </Button>
                ))}
              </div>
              {noPassado && <p className="text-xs text-error">{t("Escolha um dia e uma hora que ainda não passaram.")}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="followup-instrucao">{t("O que a IA deve fazer")}</Label>
              <Textarea
                id="followup-instrucao"
                value={instrucao}
                onChange={(e) => setInstrucao(e.target.value)}
                placeholder={t("Ex.: perguntar se ela decidiu pelo clareamento e oferecer o horário de sábado")}
                maxLength={1000}
                rows={4}
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => fechar(false)}>
                {t("Cancelar")}
              </Button>
              <Button disabled={!podeAgendar} onClick={confirmar} data-testid="agendar-followup-confirmar">
                {agendar.isPending ? t("Agendando…") : t("Agendar")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A seção "Follow-up" do painel do contato: o botão de marcar e, se já existe, o que está marcado.
 * Os dois abrem o mesmo diálogo.
 */
export function FollowupAgendadoSecao({ contactId, nomeDoContato }: { contactId: string; nomeDoContato: string }) {
  const t = useT();
  const locale = useLocaleDeData();
  const [aberto, setAberto] = useState(false);
  const retornos = useRetornosDoContato(contactId);
  const vivo = retornoVivo(retornos.data);

  return (
    <section data-testid="secao-followup">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("Follow-up")}</h3>
      {vivo ? (
        <div className="mt-2 space-y-1.5 rounded-md border border-border p-2 text-xs" data-testid="followup-marcado">
          <div className="font-medium">{quandoLegivel(vivo.quando, locale)}</div>
          <p className="line-clamp-3 text-muted-foreground">{vivo.instrucao ?? vivo.motivo}</p>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAberto(true)}>
            {t("Ver ou desmarcar")}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 px-2 text-xs"
          data-testid="agendar-followup"
          onClick={() => setAberto(true)}
        >
          <CalendarPlus size={12} className="mr-1" weight="regular" aria-hidden />
          {t("Agendar follow-up")}
        </Button>
      )}
      {aberto && (
        <AgendarFollowupDialog contactId={contactId} nomeDoContato={nomeDoContato} open onOpenChange={setAberto} />
      )}
    </section>
  );
}
