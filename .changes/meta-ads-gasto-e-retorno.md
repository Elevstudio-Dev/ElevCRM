---
impacto: capacidade_nova
secao: adicionado
titulo: Ligação com a Meta: gasto, custo por contato, custo por venda e retorno de cada anúncio
---
Cada organização pode conectar a **própria conta de anúncios da Meta** e passar a ver, na aba Relatórios, quanto cada
anúncio gastou e o que ele trouxe.

- **Conexão** em Configurações → Meta Ads (só dono e gerente). Você cola o número da conta de anúncios e uma chave de
  acesso **somente de leitura** (permissão `ads_read`). O sistema confere a chave na Meta antes de guardá-la, guarda-a
  cifrada e nunca a mostra de volta. A tela traz o passo a passo para gerar a chave.
- **Atualização** automática de hora em hora e botão "Atualizar agora". Na primeira vez traz os últimos 90 dias.
- **Relatórios** ganha a tabela "Anúncios: gasto, custo e retorno", com campanha, conjunto e anúncio, **gasto**,
  **contatos**, **custo por contato**, vendas, **custo por venda**, valor ganho e **retorno** (valor ganho ÷ gasto).
  O anúncio que gastou e não trouxe ninguém aparece marcado.
- Se a conta de anúncios não for em reais, o gasto aparece na moeda dela e o retorno não é calculado, para não misturar
  moedas.

Para quem atualiza: a migration 0224 é aditiva (duas tabelas novas e uma função de relatório). Nada muda até alguém
conectar a conta.
