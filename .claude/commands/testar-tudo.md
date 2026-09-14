---
description: Roda TODOS os testes da Definition of Done (gov:verify, test:db, test:shell, E2E com as listas do CI) e reporta por camada, com evidência
---
Rode a Definition of Done inteira nesta máquina e reporte o resultado por camada.

1. Antes de rodar: se o servidor de teste da 3100 estiver no ar, derrube
   (`fuser -k 3100/tcp` no WSL) — o build da E2E reescreve o `.next` que ele serve.
   Docker precisa estar de pé (o `test:db` sobe um Postgres efêmero).
2. Rode `pnpm elev:testar` (ou `pnpm elev:testar --sem-e2e` se o pedido disser
   explicitamente que a mudança não toca UI). Demora ~55 min com E2E; rode em
   segundo plano e espere terminar — não reporte antes do veredito.
3. Leia o veredito e, para cada camada vermelha, o log em
   `.superpowers/testar-tudo/<data>/<camada>.log`. Separe o que é defeito do
   produto do que é ambiente (banco local com dados de rodadas anteriores,
   credencial ausente, spec fora do CI) — `docs/elev/rodar-os-testes.md`
   lista os casos conhecidos.
4. Reporte com a evidência: contagem por camada (arquivos/testes, tempo), as
   specs vermelhas pelo nome com a causa, e o que você consertou. Nunca diga
   "passou" sem ter lido a linha `TUDO VERDE` deste run — resultado de rodada
   anterior não vale (`verification-before-completion`).
5. Depois da E2E, o servidor de teste local fica derrubado: suba de novo (o
   script de subir fica fora do repositório — pergunte ou veja a memória) se
   alguém for testar pela tela.
