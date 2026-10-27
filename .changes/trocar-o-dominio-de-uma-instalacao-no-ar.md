---
impacto: capacidade_nova
secao: adicionado
titulo: Trocar o domínio de uma instalação que já está no ar, com volta automática se algo falhar
---

O kit ganhou o `trocar-dominio.sh`, para quem instalou no endereço provisório da hospedagem
e quer passar para o domínio da empresa sem reinstalar.

Ele confere **antes de escrever qualquer coisa** que o nome novo já aponta para a VPS (e que não
tem um registro IPv6 que faria o certificado falhar). Depois guarda uma cópia do `.env`, troca o
`DOMAIN` e as duas URLs públicas, recria os contêineres e espera o HTTPS novo responder e o app
ficar saudável.
**Se qualquer passo falhar, o `.env` volta ao de antes e o site segue no endereço anterior.**
A mensagem diz isso, em vez de deixar o site caído.

Também reescreve o cron que chama o app pelo endereço, que levaria o domínio velho para sempre.
`--ensaio` só confere e não altera nada. O passo a passo, e o que fica fora da VPS (o Site URL do
Supabase), está em `docs/runbooks/operacao-24h.md` §6.2.
