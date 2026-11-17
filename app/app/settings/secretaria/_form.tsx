"use client";
/**
 * O formulário da agenda da secretaria.
 *
 * A cópia importa mais que o layout: quem liga isto não sabe o que é "bastidor" nem "agenda conferida". Cada bloco
 * diz o que ACONTECE (quem a IA procura, a que horas, o que acontece se ninguém responde).
 */
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { SecretariaDaTela } from "@/lib/agenda/secretaria/situacao";

export interface ConfigDaTela {
  ativa: boolean;
  dono_da_agenda_user_id: string | null;
  duracao_min: number;
  perguntas: string[];
  dias: number[];
}

const DIAS_DA_SEMANA: Array<{ valor: number; rotulo: string }> = [
  { valor: 1, rotulo: "Seg" },
  { valor: 2, rotulo: "Ter" },
  { valor: 3, rotulo: "Qua" },
  { valor: 4, rotulo: "Qui" },
  { valor: 5, rotulo: "Sex" },
  { valor: 6, rotulo: "Sáb" },
  { valor: 0, rotulo: "Dom" },
];

const MAXIMO_DE_HORARIOS = 6;
const HORARIO_NOVO = "12:00";

export function SecretariaForm({ initial, secretarias }: { initial: ConfigDaTela; secretarias: SecretariaDaTela[] }) {
  const t = useT();
  const [form, setForm] = useState<ConfigDaTela>(initial);
  const [salvo, setSalvo] = useState<ConfigDaTela>(initial);
  const [isPending, startTransition] = useTransition();
  const { data: membros } = useAssignableMembers(true);

  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);
  const horariosRepetidos = new Set(form.perguntas).size !== form.perguntas.length;
  const semHorario = form.perguntas.some((h) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(h));
  const invalido = horariosRepetidos || semHorario || form.dias.length === 0 || form.perguntas.length === 0;

  const semSecretaria = secretarias.length === 0;
  const semConversa = secretarias.filter((s) => !s.tem_conversa);

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (invalido) return;
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/secretaria", form);
        setSalvo(form);
        toast.success(t("Agenda da secretaria salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  function alternarDia(dia: number) {
    setForm((f) => ({
      ...f,
      dias: f.dias.includes(dia) ? f.dias.filter((d) => d !== dia) : [...f.dias, dia].sort((a, b) => a - b),
    }));
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-6" data-testid="form-secretaria">
      <Card className="space-y-4 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={form.ativa}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, ativa: e.target.checked }))}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            data-testid="secretaria-ativa"
          />
          <span className="space-y-1">
            <span className="block text-sm font-semibold">{t("Usar a agenda da secretaria")}</span>
            <span className="block text-xs text-muted-foreground">
              {t(
                "Ligado: a IA pergunta a agenda à secretaria e só oferece horário aos pacientes quando ela conferiu há pouco. Desligado: nada muda no atendimento.",
              )}
            </span>
          </span>
        </label>

        <div className="space-y-1 border-t pt-4">
          <Label htmlFor="dono">{t("De quem é a agenda")}</Label>
          <select
            id="dono"
            value={form.dono_da_agenda_user_id ?? ""}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, dono_da_agenda_user_id: e.target.value === "" ? null : e.target.value }))}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t("Quem o tipo de agendamento indicar")}</option>
            {(membros ?? []).map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name ?? m.user_id}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t("O profissional que faz a avaliação. O fuso e os horários de atendimento dele valem para a agenda.")}
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="duracao">{t("Duração da avaliação (minutos)")}</Label>
          <Input
            id="duracao"
            type="number"
            min={5}
            max={240}
            value={form.duracao_min}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, duracao_min: Number(e.target.value) }))}
            className="max-w-32"
          />
          <p className="text-xs text-muted-foreground">
            {t("Usada quando a secretaria diz só a hora de início.")}
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Quando a IA pergunta")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Se a secretaria não responde em 30 minutos, a IA lembra uma vez; se continua sem responder, você recebe um aviso na Central de avisos.",
            )}
          </p>
        </div>

        <div className="space-y-2" data-testid="horarios-das-perguntas">
          {form.perguntas.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="time"
                value={h}
                disabled={isPending}
                aria-label={t("Horário da pergunta")}
                onChange={(e) =>
                  setForm((f) => ({ ...f, perguntas: f.perguntas.map((x, j) => (j === i ? e.target.value : x)) }))
                }
                className="max-w-36"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending || form.perguntas.length <= 1}
                onClick={() => setForm((f) => ({ ...f, perguntas: f.perguntas.filter((_, j) => j !== i) }))}
              >
                {t("Remover")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending || form.perguntas.length >= MAXIMO_DE_HORARIOS}
            onClick={() => setForm((f) => ({ ...f, perguntas: [...f.perguntas, HORARIO_NOVO] }))}
          >
            {t("Adicionar horário")}
          </Button>
          {horariosRepetidos ? (
            <p data-testid="aviso-horario-repetido" className="text-xs text-destructive">
              {t("Há horários repetidos na lista.")}
            </p>
          ) : null}
        </div>

        <div className="space-y-2 border-t pt-4">
          <Label>{t("Em quais dias")}</Label>
          <div className="flex flex-wrap gap-3" data-testid="dias-das-perguntas">
            {DIAS_DA_SEMANA.map((d) => (
              <label key={d.valor} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.dias.includes(d.valor)}
                  disabled={isPending}
                  onChange={() => alternarDia(d.valor)}
                  className="h-4 w-4 accent-primary"
                />
                {t(d.rotulo)}
              </label>
            ))}
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4" data-testid="quem-e-a-secretaria">
        <div>
          <h2 className="text-sm font-semibold">{t("Quem é a secretaria")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Abra o contato dela e marque o papel “Secretaria”. A IA só consegue perguntar se ela já tem uma conversa com o número da clínica: se ela nunca falou com o número, peça para mandar um “oi”.",
            )}
          </p>
        </div>

        {semSecretaria ? (
          <p data-testid="sem-secretaria" className="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-xs dark:bg-amber-900/10">
            {t("Nenhum contato tem o papel de Secretaria ainda. Sem isso, a IA não tem para quem perguntar.")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {secretarias.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                <Link href={`/app/contacts/${s.id}`} className="font-medium underline-offset-2 hover:underline">
                  {s.nome ?? t("Sem nome")}
                </Link>
                <span
                  data-testid={`conversa-${s.tem_conversa ? "sim" : "nao"}`}
                  className={s.tem_conversa ? "text-xs text-emerald-600" : "text-xs text-amber-600"}
                >
                  {s.tem_conversa ? t("A IA consegue falar com ela") : t("Ainda sem conversa com o número")}
                </span>
              </li>
            ))}
          </ul>
        )}

        {semConversa.length > 0 && !semSecretaria ? (
          <p className="text-xs text-muted-foreground">
            {t("Quem está “sem conversa” só passa a receber a pergunta depois de mandar a primeira mensagem ao número.")}
          </p>
        ) : null}
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo || invalido} data-testid="salvar-secretaria">
          {isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        {!sujo ? <span className="text-xs text-muted-foreground">{t("Nada para salvar.")}</span> : null}
      </div>
    </form>
  );
}
