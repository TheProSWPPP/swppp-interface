FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
# postinstall runs `playwright install --with-deps chromium` which the base image
# normally has, but new Playwright defaults to chrome-headless-shell which needs
# explicit deps. Run install with --with-deps to ensure libglib etc are present.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
 && npx playwright install --with-deps chromium

COPY index.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
