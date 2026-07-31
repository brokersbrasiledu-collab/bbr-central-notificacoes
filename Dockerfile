# ────────────────────────────────────────────────────────────────
# Central de Notificações Push — Brokers Brasil
#
# Imagem enxuta baseada no Node 22 LTS. O Debian (slim) é proposital:
# o better-sqlite3 tem binário pronto para ele, então o build não
# precisa compilar nada e termina em poucos minutos.
# ────────────────────────────────────────────────────────────────
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Só os manifestos primeiro. Assim o Docker reaproveita a camada das
# dependências quando apenas o código muda — deploys ficam bem mais rápidos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Identificação da build. O GitHub Actions injeta aqui o commit que gerou
# esta imagem, e o app devolve o valor em /api/saude — é assim que se
# confirma, pelo navegador, qual versão está de fato rodando na VPS.
ARG VERSAO=local
ENV VERSAO=$VERSAO

# Pasta do banco criada com o dono certo. O volume nomeado herda estas
# permissões na primeira montagem — sem isso o container não gravaria nada.
RUN mkdir -p /dados && chown -R node:node /dados /app

# Nunca como root.
USER node

EXPOSE 3000

# O Portainer mostra este estado como "healthy" na lista de containers.
# A folga de 45s na partida evita que uma VPS ocupada marque o serviço como
# doente antes de ele terminar de subir — o Swarm reiniciaria em looping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
