# Rastreio de Entrega Lume — GPS real

Sistema com três partes:

- **server.js** — servidor que recebe a localização do motoboy e responde às consultas da cliente. Guarda os dados num banco Postgres de verdade (veja `db.js` e a seção "Banco de dados" abaixo) — pedidos ficam salvos por até 40 dias, motoboys ficam salvos para sempre.
- **public/motoboy.html** — página que o motoboy abre no celular. Pede permissão de GPS e envia a localização em tempo real.
- **public/cliente.html** — página que a cliente recebe pelo link no WhatsApp. Mostra a posição do motoboy num mapa, com distância e tempo estimado calculados de verdade (via OpenStreetMap/OSRM, gratuitos).

## Banco de dados (Supabase, gratuito)

Antes de colocar no ar, você precisa de um banco de dados Postgres gratuito no Supabase:

1. Crie uma conta gratuita em **https://supabase.com** e clique em **"New project"**.
2. Dê um nome ao projeto, escolha uma **senha do banco de dados** (anote essa senha em algum lugar seguro — você vai precisar dela já já) e a região mais próxima de você.
3. Espere o projeto terminar de criar (leva 1-2 minutos).
4. Vá em **Project Settings → Database → Connection string**, escolha a aba **URI** e copie o texto. Ele parece com isso: `postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-x-xxxx.pooler.supabase.com:5432/postgres`
5. Troque o trecho `[YOUR-PASSWORD]` pela senha que você escolheu no passo 2. Essa string completa vai virar a variável `DATABASE_URL` lá no Render (explico abaixo).

Você não precisa criar nenhuma tabela manualmente — o servidor cria tudo sozinho (`motoboys` e `pedidos`) na primeira vez que sobe.

**Detalhe do plano gratuito do Supabase:** se o sistema ficar 7 dias seguidos sem nenhum acesso, o projeto "pausa" sozinho (os dados continuam salvos, só não aceita conexão até você reativar). Pra reativar, basta entrar no painel do Supabase e clicar em "Restore/Resume" — leva menos de um minuto. Como o Lume é usado quase todo dia, isso dificilmente deve acontecer.

## Por que não dá pra só abrir os arquivos no navegador?

Celular só libera GPS para páginas em **HTTPS** (ou `localhost`). Por isso este projeto precisa estar rodando num servidor com endereço `https://...` para o teste funcionar no celular do motoboy. A forma mais simples e gratuita de conseguir isso é o **Render**.

## Como colocar no ar (grátis, ~10 minutos, sem instalar nada no computador)

1. **Crie uma conta gratuita no GitHub** (https://github.com), se ainda não tiver.
2. No GitHub, clique em **"New repository"**, dê um nome (ex: `rastreio-entrega`) e crie.
3. Dentro do repositório, clique em **"Add file" → "Upload files"** e arraste todos os arquivos desta pasta (`server.js`, `package.json`, `README.md` e a pasta `public` inteira). Confirme o upload.
4. Crie uma conta gratuita no **Render** (https://render.com) — dá para entrar direto com o GitHub.
5. No Render, clique em **"New +" → "Web Service"** e escolha o repositório que você acabou de criar.
6. Deixe as configurações padrão (Render detecta o Node.js sozinho). Em **Build Command** confirme `npm install` e em **Start Command** confirme `npm start` (ou `node server.js`).
7. Antes de criar, abra a seção **Environment** (ou "Environment Variables") e adicione duas variáveis:
   - `DATABASE_URL` = a connection string do Supabase que você montou na seção anterior.
   - `ADMIN_PASSWORD` = a senha que você (dono da loja) vai usar pra cadastrar motoboys e ver o relatório completo de valores. Escolha algo só seu, não compartilhe com os motoboys.
8. Escolha o plano **Free** e clique em **Create Web Service**. Em 1–2 minutos o Render te dá uma URL parecida com `https://rastreio-entrega.onrender.com`.

Se depois quiser trocar a senha de administrador, é só editar o valor de `ADMIN_PASSWORD` em Environment e o Render reimplanta sozinho.

## Como testar

1. Abra `https://SEU-ENDERECO.onrender.com/motoboy.html` e vá na aba **"Motoboy parceiro"** pra cadastrar o primeiro motoboy (vai pedir a senha de administrador que você configurou + uma senha pra esse motoboy).
2. Vá na aba **"Novo pedido"**, preencha um pedido de teste selecionando esse motoboy, e toque em **"➕ Cadastrar pedido"**. Ele entra na fila da aba "Em rota".
3. Na aba **"Em rota"**, toque no ▶ do pedido — isso abre o WhatsApp com o link de rastreio pronto (pode mandar pra você mesmo pra testar) e começa a enviar o GPS. Aceite a permissão de localização quando o navegador perguntar.
4. Abra esse link (o da tela da cliente) em **outro celular ou computador** — você deve ver o motoboy se movendo no mapa em tempo real conforme ele anda.
5. De volta na aba "Em rota", toque em **"✅ Marcar como entregue"** pra encerrar (se o pagamento for cartão/dinheiro na entrega, ele vai pedir a confirmação de recebimento antes).

## Senhas: cadastro de motoboy e relatório de valores

- **Cadastrar um motoboy novo** exige a senha de administrador (`ADMIN_PASSWORD`). Ao cadastrar, você também define uma **senha própria pra aquele motoboy** (mínimo 4 caracteres) — é a senha que ele vai usar pra ver os valores dele.
- **A aba "Valor de entregas"** pede uma senha antes de mostrar qualquer valor:
  - Digitando a **senha de administrador**, vê o relatório completo (todos os motoboys).
  - Digitando a **senha de um motoboy específico**, vê só as entregas daquele motoboy.
  - A senha fica só na memória da página enquanto ela estiver aberta — feche/recarregue a página e ela pede de novo.

## Retenção de dados

- **Pedidos/entregas** ficam guardados por até **40 dias**; depois disso, uma limpeza automática apaga os mais antigos (roda quando o servidor sobe e depois a cada 6 horas). Se precisar de um histórico maior que isso, seria necessário aumentar o prazo no `db.js` (`RETENCAO_PEDIDOS_DIAS`) ou exportar os dados manualmente antes dos 40 dias.
- **Motoboys cadastrados** ficam guardados para sempre — não expiram sozinhos.

## Observações importantes

- **Plano gratuito do Render "dorme"** depois de um tempo sem uso — a primeira abertura depois disso pode demorar uns 30-50 segundos. Isso não afeta os dados salvos (eles ficam no Supabase, não no Render). Se quiser deixar o site sempre ligado pros clientes, o plano pago mais simples do Render custa hoje uns US$ 7/mês — é opcional e independente do banco de dados.
- **Mantenha a página do motoboy aberta e em primeiro plano** durante a entrega — se ele trocar de aplicativo (ex: abrir o Waze), o envio da localização pode parar, dependendo do celular.
- O endereço da cliente é localizado no mapa automaticamente (gratuito, via OpenStreetMap). Às vezes não encontra um endereço muito específico — nesse caso o mapa ainda mostra a posição do motoboy normalmente, só não mostra o pino da casa da cliente.
- Se o servidor não conseguir se conectar ao banco (por exemplo, `DATABASE_URL` errada ou não configurada), ele ainda sobe, mas qualquer ação que mexa com dados (cadastrar pedido, motoboy, etc.) vai dar erro — confira nos logs do Render se aparecer algo assim.
