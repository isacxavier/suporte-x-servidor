# Suporte X QuickView (Web)

**Objetivo:** compartilhar a tela do celular **(Android)** do cliente via navegador (Chrome) para que o técnico visualize em tempo real. Não há controle remoto, é **apenas visualização** (view-only). Não precisa instalar app — basta abrir um link e tocar em "Iniciar agora".

## Como funciona
- `send.html` (no celular do cliente): usa `getDisplayMedia` para capturar a tela e envia via **WebRTC**.
- `view.html` (no navegador do técnico): recebe o vídeo.
- `server.js` (Node + Socket.IO): faz a **sinalização** (troca de SDP/ICE). O vídeo trafega P2P quando possível.

### Estrutura básica do projeto

Se você nunca trabalhou com WebRTC ou Socket.IO, este repositório pode parecer confuso à primeira vista. A estrutura é
intencionalmente enxuta:

- `public/`: contém os arquivos estáticos servidos para navegador, incluindo `send.html` (cliente) e `view.html` (técnico).
- `server.js`: cria um servidor Express + Socket.IO responsável apenas por intermediar a troca das mensagens de sinalização.
- `package.json`: lista dependências (Express e Socket.IO) e scripts (`npm start`).

> Não existe build front-end. O HTML/JS é carregado diretamente pelo navegador, o que facilita a leitura do código para quem
> está começando. Abra os arquivos do diretório `public/` para entender a lógica passo a passo.

> Em produção, **HTTPS** é obrigatório para `getDisplayMedia`. Ao hospedar no Render, Vercel, etc., você terá HTTPS automaticamente.

## Rodando localmente (teste rápido)
1. Instale o Node 18+.
2. No terminal, dentro da pasta, rode:
   ```bash
   npm install
   npm start
   ```
3. Acesse `http://localhost:3000` no seu PC.
4. Para testar no celular na mesma rede, use o IP local do seu PC (ex.: `http://192.168.0.10:3000`). *OBS: sem HTTPS alguns celulares podem bloquear `getDisplayMedia`.*

## Hospedagem simples (Render.com)
1. Crie um repositório no GitHub e envie estes arquivos.
2. No Render, crie um **Web Service** conectado ao seu repositório.
3. *Build Command:* `npm install`
4. *Start Command:* `node server.js`
5. Após o deploy, pegue a URL pública HTTPS (ex.: `https://suportex.onrender.com`).

## Uso com o cliente
- Envie a ele `https://SEU_DOMINIO/send.html`
- Ele toca em **Gerar código** (ou você envia `?room=123456` pronto).
- Ele toca em **Iniciar compartilhamento** e confirma **Iniciar agora**.
- Você abre `https://SEU_DOMINIO/view.html?room=123456` e vê a tela.

## TURN (opcional, recomendado)
Em redes restritas, pode ser necessário um **TURN server** para garantir conexão.
- Você pode instalar **coturn** num VPS e depois configurar as credenciais nas páginas `send.html` e `view.html` (função `iceServers()`).

## Limitações
- **Sem controle remoto.** Apenas visualização (por segurança da plataforma).
- O cliente **sempre** precisa tocar em "Iniciar agora".
- iOS: o Safari mobile tem mais restrições; priorize Android (Chrome).

## Segurança
- O stream não passa pelo servidor (só a sinalização). Quando possível, a mídia trafega P2P e é criptografada pelo WebRTC.
